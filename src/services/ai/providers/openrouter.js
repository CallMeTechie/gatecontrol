'use strict';

// OpenRouter (openrouter.ai): OpenAI-compatible chat completions. Its model
// list names input types, supported parameters and prices per model; the
// cost of a request comes with the answer (usage.cost, US dollars). A strict
// JSON schema only for models that support structured outputs — the others
// get the schema in the instructions (the answer is checked either way).

const { requestJson, base } = require('./http');
const openai = require('./openai');
const schemaLib = require('../schema');

const HOST = 'https://openrouter.ai';

function headers(key) { return { authorization: `Bearer ${key}`, 'x-title': 'GateControl' }; }

/** US dollars per token (string) → per million tokens, null when unknown. */
function perMillion(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
}

async function listModels(key, { timeoutMs = 15000 } = {}) {
  const j = await requestJson({ url: `${base('openrouter', HOST)}/api/v1/models`, headers: headers(key), timeoutMs, secrets: [key] });
  const list = Array.isArray(j.data) ? j.data : [];
  return list.filter((m) => m && typeof m.id === 'string').map((m) => {
    const arch = m.architecture || {};
    const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : String(arch.modality || 'text').split('->')[0].split('+');
    const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities : ['text'];
    const caps = [];
    if (inputs.includes('text') && outputs.includes('text')) caps.push('text');
    if (inputs.includes('image')) caps.push('vision');
    if (inputs.includes('audio')) caps.push('audio');
    if (inputs.includes('video')) caps.push('video');
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const pricing = m.pricing || {};
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    return {
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      capabilities: caps,
      structured: params.includes('structured_outputs') || params.includes('response_format'),
      price: input != null && output != null ? { input, output } : null,
    };
  }).filter((m) => m.capabilities.includes('text'));
}

/** o as openai.complete, plus structured (the model supports a strict schema). */
async function complete(o) {
  const body = { model: o.model, messages: openai.messages(o), max_tokens: o.maxOutputTokens, usage: { include: true } };
  if (o.schema) {
    if (o.structured !== false) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: schemaLib.strict(o.schema) } };
    } else {
      body.messages[0].content += `\n\nAnswer with JSON only, matching this JSON schema:\n${JSON.stringify(schemaLib.plain(o.schema))}`;
    }
  }
  const j = await requestJson({ url: `${base('openrouter', HOST)}/api/v1/chat/completions`, headers: headers(o.key), body, timeoutMs: o.timeoutMs, secrets: [o.key] });
  return openai.answer(j);
}

module.exports = { id: 'openrouter', HOST, listModels, complete, perMillion };
