// Shared model access for every agent in the pipeline.
//
// Two tiers, per docs/AGENTS.md:
//   ORCHESTRATOR — judgment work, low volume.
//   SPECIALIST   — narrow tasks with a fixed output shape, run over many rows.
//
// Every specialist call goes through askForJson(), which pins down three
// things that agents must not get wrong individually:
//   1. Untrusted job text is wrapped and explicitly marked as data, never
//      instructions (src/lib/promptSafety.js).
//   2. A JSON schema is attached to the request, so the reply is guaranteed
//      to parse — no regex, no "please respond in JSON".
//   3. Adaptive thinking is on, with a per-agent effort level.

const Anthropic = require('@anthropic-ai/sdk');
const { UNTRUSTED_CONTENT_BOUNDARY, wrapUntrustedContent } = require('./promptSafety');
require('dotenv').config();

const MODELS = {
  ORCHESTRATOR: 'claude-opus-5',
  SPECIALIST: 'claude-sonnet-5',
};

const client = new Anthropic();

/**
 * Ask a model for a JSON object matching `schema`.
 *
 * @param {object}  opts
 * @param {string}  opts.system         The agent's role instructions.
 * @param {string}  opts.task           Trusted instructions for this call.
 * @param {string}  [opts.untrusted]    Third-party text (a job description).
 *                                      Wrapped and fenced off if present.
 * @param {string}  [opts.untrustedLabel]
 * @param {object}  opts.schema         JSON Schema for the reply.
 * @param {string}  [opts.model]        Defaults to the specialist tier.
 * @param {string}  [opts.effort]       low | medium | high | xhigh | max
 * @param {number}  [opts.maxTokens]
 * @returns {Promise<object>} The parsed reply.
 */
async function askForJson({
  system,
  task,
  untrusted,
  untrustedLabel = 'job_posting',
  schema,
  model = MODELS.SPECIALIST,
  effort = 'medium',
  maxTokens = 8000,
}) {
  const systemPrompt = untrusted
    ? `${system}\n\n${UNTRUSTED_CONTENT_BOUNDARY}`
    : system;

  const userContent = untrusted
    ? `${task}\n\n${wrapUntrustedContent(untrusted, untrustedLabel)}`
    : task;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    thinking: { type: 'adaptive' },
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: userContent }],
  });

  if (response.stop_reason === 'refusal') {
    const err = new Error('Model declined the request');
    err.code = 'REFUSAL';
    err.details = response.stop_details;
    throw err;
  }

  if (response.stop_reason === 'max_tokens') {
    const err = new Error('Reply hit max_tokens and is incomplete');
    err.code = 'TRUNCATED';
    throw err;
  }

  // Thinking blocks come before text blocks — find the text, don't assume [0].
  const text = response.content.find((block) => block.type === 'text');
  if (!text) {
    const err = new Error('No text block in response');
    err.code = 'EMPTY';
    throw err;
  }

  return { data: JSON.parse(text.text), usage: response.usage };
}

module.exports = { MODELS, askForJson, client };
