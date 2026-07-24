// Remotive — https://remotive.com/api/remote-jobs
//
// Free, no key, all listings genuinely remote with a useful eligibility field
// ("Worldwide", "USA", "Americas, Europe, Israel").
//
// Two measured caveats (2026-07-24):
//   * The `category` parameter is ignored — every category slug returns the
//     same 35 rows, so there is no point requesting one.
//   * That's the whole feed: 35 postings, of which 2 survived the prefilter.
// Small but clean. Kept because it costs one request and overlaps little with
// the other sources.

const { cleanText } = require('../lib/text');

const URL = 'https://remotive.com/api/remote-jobs';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';

async function fetchJobs() {
  const res = await fetch(URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Remotive request failed: ${res.status}`);
  const data = await res.json();

  return (data.jobs || []).map((j) => ({
    source: 'remotive',
    source_id: String(j.id),
    url: j.url,
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || null,
    remote: 1,
    salary_min: null, // `salary` is free text ("$50k-70k", "") — not parsed
    salary_max: null,
    posted_at: j.publication_date || null,
    tags: j.tags || [],
    raw_description: cleanText(j.description),
  }));
}

module.exports = { name: 'remotive', fetchJobs };
