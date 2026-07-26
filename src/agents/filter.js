// Filter agent — scores an analyzed job against your profile and produces the
// shortlist. This is the step that turns "137 real software jobs" into "the
// eight worth your evening".
//
// It reads the *extracted requirements* rather than the raw posting. That
// matters: the requirements are already clean, structured, and stripped of
// whatever the posting was trying to do to an AI reader. Scoring against
// prose would put untrusted text back into a decision-making prompt.
//
// The posting title and company are passed as untrusted (they come straight
// from the source), but the bulk of the input is our own extracted data.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { askForJson, MODELS } = require('../lib/llm');
const { mapPool } = require('../lib/pool');

const PROFILE_PATH = path.join(__dirname, '../profile/profile.json');

function loadProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error('src/profile/profile.json not found — copy the example and fill it in.');
  }
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

const SYSTEM = `You score how well a job matches a candidate's stated goals.

Judge only against the criteria you are given. Do not assume the candidate has
skills that are not listed, and do not penalise them for requirements the
posting itself never states.

Be honest and calibrated. If most jobs score high the score is useless.

Use the whole range. These anchors matter — reserve the bottom for jobs in the
wrong field entirely, not for near-misses:

  0.9-1.0  Right field, right level. Apply today.
  0.7-0.9  Right field, minor gaps — a couple of unfamiliar technologies.
  0.5-0.7  Right field, real gaps. A stretch, but plausibly worth applying.
  0.3-0.5  Right field, wrong level or location. Not now, but not irrelevant —
           e.g. a full-stack role wanting three more years than the candidate
           has. Score here, NOT at zero.
  0.1-0.3  Adjacent field, or the candidate would need retraining.
  0.0-0.1  Different profession entirely (retail, hospitality, admin), or the
           posting is not a real job.

A role in the candidate's field that simply wants more seniority is a 0.3-0.5,
never a 0.0. Zero means "this has nothing to do with them".`;

const SCHEMA = {
  type: 'object',
  properties: {
    fit_score: {
      type: 'number',
      description:
        'How well this matches the candidate, 0 to 1. 0.8+ strong fit, 0.5-0.8 worth a look, below 0.5 poor fit.',
    },
    verdict: {
      type: 'string',
      enum: ['strong', 'worth_a_look', 'poor'],
      description: 'Bucket matching the score.',
    },
    reasoning: {
      type: 'string',
      description: 'Two or three sentences a human can act on. Say what fits and what does not.',
    },
    matched_criteria: {
      type: 'array',
      items: { type: 'string' },
      description: "Specific things about this role that match the candidate's goals.",
    },
    gaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Requirements the candidate likely does not meet.',
    },
    seniority_mismatch: {
      type: 'boolean',
      description: "True if the role's level is clearly above or below what the candidate wants.",
    },
  },
  required: ['fit_score', 'verdict', 'reasoning', 'matched_criteria', 'gaps', 'seniority_mismatch'],
  additionalProperties: false,
};

const selectAnalyzed = db.prepare(`
  SELECT id, title, company, location, source, tags, posted_at, extracted_requirements
  FROM jobs
  WHERE status = 'analyzed'
  ORDER BY id
  LIMIT ?
`);

const saveScore = db.prepare(`
  UPDATE jobs
  SET fit_score = ?, fit_reasoning = ?, status = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, 'analyzed', ?, ?)
`);

// Below this a job isn't worth tailoring a CV for. Deliberately low — the cost
// of a borderline keep is one more row on your review screen.
const SHORTLIST_THRESHOLD = 0.5;

const SENIOR_LEVELS = ['senior', 'lead', 'principal', 'staff', 'expert'];
const STALE_AFTER_DAYS = 45;

/** Compare on a normalised name so "Node.js" matches "nodejs" and "node js". */
const skillKey = (s) => String(s).toLowerCase().replace(/[.\s_/-]/g, '');

/**
 * How much of what the posting asks for does the candidate actually have?
 *
 * A fact, computed here rather than left to the model, and recorded on the row
 * so a ranking can be explained afterwards. Whether an overlap of 2/5 makes a
 * job worth applying to is a judgment, and that part stays with the model.
 */
function skillOverlap(requiredSkills, profileSkills) {
  const required = (requiredSkills || []).filter(Boolean);
  if (required.length === 0) return null;

  const have = new Set(profileSkills.map((s) => skillKey(s.name)));

  const matched = required.filter((req) => {
    const k = skillKey(req);

    return [...have].some((h) => {
      if (h === k) return true;
      // Substring both ways, so a posting's "React.js" matches "React" and
      // "TypeScript/React" matches either — but only for names long enough
      // that a coincidence is unlikely. Without the length floor, a posting
      // requiring "Go" matched because "go" appears inside "mongodb".
      const shorter = h.length < k.length ? h : k;
      if (shorter.length < 4) return false;
      return k.includes(h) || h.includes(k);
    });
  });

  return {
    matched,
    missing: required.filter((r) => !matched.includes(r)),
    ratio: Number((matched.length / required.length).toFixed(2)),
  };
}

/**
 * Deterministic corrections applied after the model scores a job.
 *
 * Two failures showed up when the first full shortlist was audited, and both
 * were the model being asked to weigh facts rather than judge them:
 *
 *   33 of 98 shortlisted jobs were tagged senior or expert yet scored 0.7+.
 *   For one, the model wrote "no restriction on junior experience" about a
 *   posting explicitly labelled senior by its own job board.
 *
 *   27 of 98 were over two months old and almost certainly filled, because
 *   nothing in the prompt knew what today's date is.
 *
 * Seniority and posting age are facts already on the row. Checking them in
 * code is cheaper, cannot be argued with, and leaves the model to do the part
 * that genuinely needs judgment.
 */
function applyRules(score, job, requirements, profile) {
  const adjustments = [];
  let adjusted = score;

  const wantsJunior = ['junior', 'intern', 'entry'].includes(
    (profile.targeting.seniority || '').toLowerCase(),
  );

  // The source's own seniority label beats anything inferred from prose.
  const sourceTags = JSON.parse(job.tags || '[]').map((t) => String(t).toLowerCase());
  const level = sourceTags.find((t) => SENIOR_LEVELS.includes(t))
    || (SENIOR_LEVELS.includes(requirements.seniority) ? requirements.seniority : null);

  if (wantsJunior && level) {
    // Capped rather than zeroed: a senior posting is a poor fit, not a
    // different profession, and some do hire below the advertised level.
    const cap = 0.35;
    if (adjusted > cap) {
      adjustments.push(`capped at ${cap} — posting is ${level} level`);
      adjusted = cap;
    }
  }

  if (job.posted_at) {
    const ageDays = Math.floor((Date.now() - new Date(job.posted_at).getTime()) / 86_400_000);
    if (Number.isFinite(ageDays) && ageDays > STALE_AFTER_DAYS) {
      // Linear decay rather than a cliff — a 50-day-old posting is worth
      // slightly less than a fresh one, not nothing.
      const penalty = Math.min(0.4, ((ageDays - STALE_AFTER_DAYS) / 120) * 0.4);
      adjustments.push(`-${penalty.toFixed(2)} — posted ${ageDays} days ago`);
      adjusted = Math.max(0, adjusted - penalty);
    }
  }

  return { score: Number(adjusted.toFixed(2)), adjustments };
}

/**
 * Describe the candidate's skills to the model, keeping the distinction
 * between what is claimed and what is demonstrable. A skill backed by public
 * repos is stronger evidence than one listed on a CV, and the model should be
 * able to weigh that.
 */
function describeSkills(profile) {
  const skills = profile.ground_truth?.skills || [];
  if (skills.length === 0) return null;

  const label = (s) =>
    s.source === 'both' || s.source === 'github'
      ? `${s.name} (demonstrated in public repos)`
      : s.name;

  return skills.map(label).join(', ');
}

async function scoreOne(job, profile) {
  const requirements = JSON.parse(job.extracted_requirements);
  const t = profile.targeting;
  const g = profile.ground_truth || {};

  const skillList = describeSkills(profile);

  const criteria = [
    `Target roles: ${t.target_roles.join(', ')}`,
    `Experience level: ${t.seniority}`,
    skillList ? `Skills the candidate actually has: ${skillList}` : null,
    g.years_hands_on
      ? `Hands-on experience: about ${g.years_hands_on} years — ${g.software_experience_type}. ` +
        `Treat a posting asking for 2-3 years as a genuine match, not a stretch.`
      : null,
    (g.spoken_languages || []).length
      ? `Spoken languages: ${g.spoken_languages.map((l) => `${l.language} (${l.level})`).join(', ')}`
      : null,
    `Work mode: ${(t.work_mode || []).join(', ') || 'any'}`,
    t.min_salary ? `Minimum salary: ${t.min_salary} ${t.salary_currency}` : 'No salary floor',
    t.filter_by_region
      ? `Must be eligible in: ${(t.regions_eligible || []).join(', ')}`
      : 'Region: no restriction',
    (t.dealbreakers || []).length ? `Dealbreakers: ${t.dealbreakers.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const { data } = await askForJson({
    system: SYSTEM,
    task:
      `Score this job against the candidate's criteria.\n\n` +
      `CANDIDATE CRITERIA\n${criteria}\n\n` +
      `ROLE: ${job.title}\nCOMPANY: ${job.company}\nLOCATION: ${job.location || 'not stated'}\n\n` +
      `EXTRACTED REQUIREMENTS (already parsed from the posting)\n` +
      JSON.stringify(requirements, null, 2),
    schema: SCHEMA,
    model: MODELS.FAST,
  });

  // Clamp: a model can return 1.4 or -0.2 even under a schema.
  const modelScore = Math.max(0, Math.min(1, Number(data.fit_score) || 0));
  const { score, adjustments } = applyRules(modelScore, job, requirements, profile);

  // Recorded rather than applied: the overlap explains a ranking without
  // second-guessing the model's judgment of how much it matters.
  const overlap = skillOverlap(requirements.required_skills, profile.ground_truth?.skills || []);
  if (overlap) {
    data.skill_overlap = overlap.ratio;
    data.skills_matched = overlap.matched;
    data.skills_missing = overlap.missing;
  }

  // Keep both numbers so a surprising ranking can be traced back to whether
  // the model or the rules produced it.
  data.model_score = modelScore;
  data.fit_score = score;
  data.rule_adjustments = adjustments;

  const status = score >= SHORTLIST_THRESHOLD ? 'scored_in' : 'scored_out';

  saveScore.run(score, JSON.stringify(data), status, job.id);
  recordTransition.run(
    job.id,
    status,
    `fit ${score.toFixed(2)}${adjustments.length ? ' (' + adjustments.join('; ') + ')' : ''}`,
  );

  return { score, status, data };
}

async function run({ limit = 10, concurrency = 6 } = {}) {
  const profile = loadProfile();
  const jobs = selectAnalyzed.all(limit);
  const results = { scored: 0, shortlisted: 0, failed: 0, errors: [] };

  const outcomes = await mapPool(
    jobs,
    concurrency,
    (job) => scoreOne(job, profile),
    (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`    ...${done}/${total}`);
    },
  );

  for (let i = 0; i < outcomes.length; i++) {
    const job = jobs[i];
    const o = outcomes[i];

    if (o.status === 'error') {
      // Row stays 'analyzed' so the next run retries it.
      results.failed++;
      results.errors.push({ id: job.id, message: o.error.message });
      continue;
    }

    results.scored++;
    if (o.value.status === 'scored_in') results.shortlisted++;
  }

  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const limit = Number(args.find((a) => /^\d+$/.test(a))) || 10;
  const cFlag = args.indexOf('--concurrency');
  const concurrency = cFlag !== -1 ? Number(args[cFlag + 1]) : 6;

  run({ limit, concurrency })
    .then(({ scored, shortlisted, failed }) => {
      console.log(`\nScored ${scored}, shortlisted ${shortlisted}, failed ${failed}.`);
      if (failed > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Filter run failed:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { run, scoreOne, SCHEMA, SHORTLIST_THRESHOLD };
