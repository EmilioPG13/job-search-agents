// Tailor agent — sends your CV and a job posting to the CV Tailor service and
// stores what comes back.
//
//   npm run tailor -- 407        one job by id
//   npm run tailor -- --top 3    the three highest-scoring untailored jobs
//
// On demand rather than batch, deliberately. Tailoring is slow, CV Tailor
// sleeps on Render's free tier, and you only tailor for jobs you actually
// intend to apply to — running it over all 68 shortlisted jobs would burn time
// on applications you'll never send.

const db = require('../db');
const { tailor, openSession, hasSavedLogin } = require('../lib/cvTailor');
const { cvForPosting, loadProfile } = require('../lib/cvSource');

const selectById = db.prepare(`
  SELECT id, title, company, url, raw_description, fit_score, status
  FROM jobs WHERE id = ?
`);

const selectTopUntailored = db.prepare(`
  SELECT id, title, company, url, raw_description, fit_score, status
  FROM jobs
  WHERE status = 'scored_in'
  ORDER BY fit_score DESC
  LIMIT ?
`);

const saveTailored = db.prepare(`
  UPDATE jobs
  SET tailored_resume = ?, cover_letter = ?, status = 'tailored',
      updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, ?, 'tailored', ?)
`);

/**
 * The service returns prose sections rather than a fixed schema, and the exact
 * field names are whatever the deployed version sends. Rather than guessing,
 * try the likely keys and fall back to splitting the combined text on the
 * section headings its prompt produces.
 */
function extractParts(response) {
  const pick = (...keys) => keys.map((k) => response[k]).find((v) => typeof v === 'string' && v.trim());

  const cv = pick('tailoredCv', 'tailored_cv', 'cv', 'resume', 'tailoredResume');
  const letter = pick('coverLetter', 'cover_letter', 'letter');
  if (cv) return { tailoredCv: cv, coverLetter: letter || null };

  // Combined blob: split on the headings the service's prompt asks for.
  const blob = pick('result', 'text', 'output', 'content', 'raw');
  if (!blob) return { tailoredCv: null, coverLetter: null };

  const split = blob.split(/\n\s*#*\s*COVER\s+LETTER\s*#*\s*\n/i);
  return {
    tailoredCv: split[0].replace(/^\s*#*\s*TAILORED\s+CV\s*#*\s*\n/i, '').trim(),
    coverLetter: split[1] ? split[1].trim() : null,
  };
}

/**
 * Did the service stop mid-thought?
 *
 * The API now reports this itself via a `truncated` boolean, which is
 * authoritative — it comes from the model's own finish_reason. This heuristic
 * remains as a fallback for older deployments that don't send the field, and
 * for the case the flag says false but the text plainly isn't finished.
 *
 * It was written against a real failure: a CV ending "Relevant coursework: D"
 * with no cover letter, because the tailoring model hit its output limit.
 * Storing that would put a half-finished document in front of a human as
 * though it were complete.
 */
function looksTruncated(text) {
  const tail = text.trimEnd().slice(-80);
  // A finished document ends on punctuation, a closing bracket, or a complete
  // word on its own line — not mid-word or mid-clause.
  if (/[.!?)\]"'”]$/.test(tail)) return false;

  const lastLine = tail.split('\n').pop().trim();
  // A short trailing fragment ("Relevant coursework: D") is the tell. A long
  // final line without punctuation is more likely a heading or a skills list.
  return lastLine.length > 0 && lastLine.length < 40 && /[:,]|\s\w{1,2}$/.test(lastLine);
}

async function tailorOne(job, profile, token) {
  // Language is decided per posting, not per run: a batch can mix a Spanish
  // Get on Board role with an English Hacker News one.
  const cv = cvForPosting(job.raw_description, { profile });

  const response = await tailor({
    cv: cv.text,
    jobDescription: job.raw_description,
    token,
    language: cv.language,
  });

  const { tailoredCv, coverLetter } = extractParts(response);

  // The service's own flag wins when present: it reflects the model's
  // finish_reason rather than guessing from how the text reads.
  const truncated =
    typeof response.truncated === 'boolean'
      ? response.truncated
      : Boolean(tailoredCv && looksTruncated(tailoredCv));

  if (truncated) {
    const err = new Error(
      `The service reported a truncated result${
        tailoredCv ? ` — ends "...${tailoredCv.slice(-50).trim()}"` : ''
      }.\n      Raising max_tokens on CV Tailor's /api/tailor route is the fix.`,
    );
    err.code = 'TRUNCATED';
    throw err;
  }

  if (!tailoredCv) {
    const err = new Error(
      `Could not find the tailored CV in the response. Fields returned: ${Object.keys(response).join(', ')}`,
    );
    err.response = response;
    throw err;
  }

  saveTailored.run(tailoredCv, coverLetter, job.id);
  recordTransition.run(job.id, job.status, `tailored via CV Tailor service (${cv.language})`);

  return { tailoredCv, coverLetter, response, language: cv.language };
}

async function run({ ids = [], top = 0 } = {}) {
  if (!hasSavedLogin()) {
    throw new Error('Not signed in to CV Tailor. Run: npm run cvtailor:login');
  }

  const profile = loadProfile();

  const jobs = ids.length
    ? ids.map((id) => selectById.get(id)).filter(Boolean)
    : selectTopUntailored.all(top || 1);

  if (jobs.length === 0) {
    console.log('No matching jobs. Shortlisted jobs are listed by: npm run shortlist');
    return { tailored: 0, failed: 0 };
  }

  // One browser for the run, one token per job. A tailoring call outlives a
  // Clerk token, so a token minted before the loop is already dead by the
  // second job.
  const session = await openSession();
  const results = { tailored: 0, failed: 0 };

  try {
    for (const job of jobs) {
      process.stdout.write(`  #${job.id} ${job.title.slice(0, 50)} … `);
      try {
        const token = await session.mintToken();
        const { coverLetter, language } = await tailorOne(job, profile, token);
        results.tailored++;
        console.log(`done [${language}]${coverLetter ? ' (+ cover letter)' : ''}`);
      } catch (err) {
        results.failed++;
        console.log(`FAILED\n      ${err.message}`);
      }
    }
  } finally {
    await session.close();
  }

  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const topFlag = args.indexOf('--top');
  const top = topFlag !== -1 ? Number(args[topFlag + 1]) : 0;
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

  run({ ids: top ? [] : ids, top })
    .then(({ tailored, failed }) => {
      console.log(`\nTailored ${tailored}, failed ${failed}.`);
      if (tailored > 0) console.log('Next: npm run verify');
      if (failed > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { run, tailorOne, extractParts };
