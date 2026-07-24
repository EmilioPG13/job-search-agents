# Agent Workflow Spec

How the job-search pipeline is built: one orchestrator, several narrow
specialist agents, one shared database, one human approval gate.

## The shape of the system

```
                      ORCHESTRATOR  (Claude Opus 5)
                      picks up rows, decides what runs next,
                      handles retries and errors
                                 │
    ┌──────────┬──────────┬──────┴─────┬──────────┬──────────────┐
    ▼          ▼          ▼            ▼          ▼              ▼
 Discovery  Prefilter  Analysis     Filter     Tailor        Verify
 (no LLM)   (no LLM)   (Sonnet 5)  (Sonnet 5) (Sonnet 5)   (Sonnet 5)
    │          │          │            │          │              │
    └──────────┴──────────┴────────────┴──────────┴──────────────┘
                                 │
                       jobs table (SQLite)
                                 │
                       ┌─────────┴─────────┐
                       │  HUMAN APPROVAL   │  ← nothing is submitted
                       └─────────┬─────────┘     before this
                                 ▼
                          Application agent
```

Agents never call each other. Every agent reads a job row, does one job,
writes its result back, and moves the row's `status` forward. That is the
whole coordination mechanism — no message queue, no agent-to-agent chat.

**Why this matters:** any agent can be re-run on its own, a crash loses at
most one row's work, and "why did this job get rejected?" is answerable by
reading one row plus its history.

## Model tiering

| Role | Model | Why |
|---|---|---|
| Orchestrator | `claude-opus-5` | Decides what runs, interprets failures, handles the odd cases. Judgment work, low volume. |
| Specialist agents | `claude-sonnet-5` | Narrow tasks with a fixed output shape, run over many rows. Fast and cheaper per row. |
| Discovery, Prefilter, Approval, Application | no model | Deterministic code. Never spend a model call on something a rule can decide. |

The cheapest optimization in the whole system is *ordering*: the deterministic
prefilter runs before any model call, so obviously-wrong jobs (wrong country,
below salary floor) never cost anything.

## The status ladder

`status` on the `jobs` row is the pipeline. Each agent claims rows in one
status and leaves them in another.

| From | Agent | To |
|---|---|---|
| — | Discovery | `discovered` |
| `discovered` | Prefilter (rules) | `analyzed`-bound, or `rules_rejected` |
| `discovered` | Analysis | `analyzed` |
| `analyzed` | Filter | `scored_in` or `scored_out` |
| `scored_in` | Tailor | `tailored` |
| `tailored` | Verify | `verified` or back to `scored_in` to retry |
| `verified` | (automatic) | `pending_approval` |
| `pending_approval` | **human** | `approved` or `rejected_by_user` |
| `approved` | Application | `applied` |
| `applied` | Tracker | `tracking` → `closed` |

Every transition also writes a row to `job_status_history` with a reason.

## The agents

### Discovery — no model
Fetches postings from job board APIs, maps them to the `jobs` schema, dedupes
on `(source, source_id)`, runs the prompt-injection detector, inserts.
Currently implemented for RemoteOK; sources are pluggable.

**Deliberately dumb.** No judgment, no filtering. Job boards break constantly
and this is the part most likely to fail — keeping it separate means a broken
scraper can't take down the rest of the pipeline.

### Prefilter — no model
Rule checks against `profile.json`: salary floor, work mode, location,
dealbreaker keywords. Rejects cheaply so the model never sees hopeless rows.

### Analysis — Sonnet 5
Reads `raw_description`, returns structured requirements: required and
preferred skills, years of experience, seniority, keywords, red flags, and
whether the posting contains instructions aimed at an AI reader.

**Contract**
- In: `raw_description`, `title`, `company`
- Out: `extracted_requirements` (JSON)
- Needs no profile — it describes the *job*, not the fit.

**Why it's separate from Filter:** the same extracted requirements feed both
the fit score and the resume tailoring. Extract once, reuse twice.

### Filter — Sonnet 5
Scores the job against your profile using the *extracted requirements*, not
the raw text. Returns `fit_score` (0–1) and `fit_reasoning`.

### Tailor — Sonnet 5
Calls the existing CV Tailor tool with your base CV plus the extracted
requirements, producing a tailored resume.

### Verify — Sonnet 5, fresh context
Checks the tailored resume against two things:
1. **Ground truth** — every claim traces to `profile.json.ground_truth`. No
   invented titles, dates, employers, or metrics.
2. **The job** — does it actually address the requirements? Any keyword
   stuffing? Did any embedded instruction from the posting leak into the
   output (e.g. an anti-spam token echoed into your resume)?

**This is a separate model call with no memory of the tailoring pass.** A model
that just wrote something is a bad judge of whether it made it up.

### Human approval — no model
A UI or CLI showing: the posting, the fit score and reasoning, the tailored
resume, and the verification report. You approve, edit, or reject.

**This is a hard boundary in code, not a prompt instruction.** The Application
agent's query is `WHERE status = 'approved'`. There is no path from `verified`
to `applied` that doesn't pass through a human writing to `approved_at`.

### Application — no model (initially)
Acts only on `approved` rows. Starts as *prepare, don't submit*: stages the
files, opens the posting. The final click stays yours until the system has
earned more trust.

### Tracker — no model
Logs what was applied to and when; surfaces follow-up reminders.

## How agents talk to the model

Every specialist agent call follows the same shape:

1. **System prompt** — the agent's role, plus the untrusted-content boundary
   from [`src/lib/promptSafety.js`](../src/lib/promptSafety.js).
2. **Job text wrapped in delimiters** — `wrapUntrustedContent()` marks it as
   data to read, never instructions to follow. Non-negotiable: job
   descriptions are scraped third-party text, and real postings do contain
   text aimed at AI readers.
3. **Structured output** — a JSON schema is attached to the request, so the
   model's reply is guaranteed to parse. No regex, no "please respond in JSON".
4. **Adaptive thinking**, with an `effort` level chosen per agent — low for
   extraction, higher for verification.

## Failure handling

| Failure | Response |
|---|---|
| API error / rate limit | Row keeps its current status; retried on next run. The SDK retries transient errors on its own. |
| Model refuses | Recorded on the row, status unchanged, surfaced to the human. |
| Verification fails | Row goes back for another tailoring pass; after repeated failures it goes to the human with the report attached. |
| Bad job data | Row marked `rules_rejected` with a reason. Never crashes the run. |

Because state lives in the database rather than in memory, a crashed run is
resumed by simply running it again.

## Build order

1. ~~Schema + profile format~~ ✅
2. ~~Prompt-injection defense~~ ✅
3. ~~Discovery (RemoteOK)~~ ✅
4. **Analysis** ← current
5. Prefilter + Filter (needs a filled-in `profile.json`)
6. Tailor (wire up CV Tailor)
7. Verify
8. Approval UI
9. Application + Tracker
10. Orchestrator loop — last, once each step works standalone
