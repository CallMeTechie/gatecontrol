'use strict';

// Plugin licences (docs/plugins.md "Lizenzen").
//
// first-party  (signed by a trusted CallMeTechie key): the entitlement of the
//              GateControl licence server — license.getPluginEntitlements(),
//              matched on slug === plugin id. The key is one of the plugin
//              keys sent with every v2 validation (license.setPluginKeys).
// third-party  (unsigned or signed by another key): the plugin's own licence
//              server from plugin.json (license.server, HTTPS only), contract
//              of callmetechie.de docs/api/plugin-license-protocol.md:
//                POST <server>  { license_key, plugin_id, server_id }
//                200            { valid: boolean, expires_at: ISO-8601|null }
//              server_id is an anonymous, stable id of this install for that
//              licence server (HMAC of a random install secret and the server
//              origin — not the hardware fingerprint, and different for every
//              licence server, so two vendors cannot correlate installs).
//              Checked on entry and daily; a server that cannot be reached
//              keeps the last good answer for GRACE_MS (14 days, as the
//              GateControl licence itself).

const crypto = require('node:crypto');
const registry = require('./registry');
const netPolicy = require('./netPolicy');

const DAY = 24 * 60 * 60 * 1000;
const GRACE_MS = 14 * DAY;
const EXPIRING_MS = 14 * DAY;
const CHECK_TIMEOUT_MS = 15000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;

const LICENSED_STATES = new Set(['valid', 'expiring', 'unreachable', 'not_required']);

let transport = null; // test seam

function kindOf(plugin) {
  return plugin.signature === 'trusted' ? 'first_party' : 'third_party';
}

function mask(key) {
  const k = String(key || '');
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '-••••-' + k.slice(-4);
}

function settings() { return require('../settings'); }

function installSecret() {
  let s = settings().get('plugins.install_secret', null);
  if (!s || !/^[0-9a-f]{64}$/.test(s)) {
    s = crypto.randomBytes(32).toString('hex');
    settings().set('plugins.install_secret', s);
  }
  return s;
}

/** Anonymous id of this install for one licence server. */
function serverId(licenseServerUrl) {
  let origin;
  try { origin = new URL(licenseServerUrl).origin; } catch { origin = String(licenseServerUrl); }
  return crypto.createHmac('sha256', installSecret()).update('gc-plugin-server-id:' + origin).digest('hex');
}

function expiryState(expiresAt, now) {
  if (!expiresAt) return 'valid';
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 'valid';
  if (t <= now) return 'expired';
  return t - now <= EXPIRING_MS ? 'expiring' : 'valid';
}

// A plugin key that is not needed: the plugin is already included in the
// GateControl plan or covered by a lifetime licence (licence server error).
const COVERED = new Map([['covered_by_plan', 'plan'], ['covered_by_lifetime', 'lifetime']]);

function firstPartyStatus(plugin, now) {
  const license = require('../license');
  const all = license.getPluginEntitlements().filter((e) => e.slug === plugin.id);
  // a redundant key ("covered_by_…") never decides the state — the entry that covers it does
  const isCovered = (e) => !e.valid && COVERED.has(String(e.error || ''));
  const covered = all.find(isCovered);
  const real = all.filter((e) => !isCovered(e));
  const ent = real.find((e) => e.valid) || real[0] || null;
  const coveredBy = covered ? COVERED.get(String(covered.error)) : null;
  const base = { kind: 'first_party', required: true, server: null, keyMasked: ent ? ent.key_masked || null : null,
    ...(coveredBy ? { coveredBy, redundantKeyMasked: covered.key_masked || null } : {}) };
  if (!ent) return { ...base, state: 'missing' };
  if (ent.valid) {
    let state = expiryState(ent.expires_at, now);
    const offline = (license.getLicenseInfo() || {}).verification === 'signed_offline';
    if (state !== 'expired' && offline) state = 'unreachable';
    return { ...base, state, expiresAt: ent.expires_at || null, updatesUntil: ent.updates_until || null, source: ent.source };
  }
  const err = String(ent.error || '');
  let state = 'invalid';
  if (ent.source) base.source = ent.source;
  if (err === 'expired') state = 'expired';
  else if (/activation|bound|limit|in_use/.test(err)) state = 'bound_elsewhere';
  else if (/wrong|product|mismatch/.test(err)) state = 'wrong_plugin';
  return { ...base, state, error: err || null, expiresAt: ent.expires_at || null };
}

function thirdPartyStatus(plugin, now) {
  const server = plugin.manifest && plugin.manifest.license ? plugin.manifest.license.server : null;
  const rec = registry.getLicense(plugin.id);
  const base = { kind: 'third_party', required: true, server };
  if (!rec || !rec.keyEncrypted) return { ...base, state: 'missing' };
  let keyMasked = null;
  try { keyMasked = mask(require('../../utils/crypto').decrypt(rec.keyEncrypted)); } catch { keyMasked = '••••'; }
  const st = rec.state || {};
  const out = { ...base, keyMasked, checkedAt: st.checked_at || null, lastOkAt: st.last_ok_at || null, expiresAt: st.expires_at || null };
  if (st.valid !== true) {
    if (st.error === 'invalid') return { ...out, state: 'invalid' };
    if (st.error === 'unreachable') return { ...out, state: 'unreachable_new' };
    return { ...out, state: 'missing' };
  }
  const exp = expiryState(st.expires_at, now);
  if (exp === 'expired') return { ...out, state: 'expired' };
  if (st.error === 'unreachable') {
    const lastOk = Date.parse(st.last_ok_at || '') || 0;
    return { ...out, state: now - lastOk > GRACE_MS ? 'grace_over' : 'unreachable' };
  }
  return { ...out, state: exp };
}

/**
 * Licence state of an installed plugin.
 * @returns {{kind, required, state, licensed, keyMasked?, expiresAt?, server?, ...}}
 */
function status(plugin, now = Date.now()) {
  const m = plugin.manifest || {};
  const kind = kindOf(plugin);
  if (!m.license || !m.license.required) return { kind, required: false, state: 'not_required', licensed: true };
  const s = kind === 'first_party' ? firstPartyStatus(plugin, now) : thirdPartyStatus(plugin, now);
  return { ...s, licensed: LICENSED_STATES.has(s.state) };
}

async function defaultTransport(url, body) {
  const target = await netPolicy.checkTarget(url, { network: [new URL(url).host], lan: false });
  if (!target.ok) throw new Error('license server address refused: ' + target.reason);
  const res = await netPolicy.pinnedRequest({
    target, method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'GateControl-plugin-license' },
    timeoutMs: CHECK_TIMEOUT_MS, maxBytes: 64 * 1024,
  });
  let json = null;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { json = null; }
  return { status: res.status, json };
}

/**
 * Ask a third-party plugin's licence server (and store the answer).
 * @returns {Promise<object>} status() afterwards
 */
async function checkThirdParty(plugin, now = Date.now()) {
  const server = plugin.manifest && plugin.manifest.license && plugin.manifest.license.server;
  const rec = registry.getLicense(plugin.id);
  if (!server || !rec || !rec.keyEncrypted) return status(plugin, now);
  let key;
  try { key = require('../../utils/crypto').decrypt(rec.keyEncrypted); } catch { return status(plugin, now); }
  const prev = rec.state || {};
  const nowIso = new Date(now).toISOString();
  let next;
  try {
    if (new URL(server).protocol !== 'https:') throw new Error('license server must use https');
    const res = await (transport || defaultTransport)(server, { license_key: key, plugin_id: plugin.id, server_id: serverId(server) });
    const j = res && res.json;
    if (res && res.status === 200 && j && typeof j.valid === 'boolean') {
      const expires = typeof j.expires_at === 'string' && Number.isFinite(Date.parse(j.expires_at)) ? new Date(Date.parse(j.expires_at)).toISOString() : null;
      next = j.valid
        ? { valid: true, expires_at: expires, checked_at: nowIso, last_ok_at: nowIso, error: null }
        : { valid: false, expires_at: expires, checked_at: nowIso, last_ok_at: prev.last_ok_at || null, error: 'invalid' };
    } else if (res && res.status >= 400 && res.status < 500 && j && j.valid === false) {
      next = { valid: false, expires_at: null, checked_at: nowIso, last_ok_at: prev.last_ok_at || null, error: 'invalid' };
    } else {
      throw new Error('unexpected answer');
    }
  } catch {
    next = { valid: prev.valid === true, expires_at: prev.expires_at || null, checked_at: nowIso, last_ok_at: prev.last_ok_at || null, error: 'unreachable' };
  }
  registry.setLicense(plugin.id, { state: next });
  return status(plugin, now);
}

function validKey(key) {
  return typeof key === 'string' && KEY_RE.test(key.trim());
}

/**
 * Enter a licence key for a plugin. First-party: added to the plugin keys of
 * the GateControl licence and a licence refresh runs. Third-party: stored
 * encrypted and checked against the plugin's licence server.
 */
async function setKey(plugin, key, { refreshTimeoutMs = 20000 } = {}) {
  if (!validKey(key)) throw Object.assign(new Error('invalid licence key'), { code: 'invalid_key' });
  const k = key.trim();
  if (kindOf(plugin) === 'first_party') {
    const license = require('../license');
    const keys = license.getPluginKeys();
    if (!keys.includes(k)) license.setPluginKeys([...keys, k]);
    await Promise.race([
      Promise.resolve(license.refreshLicenseInBackground()).catch(() => {}),
      new Promise((r) => { const t = setTimeout(r, refreshTimeoutMs); t.unref(); }),
    ]);
    return status(plugin);
  }
  if (!plugin.manifest.license || !plugin.manifest.license.server) throw Object.assign(new Error('plugin has no licence server'), { code: 'no_license_server' });
  registry.setLicense(plugin.id, { keyEncrypted: require('../../utils/crypto').encrypt(k), state: null });
  return checkThirdParty(plugin);
}

function _setTransportForTest(fn) {
  if (process.env.NODE_ENV === 'test') transport = fn;
}

module.exports = { status, checkThirdParty, setKey, serverId, kindOf, mask, validKey, GRACE_MS, LICENSED_STATES, _setTransportForTest };
