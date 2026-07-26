// Verify agent — checks a tailored CV before a human ever sees it.
//
//   npm run verify            all tailored jobs
//   npm run verify -- 407     one job
//
// This is the most important agent in the project. A tailored CV that invents
// an employer, a date, or a metric is worse than no CV at all: it goes out
// under your name, and you find out in an interview.
//
// Three design decisions, each the result of something that actually went
// wrong earlier in this project:
//
//   A separate model call, with no memory of the tailoring. A model asked
//   whether it just fabricated something is a poor witness.
//
//   The strong tier, not the fast one. This is the judgment call the whole
//   pipeline protects; it is not the place to save a fraction of a cent.
//
//   Every claim must be quoted verbatim and is checked against the source
//   before it is believed. The Analysis agent's 8B model asserted findings it
//   had copied out of the prompt's own wording, and the same guard catches it
//   here — in both directions, since a *missed* fabrication is the dangerous
//   failure.

const db = require('../db');
const { askForJson, MODELS } = require('../lib/llm');
const { mapPool } = require('../lib/pool');
const { cvForPosting, detectLanguage, loadProfile } = require('../lib/cvSource');

const SYSTEM = `You audit a tailored CV against the candidate's real CV.

Your job is to catch anything in the tailored version that is not supported by
the real one: employers, job titles, dates, technologies, qualifications,
metrics, or achievements that were invented or inflated.

Rewording is fine. Emphasis is fine. Reordering, dropping, and rephrasing to
match a job posting are all fine. Introducing facts is not.

For every problem you report, quote the exact text from the tailored CV. The
quote is checked against the document, so a paraphrase will be discarded and
the problem will be missed. Quote verbatim or do not report it.

If the tailored CV is faithful, say so plainly. Do not invent problems to
appear thorough.`;

const SCHEMA = {
  type: 'object',
  properties: {
    passed: {
      type: 'boolean',
      description: 'True only if there are no unsupported claims.',
    },
    unsupported_claims: {
      type: 'array',
      description: 'Statements in the tailored CV not supported by the real CV.',
      items: {
        type: 'object',
        properties: {
          quote: {
            type: 'string',
            description: 'Exact text from the tailored CV, copied verbatim.',
          },
          problem: {
            type: 'string',
            description: 'What is wrong: invented employer, inflated metric, unsupported skill, etc.',
          },
          severity: {
            type: 'string',
            enum: ['critical', 'moderate', 'minor'],
            description: 'critical = a factual claim about history or credentials.',
          },
        },
        required: ['quote', 'problem', 'severity'],
        additionalProperties: false,
      },
    },
    echoed_posting_instructions: {
      type: ['string', 'null'],
      description:
        'Verbatim text that appears to have been copied from the job posting into the CV, such as a codeword or tracking tag. Null if none.',
    },
    addresses_requirements: {
      type: 'boolean',
      description: 'Does the tailored CV engage with what the posting asked for.',
    },
    summary: {
      type: 'string',
      description: 'Two sentences a human can act on.',
    },
  },
  required: [
    'passed',
    'unsupported_claims',
    'echoed_posting_instructions',
    'addresses_requirements',
    'summary',
  ],
  additionalProperties: false,
};

const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Did any text the posting aimed at an AI reader end up in the CV?
 *
 * Checked in code rather than asked of the model. The verifier is given the
 * real CV and the tailored one, but not the posting, so it has no way to know
 * what a codeword would even look like — in testing it flagged the job title
 * instead and the planted token went straight past it.
 *
 * The Discovery agent already stored the exact matched strings on the row, so
 * this is a substring check against known-bad text, not a judgment call.
 */
function findEchoedInjection(tailoredCv, flaggedNotes) {
  if (!flaggedNotes) return null;

  let matches;
  try {
    matches = JSON.parse(flaggedNotes);
  } catch {
    return null;
  }
  if (!Array.isArray(matches)) return null;

  const haystack = normalize(tailoredCv);

  for (const match of matches) {
    const needle = normalize(match);
    // Distinctive tokens only — a short generic phrase would match by chance.
    if (needle.length >= 10 && haystack.includes(needle)) return match;
  }
  return null;
}

/**
 * Discard claims whose quote isn't actually in the tailored CV.
 *
 * A fabricated *complaint* is noise, but the failure that matters is the
 * opposite one — so discarded claims are counted and surfaced rather than
 * quietly dropped. A verifier reporting many unquotable problems is itself
 * a signal that something is wrong.
 */
function keepGroundedClaims(data, tailoredCv) {
  const haystack = normalize(tailoredCv);
  const kept = [];
  let discarded = 0;

  for (const claim of data.unsupported_claims || []) {
    const quote = normalize(claim.quote);
    if (quote.length >= 12 && haystack.includes(quote)) kept.push(claim);
    else discarded++;
  }

  data.unsupported_claims = kept;

  // The same guard has to apply here. This field asks for verbatim text, but
  // the model reliably writes a summary into it instead ("The tailored CV is
  // faithful to the real CV..."), and since any non-empty value counted as
  // evidence, a clean CV failed verification. Checking the quote is present
  // makes the field mean what it claims to mean.
  const echoed = normalize(data.echoed_posting_instructions);
  if (echoed && !(echoed.length >= 12 && haystack.includes(echoed))) {
    data.echoed_posting_instructions = null;
    discarded++;
  }

  // The model's own `passed` is advisory; the claims decide. A model that
  // lists three critical problems and then says "passed: true" must not pass.
  //
  // Only critical claims block. Severity levels are pointless if every one of
  // them fails the document: a fabricated employer and a CV retitled from
  // "Junior Software Developer" to "Junior Full-Stack Developer" are not the
  // same problem, and treating them alike sends every honest CV back for
  // another pointless tailoring round.
  //
  // Nothing is hidden — moderate and minor claims are stored and shown at
  // review. The human is still the gate; this only decides what is worth
  // automatically rejecting before a human looks.
  const bySeverity = (s) => kept.filter((c) => c.severity === s).length;
  const critical = bySeverity('critical');

  data.passed = critical === 0 && !data.echoed_posting_instructions;
  data.critical_count = critical;
  data.moderate_count = bySeverity('moderate');
  data.minor_count = bySeverity('minor');
  data.discarded_claims = discarded;

  return { kept: kept.length, critical, discarded };
}

// raw_description is selected so the ground-truth CV can be chosen in the same
// language the tailoring used.
const selectTailored = db.prepare(`
  SELECT id, title, company, tailored_resume, extracted_requirements,
         flagged_injection_notes, raw_description, status
  FROM jobs
  WHERE status = 'tailored'
  ORDER BY fit_score DESC
  LIMIT ?
`);

const selectOne = db.prepare(`
  SELECT id, title, company, tailored_resume, extracted_requirements,
         flagged_injection_notes, raw_description, status
  FROM jobs WHERE id = ?
`);

const saveVerification = db.prepare(`
  UPDATE jobs
  SET verification_passed = ?, verification_report = ?, status = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, 'tailored', ?, ?)
`);

/**
 * @param {object} job
 * @param {string|object} [source]  Ground-truth CV text, or a profile to pick
 *   one from. Passing text directly is what the self-test does; in normal use
 *   the language is chosen from the posting so the audit compares like with
 *   like. Auditing a Spanish CV against the English original would report
 *   every line as unsupported.
 */
async function verifyOne(job, source) {
  if (!job.tailored_resume) {
    throw new Error('no tailored CV stored for this job');
  }

  let groundTruth;
  let language = 'en';

  if (typeof source === 'string') {
    groundTruth = source;
    language = detectLanguage(source);
  } else {
    const cv = cvForPosting(job.raw_description || job.tailored_resume, { profile: source });
    groundTruth = cv.text;
    language = cv.language;
  }

  const requirements = job.extracted_requirements
    ? JSON.parse(job.extracted_requirements)
    : {};

  const { data } = await askForJson({
    system: SYSTEM,
    task:
      `Audit the TAILORED CV against the REAL CV.\n\n` +
      `=== REAL CV (ground truth — nothing outside this is supported) ===\n${groundTruth}\n\n` +
      `=== TAILORED CV (the document under audit) ===\n${job.tailored_resume}\n\n` +
      `=== WHAT THE POSTING ASKED FOR ===\n${JSON.stringify(requirements, null, 2)}`,
    schema: SCHEMA,
    model: MODELS.STRONG,
    maxTokens: 6000,
  });

  data.verified_against_language = language;

  const counts = keepGroundedClaims(data, job.tailored_resume);

  // Deterministic check wins over the model's opinion: if a token the posting
  // aimed at an AI reader is sitting in the CV, that is a fact, not a view.
  const echoed = findEchoedInjection(job.tailored_resume, job.flagged_injection_notes);
  if (echoed) {
    data.echoed_posting_instructions = echoed;
    data.echo_detected_by = 'rule';
    data.passed = false;
  }

  // Failure sends it back for another tailoring pass rather than forward.
  const status = data.passed ? 'verified' : 'scored_in';

  saveVerification.run(data.passed ? 1 : 0, JSON.stringify(data), status, job.id);
  recordTransition.run(
    job.id,
    status,
    data.passed
      ? 'verification passed'
      : `verification failed — ${counts.kept} unsupported claim(s), ${counts.critical} critical`,
  );

  return { data, counts };
}

async function run({ ids = [], limit = 10, concurrency = 3 } = {}) {
  const profile = loadProfile();

  const jobs = ids.length
    ? ids.map((id) => selectOne.get(id)).filter(Boolean)
    : selectTailored.all(limit);

  if (jobs.length === 0) {
    console.log('Nothing to verify. Tailor a job first: npm run tailor -- --top 1');
    return { verified: 0, failed: 0, errored: 0 };
  }

  const results = { verified: 0, failed: 0, errored: 0 };

  const outcomes = await mapPool(jobs, concurrency, (job) => verifyOne(job, profile));

  for (let i = 0; i < outcomes.length; i++) {
    const job = jobs[i];
    const o = outcomes[i];

    if (o.status === 'error') {
      results.errored++;
      console.log(`  #${job.id} ERROR — ${o.error.message}`);
      continue;
    }

    const { data, counts } = o.value;
    if (data.passed) {
      results.verified++;
      const noted = data.moderate_count + data.minor_count;
      console.log(
        `  #${job.id} PASSED   ${job.title.slice(0, 46)}` +
          (noted ? `   (${noted} non-blocking note(s) for review)` : ''),
      );
    } else {
      results.failed++;
      console.log(`  #${job.id} FAILED   ${job.title.slice(0, 46)}`);
      for (const c of data.unsupported_claims.slice(0, 4)) {
        // Marked so it's clear which claims actually caused the failure.
        console.log(`            [${c.severity}] "${c.quote.slice(0, 70)}"`);
        console.log(`                       ${c.problem.slice(0, 80)}`);
      }
      if (data.echoed_posting_instructions) {
        console.log(`            [posting text echoed] "${data.echoed_posting_instructions.slice(0, 70)}"`);
      }
    }
    if (counts.discarded > 0) {
      console.log(`            (${counts.discarded} unquotable claim(s) discarded)`);
    }
  }

  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

  run({ ids })
    .then(({ verified, failed, errored }) => {
      console.log(`\nPassed ${verified}, failed ${failed}, errored ${errored}.`);
      if (verified > 0) console.log('Next: npm run review');
      if (errored > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { run, verifyOne, keepGroundedClaims, SCHEMA };
