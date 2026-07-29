// Record that you actually sent an application.
//
//   npm run applied -- 404
//   npm run applied -- 404 --note "referred by Ana"
//
// Separate from `export` on purpose: exporting produces the files, and sending
// them is something only you can confirm. Nothing here can run on its own.

const db = require('../db');

const selectJob = db.prepare(`SELECT id, title, company, status, applied_at FROM jobs WHERE id = ?`);

const markApplied = db.prepare(`
  UPDATE jobs
  SET status = 'applied',
      applied_at = datetime('now'),
      application_method = ?,
      notes = COALESCE(?, notes),
      updated_at = datetime('now')
  WHERE id = ?
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  VALUES (?, ?, 'applied', ?)
`);

function run({ id, method = 'web', note = null } = {}) {
  const job = selectJob.get(id);

  if (!job) {
    throw new Error(`No job #${id}.`);
  }
  if (job.status === 'applied') {
    throw new Error(`#${id} is already recorded as applied on ${job.applied_at}.`);
  }
  if (job.status !== 'approved') {
    throw new Error(
      `#${id} is "${job.status}", not "approved". Only a job you approved can be marked applied.`,
    );
  }

  recordTransition.run(id, job.status, `applied via ${method}`);
  markApplied.run(method, note, id);

  return selectJob.get(id);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const id = Number(args.find((a) => /^\d+$/.test(a)));
  const methodFlag = args.indexOf('--method');
  const noteFlag = args.indexOf('--note');

  if (!id) {
    console.log('\n  Usage: npm run applied -- <job id> [--method web|email] [--note "..."]\n');
    process.exitCode = 1;
  } else {
    try {
      const job = run({
        id,
        method: methodFlag !== -1 ? args[methodFlag + 1] : 'web',
        note: noteFlag !== -1 ? args[noteFlag + 1] : null,
      });
      console.log(`\n  #${job.id} ${job.title.slice(0, 56)}`);
      console.log(`  ${job.company} — recorded as applied ${job.applied_at}.`);
      console.log('\n  See everything outstanding: npm run tracker\n');
    } catch (err) {
      console.error(`\n  ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { run };
