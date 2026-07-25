// Company job boards — Greenhouse and Lever.
//
// The highest-quality source here, and the one worth curating. Aggregators
// give you a wide, noisy feed; a company board gives you every current opening
// at a company you actually chose, posted by the employer itself. Nothing is
// stale, duplicated, or SEO-stuffed.
//
// The trade-off is that it isn't a firehose: it only finds jobs at companies
// you list. Edit src/sources/companies.json — that list is the feature.
//
// Both platforms serve unauthenticated JSON:
//   Greenhouse  boards-api.greenhouse.io/v1/boards/TOKEN/jobs?content=true
//   Lever       api.lever.co/v0/postings/TOKEN?mode=json

const fs = require('fs');
const path = require('path');
const { cleanText, decodeEntities } = require('../lib/text');

const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';
const CONFIG = path.join(__dirname, 'companies.json');

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

function loadCompanies() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  return {
    greenhouse: (cfg.greenhouse || []).filter((c) => c.enabled !== false),
    lever: (cfg.lever || []).filter((c) => c.enabled !== false),
  };
}

/**
 * Greenhouse returns entity-escaped HTML — the body arrives as
 * "&lt;p&gt;We are:&lt;/p&gt;", not "<p>We are:</p>". Stripping tags before
 * decoding would find no tags to strip and leave the markup in the text, so
 * the entities have to be decoded first.
 */
const cleanGreenhouseContent = (content) => cleanText(decodeEntities(content || ''));

/** Greenhouse exposes employment type and similar under a metadata array. */
function metadataTags(job) {
  return (job.metadata || [])
    .filter((m) => m && m.value && typeof m.value === 'string')
    .map((m) => `${m.name}: ${m.value}`)
    .slice(0, 8);
}

async function fetchGreenhouse(company) {
  const data = await get(
    `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs?content=true`,
  );

  return (data.jobs || []).map((j) => {
    const location = j.location?.name || null;
    return {
      source: 'companyboards',
      source_id: `greenhouse:${company.token}:${j.id}`,
      url: j.absolute_url,
      title: j.title,
      company: j.company_name || company.label || company.token,
      location,
      remote: /remote|anywhere|distributed/i.test(`${j.title} ${location || ''}`) ? 1 : 0,
      salary_min: null, // not exposed by the boards API
      salary_max: null,
      posted_at: j.first_published || j.updated_at || null,
      tags: metadataTags(j),
      raw_description: cleanGreenhouseContent(j.content),
    };
  });
}

async function fetchLever(company) {
  const data = await get(`https://api.lever.co/v0/postings/${company.token}?mode=json`);
  if (!Array.isArray(data)) return [];

  return data.map((j) => {
    const location = j.categories?.location || null;
    return {
      source: 'companyboards',
      source_id: `lever:${company.token}:${j.id}`,
      url: j.hostedUrl || j.applyUrl,
      title: j.text,
      company: company.label || company.token,
      location,
      remote: /remote|anywhere|distributed/i.test(`${j.text} ${location || ''}`) ? 1 : 0,
      salary_min: null,
      salary_max: null,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      tags: [j.categories?.team, j.categories?.commitment].filter(Boolean),
      // Lever splits the body across `description` and `lists`.
      raw_description: cleanText(
        [j.description, ...(j.lists || []).map((l) => `${l.text}: ${l.content}`)]
          .filter(Boolean)
          .join('\n\n'),
      ),
    };
  });
}

async function fetchJobs() {
  const { greenhouse, lever } = loadCompanies();
  const jobs = [];
  const failures = [];

  for (const company of greenhouse) {
    // One company changing its board token must not lose the others.
    try {
      jobs.push(...(await fetchGreenhouse(company)));
    } catch (err) {
      failures.push(`greenhouse:${company.token} (${err.message})`);
    }
  }

  for (const company of lever) {
    try {
      jobs.push(...(await fetchLever(company)));
    } catch (err) {
      failures.push(`lever:${company.token} (${err.message})`);
    }
  }

  if (failures.length) {
    console.warn(`    company boards unreachable: ${failures.join(', ')}`);
  }

  return jobs;
}

module.exports = { name: 'companyboards', fetchJobs, loadCompanies };
