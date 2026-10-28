'use strict';

// HTTP for the provider adapters: GateControl's own outgoing way (global
// fetch) to the fixed host of each provider — never the plugin network
// policy. No new dependency. A test run (NODE_ENV=test) never reaches a
// provider: only a base URL a test set (_testBase, a local stub) is used,
// any other call ends before a connection is made.

const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

const testBase = {}; // provider id → 'http://127.0.0.1:<port>' (tests only)

class ProviderError extends Error {
  /**
   * @param {'timeout'|'rate'|'server'|'network'|'auth'|'client'|'invalid'|'test_mode'} kind
   */
  constructor(kind, message, status) {
    super(message || kind);
    this.kind = kind;
    this.status = status || null;
  }

  /** Worth one try at the fallback provider: a timeout, 429, 5xx or no connection — never 400/401/403. */
  get retryable() { return this.kind === 'timeout' || this.kind === 'rate' || this.kind === 'server' || this.kind === 'network'; }
}

function testMode() { return process.env.NODE_ENV === 'test'; }

/** The base URL of a provider: its fixed host, in a test run only the stub a test set. */
function base(provider, fixed) {
  if (testMode()) {
    if (!testBase[provider]) throw new ProviderError('test_mode', 'no provider is contacted in a test run');
    return testBase[provider];
  }
  return fixed;
}

/** Remove every secret from a provider's message (the key itself, bearer values, key= query parameters). */
function scrub(text, secrets) {
  let s = String(text == null ? '' : text);
  for (const k of secrets || []) if (k && k.length >= 4) s = s.split(k).join('[REDACTED]');
  s = s.replace(/(bearer\s+)[^\s"',;]+/gi, '$1[REDACTED]').replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]');
  return s.slice(0, 300);
}

function kindOf(status) {
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  return 'client';
}

/** A provider's error text from its JSON answer (OpenAI / Anthropic / Gemini / OpenRouter shapes). */
function errorText(json, text) {
  const e = json && json.error;
  if (e && typeof e === 'object') return e.message || e.type || e.status || JSON.stringify(e).slice(0, 200);
  if (typeof e === 'string') return e;
  return String(text || '').slice(0, 200);
}

/**
 * One JSON request. → parsed JSON of a 2xx answer; ProviderError otherwise.
 * @param {{ url: string, method?: string, headers?: object, body?: object, timeoutMs: number, secrets?: string[] }} o
 */
async function requestJson(o) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, o.timeoutMs));
  let res;
  let text;
  try {
    res = await fetch(o.url, {
      method: o.method || (o.body ? 'POST' : 'GET'),
      headers: { accept: 'application/json', ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.headers || {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
      redirect: 'error',
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > RESPONSE_MAX_BYTES) throw new ProviderError('invalid', 'answer too large');
    text = buf.toString('utf8');
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (ctrl.signal.aborted) throw new ProviderError('timeout', 'the provider did not answer in time');
    throw new ProviderError('network', scrub(`provider not reachable: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`, o.secrets));
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new ProviderError(kindOf(res.status), scrub(`${res.status}: ${errorText(json, text)}`, o.secrets), res.status);
  if (!json || typeof json !== 'object') throw new ProviderError('invalid', 'the provider sent no JSON');
  return json;
}

/** Text parts of the input as one block: "<label>:\n<text>". */
function textOf(part) {
  return part.label ? `${part.label}:\n${part.text}` : part.text;
}

module.exports = { requestJson, base, scrub, textOf, ProviderError, testBase, testMode, RESPONSE_MAX_BYTES };
