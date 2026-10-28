'use strict';

// Google Gemini (generativelanguage.googleapis.com): generateContent with a
// response schema and JSON output; pictures as inline data. The key goes in
// the x-goog-api-key header, never into the URL.

const { requestJson, base, textOf, ProviderError } = require('./http');
const schemaLib = require('../schema');

const HOST = 'https://generativelanguage.googleapis.com';
const MODEL_RE = /^[A-Za-z0-9._-]{1,128}$/;

function headers(key) { return { 'x-goog-api-key': key }; }

async function listModels(key, { timeoutMs = 15000 } = {}) {
  const j = await requestJson({ url: `${base('gemini', HOST)}/v1beta/models?pageSize=1000`, headers: headers(key), timeoutMs, secrets: [key] });
  const list = Array.isArray(j.models) ? j.models : [];
  return list.filter((m) => m && typeof m.name === 'string' && Array.isArray(m.supportedGenerationMethods)
    && m.supportedGenerationMethods.includes('generateContent') && !/embed/i.test(m.name))
    .map((m) => {
      const id = m.name.replace(/^models\//, '');
      return { id, name: typeof m.displayName === 'string' && m.displayName ? m.displayName : id };
    })
    .filter((m) => MODEL_RE.test(m.id));
}

async function complete(o) {
  if (!MODEL_RE.test(String(o.model || ''))) throw new ProviderError('client', 'invalid model');
  const parts = o.parts.map((p) => (p.type === 'image' ? { inlineData: { mimeType: p.mime, data: p.data } } : { text: textOf(p) }));
  const generationConfig = { maxOutputTokens: o.maxOutputTokens };
  if (o.schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schemaLib.gemini(o.schema);
  }
  const body = { systemInstruction: { parts: [{ text: o.instructions }] }, contents: [{ role: 'user', parts }], generationConfig };
  const url = `${base('gemini', HOST)}/v1beta/models/${encodeURIComponent(o.model)}:generateContent`;
  const j = await requestJson({ url, headers: headers(o.key), body, timeoutMs: o.timeoutMs, secrets: [o.key] });
  const c = Array.isArray(j.candidates) ? j.candidates[0] : null;
  if (!c) {
    const blocked = j.promptFeedback && j.promptFeedback.blockReason;
    throw new ProviderError(blocked ? 'client' : 'invalid', blocked ? `the request was blocked (${String(blocked).slice(0, 40)})` : 'the provider sent no answer');
  }
  const text = (c.content && Array.isArray(c.content.parts) ? c.content.parts : []).map((p) => (p && typeof p.text === 'string' && !p.thought ? p.text : '')).join('');
  const u = j.usageMetadata || {};
  return {
    text,
    finish: c.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
    usage: { inputTokens: Number(u.promptTokenCount) || 0, outputTokens: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) },
    costUsd: null,
  };
}

module.exports = { id: 'gemini', HOST, listModels, complete };
