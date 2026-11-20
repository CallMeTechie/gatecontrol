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
  served: 'vpn_cert.served_zone',
  share: 'vpn_cert.share_enabled',
  sharePeers: 'vpn_cert.share_peers',
  shareUsed: 'vpn_cert.share_used',
  shareFp: 'vpn_cert.share_fingerprint',
  shareFpAt: 'vpn_cert.share_fingerprint_at',
  links: 'vpn_cert.links_new',
  deviceLabel: 'vpn_cert.device_label',
  // once per server: a main key that was passed on before the device area existed gets renewed
  mainKeyMigrated: 'vpn_cert.main_key_migrated',
  mainKeyRenewedAt: 'vpn_cert.main_key_renewed_at',
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
  // the card shows what is served right now (not the few seconds old cache)
  servedZone({ fresh: true });
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
    used_by: usedBy(st.zone),
    share: shareView(),
    links: linksView(st),
    last_test: parseJson(get(KEY.lastTest, '')),
    resolvers: config.caddy.dnsResolvers,
    catalog: catalog(),
  };
}

// ─── The names served with the wildcard ────────────────────

// Fixed names of the server that also reach the management (GC_BASE_URL
// stays its main address): server.<zone>, gc-server.<zone>
const MANAGEMENT_LABELS = ['server', 'gc-server'];

let _served = { at: 0, zone: null };
const SERVED_TTL_MS = 5000;

/**
 * The zone whose names the server answers with the wildcard right now: the
 * policy is in the Caddy config and a valid certificate is in storage —
 * without one, home.<zone> and the management names would fail every
 * TLS handshake. null otherwise. Cached for a few seconds (the portal asks on
 * every request); refreshServed() drops the cache.
 */
function servedZone({ fresh = false } = {}) {
  if (!fresh && Date.now() - _served.at < SERVED_TTL_MS) return _served.zone;
  let zone = null;
  try {
    const st = state();
    if (st.state === 'active' || st.state === 'failed') {
      const row = tlsRow(st.wildcard);
      const dl = row ? daysLeft(row.not_after) : null;
      if (dl != null && dl > 0 && wantsPolicy(st)) zone = st.zone;
    }
  } catch { zone = null; }
  _served = { at: Date.now(), zone };
  return zone;
}

/** server.<zone> and gc-server.<zone> while the wildcard is served, else []. */
function managementHosts() {
  const z = servedZone();
  return z ? MANAGEMENT_LABELS.map((l) => `${l}.${z}`) : [];
}

/**
 * After anything that may change servedZone() (certificate issued, renewed,
 * expired or paused; setup, switch off, zone change, restore): when it did
 * change, the hosts file gets home.<zone>, Caddy the portal and management
 * names, and the apps are told to fetch their configuration (portalUrl).
 * Never throws. → whether it changed
 */
function refreshServed(reason = '') {
  const before = String(get(KEY.served, '') || '') || null;
  const now = servedZone({ fresh: true });
  if (before === now) return false;
  try { settings.set(KEY.served, now || ''); } catch { /* no db */ }
  log().info({ before, now, reason }, 'vpn cert: names served with the wildcard changed');
  try { require('./dns').rebuildNow(); } catch (err) { log().warn({ err: err.message }, 'vpn cert: hosts file not rebuilt'); }
  try { syncCaddy().catch((err) => log().warn({ err: redact(err.message) }, 'vpn cert: Caddy not synced')); } catch { /* none */ }
  try { require('./notify/control').configChanged({ all: true }); } catch { /* best effort */ }
  if (now) activityLog('tls_vpn_cert_serving', `Portal and management also under home.${now} / server.${now}`, 'info', { zone: now });
  return true;
}

// ─── Passing certificate and key on (off by default) ───────

// The private key of the wildcard fits every name of the zone: whoever has it
// can pose as the portal, the management and every route below the zone to
// devices in the VPN. So: a switch of its own (off), a list of the devices
// and gateways allowed to fetch it (empty), an explicit "I accept the risk"
// when switching on, fetching only authenticated (gateway token over the
// tunnel; app token bound to that device, from a VPN address), and every
// fetch logged — never the key itself. Switching off offers a new key
// (rotateKey), since a fetched key cannot be called back.

function sharePeerIds() {
  const v = parseJson(get(KEY.sharePeers, ''));
  return Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
}
function shareEnabled() { return get(KEY.share, '') === '1'; }

/**
 * The certificate files of a wildcard in Caddy's storage — by default the one
 * passed on (the device area, never the main wildcard).
 * → { certPem, keyPem, notBefore, notAfter, fingerprint, dir } | null
 */
function certMaterial(wildcard = deviceWildcard()) {
  if (!wildcard) return null;
  let entry = null;
  try { entry = tlsGuard().scanCertificates(undefined, wildcard).get(wildcard) || null; } catch { entry = null; }
  if (!entry || !entry.file) return null;
  try {
    const certPem = fs.readFileSync(entry.file, 'utf8');
    const keyPem = fs.readFileSync(entry.file.replace(/\.crt$/, '.key'), 'utf8');
    const x509 = new crypto.X509Certificate(certPem);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(keyPem))) return null;
    if (new Date(x509.validTo).getTime() <= Date.now()) return null;
    return { certPem, keyPem, notBefore: new Date(x509.validFrom).toISOString(), notAfter: new Date(x509.validTo).toISOString(), fingerprint: x509.fingerprint256.replace(/:/g, '').toLowerCase(), dir: path.dirname(entry.file) };
  } catch { return null; }
}

/**
 * The names a peer needs besides the certificate (config pull, app
 * permissions, fetch): the wildcard passed on is the one of the device area,
 * the server answers the fetch under server.<zone> (main wildcard).
 * → { wildcard, zone, device_zone, server_host, host }
 */
function shareNames(peerId, zone = servedZone()) {
  const dz = deviceZone(zone);
  let hostname = null;
  try {
    const row = require('../db/connection').getDb().prepare('SELECT hostname FROM peers WHERE id = ?').get(Number(peerId));
    hostname = row && row.hostname ? String(row.hostname).toLowerCase() : null;
  } catch { hostname = null; }
  return {
    wildcard: `*.${dz}`,
    zone,
    device_zone: dz,
    server_host: `server.${zone}`,
    // this peer's own name in the device area (null: no device name, or one kept free)
    host: hostname && !DEVICE_AREA_RESERVED.has(hostname) ? `${hostname}.${dz}` : null,
  };
}

/**
 * What a peer may know about the shared certificate (config pull, app permissions)
 * → { wildcard, zone, device_zone, server_host, host, fingerprint, not_after } | null
 */
function shareSummary(peerId) {
  if (!shareEnabled() || !sharePeerIds().includes(Number(peerId)) || !servedZone()) return null;
  const m = certMaterial();
  if (!m) return null;
  return { ...shareNames(peerId), fingerprint: m.fingerprint, not_after: m.notAfter };
}

/**
 * Certificate and key for a fetching peer. → { ok: true, ... } | { ok: false, code }
 *   code: not_shared (switch off / zone not served) | not_allowed | no_certificate
 * Logs every handed-out key (peer, fingerprint — never the key).
 */
// Does the request come from the VPN address of this peer? (the key only through the tunnel)
function fromPeerAddress(peerId, ip) {
  const addr = String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!addr) return false;
  try {
    const row = require('../db/connection').getDb().prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(Number(peerId));
    if (!row || !row.allowed_ips) return false;
    return String(row.allowed_ips).split(',').map((x) => x.trim().split('/')[0].toLowerCase()).some((a) => a === addr);
  } catch { return false; }
}

function fetchFor(peerId, { via = 'gateway', ip = null } = {}) {
  if (!hasFeature(FEATURE) || !shareEnabled() || !servedZone()) return { ok: false, code: 'not_shared' };
  const id = Number(peerId);
  if (!sharePeerIds().includes(id)) return { ok: false, code: 'not_allowed' };
  if (!fromPeerAddress(id, ip)) return { ok: false, code: 'not_from_vpn' };
  const m = certMaterial();
  if (!m) return { ok: false, code: 'no_certificate' };
  let name = String(id);
  try { const row = require('../db/connection').getDb().prepare('SELECT name FROM peers WHERE id = ?').get(id); if (row) name = row.name; } catch { /* name stays the id */ }
  try { settings.set(KEY.shareUsed, '1'); } catch { /* best effort */ }
  const names = shareNames(id);
  activityLog('tls_vpn_cert_key_fetched', `Certificate and key of ${names.wildcard} fetched by ${name}`, 'warning',
    { peer_id: id, peer: name, via, wildcard: names.wildcard, fingerprint: m.fingerprint, not_after: m.notAfter }, ip);
  return { ok: true, ...names, cert_pem: m.certPem, key_pem: m.keyPem, not_after: m.notAfter, fingerprint: m.fingerprint };
}

function shareView() {
  const ids = new Set(sharePeerIds());
  const m = shareEnabled() ? certMaterial() : null;
  let certs = new Map();
  try { certs = gatewayCertStates({ material: m }); } catch { certs = new Map(); }
  let peers = [];
  try {
    peers = require('../db/connection').getDb()
      .prepare("SELECT id, name, peer_type, hostname FROM peers WHERE enabled = 1 ORDER BY (CASE WHEN peer_type = 'gateway' THEN 0 ELSE 1 END), name COLLATE NOCASE").all()
      .map((p) => ({ id: p.id, name: p.name, gateway: p.peer_type === 'gateway', hostname: p.hostname || null, allowed: ids.has(p.id), cert: certs.get(p.id) || null }));
  } catch { peers = []; }
  const st = state();
  const dz = deviceZone(st.zone);
  const row = dz ? tlsRow(`*.${dz}`) : null;
  const delegated = !!dz && !!get(KEY.delegate, '') && !(PROVIDERS[providerId()] || {}).own_cname;
  const ownCname = !!dz && !!(PROVIDERS[providerId()] || {}).own_cname;
  let target = null;
  if (delegated) target = get(KEY.delegate, '');
  else if (ownCname) { const { values } = storedCredentials(); target = norm((values || {}).fulldomain) || null; }
  return {
    enabled: shareEnabled(),
    peers,
    allowed: [...ids],
    used: get(KEY.shareUsed, '') === '1',
    fingerprint: m ? m.fingerprint : null,
    // the device area: its own wildcard, only that one is passed on
    label: deviceLabel(),
    default_label: DEFAULT_DEVICE_LABEL,
    device_zone: dz,
    wildcard: dz ? `*.${dz}` : null,
    reserved: [...DEVICE_AREA_RESERVED],
    // forwarding (CNAME): the challenge of the device area needs a CNAME of its own, to the same target
    cname: target ? { name: `_acme-challenge.${dz}`, target } : null,
    certificate: row ? {
      state: row.state || null,
      not_after: row.not_after || null,
      days_left: daysLeft(row.not_after),
      last_error_code: row.last_error_code || null,
      last_error: row.last_error ? redact(row.last_error) : null,
    } : null,
    main_key_renewed_at: get(KEY.mainKeyRenewedAt, '') || null,
  };
}

// ─── The device area ───────────────────────────────────────
//
// Passing on never hands out the main wildcard *.<zone> (portal, management,
// routes). The server gets a second wildcard for a device area of its own,
// *.<label>.<zone> (label "geraete" by default), with the same DNS provider,
// only while passing on is on, and hands out only that one. dnsmasq answers
// <device>.<label>.<zone> with the device's tunnel address (services/dns.js);
// Caddy serves nothing under the device area, routes there are refused.

const DEFAULT_DEVICE_LABEL = 'geraete';
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// names under the device area kept free for later use (no device gets them there)
const DEVICE_AREA_RESERVED = new Set(['mqtt', 'www', 'ca']);

function deviceLabel() {
  const v = norm(get(KEY.deviceLabel, ''));
  return v && LABEL_RE.test(v) ? v : DEFAULT_DEVICE_LABEL;
}

/** <label>.<zone> | null */
function deviceZone(zone = state().zone) {
  return zone ? `${deviceLabel()}.${zone}` : null;
}

/** *.<label>.<zone> while passing on can use it (zone set), else null */
function deviceWildcard(zone = state().zone) {
  const dz = deviceZone(zone);
  return dz ? `*.${dz}` : null;
}

/**
 * May `label` name the device area of `zone`? → null | error code
 *   device_label_invalid  not one DNS label
 *   device_label_reserved a fixed name of the server (home, server, gateway …)
 *   device_label_taken    a device has this name, or a route lives at / below it
 */
function deviceLabelProblem(label, zone) {
  const l = norm(label);
  if (!l || l.length > 63 || !LABEL_RE.test(l)) return 'device_label_invalid';
  let reserved = new Set();
  try { reserved = require('./dns').RESERVED_HOSTNAMES; } catch { /* none */ }
  if (reserved.has(l) || MANAGEMENT_LABELS.includes(l)) return 'device_label_reserved';
  try {
    const db = require('../db/connection').getDb();
    if (db.prepare('SELECT 1 FROM peers WHERE hostname = ? COLLATE NOCASE LIMIT 1').get(l)) return 'device_label_taken';
    if (zone) {
      const at = `${l}.${zone}`;
      const rows = db.prepare('SELECT domain FROM routes WHERE domain IS NOT NULL AND domain != \'\'').all();
      if (rows.some((r) => { const d = norm(r.domain); return d === at || d.endsWith('.' + at); })) return 'device_label_taken';
    }
  } catch { /* no db */ }
  return null;
}

/** Is `host` the device area or a name below it? (routes are refused there) */
function inDeviceArea(host) {
  const dz = deviceZone();
  if (!dz) return false;
  const h = norm(host);
  return h === dz || h.endsWith('.' + dz);
}

/**
 * Once per server, after the update that brought the device area: a main key
 * that was passed on before (vpn_cert.share_used) is renewed like "Neuen
 * Schlüssel holen" — the copies out there then fit nothing the server serves.
 * The card and the activity log say so. → whether it renewed
 */
async function migrateSharedMainKey() {
  if (get(KEY.mainKeyMigrated, '') === '1') return false;
  try { settings.set(KEY.mainKeyMigrated, '1'); } catch { return false; }
  if (get(KEY.shareUsed, '') !== '1') return false;
  const st = state();
  settings.set(KEY.shareUsed, '');
  settings.set(KEY.shareFp, '');
  if (!['active', 'failed'].includes(st.state)) return false;
  const m = certMaterial(st.wildcard);
  if (m && m.dir && path.basename(m.dir) === `wildcard_.${st.zone}`) {
    try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (err) { log().warn({ err: err.message }, 'vpn cert: stored main certificate not removed'); }
  }
  tlsGuard().writeRow(st.wildcard, { state: 'pending', attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null, not_after: null, issuer: null });
  settings.set(KEY.mainKeyRenewedAt, new Date().toISOString());
  activityLog('tls_vpn_cert_main_key_renewed',
    `The key of ${st.wildcard} was passed on before; the server fetches a new one once. Devices now get ${deviceWildcard(st.zone)} only.`,
    'warning', { zone: st.zone, device_wildcard: deviceWildcard(st.zone) });
  try { await syncCaddy(); } catch (err) { log().warn({ err: redact(err.message) }, 'vpn cert: Caddy not synced after the key renewal'); }
  refreshServed('main key renewed');
  return true;
}

// ─── Has the gateway fetched it? ──────────────────────────
//
// A gateway since 1.41.0 names the capability `vpn-cert` in its heartbeat, since the
// device area (MIN_GATEWAY_CERT) also `vpn-cert-devices`, and
// reports what it holds as telemetry.vpn_cert { fingerprint, not_after } (null
// = nothing stored); gateway_meta.last_health keeps that. Only for gateways in
// "Darf abholen" while passing on is on:
//   fetched   it holds the certificate the server hands out now
//   stale     it holds an older one (fingerprint ≠ the current)
//   pending   allowed, but nothing reported yet
//   too_old   no capability `vpn-cert` + `vpn-cert-devices`: update the gateway (MIN_GATEWAY_CERT)
// A stale gateway becomes a dashboard problem only after STALE_PROBLEM_MS from
// when the current certificate is there to fetch (issued, or passing on
// switched on / fingerprint changed — whichever is later): a gateway fetches
// within minutes, a short delay is no problem.

const GATEWAY_CERT_CAPABILITY = 'vpn-cert';
// since the device area: the gateway fetches at vpn_cert.server_host and accepts
// *.<label>.<zone> — an older one would ask server.<label>.<zone> and fail
const GATEWAY_CERT_DEVICES_CAPABILITY = 'vpn-cert-devices';
const MIN_GATEWAY_CERT = '1.43.0';
const STALE_PROBLEM_MS = 24 * 3600 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

function healthOf(raw) {
  let h = raw;
  if (typeof h === 'string') { try { h = JSON.parse(h); } catch { return {}; } }
  return h && typeof h === 'object' ? h : {};
}

/** Since when the current certificate is there to fetch (ISO) | null */
function currentSince(m) {
  if (!m) return null;
  const t = Math.max(Date.parse(m.notBefore || '') || 0, Date.parse(get(KEY.shareFpAt, '')) || 0);
  return t > 0 ? new Date(t).toISOString() : null;
}

/**
 * The state of one gateway from its last heartbeat.
 * → { state, fingerprint, not_after, current_fingerprint, stale_since, min_version }
 */
function gatewayCertStatus(lastHealth, m, since = currentSince(m)) {
  const tel = healthOf(lastHealth).telemetry;
  const t = tel && typeof tel === 'object' ? tel : {};
  const caps = Array.isArray(t.capabilities) ? t.capabilities : [];
  const out = { state: 'pending', fingerprint: null, not_after: null, current_fingerprint: m ? m.fingerprint : null, stale_since: null, min_version: MIN_GATEWAY_CERT };
  if (!caps.includes(GATEWAY_CERT_CAPABILITY) || !caps.includes(GATEWAY_CERT_DEVICES_CAPABILITY)) {
    // never reported at all: nothing to say about its version yet
    if (typeof t.gateway_version === 'string' && t.gateway_version) out.state = 'too_old';
    return out;
  }
  const rep = t.vpn_cert && typeof t.vpn_cert === 'object' ? t.vpn_cert : null;
  const fp = rep && typeof rep.fingerprint === 'string' ? rep.fingerprint.replace(/:/g, '').trim().toLowerCase() : '';
  if (!HEX64.test(fp)) return out;
  out.fingerprint = fp;
  const na = rep && typeof rep.not_after === 'string' ? Date.parse(rep.not_after) : NaN;
  out.not_after = Number.isNaN(na) ? null : new Date(na).toISOString();
  // without a current certificate (none yet, expired) nothing can be compared
  if (m && fp !== m.fingerprint) { out.state = 'stale'; out.stale_since = since; } else out.state = 'fetched';
  return out;
}

/** Map(peer id → status) of the gateways in "Darf abholen" — empty while passing on is off. */
function gatewayCertStates({ material } = {}) {
  const out = new Map();
  if (!hasFeature(FEATURE) || !shareEnabled()) return out;
  const ids = sharePeerIds();
  if (!ids.length) return out;
  const rows = require('../db/connection').getDb().prepare(`SELECT p.id, gm.last_health FROM peers p LEFT JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const m = material !== undefined ? material : certMaterial();
  const since = currentSince(m);
  for (const r of rows) out.set(r.id, gatewayCertStatus(r.last_health, m, since));
  return out;
}

/** Gateways stale for longer than STALE_PROBLEM_MS (dashboard). → [{ peer_id, name, status }] */
function staleGateways(now = Date.now()) {
  const states = gatewayCertStates();
  const ids = [...states.entries()].filter(([, s]) => s.state === 'stale' && s.stale_since && now - Date.parse(s.stale_since) > STALE_PROBLEM_MS).map(([id]) => id);
  if (!ids.length) return [];
  const names = new Map(require('../db/connection').getDb().prepare(`SELECT id, name FROM peers WHERE enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => [r.id, r.name]));
  return ids.filter((id) => names.has(id)).map((id) => ({ peer_id: id, name: names.get(id), status: states.get(id) }));
}

function notifyShare() {
  try { require('./gatewayFeatures').notifyAllGateways(); } catch { /* best effort */ }
  try { require('./notify/control').configChanged({ all: true }); } catch { /* best effort */ }
}

// ─── Links on the new address ─────────────────────────────
//
// Off by default. While on and the wildcard is in use (servedZone), the links
// people open anywhere — invitations, kiosk pairing, the member menu, the way
// back after connecting a cloud account — point to home.<zone> instead of
// home.<legacy> (portalConfig.effectivePortalHost().linkHost).

function linksNew() { return get(KEY.links, '') === '1'; }

function linksView(st) {
  let publicPortal = false;
  try { publicPortal = !!require('./portalConfig').effectivePortalHost().public; } catch { publicPortal = false; }
  return {
    enabled: linksNew(),
    new_host: st.zone ? `home.${st.zone}` : null,
    old_host: `home.${config.dns.domain}`,
    public_portal: publicPortal,
  };
}

/** Switch the links on the new address. input: { enabled } */
function setLinks(input = {}, { ip = null } = {}) {
  if (!hasFeature(FEATURE)) { const err = new Error('feature_not_available'); err.code = 'feature_not_available'; err.statusCode = 403; throw err; }
  if (typeof input.enabled !== 'boolean') throw validationError('links_invalid', 'enabled');
  const enabled = input.enabled;
  if (enabled && !providerId()) throw validationError('not_configured');
  const was = linksNew();
  settings.set(KEY.links, enabled ? '1' : '');
  if (enabled !== was) {
    activityLog(enabled ? 'tls_vpn_cert_links_on' : 'tls_vpn_cert_links_off',
      enabled ? 'Links to the portal: new address under the VPN zone' : 'Links to the portal: previous address again',
      'info', {}, ip);
  }
  return view();
}

/**
 * Switch passing on, who may fetch, and the name of the device area.
 * input: { enabled, peers: [ids], accept_risk, device_label }
 * The device area is renamed only while passing on is off (or in the request
 * that switches it on or off).
 */
function setShare(input = {}, { ip = null } = {}) {
  if (!hasFeature(FEATURE)) { const err = new Error('feature_not_available'); err.code = 'feature_not_available'; err.statusCode = 403; throw err; }
  const enabled = input.enabled === true;
  const ids = Array.isArray(input.peers) ? [...new Set(input.peers.map(Number))] : sharePeerIds();
  if (ids.some((n) => !Number.isInteger(n) || n < 1)) throw validationError('peers_invalid', 'peers');
  if (ids.length > 0) {
    const db = require('../db/connection').getDb();
    const known = new Set(db.prepare(`SELECT id FROM peers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id));
    if (ids.some((n) => !known.has(n))) throw validationError('peers_invalid', 'peers');
  }
  const wasOn = shareEnabled();
  const st = state();
  const oldLabel = deviceLabel();
  const label = input.device_label === undefined || input.device_label === null ? oldLabel : norm(input.device_label);
  if (label !== oldLabel) {
    // the allowed devices hold a certificate of the old name: rename only while (or by) switching off
    if (wasOn && enabled) { const err = validationError('share_on', 'device_label'); err.statusCode = 409; throw err; }
  }
  if (label !== oldLabel || (enabled && !wasOn)) {
    const problem = deviceLabelProblem(label, st.zone);
    if (problem) throw validationError(problem, 'device_label');
  }
  if (enabled && !wasOn) {
    if (input.accept_risk !== true) throw validationError('risk_not_accepted', 'accept_risk');
    if (!['active', 'failed', 'pending'].includes(st.state)) throw validationError('not_configured');
  }
  if (label !== oldLabel) {
    // the old device area's row goes; its wildcard is not requested any more
    try { if (st.zone) tlsGuard().forgetHosts([`*.${oldLabel}.${st.zone}`]); } catch { /* none */ }
    settings.set(KEY.deviceLabel, label === DEFAULT_DEVICE_LABEL ? '' : label);
    settings.set(KEY.shareUsed, '');
    activityLog('tls_vpn_cert_device_area', `Device area of the VPN names: ${label}.${st.zone || ''}`, 'info', { label, previous: oldLabel }, ip);
    try { require('./dns').rebuildNow(); } catch { /* no dnsmasq here */ }
  }
  const before = new Set(sharePeerIds());
  settings.set(KEY.share, enabled ? '1' : '');
  settings.set(KEY.sharePeers, JSON.stringify(ids));
  // from now on the gateways can fetch it — "veraltet" counts from here
  if (enabled && !wasOn) settings.set(KEY.shareFpAt, new Date().toISOString());
  if (enabled !== wasOn) {
    activityLog(enabled ? 'tls_vpn_cert_share_on' : 'tls_vpn_cert_share_off',
      enabled ? 'Passing certificate and key of the VPN names on: switched on' : 'Passing certificate and key of the VPN names on: switched off',
      enabled ? 'warning' : 'info', { peers: ids }, ip);
  } else if (ids.length !== before.size || ids.some((n) => !before.has(n))) {
    activityLog('tls_vpn_cert_share_peers', 'Devices allowed to fetch certificate and key of the VPN names changed', 'warning', { peers: ids }, ip);
  }
  // switched on: Caddy requests the device area's wildcard; switched off: no longer
  if (enabled !== wasOn || label !== oldLabel) {
    try { syncCaddy().catch((err) => log().warn({ err: redact(err.message) }, 'vpn cert: Caddy not synced')); } catch { /* none */ }
  }
  notifyShare();
  return view();
}

/**
 * A new key after passing it on: Caddy's stored certificate of the device
 * area is removed. While passing on is on, Caddy fetches a new one at once
 * (the allowed devices then fetch the new key); while off, the next switch-on
 * fetches it. Only after a key was fetched. The main wildcard is not touched.
 */
async function rotateKey({ ip = null } = {}) {
  requireZone();
  if (get(KEY.shareUsed, '') !== '1') { const err = validationError('rotate_not_needed'); err.statusCode = 409; throw err; }
  const st = state();
  const wildcard = deviceWildcard(st.zone);
  if (!wildcard) throw validationError('not_configured');
  const m = certMaterial(wildcard);
  if (m && m.dir && path.basename(m.dir) === `wildcard_.${deviceZone(st.zone)}`) {
    try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (err) { log().warn({ err: err.message }, 'vpn cert: stored certificate not removed'); }
  }
  if (shareEnabled()) {
    tlsGuard().writeRow(wildcard, { state: 'pending', attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null, not_after: null, issuer: null });
  } else {
    try { tlsGuard().forgetHosts([wildcard]); } catch { /* none */ }
  }
  settings.set(KEY.shareUsed, '');
  activityLog('tls_vpn_cert_key_rotated', `New key for ${wildcard} requested after passing it on`, 'warning', { zone: st.zone, wildcard }, ip);
  await syncCaddy();
  shareRefresh();
  return view();
}

/** After a certificate change: tell the peers that may fetch it (new fingerprint). */
function shareRefresh() {
  if (!shareEnabled()) return false;
  const m = certMaterial();
  const fp = m ? m.fingerprint : '';
  if (fp === get(KEY.shareFp, '')) return false;
  try { settings.set(KEY.shareFp, fp); settings.set(KEY.shareFpAt, new Date().toISOString()); } catch { /* no db */ }
  notifyShare();
  return true;
}

/** Names under the zone the server answers with the wildcard ("Genutzt von"). → [{ host, kind }] */
function usedBy(zone) {
  if (!zone) return [];
  const covers = (h) => { const n = norm(h); if (!n.endsWith('.' + zone)) return false; const l = n.slice(0, -(zone.length + 1)); return !!l && !l.includes('.'); };
  const out = [];
  try {
    const portal = require('./portalConfig').effectivePortalHost();
    if (portal && portal.host && covers(portal.host)) out.push({ host: norm(portal.host), kind: 'portal' });
  } catch { /* none */ }
  for (const h of managementHosts()) if (covers(h)) out.push({ host: h, kind: 'management' });
  try {
    const rows = require('../db/connection').getDb().prepare("SELECT DISTINCT domain FROM routes WHERE enabled = 1 AND route_type != 'l4' AND https_enabled = 1 AND domain IS NOT NULL AND domain != ''").all();
    for (const r of rows) if (covers(r.domain) && !out.some((o) => o.host === norm(r.domain))) out.push({ host: norm(r.domain), kind: 'route' });
  } catch { /* none */ }
  const rank = { portal: 0, management: 1, route: 2 };
  return out.sort((a, b) => (a.kind === b.kind ? a.host.localeCompare(b.host) : rank[a.kind] - rank[b.kind]));
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
  // the device area's wildcard (same provider, same forwarding target) only while passing on is on;
  // Caddy serves nothing under it — it is there to be passed on
  let device = shareEnabled() && !deviceLabelProblemCached(zone) ? deviceWildcard(zone) : null;
  // the TLS guard paused it (attempt cap, CAA): not requested until "Erneut versuchen"
  if (device) { const dr = tlsRow(device); if (dr && dr.state === 'paused') device = null; }
  const subjects = device ? [st.wildcard, device] : [st.wildcard];
  return {
    subject: st.wildcard,
    subjects,
    device,
    zone,
    policy: { subjects, issuers: [issuer] },
    // one level only: nas-web.<zone> yes, a.b.<zone> no
    covers(host) {
      const h = norm(host);
      if (!h.endsWith('.' + zone)) return false;
      const label = h.slice(0, -(zone.length + 1));
      return !!label && !label.includes('.') && label !== '*';
    },
  };
}

// a device took the name meanwhile: leave the device area out instead of failing the sync
function deviceLabelProblemCached(zone) {
  const p = deviceLabelProblem(deviceLabel(), zone);
  // reserved/invalid cannot be stored; a name taken later by a route or device is the case here
  return p === 'device_label_taken';
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
  _served.at = 0;
  activityLog('tls_vpn_cert_suspended', 'Wildcard certificate of the VPN names stopped: Caddy refused the DNS provider configuration', 'warning', { error });
}

function unsuspend() { settings.set(KEY.suspended, ''); _served.at = 0; }

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
  refreshServed('saved');
  return view();
}

/** Switch off: settings, files and the status row go; Caddy forgets the policy. */
async function disable({ ip = null } = {}) {
  const st = state();
  const zones = [st.zone, st.stored_zone].filter(Boolean);
  const devices = zones.map((z) => deviceWildcard(z));
  for (const k of [KEY.provider, KEY.credentials, KEY.savedAt, KEY.zone, KEY.delegate, KEY.suspended, KEY.share, KEY.sharePeers, KEY.shareFp, KEY.shareFpAt, KEY.links]) settings.set(k, '');
  removeSecretFiles();
  try { tlsGuard().forgetHosts([...zones.map(wildcardOf), ...devices]); } catch { /* none */ }
  if (st.provider) activityLog('tls_vpn_cert_disabled', 'Wildcard certificate of the VPN names switched off', 'info', { provider: st.provider, zone: st.zone }, ip);
  await syncCaddy();
  refreshServed('disabled');
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
  refreshServed('renew');
  return view();
}

/** "Erneut versuchen" of the device area's wildcard: reset its counters, ask Caddy again. */
async function renewDevice({ ip = null } = {}) {
  requireZone();
  const st = state();
  const wildcard = deviceWildcard(st.zone);
  if (!shareEnabled() || !wildcard || !wantsPolicy(st)) throw validationError('not_configured');
  const row = tlsRow(wildcard);
  writeSecretFiles();
  tlsGuard().writeRow(wildcard, {
    state: row && row.not_after && daysLeft(row.not_after) > 0 ? 'issued' : 'pending',
    attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null,
  });
  activityLog('tls_vpn_cert_renew', `Wildcard certificate for ${wildcard}: new attempt requested`, 'info', { zone: st.zone, wildcard }, ip);
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
  // the hosts file was written before the files were back: once more, with home.<zone> when served
  _served.at = 0;
  try { settings.set(KEY.served, servedZone({ fresh: true }) || ''); } catch { /* no db */ }
  try { require('./dns').rebuildNow(); } catch { /* no dnsmasq here */ }
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
// after them, while passing on is on: the same test at the challenge of the device area
const DEVICE_STEP = 'devices';
const ALL_STEPS = [...STEPS, DEVICE_STEP];
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
    devices: _test.devices,
    steps: ALL_STEPS.map((s) => _test.steps[s] || { step: s, status: 'waiting' }),
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
  // the device area's challenge (same provider, same forwarding target) — only while passing on is on
  const dz = shareEnabled() || input.devices === true ? deviceZone(zone.primary) : null;
  const deviceNames = dz ? challengeNames(dz, id, values, delegate) : null;
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
    devices: deviceNames ? { zone: dz, record: deviceNames.record, lookup: deviceNames.lookup } : null,
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
        at: test.finished_at, provider: id, record: test.record, lookup: test.lookup, devices: test.devices,
        steps: ALL_STEPS.map((s) => ({ step: s, status: (test.steps[s] || {}).status || 'waiting' })),
        ...test.result,
      }));
    } catch { /* best effort */ }
    activityLog('tls_vpn_cert_test', `DNS provider test for the VPN names: ${test.result.ok ? 'passed' : 'failed'}`, test.result.ok ? 'info' : 'warning',
      { provider: id, zone: zone.primary, code: test.result.code }, ip);
  };

  const deviceStep = (status, extra = {}) => {
    test.steps[DEVICE_STEP] = { step: DEVICE_STEP, status, ms: null, code: null, detail: deviceNames ? (deviceNames.lookup || deviceNames.record) : null, error: null, ...extra };
  };
  runDnsTest(test, request, clean, (result) => {
    if (!deviceNames) { deviceStep('skip'); finish(result); return; }
    if (!result.ok) { deviceStep('skip'); finish(result); return; }
    // the main challenge works: once more at the device area's (its own CNAME when forwarding)
    const second = { ...request, record: deviceNames.record, value: 'gc-test-' + crypto.randomBytes(12).toString('hex') };
    if (deviceNames.lookup) second.lookup = deviceNames.lookup; else delete second.lookup;
    const t0 = Date.now();
    runDnsTest(test, second, clean, (r2) => {
      if (r2.ok) { deviceStep('ok', { ms: Date.now() - t0 }); finish(result); return; }
      deviceStep('fail', { ms: Date.now() - t0, code: r2.code || 'test_failed', error: r2.error ? clean(r2.error) : null });
      finish({ ...r2, ok: false, code: 'devices_' + (r2.code || 'test_failed'), zone: result.zone, nameservers: result.nameservers, propagation_ms: result.propagation_ms });
    }, { stepsOf: null });
  }, { stepsOf: STEPS });
  return testView();
}

/**
 * One run of `caddy gc-dnstest` with `request` → done(result). The steps it
 * reports land in test.steps when `stepsOf` lists them (the second run, at the
 * device area, reports only its outcome).
 */
function runDnsTest(test, request, clean, done, { stepsOf = STEPS } = {}) {
  let ended = false;
  const end = (r) => { if (ended) return; ended = true; done(r); };
  let child;
  try {
    child = spawn(config.caddy.bin || 'caddy', ['gc-dnstest'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' } });
  } catch (err) {
    end({ ok: false, code: 'caddy_unavailable', error: err.message });
    return;
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
      if (obj && stepsOf && stepsOf.includes(obj.step)) {
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
    end({ ok: false, code: err && err.code === 'ENOENT' ? 'caddy_unavailable' : 'test_failed', error: err.message });
  });
  child.on('close', (code) => {
    clearTimeout(killer);
    if (final) end(final);
    else end({ ok: false, code: 'test_failed', error: `gc-dnstest ended without result (exit ${code})` });
  });
  child.stdin.on('error', () => { /* process gone early */ });
  child.stdin.end(JSON.stringify(request));
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  if (_test && _test.child) { try { _test.child.kill('SIGKILL'); } catch { /* gone */ } }
  _test = null;
  _detectCache.clear();
  _served = { at: 0, zone: null };
}

module.exports = {
  KEY, PROVIDERS, ORDER, FEATURE,
  catalog, state, view, wantsPolicy,
  save, disable, renew, renewDevice, applyAfterRestore,
  caddyTls, inConfig, suspend, unsuspend,
  servedZone, managementHosts, refreshServed, MANAGEMENT_LABELS,
  setLinks, linksNew,
  setShare, shareSummary, fetchFor, rotateKey, shareRefresh, certMaterial,
  deviceLabel, deviceZone, deviceWildcard, deviceLabelProblem, inDeviceArea, migrateSharedMainKey,
  DEFAULT_DEVICE_LABEL, DEVICE_AREA_RESERVED,
  gatewayCertStatus, gatewayCertStates, staleGateways, GATEWAY_CERT_CAPABILITY, GATEWAY_CERT_DEVICES_CAPABILITY, MIN_GATEWAY_CERT, STALE_PROBLEM_MS,
  writeSecretFiles, removeSecretFiles, secretsDir,
  redact, preflight, detect, challengeNames, normDelegate,
  startTest, testView, suggestedDelay,
  _setNsResolverForTest, _resetForTest,
};
