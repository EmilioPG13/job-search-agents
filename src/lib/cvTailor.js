// Client for the CV Tailor service — https://github.com/EmilioPG13/cv-tailor
//
// The frontend is on Vercel but the Express API is on Render, and every
// tailoring endpoint is behind Clerk. Rather than clicking through the UI,
// which breaks whenever the page changes, Playwright is used only to hold the
// login: a saved session is replayed to mint a fresh Clerk JWT, and the actual
// request is plain HTTP.
//
//   1. `npm run cvtailor:login` — you sign in yourself, once. Cookies are
//      saved to data/cv-tailor-auth.json (gitignored — it is a live session).
//   2. Everything after that runs headless with no interaction.
//
// Clerk JWTs are deliberately short-lived, so a token is minted per run rather
// than stored.

const fs = require('fs');
const path = require('path');

const APP_URL = process.env.CV_TAILOR_APP_URL || 'https://cv-tailor-gold-zeta.vercel.app';
const API_URL = process.env.CV_TAILOR_API_URL || 'https://cv-tailor-8fo7.onrender.com';
const AUTH_STATE = path.join(__dirname, '../../data/cv-tailor-auth.json');

const hasSavedLogin = () => fs.existsSync(AUTH_STATE);

/**
 * Replay the saved session and keep the signed-in page open, so a fresh token
 * can be minted for each request.
 *
 * Clerk tokens are deliberately short-lived — about a minute — and a single
 * tailoring call takes longer than that. Minting one token for a whole run
 * therefore works for the first job and returns 401 for every job after it,
 * which reads exactly like an expired login and is not one. Opening a browser
 * per job would also fix the expiry, but pays several seconds of startup every
 * time; holding one page open pays that once and mints in milliseconds.
 *
 * The token is minted in the page rather than read from a cookie: Clerk's
 * session cookie is not the bearer token the API expects.
 */
async function openSession({ timeoutMs = 60_000 } = {}) {
  if (!hasSavedLogin()) {
    throw new Error(
      'Not signed in to CV Tailor. Run: npm run cvtailor:login',
    );
  }

  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({ storageState: AUTH_STATE });
    const page = await context.newPage();
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Clerk attaches itself asynchronously, so wait for a live session rather
    // than assuming it is ready on load.
    await page.waitForFunction(() => window.Clerk?.session, null, { timeout: timeoutMs });

    return {
      // skipCache, because Clerk hands back the cached token until it is
      // nearly expired — which is precisely the token that just failed.
      async mintToken() {
        const token = await page.evaluate(() =>
          window.Clerk.session.getToken({ skipCache: true }),
        );
        if (!token) throw new Error('Clerk returned no token — the saved session has expired.');
        return token;
      },
      close: () => browser.close(),
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/** A single token, for callers that make one request and stop. */
async function getToken(opts) {
  const session = await openSession(opts);
  try {
    return await session.mintToken();
  } finally {
    await session.close();
  }
}

/** Public endpoint — useful to check the service is up without signing in. */
async function getServiceInfo() {
  const res = await fetch(`${API_URL}/api/tailor/info`);
  if (!res.ok) throw new Error(`CV Tailor info failed: ${res.status}`);
  return res.json();
}

/**
 * Tailor a CV against a job description.
 *
 * @param {object} opts
 * @param {string} opts.cv               Your CV as plain text.
 * @param {string} opts.jobDescription   The posting.
 * @param {string} [opts.token]          Reuse a token across several calls.
 * @param {string} [opts.tone]           professional | conversational | enthusiastic
 * @param {string} [opts.language]       'en' | 'es'
 */
async function tailor({ cv, jobDescription, token, tone = 'professional', language = 'en' }) {
  const bearer = token || (await getToken());

  const res = await fetch(`${API_URL}/api/tailor`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ cv, jobDescription, tone, language }),
  });

  const body = await res.text();

  if (!res.ok) {
    const err = new Error(`CV Tailor returned ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    // 401 here means the saved session died, which is a different fix from a
    // server error — say so rather than making the user guess.
    if (res.status === 401) {
      err.message += '\n  The saved session has expired. Run: npm run cvtailor:login';
    }
    throw err;
  }

  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

module.exports = {
  tailor,
  getToken,
  openSession,
  getServiceInfo,
  hasSavedLogin,
  APP_URL,
  API_URL,
  AUTH_STATE,
};
