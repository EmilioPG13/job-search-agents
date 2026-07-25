// We Work Remotely — https://weworkremotely.com
//
// RSS rather than JSON, one feed per category, ~25 postings each. Remote-only
// by definition and reasonably curated.
//
// The feed is small XML with predictable structure, so it's parsed with
// targeted extraction rather than pulling in an XML library for four fields.
// If WWR ever changes its markup this will return zero rather than garbage —
// Discovery treats a source returning nothing as a failed source, not silently
// fine.

const { cleanText, decodeEntities } = require('../lib/text');

const FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/categories/remote-design-jobs.rss',
];

const USER_AGENT = 'Mozilla/5.0 (compatible; job-search-agents/0.1)';

const unwrap = (s) =>
  decodeEntities((s || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')).trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? unwrap(m[1]) : null;
}

/** WWR titles follow "Company: Role". Split when it holds, keep whole if not. */
function splitTitle(raw) {
  const i = (raw || '').indexOf(':');
  if (i > 0 && i < 60) {
    return { company: raw.slice(0, i).trim(), title: raw.slice(i + 1).trim() };
  }
  return { company: 'unknown', title: raw || '(untitled)' };
}

async function fetchFeed(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`We Work Remotely request failed: ${res.status}`);
  const xml = await res.text();

  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  return blocks.map((block) => {
    const link = tag(block, 'link') || '';
    const { company, title } = splitTitle(tag(block, 'title'));
    const region = tag(block, 'region');
    const pubDate = tag(block, 'pubDate');

    return {
      source: 'weworkremotely',
      // The URL slug is the only stable identifier in the feed.
      source_id: (link.split('/').filter(Boolean).pop() || link).slice(0, 200),
      url: link,
      title,
      company,
      location: region || null,
      remote: 1, // the entire board is remote
      salary_min: null, // not present in the feed
      salary_max: null,
      posted_at: pubDate ? new Date(pubDate).toISOString() : null,
      tags: [],
      raw_description: cleanText(tag(block, 'description')),
    };
  });
}

async function fetchJobs() {
  const all = [];
  const seen = new Set();

  for (const feed of FEEDS) {
    // One dead category shouldn't lose the others.
    try {
      for (const job of await fetchFeed(feed)) {
        if (seen.has(job.source_id)) continue; // categories overlap
        seen.add(job.source_id);
        all.push(job);
      }
    } catch {
      // Recorded as a smaller fetch count rather than a hard failure.
    }
  }

  return all;
}

module.exports = { name: 'weworkremotely', fetchJobs, splitTitle };
