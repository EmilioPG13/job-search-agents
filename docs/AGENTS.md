# Agent Workflow Spec

How the job-search pipeline is built: one orchestrator, several narrow
specialist agents, one shared database, one human approval gate.

## The shape of the system

```
                      ORCHESTRATOR
                      picks up rows, decides what runs next,
                      handles retries and errors
                                 │
    ┌──────────┬──────────┬──────┴─────┬──────────┬──────────────┐
    ▼          ▼          ▼            ▼          ▼              ▼
 Discovery  Prefilter  Analysis     Filter     Tailor        Verify
 (no LLM)   (no LLM)   (NIM fast)  (NIM fast) (NIM strong) (NIM strong)
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

## Two different sets of models

These are easy to confuse, and confusing them costs real money.

| | Build time | Run time |
|---|---|---|
| What it is | Writing this codebase | The app analyzing job postings |
| Models | Claude (Opus orchestrating, Sonnet subagents) | **NVIDIA NIM** |
| Runs | While developing, in Claude Code | Every time the pipeline processes a job |
| Who pays | Part of the dev session | Your NVIDIA account |

**Nothing in `src/` may call a paid frontier API.** The app's models are
reached only through [`src/lib/llm.js`](../src/lib/llm.js), which points at
NIM. Claude's involvement ends when the code is written.

NIM speaks the OpenAI wire format, so the app uses the `openai` package with a
different `baseURL` — not an NVIDIA-specific client. Changing providers later
is a base URL and two model names.

Agents never call each other. Every agent reads a job row, does one job,
writes its result back, and moves the row's `status` forward. That is the
whole coordination mechanism — no message queue, no agent-to-agent chat.

**Why this matters:** any agent can be re-run on its own, a crash loses at
most one row's work, and "why did this job get rejected?" is answerable by
reading one row plus its history.

## Runtime model tiering (all on NIM)

| Tier | Default model | Used by | Why |
|---|---|---|---|
| `FAST` | `meta/llama-3.1-8b-instruct` | Analysis, Filter | High volume, mechanical extraction and scoring against a fixed schema. |
| `STRONG` | `meta/llama-3.3-70b-instruct` | Tailor, Verify | Writing and fact-checking. Lower volume, higher stakes — a hallucinated resume line is the worst failure this system can produce. |
| none | — | Discovery, Prefilter, Approval, Application, Tracker | Deterministic code. Never spend a model call on something a rule can decide. |

Both are overridable via `NIM_MODEL_FAST` / `NIM_MODEL_STRONG` in `.env`, so
swapping models is config, not a code change.

The cheapest optimization in the whole system is *ordering*: the deterministic
prefilter runs before any model call, so obviously-wrong jobs (wrong country,
below salary floor) never cost anything.

### Getting reliable JSON out of NIM

NIM offers two ways to constrain output, and they are not equivalent:

- `nvext.guided_json` — constrains generation to an actual JSON schema.
- `response_format: {type: "json_object"}` — only guarantees *some* valid
  JSON. An empty `{}` satisfies it.

We send `guided_json`, and fall back to `json_object` plus an in-prompt schema
only if an endpoint rejects the `nvext` extension. Because that fallback has no
real guarantee, `askForJson()` validates the required fields itself before
returning — so a malformed reply fails loudly on the row instead of silently
writing junk into the database.

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

### Analysis — NIM, fast tier
Reads `raw_description`, returns structured requirements: required and
preferred skills, years of experience, seniority, keywords, red flags, and
whether the posting contains instructions aimed at an AI reader.

**Contract**
- In: `raw_description`, `title`, `company`
- Out: `extracted_requirements` (JSON)
- Needs no profile — it describes the *job*, not the fit.

**Why it's separate from Filter:** the same extracted requirements feed both
the fit score and the resume tailoring. Extract once, reuse twice.

### Filter — NIM, fast tier
Scores the job against your profile using the *extracted requirements*, not
the raw text. Returns `fit_score` (0–1) and `fit_reasoning`.

### Tailor — NIM, strong tier
Calls the existing CV Tailor tool with your base CV plus the extracted
requirements, producing a tailored resume.

### Verify — NIM, strong tier, fresh context
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
3. **Schema-constrained output** — see "Getting reliable JSON out of NIM"
   above. No regex, no "please respond in JSON" as the primary mechanism.
4. **Low temperature** — this is extraction and checking, not creative work.

All of it goes through the single `askForJson()` in `src/lib/llm.js`, so an
agent can't accidentally skip the untrusted-content boundary or the schema
check by writing its own call.

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
