// Merge languages evidenced by public GitHub repos into the profile's skills.
//
//   npm run sync:github            update profile.json
//   npm run sync:github -- --dry   show what would change
//
// A CV is a claim; a repo is proof. Both belong in the profile, but they are
// not the same kind of fact, so each skill records where it came from:
//
//   cv      claimed on the CV, no public repo evidence
//   github  evidenced by repos, absent from the CV
//   both    claimed and evidenced
//
// This matters in practice. Emilio's CV omits TypeScript entirely, while it is
// 89-99% of his three most recent projects — and postings ask for it by name.
// Scoring against the CV alone was quietly underselling him.
//
// Run as a separate step rather than fetching during scoring: the pipeline
// stays usable offline, GitHub's 60-requests-per-hour unauthenticated limit
// can't stall a scoring run, and the data is reviewable before it influences
// anything.

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '../profile/profile.json');
const USER = process.env.GITHUB_USER || 'EmilioPG13';
const UA = { 'User-Agent': 'job-search-agents' };

// How many of the most recent repos to read language breakdowns for. Older
// student exercises say little about current ability and each repo costs a
// request against the rate limit.
const RECENT_REPOS = 10;

// GitHub reports what a file is written in, not what it demonstrates. These
// are markup, config or generated output — counting them as skills would put
// "HTML" beside "PostgreSQL" as though they were comparable.
const NOT_A_SKILL = new Set(['HTML', 'CSS', 'Shell', 'Batchfile', 'Dockerfile', 'Makefile', 'Procfile']);

// Below this share of a repo's bytes, a language is usually a stray config
// file rather than something that was actually worked in.
const MIN_SHARE = 0.05;

const get = async (url) => {
  const res = await fetch(url, { headers: UA });
  if (res.status === 403) {
    throw new Error('GitHub rate limit reached (60/hour unauthenticated). Try again later.');
  }
  if (!res.ok) throw new Error(`GitHub request failed: ${res.status} ${url}`);
  return res.json();
};

// GitHub's language API reports what files are written in, not what was used.
// React, Express and Sequelize all register as "JavaScript", so relying on it
// alone reports a React developer's React skill as unproven. Dependencies are
// the actual evidence.
//
// Served from raw.githubusercontent.com, which has its own quota, so this does
// not eat into the 60/hour API limit.
const DEPENDENCY_SKILLS = {
  react: 'React',
  'react-dom': 'React',
  'react-router-dom': 'React Router',
  next: 'Next.js',
  express: 'Express',
  'node-fetch': 'Node.js',
  sequelize: 'Sequelize ORM',
  mongoose: 'MongoDB',
  pg: 'PostgreSQL',
  mysql2: 'MySQL',
  tailwindcss: 'Tailwind CSS',
  vite: 'Vite',
  typescript: 'TypeScript',
  axios: 'Axios',
  stripe: 'Stripe API',
  jsonwebtoken: 'JWT',
  bcrypt: 'bcrypt',
  bcryptjs: 'bcrypt',
  'swagger-ui-express': 'Swagger UI',
  '@anthropic-ai/sdk': 'Anthropic SDK',
  openai: 'OpenAI SDK',
  playwright: 'Playwright',
  '@playwright/test': 'Playwright',
  jest: 'Jest',
  vitest: 'Vitest',
  supabase: 'Supabase',
  '@supabase/supabase-js': 'Supabase',
  '@clerk/clerk-react': 'Clerk',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
};

async function readDependencies(repoName) {
  const url = `https://raw.githubusercontent.com/${USER}/${repoName}/HEAD/package.json`;
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return []; // not a Node project, or no package.json
    const pkg = JSON.parse(await res.text());
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    return [...new Set(names.map((n) => DEPENDENCY_SKILLS[n]).filter(Boolean))];
  } catch {
    return []; // unparseable package.json is not worth failing the run over
  }
}

async function collectEvidence() {
  const repos = await get(`https://api.github.com/users/${USER}/repos?per_page=100&sort=updated`);
  if (!Array.isArray(repos)) throw new Error('Unexpected response listing repos');

  const recent = repos.filter((r) => !r.fork).slice(0, RECENT_REPOS);
  const totals = {};
  const perRepo = [];
  const depCounts = {};

  for (const repo of recent) {
    const langs = await get(repo.languages_url);
    const bytes = Object.values(langs).reduce((a, b) => a + b, 0);

    const significant = Object.entries(langs)
      .filter(([, n]) => n / bytes >= MIN_SHARE)
      .map(([name]) => name);

    const deps = await readDependencies(repo.name);
    for (const skill of deps) depCounts[skill] = (depCounts[skill] || 0) + 1;

    perRepo.push({
      name: repo.name,
      updated: repo.updated_at.slice(0, 10),
      languages: significant,
      deps,
    });

    for (const [name, n] of Object.entries(langs)) totals[name] = (totals[name] || 0) + n;
  }

  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;

  const evidenced = Object.entries(totals)
    .filter(([name, n]) => !NOT_A_SKILL.has(name) && n / grand >= 0.01)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, share: Number(((n / grand) * 100).toFixed(1)) }));

  // Frameworks carry a repo count rather than a byte share — "used in 4 repos"
  // is the meaningful measure, not what fraction of characters it accounts for.
  const fromDeps = Object.entries(depCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, repoCount]) => ({ name, repoCount }));

  return { reposConsidered: recent.length, totalRepos: repos.length, evidenced, fromDeps, perRepo };
}

/** Compare on a normalised name so "Node.js" and "nodejs" don't both appear. */
const key = (s) => String(s).toLowerCase().replace(/[.\s_-]/g, '');

function mergeSkills(profile, evidenced, fromDeps = []) {
  const ground = profile.ground_truth || (profile.ground_truth = {});

  // Skills may already be plain strings from the earlier format.
  const existing = (ground.skills || []).map((s) =>
    typeof s === 'string' ? { name: s, source: 'cv' } : { ...s },
  );

  const byKey = new Map(existing.map((s) => [key(s.name), s]));
  const added = [];
  const promoted = [];

  for (const { name, share } of evidenced) {
    const found = byKey.get(key(name));
    if (found) {
      if (found.source === 'cv') {
        found.source = 'both';
        promoted.push(name);
      }
      found.github_share = share;
    } else {
      const entry = { name, source: 'github', github_share: share };
      byKey.set(key(name), entry);
      added.push(name);
    }
  }

  for (const { name, repoCount } of fromDeps) {
    const found = byKey.get(key(name));
    if (found) {
      if (found.source === 'cv') {
        found.source = 'both';
        promoted.push(name);
      }
      found.github_repos = repoCount;
    } else {
      byKey.set(key(name), { name, source: 'github', github_repos: repoCount });
      added.push(name);
    }
  }

  ground.skills = [...byKey.values()];
  return { added, promoted };
}

(async () => {
  const dryRun = process.argv.includes('--dry');

  if (!fs.existsSync(PROFILE_PATH)) {
    console.error('src/profile/profile.json not found.');
    process.exitCode = 1;
    return;
  }

  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

  let evidence;
  try {
    evidence = await collectEvidence();
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n  ${USER}: ${evidence.totalRepos} public repos, read the ${evidence.reposConsidered} most recent\n`,
  );
  for (const r of evidence.perRepo) {
    console.log(`    ${r.updated}  ${r.name.slice(0, 24).padEnd(26)}${r.languages.join(', ')}`);
    if (r.deps.length) console.log(`                ${' '.repeat(26)}└ ${r.deps.join(', ')}`);
  }

  console.log('\n  languages (share of bytes across those repos):');
  for (const e of evidence.evidenced) {
    console.log(`    ${String(e.share).padStart(5)}%  ${e.name}`);
  }

  console.log('\n  frameworks and libraries (from package.json dependencies):');
  for (const d of evidence.fromDeps) {
    console.log(`    ${String(d.repoCount).padStart(4)} repos  ${d.name}`);
  }

  const { added, promoted } = mergeSkills(profile, evidence.evidenced, evidence.fromDeps);

  console.log('\n  changes:');
  if (added.length) {
    console.log(`    proven by repos but MISSING FROM CV: ${added.join(', ')}`);
    console.log('      → worth adding to the CV itself, not just this profile');
  }
  if (promoted.length) console.log(`    now claimed and proven: ${promoted.join(', ')}`);

  const cvOnly = profile.ground_truth.skills
    .filter((s) => s.source === 'cv')
    .map((s) => s.name);
  if (cvOnly.length) {
    console.log(`    claimed on CV, no public repo evidence: ${cvOnly.join(', ')}`);
    console.log('      → kept; a CV is the candidate\'s own claim, not this tool\'s to doubt');
  }

  if (dryRun) {
    console.log('\n  [dry run] profile.json not written.\n');
    return;
  }

  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2) + '\n');
  console.log(`\n  Updated ${path.relative(process.cwd(), PROFILE_PATH)}\n`);
})();
