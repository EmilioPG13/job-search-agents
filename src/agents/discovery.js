const db = require('../db');
const { detectSuspiciousInstructions } = require('../lib/promptSafety');

const REMOTEOK_URL = 'https://remoteok.com/api';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';

async function fetchListings() {
  const res = await fetch(REMOTEOK_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`RemoteOK request failed: ${res.status}`);
  const data = await res.json();
  return data.slice(1); // index 0 is a legal notice, not a job
}

const upsert = db.prepare(`
  INSERT INTO jobs (
    source, source_id, url, title, company, location, remote,
    salary_min, salary_max, posted_at, raw_description,
    flagged_injection, flagged_injection_notes
  ) VALUES (
    'remoteok', @source_id, @url, @title, @company, @location, 1,
    @salary_min, @salary_max, @posted_at, @raw_description,
    @flagged_injection, @flagged_injection_notes
  )
  ON CONFLICT (source, source_id) DO NOTHING
`);

function run() {
  return fetchListings().then((listings) => {
    let inserted = 0;
    for (const job of listings) {
      const check = detectSuspiciousInstructions(job.description);
      const result = upsert.run({
        source_id: job.slug,
        url: job.url,
        title: job.position,
        company: job.company,
        location: job.location || null,
        salary_min: job.salary_min || null,
        salary_max: job.salary_max || null,
        posted_at: job.date || null,
        raw_description: job.description,
        flagged_injection: check.flagged ? 1 : 0,
        flagged_injection_notes: check.flagged ? JSON.stringify(check.matches) : null,
      });
      if (result.changes > 0) inserted++;
    }
    return { fetched: listings.length, inserted };
  });
}

if (require.main === module) {
  run()
    .then(({ fetched, inserted }) => {
      console.log(`Fetched ${fetched} listings, inserted ${inserted} new.`);
    })
    .catch((err) => {
      console.error('Discovery run failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
