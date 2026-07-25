// Check the CV Tailor connection end to end.
//
//   npm run cvtailor:check
//
// Reports each step separately so a failure points at one thing: the service
// being down, the session having expired, or the request shape being wrong.

const { getServiceInfo, getToken, tailor, hasSavedLogin, API_URL } = require('../lib/cvTailor');

const SAMPLE_CV = `Emilio Perez
Junior Software Developer

EXPERIENCE
Freelance Web Developer (2024-present)
- Built responsive sites with React and Tailwind CSS
- Integrated REST APIs and handled client deployments

SKILLS
JavaScript, React, Node.js, Express, SQL, Git`;

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
