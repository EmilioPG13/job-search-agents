-- The `jobs` table is the shared "blackboard" every agent reads from and
-- writes to. `status` is what drives the pipeline: each agent picks up rows
-- in the status it cares about, does its work, and advances (or bounces)
-- the status. This means any agent can be re-run independently, and the
-- whole pipeline can be paused/resumed just by looking at this table.

CREATE TABLE IF NOT EXISTS jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identity / dedupe
  source                TEXT NOT NULL,          -- e.g. "greenhouse", "adzuna"
  source_id             TEXT NOT NULL,           -- id/slug from that source
  url                    TEXT NOT NULL,
  title                  TEXT NOT NULL,
  company                TEXT NOT NULL,
  location               TEXT,
  remote                 INTEGER,                 -- 0/1 boolean
  salary_min             INTEGER,
  salary_max             INTEGER,
  salary_currency        TEXT,
  posted_at              TEXT,                     -- ISO date from the source
  raw_description        TEXT NOT NULL,

  -- Set by the Discovery agent's heuristic scan (src/lib/promptSafety.js) at
  -- ingestion time. A flag here does NOT block the job from the pipeline —
  -- it's a visibility signal for you and for downstream agents, which must
  -- independently treat raw_description as untrusted data regardless of
  -- this flag (the flag can miss novel phrasings).
  flagged_injection       INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  flagged_injection_notes TEXT,                        -- JSON array of matched patterns

  -- Pipeline state
  status                 TEXT NOT NULL DEFAULT 'discovered',
  -- See docs/AGENTS.md for the full ladder and which agent owns each step.
  -- discovered -> rules_rejected | analyzed
  -- analyzed -> scored_out | scored_in
  -- scored_in -> tailored -> verified
  -- verified -> pending_approval -> approved | rejected_by_user
  -- approved -> applied -> tracking | closed

  -- Filter agent output
  fit_score               REAL,                     -- 0.0–1.0
  fit_reasoning            TEXT,

  -- Analysis agent output
  extracted_requirements   TEXT,                     -- JSON: skills, years, seniority, keywords

  -- Tailor agent output
  tailored_resume          TEXT,
  cover_letter             TEXT,

  -- Verify agent output
  verification_passed      INTEGER,                  -- 0/1 boolean
  verification_report      TEXT,                      -- JSON: issues found, flagged claims

  -- Human approval
  approved_at               TEXT,
  rejection_reason          TEXT,

  -- Application tracking
  applied_at                 TEXT,
  application_method          TEXT,                    -- "manual" | "auto"
  notes                       TEXT,

  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

-- Append-only audit trail: every status transition gets a row here.
-- Not required for the pipeline to function, but invaluable for debugging
-- ("why did this job get filtered out?") and for a future dashboard.
CREATE TABLE IF NOT EXISTS job_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
