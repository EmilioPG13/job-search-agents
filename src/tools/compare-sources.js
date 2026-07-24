// Measure candidate job sources against the same yardstick: how many postings
// survive the prefilter? Run before adding a source, so the decision is based
// on its actual yield rather than its marketing.
//
//   node src/tools/compare-sources.js

const { classify } = require('../agents/prefilter');
const profile = require('../profile/profile.json');

const UA = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';
const get = async (url) => (await fetch(url, { headers: { 'User-Agent': UA } })).json();

// Strip HTML so the prefilter's tech-term matching sees prose, not markup —
// otherwise tags and attributes would count toward the technology-term score.
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const SOURCES = {
  async remoteok() {
    const data = await get('https://remoteok.com/api');
    return data.slice(1).map((j) => ({
      title: j.position,
      raw_description: j.description,
      location: j.location,
    }));
  },

  async remotive() {
    const data = await get('https://remotive.com/api/remote-jobs');
    return (data.jobs || []).map((j) => ({
      title: j.title,
      raw_description: stripHtml(j.description),
      location: j.candidate_required_location,
    }));
  },

  async arbeitnow() {
    const data = await get('https://www.arbeitnow.com/api/job-board-api');
    return (data.data || []).map((j) => ({
      title: j.title,
      raw_description: stripHtml(j.description),
      location: j.location,
      remote: j.remote,
    }));
  },
};

(async () => {
  const rows = [];

  for (const [name, fetchJobs] of Object.entries(SOURCES)) {
    try {
      const jobs = await fetchJobs();
      const kept = jobs.filter((j) => classify(j, profile).keep);
      const remote = jobs.filter((j) => j.remote !== false).length;
      rows.push({ source: name, fetched: jobs.length, remote, kept: kept.length });

      console.log(`\n=== ${name} ===`);
      console.log(`fetched ${jobs.length}, survived prefilter: ${kept.length}`);
      kept.slice(0, 10).forEach((j) => console.log(`  ✓ ${j.title}  [${j.location || '?'}]`));
    } catch (err) {
      console.log(`\n=== ${name} ===\n  FAILED: ${err.message}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.table(
    rows.map((r) => ({
      ...r,
      'yield %': ((r.kept / r.fetched) * 100).toFixed(1),
    })),
  );
})();
