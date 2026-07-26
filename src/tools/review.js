// The human approval gate.
//
//   npm run review
//
// Shows each verified job in turn — the posting, the fit reasoning, the
// tailored CV, and the verification report — and waits for you to approve,
// reject, or skip.
//
// This is a boundary in code, not an instruction in a prompt. `approved_at` is
// written in exactly one place: the branch below that runs after a keystroke
// from a person. No agent sets it, and anything downstream selects on
// `status = 'approved'`, so there is no path from "the model thought it was
// fine" to "this went out under your name".

const readline = require('readline');
const db = require('../db');

const selectPending = db.prepare(`
  SELECT id, title, company, location, url, source, fit_score, fit_reasoning,
         tailored_resume, cover_letter, verification_report, posted_at
  FROM jobs
  WHERE status = 'verified'
  ORDER BY fit_score DESC
`);

const approve = db.prepare(`
  UPDATE jobs
  SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);

const reject = db.prepare(`
  UPDATE jobs
  SET status = 'rejected_by_user', rejection_reason = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, 'verified', ?, ?)
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const rule = (char = '─') => console.log('  ' + char.repeat(74));

function show(job, index, total) {
  const fit = JSON.parse(job.fit_reasoning || '{}');
  const check = JSON.parse(job.verification_report || '{}');

  console.log('\n');
  rule('━');
  console.log(`  [${index + 1}/${total}]  ${job.title}`);
  console.log(`  ${job.company || '?'}${job.location ? ' — ' + job.location : ''}   [${job.source}]`);
  console.log(`  ${job.url}`);
  rule();

  console.log(`  FIT ${job.fit_score}`);
  if (fit.reasoning) console.log(`  ${fit.reasoning.slice(0, 300)}`);
  if ((fit.gaps || []).length) console.log(`  gaps: ${fit.gaps.slice(0, 4).join('; ').slice(0, 200)}`);

  rule();
  console.log('  VERIFICATION');
  if (check.summary) console.log(`  ${check.summary.slice(0, 300)}`);
  const claims = check.unsupported_claims || [];
  if (claims.length === 0) {
    console.log('  No unsupported claims found.');
  } else {
    console.log(`  ${claims.length} unsupported claim(s):`);
    for (const c of claims) {
      console.log(`    [${c.severity}] "${c.quote.slice(0, 66)}"`);
      console.log(`              ${c.problem.slice(0, 70)}`);
    }
  }
  if (check.echoed_posting_instructions) {
    console.log(`  Posting text echoed into the CV: "${check.echoed_posting_instructions.slice(0, 60)}"`);
  }

  rule();
  console.log('  TAILORED CV');
  const cv = (job.tailored_resume || '').split('\n');
  cv.slice(0, 28).forEach((line) => console.log(`  ${line}`));
  if (cv.length > 28) console.log(`  … ${cv.length - 28} more lines (full text is in the database)`);

  if (job.cover_letter) {
    rule();
    console.log('  COVER LETTER (first lines)');
    job.cover_letter.split('\n').slice(0, 8).forEach((line) => console.log(`  ${line}`));
  }
  rule('━');
}

(async () => {
  const jobs = selectPending.all();

  if (jobs.length === 0) {
    console.log('\n  Nothing awaiting review.');
    console.log('  Tailor and verify a job first:');
    console.log('    npm run tailor -- --top 1 && npm run verify\n');
    rl.close();
    return;
  }

  console.log(`\n  ${jobs.length} job(s) awaiting your decision.`);

  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    show(job, i, jobs.length);

    let answer = '';
    while (!['a', 'r', 's', 'q'].includes(answer)) {
      answer = (await ask('\n  [a]pprove  [r]eject  [s]kip  [q]uit : ')).trim().toLowerCase();
    }

    if (answer === 'q') {
      console.log('\n  Stopped. Remaining jobs keep their current status.\n');
      break;
    }

    if (answer === 'a') {
      approve.run(job.id);
      recordTransition.run(job.id, 'approved', 'approved by human review');
      approved++;
      console.log(`  Approved. Export with: npm run export -- ${job.id}`);
    } else if (answer === 'r') {
      const why = (await ask('  Why? (optional, helps tune the filters) : ')).trim();
      reject.run(why || null, job.id);
      recordTransition.run(job.id, 'rejected_by_user', why || 'rejected by human review');
      rejected++;
    } else {
      skipped++;
    }
  }

  console.log(`\n  Approved ${approved}, rejected ${rejected}, skipped ${skipped}.\n`);
  rl.close();
})();
