// RemoteOK — https://remoteok.com/api
//
// Free, no key. Quality is poor: measured 2026-07-24, only 7 of 100 postings
// survived the prefilter, the rest being retail, sales and placeholder rows.
// Its `tags` are SEO stuffing (one gelato-shop job listed 52 tags including
// "golang"), so they are stored but never used for filtering.
//
// Attribution is required by their terms: link back to the RemoteOK posting
// and name RemoteOK as the source. The stored `url` does that.

const { cleanText, repairEncoding } = require('../lib/text');

const URL = 'https://remoteok.com/api';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';

async function fetchJobs() {
  const res = await fetch(URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`RemoteOK request failed: ${res.status}`);
  const data = await res.json();

  // Index 0 is a legal/attribution notice, not a job.
  return data.slice(1).map((j) => ({
    source: 'remoteok',
    source_id: j.slug,
    url: j.url,
    title: repairEncoding(j.position),
    company: repairEncoding(j.company),
    location: repairEncoding(j.location) || null,
    remote: 1,
    salary_min: j.salary_min || null,
    salary_max: j.salary_max || null,
    posted_at: j.date || null,
    tags: j.tags || [],
    raw_description: cleanText(j.description),
  }));
}

module.exports = { name: 'remoteok', fetchJobs };
