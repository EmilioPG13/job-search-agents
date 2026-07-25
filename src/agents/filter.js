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
  SELECT id, title, company, location, source, extracted_requirements
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

async function scoreOne(job, profile) {
  const requirements = JSON.parse(job.extracted_requirements);
  const t = profile.targeting;

  const criteria = [
    `Target roles: ${t.target_roles.join(', ')}`,
    `Experience level: ${t.seniority}`,
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
  const score = Math.max(0, Math.min(1, Number(data.fit_score) || 0));
  const status = score >= SHORTLIST_THRESHOLD ? 'scored_in' : 'scored_out';

  saveScore.run(score, JSON.stringify(data), status, job.id);
  recordTransition.run(job.id, status, `fit ${score.toFixed(2)} — ${data.verdict}`);

  return { score, status, data };
}

async function run({ limit = 10 } = {}) {
  const profile = loadProfile();
  const jobs = selectAnalyzed.all(limit);
  const results = { scored: 0, shortlisted: 0, failed: 0, errors: [] };

  for (const job of jobs) {
    try {
      const { score, status, data } = await scoreOne(job, profile);
      results.scored++;
      if (status === 'scored_in') results.shortlisted++;
      const mark = status === 'scored_in' ? '✓' : ' ';
      console.log(
        `  ${mark} ${score.toFixed(2)}  ${job.title.slice(0, 52).padEnd(52)} @ ${(job.company || '').slice(0, 22)}`,
      );
    } catch (err) {
      // Leave the row analyzed so the next run retries it.
      results.failed++;
      results.errors.push({ id: job.id, message: err.message });
      console.error(`    !!  #${job.id} failed: ${err.message}`);
    }
  }

  return results;
}

if (require.main === module) {
  const limit = Number(process.argv[2]) || 10;
  run({ limit })
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
