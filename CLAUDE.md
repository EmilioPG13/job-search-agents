# job-search-agents

Reads job boards, scores postings against a real skills profile, tailors a CV per
posting via the CV Tailor service, and runs a separate verification pass for
invented credentials before a human sees the result. It does not apply to jobs:
`approved_at` is written only after a human keystroke.

Design rationale and the failure modes this exists to prevent: `docs/AGENTS.md`.
Operational state and measured facts: `docs/HANDOFF.md`.

## Gotchas

- `node:sqlite`, not better-sqlite3. There is no `.transaction()` helper, and
  calling `process.exit()` with the DB handle open crashes libuv — set
  `process.exitCode` instead.
- Delete `job_status_history` rows before `jobs` rows; foreign key.
- Timestamps are written with `datetime('now')`, which SQLite records in **UTC**,
  while `git log` here prints local time (-0600). Comparing a row's timestamp
  against a commit's without converting reads six hours off — enough to conclude
  a run happened after a fix when it happened before it.
- Agents claim rows by `status`, do one job, and move the row on. No agent calls
  another — the table is the only shared state.
- NIM's free tier is ~40 requests/minute per key across all models, paced
  *before* sending in `src/lib/rateLimit.js` rather than retried after a 429.
  Slow is not failed: 167s for a trivial request is normal, so timeouts are 300s.
- Only `response_format: json_schema` produces schema-conformant output on hosted
  NIM. `nvext.guided_json` is silently ignored — that advice is for self-hosted.
- Never put an example in a schema field description. Small models copy it out as
  an answer; asking for AI-directed text "e.g. asking you to include a specific
  word" produced that exact phrase as a finding on clean postings.
- Posting text is untrusted and fenced as data via `src/lib/promptSafety.js`.
  Postings really do address AI readers.
- CV Tailor auth: `npm run cvtailor:login` opens a browser so the sign-in
  happens by hand, and the session is saved to `data/cv-tailor-auth.json`.
  Later runs replay it headlessly to mint a Clerk token and then call the API
  over plain HTTP. **Playwright holds the login only — it never drives the UI.**
- Personal and gitignored: `.env`, `src/profile/profile.json`,
  `data/base_cv_*.txt`, `data/cv-tailor-auth.json`, `data/*.sqlite`.
