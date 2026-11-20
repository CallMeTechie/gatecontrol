'use strict';

/**
 * "Zertifikat für die Namen" (Einstellungen › VPN & Netzwerk): one wildcard
 * certificate `*.<zone>` for the own zone of the device names ("Namen im VPN",
 * services/vpnNames.js), obtained from Let's Encrypt with the ACME DNS-01
 * challenge. The server writes a short-lived TXT record at the admin's DNS
 * provider for every issuance — no name of the zone needs a public record or
 * has to be reachable from outside, and the public certificate logs show
 * only `*.<zone>`.
 *
 * Settings (all in `settings`):
 *   vpn_cert.provider               catalog id below ('' = off)
 *   vpn_cert.credentials_encrypted  JSON { field: value }, AES-256-GCM (utils/crypto)
 *   vpn_cert.saved_at               when the credentials were stored (ISO)
 *   vpn_cert.zone                   the zone the setup was made for — a changed
 *                                   zone ("Namen im VPN") needs a new setup
 *   vpn_cert.delegate               CNAME target of _acme-challenge.<zone> ('' = none)
 *   vpn_cert.propagation_delay      seconds Caddy waits before checking the record
 *   vpn_cert.suspended              JSON { at, error } — Caddy refused the provider config
 *   vpn_cert.last_test              JSON of the last connection test (no values)
 *
 * Way to Caddy without cleartext in the config: the credentials are decrypted
 * and written one file per field under <caddy data>/secrets/dns/ (dir 0700,
 * files 0600, atomic, no trailing newline); the Caddy config names them as
 * `{file.<path>}` placeholders, which every provider module resolves itself.
 * runtime.json, the admin API, Caddy's autosave and support bundles never
 * carry a credential. Every error text shown or logged is redacted against
 * the stored values.
 *
 * Without a provider nothing of this exists: no policy, no files, no test.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const dnsPromises = require('node:dns').promises;
const settings = require('./settings');
const config = require('../../config/default');
const { encrypt, decrypt } = require('../utils/crypto');
const { atomicWrite } = require('../utils/fs');

function log() { return require('../utils/logger'); }
function vpnNames() { return require('./vpnNames'); }
function tlsGuard() { return require('./tlsGuard'); }
function hasFeature(f) { try { return require('./license').hasFeature(f); } catch { return false; } }

const KEY = {
  provider: 'vpn_cert.provider',
  credentials: 'vpn_cert.credentials_encrypted',
  savedAt: 'vpn_cert.saved_at',
  zone: 'vpn_cert.zone',
  delegate: 'vpn_cert.delegate',
  delay: 'vpn_cert.propagation_delay',
  suspended: 'vpn_cert.suspended',
  lastTest: 'vpn_cert.last_test',
};

const FEATURE = 'internal_dns';
const DEFAULT_DELAY = 60;
const MAX_DELAY = 900;
const PROPAGATION_TIMEOUT = '15m';
const TEST_TIMEOUT = '10m';
const TEST_KILL_MS = 12 * 60 * 1000;
const MAX_FIELD_LEN = 4096;
const RENEW_DAYS = 30; // Caddy renews 30 days ahead; "Jetzt erneuern" only below that

// ─── Name checks (no backtracking regex on input) ──────────

const LABEL_CHARS = /^[a-z0-9_-]+$/;

/** A DNS name of two or more labels (labels may start with `_`). */
function validName(name) {
  const n = String(name || '');
  if (!n || n.length > 253) return false;
  const labels = n.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && LABEL_CHARS.test(l) && l[0] !== '-' && l[l.length - 1] !== '-');
}

/** host, host:port, IPv4[:port] or [IPv6][:port] of a DNS server (RFC 2136). */
function validServer(v) {
  let host = String(v || '');
  let port = null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    const rest = host.slice(end + 1);
    if (rest && !rest.startsWith(':')) return false;
    port = rest ? rest.slice(1) : null;
    host = host.slice(1, end);
    if (!require('node:net').isIPv6(host)) return false;
  } else {
    const i = host.lastIndexOf(':');
    if (i >= 0) { port = host.slice(i + 1); host = host.slice(0, i); }
    if (!require('node:net').isIPv4(host) && !validName(host.toLowerCase())) return false;
  }
  if (port !== null && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return false;
  return true;
}

function validHttpsUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !/\s/.test(String(v));
  } catch { return false; }
}

// ─── Catalog ───────────────────────────────────────────────

// Field kinds: secret (password input, never shown again), text, select.
// `file: false` — the module does not resolve placeholders for this field, it
// goes into the config as plain value (only non-secret parts).
// scope: what the credential may change — all | account | project | user |
//   zone | txt (shown as rights hint); prefer_delegation: the hint
//   "besser Weiterleitung" (decision 4); ns: nameserver patterns for the
//   provider suggestion.
const PROVIDERS = Object.freeze({
  desec_delegated: {
    module: 'desec', delegated: true, recommended: true, scope: 'txt',
    fields: [{ key: 'token', kind: 'secret', required: true }],
  },
  hetzner: {
    module: 'hetzner', scope: 'project',
    fields: [{ key: 'api_token', kind: 'secret', required: true }],
    ns: [/\.ns\.hetzner\.(com|de)$/, /^(hydrogen|oxygen|helium)\.ns\.hetzner\./],
  },
  ionos: {
    module: 'ionos', scope: 'all', prefer_delegation: true,
    fields: [{ key: 'api_token', kind: 'secret', required: true, pattern: /^[^.\s]+\.[^.\s]+$/ }],
    ns: [/\.ui-dns\.(com|de|org|biz)$/],
  },
  netcup: {
    module: 'netcup', scope: 'all', prefer_delegation: true,
    fields: [
      { key: 'customer_number', kind: 'text', required: true, pattern: /^\d{1,12}$/ },
      { key: 'api_key', kind: 'secret', required: true },
      { key: 'api_password', kind: 'secret', required: true },
    ],
    ns: [/\.netcup\.net$/],
  },
  inwx: {
    module: 'inwx', scope: 'account', prefer_delegation: true,
    fields: [
      { key: 'username', kind: 'text', required: true },
      { key: 'password', kind: 'secret', required: true },
      { key: 'shared_secret', kind: 'secret', required: false },
    ],
    ns: [/\.inwx\.(de|eu|net|ch|com)$/],
  },
  allinkl: {
    module: 'allinkl', scope: 'account', prefer_delegation: true,
    fields: [
      { key: 'kas_username', kind: 'text', required: true },
      { key: 'kas_password', kind: 'secret', required: true },
    ],
    ns: [/\.kasserver\.com$/],
  },
  ovh: {
    module: 'ovh', scope: 'zone',
    fields: [
      { key: 'endpoint', kind: 'select', required: true, options: ['ovh-eu', 'ovh-ca', 'ovh-us', 'kimsufi-eu', 'kimsufi-ca', 'soyoustart-eu', 'soyoustart-ca'] },
      { key: 'application_key', kind: 'secret', required: true },
      { key: 'application_secret', kind: 'secret', required: true },
      { key: 'consumer_key', kind: 'secret', required: true },
    ],
    ns: [/\.ovh\.(net|ca|us)$/],
  },
  desec: {
    module: 'desec', scope: 'txt',
    fields: [{ key: 'token', kind: 'secret', required: true }],
    ns: [/\.desec\.(io|org)$/],
  },
  cloudflare: {
    module: 'cloudflare', scope: 'zone',
    // the module refuses any other shape at provisioning (and would print the value)
    fields: [{ key: 'api_token', kind: 'secret', required: true, pattern: /^(?:[A-Za-z0-9_-]{35,50}|cf(?:ut|at)_[A-Za-z0-9_-]{32,256})$/ }],
    ns: [/\.ns\.cloudflare\.com$/],
  },
  rfc2136: {
    module: 'rfc2136', scope: 'txt',
    fields: [
      { key: 'server', kind: 'text', required: true, check: validServer },
      { key: 'key_name', kind: 'text', required: true, pattern: /^[A-Za-z0-9._-]{1,253}$/ },
      { key: 'key_alg', kind: 'select', required: true, options: ['hmac-sha256', 'hmac-sha384', 'hmac-sha512', 'hmac-sha224', 'hmac-sha1'] },
      { key: 'key', kind: 'secret', required: true, pattern: /^[A-Za-z0-9+/=]{8,}$/ },
    ],
  },
  acmedns: {
    module: 'acmedns', scope: 'txt', own_cname: true,
    fields: [
      { key: 'server_url', kind: 'text', required: true, file: false, check: validHttpsUrl },
      { key: 'username', kind: 'text', required: true, file: false, pattern: /^[A-Za-z0-9-]{1,64}$/ },
      { key: 'password', kind: 'secret', required: true },
      { key: 'subdomain', kind: 'text', required: true, file: false, pattern: /^[A-Za-z0-9-]{1,64}$/ },
      // the CNAME target the registration returned (fulldomain)
      { key: 'fulldomain', kind: 'text', required: true, file: false, check: (v) => validName(v.toLowerCase()) },
    ],
  },
});

const ORDER = ['desec_delegated', 'hetzner', 'ionos', 'netcup', 'inwx', 'allinkl', 'ovh', 'desec', 'cloudflare', 'rfc2136', 'acmedns'];

/** The catalog for the card (no values). */
function catalog() {
  return ORDER.map((id) => {
    const p = PROVIDERS[id];
    return {
      id,
      module: p.module,
      delegated: !!p.delegated,
      recommended: !!p.recommended,
      prefer_delegation: !!p.prefer_delegation,
      own_cname: !!p.own_cname,
      scope: p.scope,
      fields: p.fields.map((f) => ({ key: f.key, kind: f.kind, required: !!f.required, options: f.options || null })),
    };
  });
}

// ─── Stored settings ───────────────────────────────────────

function norm(h) { return String(h == null ? '' : h).trim().toLowerCase().replace(/\.$/, ''); }
function get(key, def = '') { try { return settings.get(key, def) ?? def; } catch { return def; } }
function parseJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

function providerId() {
  const id = String(get(KEY.provider, '') || '');
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? id : '';
}

function delay() {
  const n = parseInt(get(KEY.delay, String(DEFAULT_DELAY)), 10);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DELAY ? n : DEFAULT_DELAY;
}

/** The stored credentials → { values, error } (error: 'unreadable' with a foreign key). */
function storedCredentials() {
  const enc = get(KEY.credentials, '');
  if (!enc) return { values: {}, error: null };
  try {
    const obj = JSON.parse(decrypt(enc));
    return { values: obj && typeof obj === 'object' ? obj : {}, error: null };
  } catch {
    return { values: {}, error: 'unreadable' };
  }
}

// ─── Redaction ─────────────────────────────────────────────

function secretValues(values) {
  const out = new Set();
  for (const v of Object.values(values || {})) {
    const s = String(v == null ? '' : v).trim();
    if (s.length >= 4) out.add(s);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every stored (and given) credential value in a text by ***. */
function redact(text, extra = null) {
  if (text == null) return text;
  let s = String(text);
  let vals = [];
  try { vals = secretValues(storedCredentials().values); } catch { vals = []; }
  if (extra) vals = [...new Set([...vals, ...secretValues(extra)])].sort((a, b) => b.length - a.length);
  for (const v of vals) s = s.split(v).join('***');
  return s;
}

// ─── Secret files for Caddy ────────────────────────────────

function secretsDir() { return path.join(config.caddy.dataDir || '/data/caddy', 'secrets', 'dns'); }
function placeholder(field, dir = secretsDir()) { return `{file.${path.join(dir, field)}}`; }

/** Remove every file of the directory (switching off, a provider change). */
function removeSecretFiles(keep = new Set()) {
  let names = [];
  try { names = fs.readdirSync(secretsDir()); } catch { return; }
  for (const n of names) {
    if (keep.has(n)) continue;
    try { fs.unlinkSync(path.join(secretsDir(), n)); } catch { /* gone */ }
  }
}

/**
 * Write the files of the stored credentials (only those the provider reads
 * via placeholder) and remove all others. Idempotent; a file that already
 * holds exactly the value is left alone. → true when all files are in place.
 */
function writeSecretFiles() {
  const id = providerId();
  if (!id) { removeSecretFiles(); return false; }
  const { values, error } = storedCredentials();
  if (error) return false;
  const p = PROVIDERS[id];
  const dir = secretsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const keep = new Set();
  for (const f of p.fields) {
    if (f.file === false) continue;
    const v = values[f.key];
    if (v == null || v === '') continue;
    keep.add(f.key);
    const file = path.join(dir, f.key);
    let same = false;
    try { same = fs.readFileSync(file, 'utf8') === String(v); } catch { same = false; }
    if (!same) atomicWrite(file, String(v), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  removeSecretFiles(keep);
  return p.fields.every((f) => !f.required || f.file === false || keep.has(f.key));
}

// ─── State ─────────────────────────────────────────────────

function zoneState() {
  const s = vpnNames().current();
  return { custom: s.custom, primary: s.primary, legacy: s.legacy, base: s.base };
}

function wildcardOf(zone) { return zone ? `*.${zone}` : null; }

function daysLeft(notAfter) {
  if (!notAfter) return null;
  const t = new Date(notAfter).getTime();
  return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86400000);
}

function tlsRow(host) {
  if (!host) return null;
  try { return tlsGuard().getRow(host); } catch { return null; }
}

/**
 * The state in effect.
 *   locked       — licence without internal_dns
 *   no_zone      — "Namen im VPN" has no own domain (gc.internal gets no certificate)
 *   off          — no provider
 *   zone_changed — set up for another zone; needs a new setup
 *   unreadable   — credentials from another GC_ENCRYPTION_KEY (restore)
 *   suspended    — Caddy refused the provider config
 *   paused       — the TLS guard stopped further attempts (attempt cap, CAA)
 *   failed       — the last attempt failed, Caddy keeps trying
 *   active       — a valid certificate is in Caddy's storage
 *   pending      — set up, the first certificate is being fetched
 */
function state() {
  const zone = zoneState();
  const id = providerId();
  const storedZone = norm(get(KEY.zone, ''));
  const wildcard = zone.custom ? wildcardOf(zone.primary) : null;
  const base = {
    licensed: hasFeature(FEATURE),
    zone: zone.custom ? zone.primary : null,
    legacy: zone.legacy,
    wildcard,
    provider: id || null,
    stored_zone: storedZone || null,
  };
  if (!base.licensed) return { ...base, state: 'locked' };
  if (!zone.custom) return { ...base, state: 'no_zone' };
  if (!id) return { ...base, state: 'off' };
  if (storedZone !== zone.primary) return { ...base, state: 'zone_changed' };
  if (storedCredentials().error) return { ...base, state: 'unreadable' };
  if (parseJson(get(KEY.suspended, ''))) return { ...base, state: 'suspended' };
  const row = tlsRow(wildcard);
  if (row && row.state === 'paused') return { ...base, state: 'paused' };
  const dl = row ? daysLeft(row.not_after) : null;
  if (row && row.state === 'issued' && dl != null && dl > 0) return { ...base, state: 'active' };
  if (row && row.state === 'failed') return { ...base, state: 'failed' };
  return { ...base, state: 'pending' };
}

/** Is the wildcard to be requested? (policy in the Caddy config) */
function wantsPolicy(st = state()) {
  return ['pending', 'active', 'failed'].includes(st.state);
}

/** The view for the API (never a credential value). */
function view() {
  const st = state();
  const id = providerId();
  const { values, error } = storedCredentials();
  const row = tlsRow(st.wildcard);
  const suspended = parseJson(get(KEY.suspended, ''));
  const p = id ? PROVIDERS[id] : null;
  return {
    ...st,
    enabled: !!id,
    delegate: get(KEY.delegate, '') || null,
    propagation_delay: delay(),
    saved_at: get(KEY.savedAt, '') || null,
    // which fields hold a value — the form shows "gespeichert" instead of the value
    fields_set: p && !error ? p.fields.filter((f) => values[f.key] != null && values[f.key] !== '').map((f) => f.key) : [],
    // plain, non-secret fields of the provider (acme-dns server, OVH endpoint …) may be shown again
    fields_plain: p && !error ? Object.fromEntries(p.fields.filter((f) => f.kind !== 'secret' && values[f.key]).map((f) => [f.key, String(values[f.key])])) : {},
    certificate: row ? {
      state: row.state || null,
      not_after: row.not_after || null,
      days_left: daysLeft(row.not_after),
      issuer: row.issuer || null,
      attempts: Number(row.attempts) || 0,
      max_attempts: (() => { try { return tlsGuard().maxAttempts(); } catch { return null; } })(),
      last_attempt_at: row.last_attempt_at || null,
      next_retry_at: row.next_retry_at || null,
      paused_reason: row.paused_reason || null,
      last_error_code: row.last_error_code || null,
      last_error: row.last_error ? redact(row.last_error) : null,
    } : null,
    suspended: suspended ? { at: suspended.at || null, error: redact(suspended.error || '') } : null,
    renew_possible: canRenew(st, row),
    last_test: parseJson(get(KEY.lastTest, '')),
    resolvers: config.caddy.dnsResolvers,
    catalog: catalog(),
  };
}

function canRenew(st, row) {
  if (['paused', 'failed', 'suspended'].includes(st.state)) return true;
  if (st.state === 'active') { const dl = row ? daysLeft(row.not_after) : null; return dl != null && dl <= RENEW_DAYS; }
  return false;
}

// ─── Challenge names ───────────────────────────────────────

/** The CNAME target as stored: `_acme-challenge.` is added to a bare zone. */
function normDelegate(raw) {
  const d = norm(raw);
  if (!d) return '';
  return d.startsWith('_acme-challenge.') ? d : `_acme-challenge.${d}`;
}


/**
 * Where the TXT record of the challenge (and of the test) lands.
 * → { record, lookup } — `lookup` is the public name that must CNAME to `record`
 *   (null when the record is written at the challenge name itself)
 */
function challengeNames(zone, id, values, delegate) {
  const challenge = `_acme-challenge.${zone}`;
  const p = PROVIDERS[id];
  if (p && p.own_cname) {
    const target = norm(values.fulldomain);
    return { record: target, lookup: challenge };
  }
  if (delegate) return { record: delegate, lookup: challenge };
  return { record: challenge, lookup: null };
}

// ─── Validation ────────────────────────────────────────────

function validationError(code, field = null) {
  const err = new Error(code);
  err.code = code;
  err.field = field;
  err.statusCode = 400;
  return err;
}

/**
 * Merge submitted fields over the stored ones (same provider: an empty or
 * missing field keeps its stored value — "Ändern" without typing everything
 * again) and check them. → values
 */
function mergeAndCheck(id, submitted) {
  const p = PROVIDERS[id];
  if (!p) throw validationError('provider_unknown', 'provider');
  const stored = id === providerId() ? storedCredentials().values : {};
  const values = {};
  const sub = submitted && typeof submitted === 'object' ? submitted : {};
  for (const f of p.fields) {
    let v = sub[f.key];
    v = v == null ? '' : String(v).trim();
    if (!v && stored[f.key] != null) v = String(stored[f.key]);
    if (!v) {
      if (f.required) throw validationError('field_required', f.key);
      continue;
    }
    // no line breaks (the files carry none); braces only where the value goes
    // into a file — an inline value would be read as a Caddy placeholder
    if (v.length > MAX_FIELD_LEN || /[\r\n\0]/.test(v) || (f.file === false && /[{}]/.test(v))) throw validationError('field_invalid', f.key);
    if (f.kind === 'select' && !f.options.includes(v)) throw validationError('field_invalid', f.key);
    if (f.pattern && !f.pattern.test(v)) throw validationError('field_invalid', f.key);
    if (f.check && !f.check(v)) throw validationError('field_invalid', f.key);
    values[f.key] = v;
  }
  return values;
}

function checkDelegate(id, raw) {
  const p = PROVIDERS[id];
  if (p.own_cname) return '';
  const d = normDelegate(raw);
  if (p.delegated && !d) throw validationError('delegate_required', 'delegate');
  if (d && !validName(d)) throw validationError('delegate_invalid', 'delegate');
  const zone = zoneState().primary;
  if (d && (d === `_acme-challenge.${zone}` || d.endsWith('.' + zone))) throw validationError('delegate_invalid', 'delegate');
  return d;
}

function checkDelay(raw) {
  if (raw == null || raw === '') return delay();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DELAY) throw validationError('delay_invalid', 'propagation_delay');
  return n;
}

function requireZone() {
  if (!hasFeature(FEATURE)) {
    const err = new Error('feature_not_available'); err.code = 'feature_not_available'; err.statusCode = 403; throw err;
  }
  const zone = zoneState();
  if (!zone.custom) throw validationError('no_zone');
  return zone;
}

// ─── Preflight (CAA) ───────────────────────────────────────

function allowedCaaIssuers() {
  const out = new Set(['letsencrypt.org']);
  try { if (config.caddy.acmeCa) out.add(new URL(config.caddy.acmeCa).hostname.toLowerCase()); } catch { /* not a URL */ }
  return out;
}

function caaPermits(value, allowed) {
  const v = String(value || '').split(';')[0].trim().toLowerCase();
  if (!v) return false;
  for (const a of allowed) if (v === a || a.endsWith('.' + v) || v.endsWith('.' + a)) return true;
  return false;
}

function preflightActive() {
  if (process.env.NODE_ENV !== 'test') return true;
  try { return require('./domains')._isResolverInjected(); } catch { return false; }
}

/**
 * CAA rule for a wildcard (RFC 8659): the closest set with records counts;
 * `issuewild` decides when present, else `issue`. → { ok, code, detail, ... }
 */
async function preflight(zone) {
  const result = {
    ok: true, code: 'ok', detail: null, checked_at: new Date().toISOString(),
    records: { a: [], aaaa: [], caa: [] }, server: { v4: null, v6: null }, caa_status: null, caa_suggestion: null,
  };
  if (!preflightActive()) return Object.assign(result, { detail: 'skipped (test environment without resolver)' });
  const domains = require('./domains');
  const labels = zone.split('.');
  let set = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const s = await domains.resolveCaa(labels.slice(i).join('.'));
    if (s === null) continue;
    if (s.length > 0) { set = s; break; }
  }
  result.records.caa = set;
  const allowed = allowedCaaIssuers();
  const wild = set.filter((r) => r.tag === 'issuewild');
  const issue = set.filter((r) => r.tag === 'issue');
  const rules = wild.length ? wild : issue;
  if (rules.length === 0) { result.caa_status = 'none'; return result; }
  if (rules.some((r) => caaPermits(r.value, allowed))) { result.caa_status = 'allows'; return result; }
  const base = labels.slice(-2).join('.');
  return Object.assign(result, {
    ok: false, code: 'caa_blocked', caa_status: 'blocks',
    detail: `CAA of ${zone} does not allow Let's Encrypt to issue a wildcard`,
    caa_suggestion: `${base}. CAA 0 issuewild "letsencrypt.org"`,
  });
}

// ─── Caddy ─────────────────────────────────────────────────

function providerConfig(id, values, { dir = secretsDir() } = {}) {
  const p = PROVIDERS[id];
  const out = { name: p.module };
  for (const f of p.fields) {
    const v = values[f.key];
    if (v == null || v === '') continue;
    out[f.key] = f.file === false ? String(v) : placeholder(f.key, dir);
  }
  return out;
}

/** Files of values in a fresh private directory (the test with unsaved values). → dir */
function writeTempSecretFiles(id, values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-dnstest-'));
  fs.chmodSync(dir, 0o700);
  for (const f of PROVIDERS[id].fields) {
    if (f.file === false) continue;
    const v = values[f.key];
    if (v == null || v === '') continue;
    atomicWrite(path.join(dir, f.key), String(v), { mode: 0o600 });
  }
  return dir;
}

/**
 * The parts for the Caddy config, or null when no wildcard is to be requested.
 * → { subject, zone, policy, covers(host) }
 */
function caddyTls({ email, acmeCa } = {}) {
  const st = state();
  if (!wantsPolicy(st)) return null;
  let filesOk = false;
  try { filesOk = writeSecretFiles(); } catch (err) { log().warn({ err: redact(err.message) }, 'vpn cert: secret files not written'); }
  if (!filesOk) return null;
  const id = providerId();
  const { values } = storedCredentials();
  const delegate = PROVIDERS[id].own_cname ? '' : get(KEY.delegate, '');
  const issuer = { module: 'acme' };
  if (email) issuer.email = email;
  if (acmeCa) issuer.ca = acmeCa;
  const dns = {
    provider: providerConfig(id, values),
    propagation_delay: `${delay()}s`,
    propagation_timeout: PROPAGATION_TIMEOUT,
    resolvers: [...config.caddy.dnsResolvers],
  };
  if (delegate) dns.override_domain = delegate;
  issuer.challenges = { http: { disabled: true }, 'tls-alpn': { disabled: true }, dns };
  const zone = st.zone;
  return {
    subject: st.wildcard,
    zone,
    policy: { subjects: [st.wildcard], issuers: [issuer] },
    // one level only: nas-web.<zone> yes, a.b.<zone> no
    covers(host) {
      const h = norm(host);
      if (!h.endsWith('.' + zone)) return false;
      const label = h.slice(0, -(zone.length + 1));
      return !!label && !label.includes('.') && label !== '*';
    },
  };
}

/** Does a built Caddy config request the wildcard? */
function inConfig(cfg) {
  const automate = cfg && cfg.apps && cfg.apps.tls && cfg.apps.tls.certificates && cfg.apps.tls.certificates.automate;
  return Array.isArray(automate) && automate.some((s) => String(s).startsWith('*.'));
}

/** Caddy refused the config with the provider in it: stop asking until the admin acts. */
function suspend(message) {
  const error = redact(String(message || '')).slice(0, 2000);
  settings.set(KEY.suspended, JSON.stringify({ at: new Date().toISOString(), error }));
  log().warn({ error }, 'vpn cert: Caddy refused the DNS provider configuration — wildcard left out');
  activityLog('tls_vpn_cert_suspended', 'Wildcard certificate of the VPN names stopped: Caddy refused the DNS provider configuration', 'warning', { error });
}

function unsuspend() { settings.set(KEY.suspended, ''); }

function syncCaddy() { return require('./caddyConfig').syncToCaddy(); }

function activityLog(type, message, severity, details, ipAddress = null) {
  try { require('./activity').log(type, message, { source: ipAddress ? 'admin' : 'system', ipAddress, severity, details }); }
  catch { /* best-effort */ }
}

// ─── Save / switch off / renew ─────────────────────────────

/**
 * Store a provider with its credentials and request the certificate.
 * input: { provider, credentials, delegate, propagation_delay }
 */
async function save(input = {}, { ip = null } = {}) {
  const zone = requireZone();
  const id = String(input.provider || '');
  if (!PROVIDERS[id]) throw validationError('provider_unknown', 'provider');
  const values = mergeAndCheck(id, input.credentials);
  const delegate = checkDelegate(id, input.delegate);
  const d = checkDelay(input.propagation_delay);
  const wildcard = wildcardOf(zone.primary);

  const changedProvider = providerId() !== id;
  settings.set(KEY.provider, id);
  settings.set(KEY.credentials, encrypt(JSON.stringify(values)));
  settings.set(KEY.savedAt, new Date().toISOString());
  settings.set(KEY.zone, zone.primary);
  settings.set(KEY.delegate, delegate);
  settings.set(KEY.delay, String(d));
  unsuspend();
  writeSecretFiles();

  // a new setup starts with fresh counters; the CAA rule may keep it paused
  const tg = tlsGuard();
  const before = tg.getRow(wildcard);
  if (before && (before.state === 'paused' || before.state === 'failed')) {
    tg.writeRow(wildcard, { state: before.not_after ? 'issued' : 'pending', attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null });
  }
  try {
    const pf = await preflight(zone.primary);
    tg.recordPreflight(wildcard, pf);
  } catch (err) { log().warn({ err: err.message }, 'vpn cert: preflight failed'); }

  activityLog('tls_vpn_cert_saved', `Wildcard certificate for ${wildcard}: DNS provider ${id} saved`, 'info',
    { provider: id, zone: zone.primary, delegated: !!delegate, provider_changed: changedProvider }, ip);
  await syncCaddy();
  return view();
}

/** Switch off: settings, files and the status row go; Caddy forgets the policy. */
async function disable({ ip = null } = {}) {
  const st = state();
  const zones = [st.zone, st.stored_zone].filter(Boolean);
  for (const k of [KEY.provider, KEY.credentials, KEY.savedAt, KEY.zone, KEY.delegate, KEY.suspended]) settings.set(k, '');
  removeSecretFiles();
  try { tlsGuard().forgetHosts(zones.map(wildcardOf)); } catch { /* none */ }
  if (st.provider) activityLog('tls_vpn_cert_disabled', 'Wildcard certificate of the VPN names switched off', 'info', { provider: st.provider, zone: st.zone }, ip);
  await syncCaddy();
  return view();
}

/** "Jetzt erneuern" / "Erneut versuchen": check again, reset the counters, ask Caddy again. */
async function renew({ ip = null } = {}) {
  requireZone();
  const st = state();
  const row = tlsRow(st.wildcard);
  if (!st.provider || st.state === 'zone_changed' || st.state === 'unreadable') throw validationError('not_configured');
  if (!canRenew(st, row)) { const err = validationError('renew_not_needed'); err.statusCode = 409; throw err; }
  const tg = tlsGuard();
  const pf = await preflight(st.zone);
  if (!pf.ok) {
    tg.recordPreflight(st.wildcard, pf);
    const err = validationError('preflight_failed'); err.statusCode = 409; err.result = pf; throw err;
  }
  unsuspend();
  writeSecretFiles();
  tg.writeRow(st.wildcard, {
    state: row && row.not_after && daysLeft(row.not_after) > 0 ? 'issued' : 'pending',
    attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null,
    preflight_json: JSON.stringify(pf),
  });
  activityLog('tls_vpn_cert_renew', `Wildcard certificate for ${st.wildcard}: new attempt requested`, 'info', { zone: st.zone }, ip);
  await syncCaddy();
  return view();
}

/** After a backup restore: files from the restored settings (or none), no stale suspension. */
function applyAfterRestore() {
  try { unsuspend(); } catch { /* no db */ }
  try {
    if (providerId() && !storedCredentials().error) writeSecretFiles();
    else removeSecretFiles();
  } catch (err) { log().warn({ err: redact(err.message) }, 'vpn cert: secret files not rewritten after restore'); }
}

// ─── Provider suggestion ───────────────────────────────────

const _detectCache = new Map(); // base → { at, result }
const DETECT_TTL_MS = 60 * 60 * 1000;

let _nsResolver = null; // tests
function _setNsResolverForTest(fn) { if (process.env.NODE_ENV === 'test') _nsResolver = fn; }

async function resolveNs(base) {
  if (_nsResolver) return _nsResolver(base);
  if (process.env.NODE_ENV === 'test') return [];
  const r = new dnsPromises.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(config.caddy.dnsResolvers.map((s) => s.replace(/:53$/, '')));
  return r.resolveNs(base);
}

/** The provider suggested by the nameservers of the base domain. → { base, nameservers, provider } */
async function detect() {
  const base = zoneState().base;
  if (!base) return null;
  const hit = _detectCache.get(base);
  if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit.result;
  let ns = [];
  try { ns = (await resolveNs(base)).map(norm); } catch { ns = []; }
  let provider = null;
  for (const id of ORDER) {
    const pats = PROVIDERS[id].ns || [];
    if (ns.some((n) => pats.some((re) => re.test(n)))) { provider = id; break; }
  }
  const result = { base, nameservers: ns.sort(), provider };
  _detectCache.set(base, { at: Date.now(), result });
  return result;
}

// ─── Connection test (caddy gc-dnstest) ────────────────────

const STEPS = ['login', 'zone', 'write', 'visible', 'delete'];
let _test = null; // { id, running, started_at, finished_at, steps, result, child }

function suggestedDelay(ms) {
  if (!Number.isFinite(ms)) return null;
  const s = Math.ceil((ms / 1000) * 1.5) + 15;
  return Math.min(MAX_DELAY, Math.max(30, Math.ceil(s / 10) * 10));
}

function testView() {
  if (!_test) return null;
  return {
    id: _test.id,
    running: _test.running,
    started_at: _test.started_at,
    finished_at: _test.finished_at,
    provider: _test.provider,
    record: _test.record,
    lookup: _test.lookup,
    steps: STEPS.map((s) => _test.steps[s] || { step: s, status: 'waiting' }),
    result: _test.result,
  };
}

/**
 * Start the connection test. input: { provider, credentials, delegate } —
 * missing fields come from the stored setup (same provider). Writes a TXT
 * record with a unique value at the real challenge name (or the CNAME target),
 * waits until the authoritative nameservers serve it and deletes it again.
 * Let's Encrypt is not asked. Nothing is saved but the outcome (no values).
 */
function startTest(input = {}, { ip = null } = {}) {
  const zone = requireZone();
  if (_test && _test.running) { const err = new Error('test_running'); err.code = 'test_running'; err.statusCode = 409; throw err; }
  const id = String(input.provider || providerId() || '');
  if (!PROVIDERS[id]) throw validationError('provider_unknown', 'provider');
  const values = mergeAndCheck(id, input.credentials);
  const delegate = checkDelegate(id, input.delegate === undefined && id === providerId() ? get(KEY.delegate, '') : input.delegate);
  const names = challengeNames(zone.primary, id, values, delegate);
  // the same way to the module as in the running server: files + {file.*}
  const tmpDir = writeTempSecretFiles(id, values);
  const dropTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* gone */ } };
  const request = {
    provider: providerConfig(id, values, { dir: tmpDir }),
    record: names.record,
    value: 'gc-test-' + crypto.randomBytes(12).toString('hex'),
    resolvers: [...config.caddy.dnsResolvers],
    propagation_timeout: TEST_TIMEOUT,
    interval: '5s',
  };
  if (names.lookup) request.lookup = names.lookup;

  const test = {
    id: crypto.randomBytes(8).toString('hex'),
    running: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    provider: id,
    record: names.record,
    lookup: names.lookup,
    steps: {},
    result: null,
    child: null,
  };
  _test = test;
  const clean = (s) => redact(s, values);

  const finish = (result) => {
    if (!test.running) return;
    dropTmp();
    test.running = false;
    test.finished_at = new Date().toISOString();
    test.result = {
      ok: !!result.ok,
      code: result.code || null,
      error: result.error ? clean(result.error) : null,
      zone: result.zone || null,
      nameservers: Array.isArray(result.nameservers) ? result.nameservers : [],
      propagation_ms: Number.isFinite(result.propagation_ms) ? result.propagation_ms : null,
      suggested_delay: result.ok ? suggestedDelay(result.propagation_ms) : null,
    };
    try {
      settings.set(KEY.lastTest, JSON.stringify({
        at: test.finished_at, provider: id, record: test.record, lookup: test.lookup,
        steps: STEPS.map((s) => ({ step: s, status: (test.steps[s] || {}).status || 'waiting' })),
        ...test.result,
      }));
    } catch { /* best effort */ }
    activityLog('tls_vpn_cert_test', `DNS provider test for the VPN names: ${test.result.ok ? 'passed' : 'failed'}`, test.result.ok ? 'info' : 'warning',
      { provider: id, zone: zone.primary, code: test.result.code }, ip);
  };

  let child;
  try {
    child = spawn(config.caddy.bin || 'caddy', ['gc-dnstest'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' } });
  } catch (err) {
    finish({ ok: false, code: 'caddy_unavailable', error: err.message });
    return testView();
  }
  test.child = child;
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TEST_KILL_MS);
  if (killer.unref) killer.unref();
  let buf = '';
  let final = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 1 << 20) buf = buf.slice(-(1 << 16));
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && obj.done) { final = obj; continue; }
      if (obj && STEPS.includes(obj.step)) {
        test.steps[obj.step] = {
          step: obj.step,
          status: ['ok', 'fail', 'skip'].includes(obj.status) ? obj.status : 'fail',
          ms: Number.isFinite(obj.ms) ? obj.ms : null,
          code: obj.code || null,
          detail: obj.detail ? clean(obj.detail) : null,
          error: obj.error ? clean(obj.error) : null,
        };
      }
    }
  });
  child.stderr.on('data', () => { /* Caddy's own log lines; never shown (may name values) */ });
  child.on('error', (err) => {
    clearTimeout(killer);
    finish({ ok: false, code: err && err.code === 'ENOENT' ? 'caddy_unavailable' : 'test_failed', error: err.message });
  });
  child.on('close', (code) => {
    clearTimeout(killer);
    if (final) finish(final);
    else finish({ ok: false, code: 'test_failed', error: `gc-dnstest ended without result (exit ${code})` });
  });
  child.stdin.on('error', () => { /* process gone early */ });
  child.stdin.end(JSON.stringify(request));
  return testView();
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  if (_test && _test.child) { try { _test.child.kill('SIGKILL'); } catch { /* gone */ } }
  _test = null;
  _detectCache.clear();
}

module.exports = {
  KEY, PROVIDERS, ORDER, FEATURE,
  catalog, state, view, wantsPolicy,
  save, disable, renew, applyAfterRestore,
  caddyTls, inConfig, suspend, unsuspend,
  writeSecretFiles, removeSecretFiles, secretsDir,
  redact, preflight, detect, challengeNames, normDelegate,
  startTest, testView, suggestedDelay,
  _setNsResolverForTest, _resetForTest,
};
