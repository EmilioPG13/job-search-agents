const db = require('../db');
const { detectSuspiciousInstructions } = require('../lib/promptSafety');

const REMOTEOK_URL = 'https://remoteok.com/api';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';

// RemoteOK serves double-encoded text: UTF-8 bytes re-encoded as if they were
// Latin-1, so "Coordenação" arrives as "CoordenaÃ§Ã£o". Re-decoding recovers
// the original. Only applied when the tell-tale byte pattern is present, and
// only kept if the result is valid UTF-8 — so correctly-encoded text is never
// touched.
// Written with explicit escapes, not literal characters: the pattern is a
// UTF-8 lead byte (U+00C2–U+00C3) followed by a continuation byte
// (U+0080–U+00BF). As literals those bytes are invisible or ambiguous in an
// editor, and an earlier version of this regex silently missed the
// non-breaking-space case ("Appel Ã  candidature").
const MOJIBAKE = /[Â-Ã][-¿]/;

function repairEncoding(text) {
  if (typeof text !== 'string' || !MOJIBAKE.test(text)) {
    return text;
  }
  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  return repaired.includes('�') ? text : repaired;
}

async function fetchListings() {
  const res = await fetch(REMOTEOK_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`RemoteOK request failed: ${res.status}`);
  const data = await res.json();
  return data.slice(1); // index 0 is a legal notice, not a job
}

// On conflict we refresh `tags` rather than doing nothing: tags were added to
// the schema after the first rows were already stored, so re-running discovery
// backfills them without disturbing a job's pipeline state.
const upsert = db.prepare(`
  INSERT INTO jobs (
    source, source_id, url, title, company, location, remote,
    salary_min, salary_max, posted_at, tags, raw_description,
    flagged_injection, flagged_injection_notes
  ) VALUES (
    'remoteok', @source_id, @url, @title, @company, @location, 1,
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

function run() {
  return fetchListings().then((listings) => {
    // `result.changes` counts updated rows too, so it can't distinguish a new
    // posting from a tag backfill. Compare row counts instead.
    const before = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
    for (const job of listings) {
      const description = repairEncoding(job.description);
      const check = detectSuspiciousInstructions(description);
      upsert.run({
        source_id: job.slug,
        url: job.url,
        title: repairEncoding(job.position),
        company: repairEncoding(job.company),
        location: repairEncoding(job.location) || null,
        salary_min: job.salary_min || null,
        salary_max: job.salary_max || null,
        posted_at: job.date || null,
        tags: JSON.stringify(job.tags || []),
        raw_description: description,
        flagged_injection: check.flagged ? 1 : 0,
        flagged_injection_notes: check.flagged ? JSON.stringify(check.matches) : null,
      });
    }
    const after = db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
    return { fetched: listings.length, inserted: after - before };
  });
}

// RemoteOK's feed is a rolling window of ~100 postings, so a row that has aged
// out can never be refreshed by re-fetching. This repairs stored rows in place
// instead — needed whenever a parsing fix lands after data was already saved.
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
    const changed = Object.keys(fixed).some((k) => fixed[k] !== row[k]);
    if (!changed) continue;
    repairStmt.run(fixed.title, fixed.company, fixed.location, fixed.raw_description, row.id);
    repaired++;
  }

  return { examined: rows.length, repaired };
}

if (require.main === module && process.argv.includes('--repair-encoding')) {
  const { examined, repaired } = repairStoredRows();
  console.log(`Checked ${examined} stored rows, repaired ${repaired}.`);
} else if (require.main === module) {
  run()
    .then(({ fetched, inserted }) => {
      console.log(`Fetched ${fetched} listings, inserted ${inserted} new.`);
    })
    .catch((err) => {
      console.error('Discovery run failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run, repairStoredRows, repairEncoding };
