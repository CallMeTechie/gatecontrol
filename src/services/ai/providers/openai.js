'use strict';

// OpenAI (api.openai.com): chat completions, structured answers as a strict
// JSON schema response format, pictures as data URLs. The model list has no
// capabilities: those come from the provider table (index.js).

const { requestJson, base, textOf, ProviderError } = require('./http');
const schemaLib = require('../schema');

const HOST = 'https://api.openai.com';
// Models of the list that cannot answer a chat request (embeddings, speech, pictures, moderation …)
const NOT_CHAT_RE = /(embed|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|search|computer-use|davinci|babbage|codex)/i;

function headers(key) { return { authorization: `Bearer ${key}` }; }

async function listModels(key, { timeoutMs = 15000 } = {}) {
  const j = await requestJson({ url: `${base('openai', HOST)}/v1/models`, headers: headers(key), timeoutMs, secrets: [key] });
  const list = Array.isArray(j.data) ? j.data : [];
  return list.filter((m) => m && typeof m.id === 'string' && !NOT_CHAT_RE.test(m.id))
    .map((m) => ({ id: m.id, name: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Messages of an OpenAI-compatible chat request. */
function messages(o) {
  const content = o.parts.map((p) => (p.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }
    : { type: 'text', text: textOf(p) }));
  return [{ role: 'system', content: o.instructions }, { role: 'user', content }];
}

/** The answer of an OpenAI-compatible chat request → { text, usage, finish }. */
function answer(j) {
  const c = Array.isArray(j.choices) ? j.choices[0] : null;
  const msg = c && c.message;
  if (!msg) throw new ProviderError('invalid', 'the provider sent no answer');
  if (msg.refusal) throw new ProviderError('client', 'the model refused the request');
  const text = typeof msg.content === 'string' ? msg.content
    : (Array.isArray(msg.content) ? msg.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : '');
  const u = j.usage || {};
  // OpenRouter adds the real cost in US dollars (usage.cost)
  const cost = u.cost == null ? null : Number(u.cost);
  return {
    text,
    finish: c.finish_reason === 'length' ? 'length' : 'stop',
    usage: { inputTokens: Number(u.prompt_tokens) || 0, outputTokens: Number(u.completion_tokens) || 0 },
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

/**
 * One request. o: { key, model, instructions, parts: [{ type: 'text', label, text } | { type: 'image', mime, data }],
 * schema?, maxOutputTokens, timeoutMs } → { text, finish, usage, costUsd }
 */
async function complete(o) {
  const body = { model: o.model, messages: messages(o), max_completion_tokens: o.maxOutputTokens };
  if (o.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: schemaLib.strict(o.schema) } };
  const j = await requestJson({ url: `${base('openai', HOST)}/v1/chat/completions`, headers: headers(o.key), body, timeoutMs: o.timeoutMs, secrets: [o.key] });
  return answer(j);
}

module.exports = { id: 'openai', HOST, listModels, complete, messages, answer, NOT_CHAT_RE };
