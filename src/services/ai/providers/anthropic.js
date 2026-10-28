'use strict';

// Anthropic (api.anthropic.com): the Messages API. A structured answer is a
// forced tool call whose input schema is the plugin's schema; pictures are
// base64 image blocks.

const { requestJson, base, textOf, ProviderError } = require('./http');
const schemaLib = require('../schema');

const HOST = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const TOOL = 'result';

function headers(key) { return { 'x-api-key': key, 'anthropic-version': VERSION }; }

async function listModels(key, { timeoutMs = 15000 } = {}) {
  const j = await requestJson({ url: `${base('anthropic', HOST)}/v1/models?limit=1000`, headers: headers(key), timeoutMs, secrets: [key] });
  const list = Array.isArray(j.data) ? j.data : [];
  return list.filter((m) => m && typeof m.id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id }));
}

async function complete(o) {
  const content = o.parts.map((p) => (p.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
    : { type: 'text', text: textOf(p) }));
  const body = { model: o.model, max_tokens: o.maxOutputTokens, system: o.instructions, messages: [{ role: 'user', content }] };
  if (o.schema) {
    body.tools = [{ name: TOOL, description: 'Return the result.', input_schema: schemaLib.plain(o.schema) }];
    body.tool_choice = { type: 'tool', name: TOOL };
  }
  const j = await requestJson({ url: `${base('anthropic', HOST)}/v1/messages`, headers: headers(o.key), body, timeoutMs: o.timeoutMs, secrets: [o.key] });
  const blocks = Array.isArray(j.content) ? j.content : [];
  let text;
  if (o.schema) {
    const tool = blocks.find((b) => b && b.type === 'tool_use' && b.name === TOOL);
    // without the tool call a JSON text block still counts (checked against the schema afterwards)
    text = tool ? JSON.stringify(tool.input) : blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  } else {
    text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  }
  if (!blocks.length) throw new ProviderError('invalid', 'the provider sent no answer');
  const u = j.usage || {};
  return {
    text,
    finish: j.stop_reason === 'max_tokens' ? 'length' : 'stop',
    usage: { inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0), outputTokens: Number(u.output_tokens) || 0 },
    costUsd: null,
  };
}

module.exports = { id: 'anthropic', HOST, listModels, complete };
