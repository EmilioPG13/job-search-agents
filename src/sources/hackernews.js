// Hacker News "Ask HN: Who is hiring?" — one thread per month, one top-level
// comment per job.
//
// Measured 2026-07-24: the July thread had 277 postings, 151 mentioning
// remote, and essentially all of them genuine software roles — far better
// signal than any of the general job-board APIs.
//
// The trade-off is structure: a posting is free text, not fields. Most follow
// the community convention
//
//   Company | Role | Location | Salary | Type | URL
//
// which we parse for title and company. When a posting doesn't follow it we
// fall back rather than guess, and leave the full text for the Analysis agent
// to read — extracting structure from prose is exactly its job.

const { cleanText, decodeEntities } = require('../lib/text');

const SEARCH = 'https://hn.algolia.com/api/v1/search_by_date';
const ITEM = 'https://hn.algolia.com/api/v1/items';
const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Hacker News request failed: ${res.status}`);
  return res.json();
};

/** Most recent "Who is hiring?" thread from the official whoishiring account. */
async function findLatestThread() {
  const data = await get(`${SEARCH}?tags=story,author_whoishiring&query=hiring&hitsPerPage=20`);
  const threads = (data.hits || []).filter((h) => /who is hiring/i.test(h.title || ''));
  if (threads.length === 0) throw new Error('No "Who is hiring?" thread found');
  return threads[0]; // search_by_date returns newest first
}

/**
 * Pull title and company out of a posting's first line.
 * Returns nulls rather than guesses when the convention isn't followed.
 */
function parseHeader(text) {
  const firstLine = (text.split('\n').find((l) => l.trim()) || '').trim();

  const parts = firstLine
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return { company: parts[0].slice(0, 120), title: parts[1].slice(0, 160) };
  }

  // "Company (Location) - Role" / "Company — Role"
  const dash = firstLine.match(/^(.{2,80}?)\s+[-–—]\s+(.{2,160})$/);
  if (dash) {
    return { company: dash[1].replace(/\s*\([^)]*\)\s*$/, '').trim(), title: dash[2].trim() };
  }

  return { company: null, title: firstLine.slice(0, 160) || null };
}

async function fetchJobs() {
  const thread = await findLatestThread();
  const full = await get(`${ITEM}/${thread.objectID}`);

  const posts = (full.children || []).filter((c) => c.text && !c.deleted);

  return posts.map((c) => {
    const text = cleanText(c.text);
    const { company, title } = parseHeader(text);
    return {
      source: 'hackernews',
      source_id: String(c.id),
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      title: title || '(untitled HN posting)',
      company: company || decodeEntities(c.author) || 'unknown',
      location: null, // stated in prose; the Analysis agent extracts it
      remote: /\bremote\b/i.test(text) ? 1 : 0,
      salary_min: null,
      salary_max: null,
      posted_at: c.created_at || null,
      tags: [],
      raw_description: text,
    };
  });
}

module.exports = { name: 'hackernews', fetchJobs, parseHeader };
