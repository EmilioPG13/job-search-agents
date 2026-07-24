// Runtime model access for every agent in the pipeline.
//
// The app runs on NVIDIA NIM, which speaks the OpenAI wire format — so we use
// the openai SDK with a different baseURL rather than an NVIDIA-specific
// client. Switching providers later is a baseURL + model-name change.
//
// Not to be confused with the models used to *build* this project. See
// docs/AGENTS.md → "Two different sets of models".
//
// Structured output: NVIDIA recommends nvext.guided_json (constrains output to
// an actual schema) over response_format: json_object (only guarantees *some*
// valid JSON, possibly empty). We send guided_json and fall back to
// json_object if the endpoint rejects the nvext extension.
// https://docs.nvidia.com/nim/large-language-models/1.12.0/structured-generation.html

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

function isNvextUnsupported(err) {
  const blob = `${err?.message || ''} ${JSON.stringify(err?.error || {})}`.toLowerCase();
  return err?.status === 400 && (blob.includes('nvext') || blob.includes('guided_json'));
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
      nvext: { guided_json: schema },
    });
  } catch (err) {
    if (!isNvextUnsupported(err)) throw err;
    // This endpoint/model doesn't accept nvext. Fall back to plain JSON mode
    // and state the schema in the prompt — weaker, so we still validate below.
    console.warn(`  (${model} rejected guided_json; falling back to json_object)`);
    response = await client.chat.completions.create({
      ...base,
      response_format: { type: 'json_object' },
      messages: [
        ...messages,
        {
          role: 'user',
          content: `Reply with JSON only, matching this schema:\n${JSON.stringify(schema)}`,
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

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`Reply was not valid JSON: ${text.slice(0, 200)}`);
    err.code = 'BAD_JSON';
    throw err;
  }

  // guided_json should make this redundant, but the fallback path has no such
  // guarantee — so check the contract either way rather than trusting it.
  const missing = (schema.required || []).filter((key) => !(key in data));
  if (missing.length > 0) {
    const err = new Error(`Reply missing required fields: ${missing.join(', ')}`);
    err.code = 'SCHEMA_MISMATCH';
    throw err;
  }

  return { data, usage: response.usage, model: response.model || model };
}

module.exports = { MODELS, BASE_URL, askForJson, getClient };
