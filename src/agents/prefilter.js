// Prefilter — the only agent that runs before any model call, and the reason
// the pipeline is affordable. Pure rules, no LLM.
//
// It answers one question per job: is this obviously not worth a model call?
// Anything it isn't sure about it leaves alone — a false reject costs you a
// real opportunity, while a false keep costs one cheap model call. The
// asymmetry is deliberate: when in doubt, keep.
//
// Note on signals: RemoteOK's `tags` are NOT used. Measured on a real fetch,
// 55 of 104 postings carried tech tags while only 3 had a tech title — one
// gelato-shop job listed 52 tags including "golang" and "engineer". The tags
// are SEO stuffing, so this filter reads the title and description instead.

const fs = require('fs');
const path = require('path');
const db = require('../db');

const PROFILE_PATH = path.join(__dirname, '../profile/profile.json');

function loadProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error(
      'src/profile/profile.json not found. Copy profile.example.json to ' +
        'profile.json and fill it in.',
    );
  }
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

// Titles that carry no information — scraper artifacts and page fragments.
const PLACEHOLDER_TITLE =
  /^(job title|heading|life|join us|apply for employment|job post\s*#?\d*|your dream job.*|wynn.*|the .*)$/i;

const TECH_TITLE =
  /\b(engineer|engineering|developer|dev|programmer|software|frontend|front.end|backend|back.end|full.?stack|devops|cloudops|sre|data scientist|data engineer|data analyst|machine learning|\bml\b|\bai\b|qa automation|web dev|it support|sysadmin|system administrator|database|ux designer|ui designer|technical writer)\b/i;

// Concrete technologies. Generic words like "cloud" or "digital" are excluded
// on purpose — every marketing post contains those.
const TECH_TERMS =
  /\b(javascript|typescript|python|golang|ruby on rails|c\+\+|c#|\.net|react|angular|vue\.?js|node\.?js|express\.?js|django|flask|spring boot|kubernetes|docker|terraform|postgres(ql)?|mysql|mongodb|graphql|rest api|git(hub|lab)?|linux|aws|azure|typescript|webpack|redux)\b/gi;

// Seniority the profile says is out of reach. Applied only when the profile
// asks for junior-level work.
const SENIOR_TITLE =
  /\b(senior|sr\.?|staff|principal|lead|head of|director|vp|vice president|chief|c[toei]o|executive|architect|manager)\b/i;

// A posting can advertise several levels at once — "Senior & Junior Software
// Engineers", "Junior to Senior Fullstack Engineer". Rejecting those on the
// senior keyword alone threw away exactly the openings a junior wants, so a
// junior signal anywhere in the posting overrides the seniority reject.
const JUNIOR_SIGNAL =
  /\b(junior|jr\.?|entry[- ]level|new grad(uate)?|intern(ship)?|apprentice(ship)?|trainee|early career|all levels|graduate program|0[-–]2 years|1[-–]3 years)\b/i;

// Accents are stripped before matching. "México" and "Mexico" must compare
// equal — an earlier version of a location check missed accented Spanish
// entirely and silently mis-sorted LatAm postings.
const fold = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Words that describe a working arrangement rather than a place. "Remote" on
// its own is open to anyone; "Remote, India" is not. A plain substring match
// treats them the same and lets region-locked jobs through — which it did,
// leaving Bangalore roles on the shortlist after the rule was first added.
const ARRANGEMENT_ONLY =
  /^(remote|anywhere(\s+in\s+the\s+world)?|worldwide|global|distributed|flexible|hybrid|on-?site|full[-\s]?time|part[-\s]?time|contract)$/;

/**
 * Is this posting somewhere the candidate could actually work from?
 *
 * A posting with no location is kept: most Hacker News entries state it in the
 * body rather than a field, and rejecting on missing data would throw away
 * good roles.
 *
 * When places *are* named, one eligible place is enough — "Remote, Brazil;
 * Remote, Mexico; Remote, United States" is workable on the strength of Mexico
 * alone.
 */
function locationIsEligible(location, profile) {
  if (!location || !location.trim()) return true;

  const eligible = profile.targeting.work_regions_eligible;
  if (!Array.isArray(eligible) || eligible.length === 0) return true;

  const parts = fold(location)
    .split(/[,/|;]|\s+[-–—]\s+|\bor\b/)
    .map((p) => p.trim())
    .filter(Boolean);

  const places = parts.filter((p) => !ARRANGEMENT_ONLY.test(p));

  // Only an arrangement was given ("Remote", "Anywhere in the World").
  if (places.length === 0) return true;

  return places.some((place) => eligible.some((region) => place.includes(fold(region))));
}

function classify(job, profile) {
  const title = (job.title || '').trim();
  const description = job.raw_description || '';
  const wantsJunior = ['junior', 'intern', 'entry'].includes(
    (profile.targeting.seniority || '').toLowerCase(),
  );

  if (!title || PLACEHOLDER_TITLE.test(title)) {
    return { keep: false, reason: 'placeholder or non-job listing' };
  }

  if (!locationIsEligible(job.location, profile)) {
    return { keep: false, reason: `location not workable: ${job.location}` };
  }

  const titleLooksTech = TECH_TITLE.test(title);
  const distinctTechTerms = new Set(
    (description.match(TECH_TERMS) || []).map((t) => t.toLowerCase()),
  ).size;

  // Two independent signals, either is enough. Requiring 2+ distinct
  // technologies in the body stops a single passing mention of "git" or "AWS"
  // in a marketing post from counting as a software role.
  if (!titleLooksTech && distinctTechTerms < 2) {
    return { keep: false, reason: 'not a software role' };
  }

  if (
    wantsJunior &&
    SENIOR_TITLE.test(title) &&
    !JUNIOR_SIGNAL.test(title) &&
    !JUNIOR_SIGNAL.test(description)
  ) {
    return { keep: false, reason: 'seniority above target level' };
  }

  return { keep: true, reason: null };
}

const selectDiscovered = db.prepare(`
  SELECT id, title, location, raw_description
  FROM jobs
  WHERE status = 'discovered'
  ORDER BY id
`);

// Rows that already moved past 'discovered'. Needed when a rule is added after
// data was processed — as happened when a location rule arrived only once a
// finished shortlist showed jobs that couldn't be worked from.
const selectAlreadyProcessed = db.prepare(`
  SELECT id, title, location, raw_description, status
  FROM jobs
  WHERE status NOT IN ('discovered', 'rules_rejected')
  ORDER BY id
`);

const reject = db.prepare(`
  UPDATE jobs
  SET status = 'rules_rejected', notes = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, ?, 'rules_rejected', ?)
`);

function run({ dryRun = false, recheck = false } = {}) {
  const profile = loadProfile();
  const jobs = recheck ? selectAlreadyProcessed.all() : selectDiscovered.all();
  const byReason = {};
  let kept = 0;

  for (const job of jobs) {
    const { keep, reason } = classify(job, profile);
    if (keep) {
      kept++;
      continue;
    }
    byReason[reason] = (byReason[reason] || 0) + 1;
    if (!dryRun) {
      reject.run(reason, job.id);
      recordTransition.run(job.id, job.status || 'discovered', reason);
    }
  }

  return { examined: jobs.length, kept, rejected: jobs.length - kept, byReason };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const recheck = process.argv.includes('--recheck');
  try {
    const { examined, kept, rejected, byReason } = run({ dryRun, recheck });
    console.log(
      `${dryRun ? '[dry run] ' : ''}Examined ${examined} ${recheck ? 'already-processed' : ''} jobs.`,
    );
    console.log(`  kept:     ${kept}`);
    console.log(`  rejected: ${rejected}`);
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${count.toString().padStart(3)}  ${reason}`);
    }
  } catch (err) {
    console.error('Prefilter failed:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { run, classify };
