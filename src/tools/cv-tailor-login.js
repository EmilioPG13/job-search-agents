// One-time sign-in to CV Tailor.
//
//   npm run cvtailor:login
//
// Opens a real browser window and waits for you to sign in. Your credentials
// are typed by you, into Clerk's own page — this script never sees, handles or
// stores them. What it saves is the resulting session cookie, so later runs
// can mint tokens without a browser window.
//
// data/cv-tailor-auth.json is a live login. It is gitignored; treat it like a
// password and delete it when you're done with a machine.

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { APP_URL, AUTH_STATE } = require('../lib/cvTailor');

const WAIT_MINUTES = 5;

(async () => {
  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });

  console.log('\n  Opening CV Tailor in a browser window.');
  console.log('  Sign in there as you normally would, then come back here.');
  console.log(`  Waiting up to ${WAIT_MINUTES} minutes.\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // Wait for Clerk to report a signed-in user, rather than watching the DOM
    // for a button that might be renamed.
    await page.waitForFunction(() => window.Clerk?.user, null, {
      timeout: WAIT_MINUTES * 60_000,
    });

    const who = await page.evaluate(() => {
      const u = window.Clerk.user;
      return u.primaryEmailAddress?.emailAddress || u.username || u.id;
    });

    await context.storageState({ path: AUTH_STATE });

    console.log(`  Signed in as ${who}`);
    console.log(`  Session saved to ${AUTH_STATE}`);
    console.log('  You can close the browser window. Future runs are headless.\n');
  } catch (err) {
    console.error(`\n  Sign-in not detected: ${err.message}`);
    console.error('  Nothing was saved. Re-run when ready.\n');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
