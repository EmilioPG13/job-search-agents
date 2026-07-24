// Runtime model access for every agent in the pipeline.
//
// The app runs on NVIDIA NIM, which speaks the OpenAI wire format — so we use
// the openai SDK with a different baseURL rather than an NVIDIA-specific
// client. Switching providers later is a baseURL + model-name change.
//
// Not to be confused with the models used to *build* this project. See
// docs/AGENTS.md → "Two different sets of models".
//
// Structured output — measured against the hosted endpoint, 2026-07-24:
//
//   response_format: json_schema   ✅ output matched the schema exactly
//   response_format: json_object   ⚠️  valid JSON, but invents its own keys
//   nvext.guided_json              ❌ silently ignored; model replied in prose
//
// NVIDIA's docs recommend nvext.guided_json, but that applies to *self-hosted*
// NIM. On integrate.api.nvidia.com it is accepted and then ignored — the worst
// failure mode, since nothing errors. Don't reinstate it without re-testing.
//
// So: json_schema first, json_object plus an explicit instruction as fallback,
// and a required-field check on the way out regardless.

const OpenAI = require('openai');
const { UNTRUSTED_CONTENT_BOUNDARY, wrapUntrustedContent } = require('./promptSafety');
require('dotenv').config();

const BASE_URL = process.env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';

// Two tiers. Extraction is high-volume and mechanical; judgment work (scoring
// fit, verifying a resume against ground truth) is lower-volume and worth a
// bigger model. Override per-agent if a model turns out to suit a task better.
const MODELS = {
  FAST: process.env.NIM_MODEL_FAST || 'meta/llama-3.1-8b-instruct',
  STRONG: process.env.NIM_MODEL_STRONG || 'meta/llama-3.3-70b-instruct',
};

// Built on first use, not at import. The OpenAI SDK throws in its constructor
// when the key is missing, so building it at module scope would crash the
// whole app on `require` — including commands that never call a model.
let _client = null;

function getClient() {
  if (_client) return _client;

  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      'NVIDIA_API_KEY is not set. Get a key at https://build.nvidia.com ' +
        'and add it to your .env file.',
    );
  }

  _client = new OpenAI({ apiKey: process.env.NVIDIA_API_KEY, baseURL: BASE_URL });
  return _client;
}

function buildMessages({ system, task, untrusted, untrustedLabel }) {
  // The boundary note is only added when untrusted text is actually present,
  // so trusted-only calls aren't given instructions about content they'll
  // never see.
  const systemPrompt = untrusted
    ? `${system}\n\n${UNTRUSTED_CONTENT_BOUNDARY}`
    : system;

  const userContent = untrusted
    ? `${task}\n\n${wrapUntrustedContent(untrusted, untrustedLabel)}`
    : task;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

function isSchemaModeUnsupported(err) {
  const blob = `${err?.message || ''} ${JSON.stringify(err?.error || {})}`.toLowerCase();
  return err?.status === 400 && blob.includes('response_format');
}

// Small models sometimes wrap JSON in prose or markdown fences even in JSON
// mode. Pull out the outermost {...} before giving up.
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Ask a model for a JSON object matching `schema`.
 *
 * @param {object} opts
 * @param {string} opts.system    The agent's role instructions.
 * @param {string} opts.task      Trusted instructions for this call.
 * @param {string} [opts.untrusted]  Third-party text (a job description).
 *                                   Wrapped and fenced off if present.
 * @param {string} [opts.untrustedLabel]
 * @param {object} opts.schema    JSON Schema the reply must satisfy.
 * @param {string} [opts.model]   Defaults to the fast tier.
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.client]  Injectable for tests.
 * @returns {Promise<{data: object, usage: object, model: string}>}
 */
async function askForJson({
  system,
  task,
  untrusted,
  untrustedLabel = 'job_posting',
  schema,
  model = MODELS.FAST,
  // Low rather than 0: some NIM endpoints reject temperature 0 outright, and
  // 0.1 is close enough to deterministic for extraction work.
  temperature = 0.1,
  maxTokens = 4000,
  client = getClient(),
}) {
  const messages = buildMessages({ system, task, untrusted, untrustedLabel });
  const base = { model, messages, temperature, max_tokens: maxTokens };

  let response;
  try {
    response = await client.chat.completions.create({
      ...base,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'agent_output', schema },
      },
    });
  } catch (err) {
    if (!isSchemaModeUnsupported(err)) throw err;
    // This model doesn't accept json_schema. Fall back to plain JSON mode with
    // the schema stated in the prompt — weaker, so the field check below does
    // the real work.
    console.warn(`  (${model} rejected json_schema; falling back to json_object)`);
    response = await client.chat.completions.create({
      ...base,
      response_format: { type: 'json_object' },
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            'Reply with a single JSON object and nothing else — no prose, no ' +
            `markdown fences. It must match this schema:\n${JSON.stringify(schema)}`,
        },
      ],
    });
  }

  const choice = response.choices?.[0];
  if (choice?.finish_reason === 'length') {
    const err = new Error('Reply was cut off by max_tokens');
    err.code = 'TRUNCATED';
    throw err;
  }

  const text = choice?.message?.content;
  if (!text) {
    const err = new Error('Model returned no content');
    err.code = 'EMPTY';
    throw err;
  }

  const data = extractJson(text);
  if (data === null) {
    const err = new Error(`Reply was not valid JSON: ${text.slice(0, 200)}`);
    err.code = 'BAD_JSON';
    throw err;
  }

  // json_schema mode should make this redundant, but the fallback path has no
  // such guarantee — so check the contract either way rather than trusting it.
  const missing = (schema.required || []).filter((key) => !(key in data));
  if (missing.length > 0) {
    const err = new Error(`Reply missing required fields: ${missing.join(', ')}`);
    err.code = 'SCHEMA_MISMATCH';
    throw err;
  }

  return { data, usage: response.usage, model: response.model || model };
}

module.exports = { MODELS, BASE_URL, askForJson, getClient };
