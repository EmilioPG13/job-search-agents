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

function classify(job, profile) {
  const title = (job.title || '').trim();
  const description = job.raw_description || '';
  const wantsJunior = ['junior', 'intern', 'entry'].includes(
    (profile.targeting.seniority || '').toLowerCase(),
  );

  if (!title || PLACEHOLDER_TITLE.test(title)) {
    return { keep: false, reason: 'placeholder or non-job listing' };
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

  if (wantsJunior && SENIOR_TITLE.test(title)) {
    return { keep: false, reason: 'seniority above target level' };
  }

  return { keep: true, reason: null };
}

const selectDiscovered = db.prepare(`
  SELECT id, title, raw_description
  FROM jobs
  WHERE status = 'discovered'
  ORDER BY id
`);

const reject = db.prepare(`
  UPDATE jobs
  SET status = 'rules_rejected', notes = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, 'discovered', 'rules_rejected', ?)
`);

function run({ dryRun = false } = {}) {
  const profile = loadProfile();
  const jobs = selectDiscovered.all();
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
      recordTransition.run(job.id, reason);
    }
  }

  return { examined: jobs.length, kept, rejected: jobs.length - kept, byReason };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const { examined, kept, rejected, byReason } = run({ dryRun });
    console.log(`${dryRun ? '[dry run] ' : ''}Examined ${examined} jobs.`);
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
