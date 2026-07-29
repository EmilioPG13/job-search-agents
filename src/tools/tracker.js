// What is waiting on you, and what is waiting on them.
//
//   npm run tracker
//
// Two lists. Approved but not sent is work you still owe; applied is work
// already out, aged so a silence you should chase is visible as a number
// rather than as a feeling.

const db = require('../db');

const approved = db.prepare(`
  SELECT id, title, company, url, fit_score, approved_at
  FROM jobs WHERE status = 'approved'
  ORDER BY fit_score DESC, id
`);

const applied = db.prepare(`
  SELECT id, title, company, url, fit_score, applied_at, application_method, notes
  FROM jobs WHERE status = 'applied'
  ORDER BY applied_at DESC
`);

const verified = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'verified'`);
const shortlisted = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'scored_in'`);

// SQLite writes datetime('now') in UTC; comparing it against a local clock
// reads hours off, which at these thresholds would mis-age a fresh application.
const daysSince = (utc) => {
  if (!utc) return null;
  const then = Date.parse(utc.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
};

const ago = (n) => (n === null ? '' : n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`);

function run() {
  const toSend = approved.all();
  const sent = applied.all();

  console.log('');

  if (toSend.length) {
    console.log(`  APPROVED, NOT YET SENT  (${toSend.length})`);
    for (const j of toSend) {
      console.log(`    #${String(j.id).padEnd(5)} ${String(j.fit_score).padEnd(5)} ${String(j.company).slice(0, 26).padEnd(26)} ${j.title.slice(0, 42)}`);
      console.log(`           approved ${ago(daysSince(j.approved_at))} · npm run export -- ${j.id}`);
    }
    console.log('');
  }

  if (sent.length) {
    console.log(`  APPLIED  (${sent.length})`);
    for (const j of sent) {
      const d = daysSince(j.applied_at);
      // Two weeks of silence is the point where a follow-up stops being eager
      // and starts being normal.
      const chase = d !== null && d >= 14 ? '  ← worth a follow-up' : '';
      console.log(`    #${String(j.id).padEnd(5)} ${String(j.company).slice(0, 26).padEnd(26)} ${j.title.slice(0, 40)}`);
      console.log(`           sent ${ago(d)} via ${j.application_method || '?'}${chase}`);
      if (j.notes) console.log(`           note: ${j.notes}`);
    }
    console.log('');
  }

  if (!toSend.length && !sent.length) {
    console.log('  Nothing approved and nothing applied to yet.\n');
  }

  const waiting = verified.get().n;
  const pool = shortlisted.get().n;
  console.log(`  ${waiting} awaiting your review (npm run review) · ${pool} shortlisted, not yet tailored\n`);

  return { approved: toSend.length, applied: sent.length, verified: waiting };
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };
