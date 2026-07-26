// Check the CV Tailor connection end to end.
//
//   npm run cvtailor:check
//
// Reports each step separately so a failure points at one thing: the service
// being down, the session having expired, or the request shape being wrong.

const { getServiceInfo, getToken, tailor, hasSavedLogin, API_URL } = require('../lib/cvTailor');

// Deliberately a realistic length. A three-line sample made the service
// return {result: null} with a 200 status, which read as a broken integration
// when the request shape was in fact correct — it simply had too little to
// work with.
const SAMPLE_CV = `Emilio Perez
Junior Software Developer - Puebla, Mexico
emilio@example.com - github.com/example

PROFILE
Full-stack developer with two years of hands-on experience building React
applications and REST APIs, gained through personal projects and a web
development bootcamp. Comfortable across the stack, from Postgres schemas to
component design.

PROJECTS
E-commerce API - Node.js, Express, PostgreSQL, Sequelize, JWT, Stripe, React
- Built a full-stack platform with authentication, cart and order management
- Integrated Stripe checkout and documented the API with Swagger

Reddit Lite - React, Vite, Tailwind CSS
- Lightweight Reddit client with subreddit browsing and post search

WORK EXPERIENCE
Medical Interpreter - Language Services Associates (2019 - present)
- Real-time English-Spanish interpretation for U.S. clinical clients
- Managed scheduling and client communication as a remote contractor

EDUCATION
B.S. Computer Science (in progress) - IU International University
Web Development Bootcamp - DEV.F, 2021-2022

SKILLS
JavaScript, TypeScript, Python, SQL, React, Node.js, Express, PostgreSQL,
MongoDB, Tailwind CSS, Vite, Git, REST APIs`;

const SAMPLE_JD = `Junior Full-Stack Developer (Remote)

We're looking for a junior developer to join our small product team.

Requirements:
- Experience with JavaScript and React
- Familiarity with Node.js and REST APIs
- Comfortable with Git and collaborative workflows

Nice to have: TypeScript, PostgreSQL.`;

(async () => {
  console.log(`\n  API: ${API_URL}\n`);

  // 1. Is the service reachable at all? (public endpoint, no auth)
  try {
    const info = await getServiceInfo();
    console.log('  [1/3] service reachable');
    console.log(`        tailoring model: ${info.llm_model}`);
    console.log(`        design model   : ${info.design_model}`);
  } catch (err) {
    console.error(`  [1/3] service unreachable — ${err.message}`);
    console.error('        Render free tier sleeps when idle; try again in a minute.\n');
    process.exitCode = 1;
    return;
  }

  // 2. Do we have a usable login?
  if (!hasSavedLogin()) {
    console.log('\n  [2/3] not signed in yet.');
    console.log('        Run: npm run cvtailor:login\n');
    process.exitCode = 1;
    return;
  }

  let token;
  try {
    token = await getToken();
    console.log(`  [2/3] session valid, token minted (${token.length} chars)`);
  } catch (err) {
    console.error(`  [2/3] could not mint a token — ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // 3. A real tailoring request, so the request shape is proven, not assumed.
  try {
    const started = Date.now();
    const result = await tailor({ cv: SAMPLE_CV, jobDescription: SAMPLE_JD, token });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`  [3/3] tailoring succeeded in ${secs}s`);
    console.log(`        response fields: ${Object.keys(result).join(', ')}`);

    const preview = (v) =>
      typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 180) : JSON.stringify(v).slice(0, 180);

    for (const [key, value] of Object.entries(result)) {
      console.log(`\n        --- ${key} ---`);
      console.log(`        ${preview(value)}...`);
    }
    console.log();
  } catch (err) {
    console.error(`  [3/3] tailoring failed — ${err.message}\n`);
    process.exitCode = 1;
  }
})();
