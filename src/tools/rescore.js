// Put already-scored postings back in the queue so they can be scored again.
//
//   node src/tools/rescore.js            # show what would be reset
//   node src/tools/rescore.js --apply    # do it, then run: npm run score -- 300
//
// Scores are a function of the profile, and the profile changes whenever the CV
// does. When TypeScript went from "absent from the CV" to "listed on it", every
// posting that asks for TypeScript became worth a different number — including
// ones already filed as `scored_out`, which is where the newly-qualifying jobs
// are hiding. Rescoring only the shortlist would miss exactly the rows that
// changed for the better.
//
// The filter agent only picks up rows in `analyzed`, so this moves them back.
// Nothing else is touched: `extracted_requirements` is preserved, so this costs
// one scoring call per row and no re-analysis. Defaults to a dry run because it
// discards the previous score of every row it touches.

const db = require('../db');

const SCORED = ['scored_in', 'scored_out'];

const countByStatus = db.prepare(`
  SELECT status, COUNT(*) n FROM jobs WHERE status IN (?, ?) GROUP BY status
`);

const reset = db.prepare(`
  UPDATE jobs SET status = 'analyzed', updated_at = datetime('now')
  WHERE status IN (?, ?)
`);

const recordTransition = db.prepare(`
  INSERT INTO job_status_history (job_id, from_status, to_status, reason)
  SELECT id, status, 'analyzed', ? FROM jobs WHERE status IN (?, ?)
`);

function run({ apply = false, reason = 'rescore — profile changed' } = {}) {
  const counts = countByStatus.all(...SCORED);
  const total = counts.reduce((sum, c) => sum + c.n, 0);

  for (const c of counts) console.log(`  ${String(c.n).padStart(5)}  ${c.status}`);
  console.log(`  ${String(total).padStart(5)}  total`);

  if (total === 0) {
    console.log('\nNothing to reset.');
    return { reset: 0 };
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to reset these rows.');
    return { reset: 0 };
  }

  // History first: the SELECT reads the old status, so it has to happen before
  // the UPDATE overwrites it.
  recordTransition.run(reason, ...SCORED);
  const { changes } = reset.run(...SCORED);

  console.log(`\nReset ${changes} rows to 'analyzed'.`);
  console.log(`Next: npm run score -- ${changes}`);
  return { reset: changes };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  try {
    run({ apply });
  } catch (err) {
    console.error('Rescore failed:', err.message);
    process.exitCode = 1;
  }
}

module.exports = { run };
