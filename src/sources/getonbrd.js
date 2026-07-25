// Get on Board — https://www.getonbrd.com/api/v0
//
// Curated tech jobs across Latin America. Free, no key. The best-structured
// source in this project by some distance: real salary figures, a proper
// seniority field, explicit remote flag, and Spanish-language postings — which
// matters if you're in LatAm and the other boards are US-centric.
//
// Measured 2026-07-24: remote=true returns ~300 postings over 3 pages, whose
// seniority split is 3 junior / 31 semi-senior / 58 senior / 8 expert per
// page. Only remote roles are fetched; the onsite listings are heavily
// Chile-based and don't suit a remote search.
//
// Salary note: Get on Board quotes USD *per month* (a senior Chilean role
// shows 2600-3200). Every other source here quotes annual, so the figures are
// multiplied by 12 on the way in. Without that, a salary floor would silently
// reject every Get on Board job.

const { cleanText } = require('../lib/text');

const API = 'https://www.getonbrd.com/api/v0';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';
const MAX_PAGES = 3;

const SENIORITY = { 1: 'no_experience', 2: 'junior', 3: 'semi_senior', 4: 'senior', 5: 'expert' };

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Get on Board request failed: ${res.status}`);
  return res.json();
};

/** The posting body is split across several fields; the agents want one blob. */
function buildDescription(a) {
  return cleanText(
    [
      a.description,
      a.functions_headline,
      a.functions,
      a.desirable_headline,
      a.desirable,
      a.benefits_headline,
      a.benefits,
      a.perks,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

async function fetchJobs() {
  const jobs = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    // Without expand=["company"] the company relationship arrives as a bare id
    // reference and every row would be stored as "unknown".
    const expand = encodeURIComponent('["company"]');
    const data = await get(
      `${API}/search/jobs?per_page=100&remote=true&page=${page}&expand=${expand}`,
    );
    const batch = data.data || [];
    if (batch.length === 0) break;

    for (const j of batch) {
      const a = j.attributes || {};
      const seniorityId = a.seniority?.data?.id;
      const monthlyMin = Number(a.min_salary) || null;
      const monthlyMax = Number(a.max_salary) || null;

      jobs.push({
        source: 'getonbrd',
        source_id: j.id,
        url: `https://www.getonbrd.com/jobs/${j.id}`,
        title: a.title,
        company: a.company?.data?.attributes?.name || 'unknown',
        location: (a.countries || []).join(', ') || a.remote_zone || null,
        remote: a.remote ? 1 : 0,
        salary_min: monthlyMin ? monthlyMin * 12 : null,
        salary_max: monthlyMax ? monthlyMax * 12 : null,
        posted_at: a.published_at ? new Date(a.published_at * 1000).toISOString() : null,
        // `a.tags` is a JSON:API relationship carrying bare ids with no names
        // ({data:[{id:113,type:'tag'}]}), so it's dropped — resolving them
        // would cost a request per tag for labels we don't filter on anyway.
        // The seniority label is worth keeping: it's authoritative, so the
        // prefilter doesn't have to infer level from the title.
        tags: [SENIORITY[seniorityId]].filter(Boolean),
        raw_description: buildDescription(a),
      });
    }

    if (page >= (data.meta?.total_pages || 1)) break;
  }

  return jobs;
}

module.exports = { name: 'getonbrd', fetchJobs, SENIORITY };
