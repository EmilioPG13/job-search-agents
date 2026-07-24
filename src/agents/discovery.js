// Discovery agent — pulls postings from every registered source into the jobs
// table. Deliberately dumb: no judgment, no filtering, no model calls. Job
// boards break constantly, so keeping this isolated means a broken source
// can't take down the rest of the pipeline.
//
// Sources live in src/sources/ and each returns rows in one shared shape.
// Adding a board is a new file plus a line in src/sources/index.js.

const db = require('../db');
const sources = require('../sources');
const { detectSuspiciousInstructions } = require('../lib/promptSafety');
const { repairEncoding } = require('../lib/text');

// On conflict we refresh the source-derived fields but never touch pipeline
// state (status, scores, tailored output). That makes re-running Discovery a
// safe "refresh from source", which is also how parser fixes get backfilled.
const upsert = db.prepare(`
  INSERT INTO jobs (
    source, source_id, url, title, company, location, remote,
    salary_min, salary_max, posted_at, tags, raw_description,
    flagged_injection, flagged_injection_notes
  ) VALUES (
    @source, @source_id, @url, @title, @company, @location, @remote,
    @salary_min, @salary_max, @posted_at, @tags, @raw_description,
    @flagged_injection, @flagged_injection_notes
  )
  ON CONFLICT (source, source_id) DO UPDATE SET
    title = excluded.title,
    company = excluded.company,
    location = excluded.location,
    tags = excluded.tags,
    raw_description = excluded.raw_description,
    flagged_injection = excluded.flagged_injection,
    flagged_injection_notes = excluded.flagged_injection_notes
`);

function store(job) {
  const check = detectSuspiciousInstructions(job.raw_description);
  upsert.run({
    source: job.source,
    source_id: job.source_id,
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.location ?? null,
    remote: job.remote ?? 1,
    salary_min: job.salary_min ?? null,
    salary_max: job.salary_max ?? null,
    posted_at: job.posted_at ?? null,
    tags: JSON.stringify(job.tags || []),
    raw_description: job.raw_description,
    flagged_injection: check.flagged ? 1 : 0,
    flagged_injection_notes: check.flagged ? JSON.stringify(check.matches) : null,
  });
}

const countRows = db.prepare('SELECT COUNT(*) AS c FROM jobs');

async function run({ only } = {}) {
  const selected = only ? sources.filter((s) => s.name === only) : sources;
  if (selected.length === 0) throw new Error(`No such source: ${only}`);

  const results = [];

  for (const source of selected) {
    // `changes` counts updated rows too, so it can't tell a new posting from a
    // refresh. Compare row counts instead.
    const before = countRows.get().c;
    try {
      const jobs = await source.fetchJobs();
      for (const job of jobs) store(job);
      results.push({
        source: source.name,
        fetched: jobs.length,
        inserted: countRows.get().c - before,
      });
    } catch (err) {
      // One dead board must not stop the others.
      results.push({ source: source.name, error: err.message });
    }
  }

  return results;
}

// A source's feed is a rolling window, so a posting that has aged out can never
// be refreshed by re-fetching. This repairs stored rows in place instead —
// needed whenever a parsing fix lands after data was already saved.
const repairStmt = db.prepare(`
  UPDATE jobs SET title = ?, company = ?, location = ?, raw_description = ?
  WHERE id = ?
`);

function repairStoredRows() {
  const rows = db.prepare('SELECT id, title, company, location, raw_description FROM jobs').all();
  let repaired = 0;

  for (const row of rows) {
    const fixed = {
      title: repairEncoding(row.title),
      company: repairEncoding(row.company),
      location: repairEncoding(row.location),
      raw_description: repairEncoding(row.raw_description),
    };
    if (!Object.keys(fixed).some((k) => fixed[k] !== row[k])) continue;
    repairStmt.run(fixed.title, fixed.company, fixed.location, fixed.raw_description, row.id);
    repaired++;
  }

  return { examined: rows.length, repaired };
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--repair-encoding')) {
    const { examined, repaired } = repairStoredRows();
    console.log(`Checked ${examined} stored rows, repaired ${repaired}.`);
  } else {
    const onlyFlag = args.indexOf('--source');
    const only = onlyFlag !== -1 ? args[onlyFlag + 1] : undefined;

    run({ only })
      .then((results) => {
        for (const r of results) {
          if (r.error) console.error(`  ${r.source}: FAILED — ${r.error}`);
          else console.log(`  ${r.source}: fetched ${r.fetched}, ${r.inserted} new`);
        }
        const total = results.reduce((n, r) => n + (r.inserted || 0), 0);
        console.log(`\n${total} new postings.`);
        if (results.every((r) => r.error)) process.exitCode = 1;
      })
      .catch((err) => {
        console.error('Discovery run failed:', err.message);
        process.exitCode = 1;
      });
  }
}

module.exports = { run, repairStoredRows };
