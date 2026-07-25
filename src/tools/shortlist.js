// Your shortlist. Everything the pipeline has scored, best first.
//
//   npm run shortlist            top 15 shortlisted jobs
//   npm run shortlist -- --all   include ones scored below the threshold
//   npm run shortlist -- 30      show more

const db = require('../db');
const { SHORTLIST_THRESHOLD } = require('../agents/filter');

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const limit = Number(args.find((a) => /^\d+$/.test(a))) || 15;

const rows = db
  .prepare(
    `SELECT id, title, company, location, url, source, posted_at,
            fit_score, fit_reasoning, status
     FROM jobs
     WHERE fit_score IS NOT NULL ${showAll ? '' : "AND status = 'scored_in'"}
     ORDER BY fit_score DESC
     LIMIT ?`,
  )
  .all(limit);

const ageOf = (posted) => {
  if (!posted) return null;
  const days = Math.floor((Date.now() - new Date(posted).getTime()) / 86_400_000);
  return Number.isFinite(days) ? days : null;
};

if (rows.length === 0) {
  console.log('Nothing scored yet. Run: npm run discover && npm run prefilter && npm run analyze && npm run score');
  process.exit(0);
}

const counts = db
  .prepare("SELECT status, COUNT(*) c FROM jobs GROUP BY status")
  .all()
  .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

console.log(`\n  YOUR SHORTLIST  (fit >= ${SHORTLIST_THRESHOLD})\n`);

for (const r of rows) {
  const analysis = JSON.parse(r.fit_reasoning || '{}');
  const bar = '█'.repeat(Math.round(r.fit_score * 10)).padEnd(10, '·');

  const age = ageOf(r.posted_at);
  // Age is shown because a high score on a four-month-old posting usually
  // means it's already filled, however well it matches.
  const ageLabel = age === null ? '' : age <= 14 ? `  ${age}d ago` : `  ${age}d ago ⚠`;

  console.log(`  ${bar}  ${r.fit_score.toFixed(2)}  ${r.title.slice(0, 58)}${ageLabel}`);
  console.log(`              ${r.company || '?'}${r.location ? ' — ' + r.location : ''}  [${r.source}]`);
  if (analysis.reasoning) {
    console.log(`              ${analysis.reasoning.slice(0, 150)}`);
  }
  if ((analysis.gaps || []).length) {
    console.log(`              gaps: ${analysis.gaps.slice(0, 3).join('; ').slice(0, 120)}`);
  }
  if ((analysis.rule_adjustments || []).length) {
    console.log(`              adjusted: ${analysis.rule_adjustments.join('; ')}`);
  }
  console.log(`              ${r.url}`);
  console.log();
}

console.log('  ── pipeline ──');
const order = ['discovered', 'rules_rejected', 'analyzed', 'scored_in', 'scored_out'];
for (const s of order) {
  if (counts[s]) console.log(`    ${String(counts[s]).padStart(4)}  ${s}`);
}
console.log();
