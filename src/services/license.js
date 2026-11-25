'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const jwt = require('jsonwebtoken');
const config = require('../../config/default');
const logger = require('../utils/logger');
const v2 = require('./licenseV2');
const eol = require('./licenseEol');
const { backoffDelay, retryableStatus, networkReason, parseRetryAfter } = require('../utils/checkBackoff');

const PRODUCT_SLUG = 'gatecontrol';

// Main version of this build (the first number of package.json). A licence
// token may carry `maj` — the main version it is valid for (docs/feature-
// license-eol.md "Hauptversion"). Only a token for an OLDER main version is
// refused ("Upgrade nötig"); a token without `maj` counts for every version.
const OWN_MAJOR = (() => {
  try { return parseInt(require('../../package.json').version, 10) || 1; } catch { return 1; }
})();
let ownMajor = OWN_MAJOR; // test seam: _setOwnMajorForTest

// Hardcodierter Community-Fallback für den unlizenzierten Modus.
// Wird verwendet wenn KEIN Lizenzschlüssel konfiguriert ist.
// Nutzer mit Community-Lizenzschlüssel erhalten aktuelle Werte vom Server.
const COMMUNITY_FALLBACK = {
  vpn_peers: 3,
  http_routes: 1,
  l4_routes: 0,
  route_auth: false,
  access_windows: false,
  share_links: false,
  custom_branding: false,
  ip_access_control: false,
  peer_acl: false,
  rate_limiting: false,
  compression: false,
  custom_headers: false,
  load_balancing: false,
  retry_on_error: false,
  circuit_breaker: false,
  request_mirroring: false,
  uptime_monitoring: false,
  traffic_history: true,
  prometheus_metrics: false,
  log_export: false,
  backup_restore: true,
  scheduled_backups: false,
  email_alerts: false,
  webhooks: false,
  api_tokens: false,
  request_debugging: false,
  bot_blocking: false,
  custom_dns: false,
  machine_binding: false,
  remote_desktop: false,
  browser_sessions: false,
  split_tunnel_preset: false,
  internal_dns: false,
  // Former built-in integrations, now first-party plugins (gatecontrol-midea,
  // -skoda, -smarthome): the licence server derives the plan-included plugin
  // entitlement (source "plan") from these keys — they no longer show any UI.
  midea_integration: false,
  skoda_integration: false,
  smarthome: false,
  gateway_peers: 1,
  gateway_http_targets: 3,
  gateway_tcp_routing: false,
  gateway_wol: false,
  rdp_via_gateway: false,
  // Gateway-Pool feature (failover + load-balancing).
  // Tier-distribution is configured on the license server, not here.
  gateway_pools: false,
  gateway_pool_failover: false,
  gateway_pool_load_balancing: false,
  gateway_pools_limit: 0,
  realtime_events: true,
  gateway_fleet: true,
  gateway_lan_discovery: false,
  gateway_lan_discovery_multi_subnet: false,
  gateway_scan_egress: false,        // Pro: LAN→Tunnel-Egress (Scan-to-Folder) + VIP-Failover
  waf: false,                        // Pro: Web Application Firewall (Coraza + OWASP CRS) per HTTP route
  ip_blocklists: false,              // Pro: IP-Sperre — Sperrlisten (Spamhaus DROP, blocklist.de, Tor-Ausgänge)
  malware_scanning: false,           // Pro: Virenscan mit ClamAV oder eigenem Scanner (ICAP), nächtliche Nachprüfung
};

// Features that no longer exist in GateControl. Licence tokens issued earlier
// still carry them: such a token stays valid as it is, the key is simply not
// taken over (no entry in the licence card, nothing to switch on).
//   pihole_integration — the Pi-hole integration, replaced by the DNS
//                        protection (a plugin with permissions.vpnDns)
const RETIRED_FEATURES = new Set(['pihole_integration']);

/** The token's features without the retired keys. */
function currentFeatures(features) {
  const out = {};
  for (const [key, val] of Object.entries(features && typeof features === 'object' ? features : {})) {
    if (!RETIRED_FEATURES.has(key)) out[key] = val;
  }
  return out;
}

let cachedPlan = 'community';
let cachedFeatures = { ...COMMUNITY_FALLBACK };
let cachedLicenseInfo = null;
let previousPlan = null;
let refreshTimer = null;   // the one scheduled background check (daily, or a retry)
let refreshActive = false; // startLicenseRefresh() ran
let enforcingLimits = false;
let unlicensed = true; // true wenn ohne Lizenzschlüssel gestartet
// Feature keys the applied licence token actually carried (null = no token
// applied: community fallback). Lets getLicenseInfo() tell a feature the plan
// switches off from one the licence server does not deliver yet (release B §11).
let tokenFeatureKeys = null;
// Plugin entitlements of the last applied v2 validation (empty without v2).
let pluginEntitlements = [];
// { licensed, installed } while the token is for an older main version.
let upgradeRequired = null;
// Why a licence key runs in Community mode right now: 'offline' (licence
// server unreachable beyond the grace), 'revoked' (403 / licence expired),
// 'upgrade' (token for an older main version) — null otherwise.
let fallbackReason = null;
const PLUGIN_SOURCES = new Set(['license', 'lifetime', 'plan']);
// Tier and seats of a plugin licence (since 1.206.0, GateControl Drive): only
// from the signed plugin token, never from the unsigned fields of the answer.
const PLUGIN_TIERS = new Set(['family', 'business', 'combo']);
const SEATS_MAX = 100000;

/** { included, family, business } of a token's `seats` (missing / invalid counts → 0). */
function seatsOf(s) {
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= SEATS_MAX ? v : 0);
  const o = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  return { included: n(o.included), family: n(o.family), business: n(o.business) };
}

// Offline grace for v2: when the licence server cannot be reached, the last
// verified token keeps working until its own `exp` or until GRACE_MS after the
// last successful validation, whichever is later.
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Hardware Fingerprint ────────────────────────

function getHardwareFingerprint() {
  // Build fingerprint from host hardware identifiers (not copyable between machines)
  const parts = [];

  // 1. DMI product UUID — unique per physical/virtual machine (BIOS/mainboard)
  try {
    const uuid = fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
    if (uuid && uuid !== 'Not Settable') parts.push(uuid);
  } catch { /* not available or no permission */ }

  // 2. CPU model — stable across restarts
  try {
    parts.push(os.cpus().map(c => c.model).join(','));
  } catch { /* unlikely */ }

  // 3. Total RAM — stable hardware identifier
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemTotal:\s+(\d+)/);
    if (match) parts.push(match[1]);
  } catch { /* not available */ }

  // Fallback if nothing hardware-specific was found
  if (parts.length === 0) {
    try {
      parts.push(fs.readFileSync('/etc/machine-id', 'utf8').trim());
    } catch {
      parts.push(os.hostname());
    }
  }

  const fingerprint = crypto.createHash('sha256').update(parts.join('|')).digest('hex');

  return fingerprint;
}

// ─── Token Management ────────────────────────────

function loadCachedToken(fingerprint, allowExpired = false) {
  try {
    const tokenPath = config.license.tokenPath;
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    const signingKey = config.license.signingKey;
    if (!signingKey) return null;

    const payload = jwt.verify(token, signingKey, {
      algorithms: ['HS256'],
      ...(allowExpired ? { ignoreExpiration: true } : {}),
    });

    if (payload.fp !== fingerprint) return null;
    if (!allowExpired && payload.lat > 0 && payload.lat < Math.floor(Date.now() / 1000)) return null;

    return {
      plan: payload.plan,
      features: payload.features,
      expires_at: payload.lat > 0 ? new Date(payload.lat * 1000).toISOString() : null,
    };
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    const tokenPath = config.license.tokenPath;
    const dir = require('path').dirname(tokenPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch (err) {
    logger.warn('Failed to save license token: ' + err.message);
  }
}

function deleteToken() {
  try {
    const tokenPath = config.license.tokenPath;
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  } catch (err) {
    logger.warn('Failed to delete license token: ' + err.message);
  }
}

// ─── Online Validation ──────────────────────────

async function validateOnline(fingerprint) {
  const res = await fetch(config.license.server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: config.license.key,
      hardware_fingerprint: fingerprint,
      device_name: (() => { try { return new URL(config.app.baseUrl).hostname; } catch { return os.hostname(); } })(),
      product_slug: PRODUCT_SLUG,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || `HTTP ${res.status}`), {
      http: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }

  const data = await res.json();

  // Reject malformed responses before mutating cached state. A 200 with a
  // missing or empty license object would otherwise spread into
  // COMMUNITY_FALLBACK in applyLicense, which then trips
  // refreshLicenseInBackground's previousPlan-changed check and disables
  // peers/routes via enforceLimits — exactly the regression seen on
  // 2026-04-26 (3 peers + 3 routes auto-disabled with COMMUNITY_FALLBACK
  // limits 3/1/0 even though the lifetime JWT was intact).
  if (!data || !data.license || typeof data.license.plan !== 'string' || !data.license.features || typeof data.license.features !== 'object') {
    throw Object.assign(new Error('License server returned malformed response'), { malformed: true });
  }

  saveToken(data.token);

  return {
    plan: data.license.plan,
    features: data.license.features,
    expires_at: data.license.expires_at,
    activations: data.license.active_activations,
    max_activations: data.license.max_activations,
  };
}

// ─── v2 (Ed25519) ───────────────────────────────

function isoFromUnix(sec) {
  return typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null;
}

/**
 * Plugin entries of a validation response, each plugin token verified. An
 * entry only counts as valid when the server says so AND its token verifies
 * for this install. Tokens stay in the stored copy (for offline restarts) but
 * never leave this module.
 */
async function verifyPlugins(plugins, fingerprint, { allowExpired, eolMode = false, lastOkAt = 0 }) {
  const out = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const graceLeft = Date.now() - Number(lastOkAt || 0) <= GRACE_MS;
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (!p || typeof p !== 'object' || typeof p.slug !== 'string') continue;
    const entry = {
      slug: p.slug,
      name: typeof p.name === 'string' ? p.name : p.slug,
      // where the entitlement comes from: an own plugin key ('license'), a
      // lifetime licence ('lifetime') or the GateControl plan that contained
      // the former built-in feature ('plan', token sub "plan:<id>")
      source: PLUGIN_SOURCES.has(p.source) ? p.source : 'license',
      key_masked: typeof p.key_masked === 'string' ? p.key_masked : null,
      valid: false,
      error: typeof p.error === 'string' ? p.error : null,
      expires_at: p.expires_at || null,
      updates_until: p.updates_until || null,
      tier: null,
      seats: null,
    };
    if (p.valid === true) {
      const r = await v2.verifyToken(p.token, { fingerprint, kind: 'plugin', allowExpired: allowExpired || eolMode });
      if (!r.ok) {
        entry.error = 'token_invalid';
      } else if (r.payload.lat > 0 && r.payload.lat < nowSec) {
        entry.error = 'expired';
      } else if (eolMode && !allowExpired && r.payload.exp <= nowSec && !eol.covers(r.payload) && !graceLeft) {
        // end of life: a plugin licence the EOL does not cover keeps the normal offline grace
        entry.error = 'token_invalid';
      } else {
        entry.valid = true;
        entry.error = null;
        entry.expires_at = isoFromUnix(r.payload.lat);
        entry.updates_until = isoFromUnix(r.payload.upd);
        if (PLUGIN_TIERS.has(r.payload.tier)) {
          entry.tier = r.payload.tier;
          entry.seats = seatsOf(r.payload.seats);
        }
      }
    }
    out.push(entry);
  }
  return out;
}

/** { licensed, installed } when the token is for an older main version, else null. */
function majorMismatch(payload) {
  const maj = payload ? payload.maj : undefined;
  if (!Number.isSafeInteger(maj) || maj <= 0 || maj >= ownMajor) return null;
  return { licensed: maj, installed: ownMajor };
}

/**
 * Put a verified v2 token in force.
 * mode: 'signed' (just validated online), 'signed_offline' (offline grace,
 * with `offline` = { last_ok_at, fallback_at }) or 'eol' (end of life).
 * @returns {boolean} false when the token is for an older main version — then nothing is applied
 */
function applyV2(payload, rec, plugins, { mode = 'signed', offline = null } = {}) {
  const mm = majorMismatch(payload);
  if (mm) {
    upgradeRequired = mm;
    return false;
  }
  upgradeRequired = null;
  fallbackReason = null;
  applyLicense({
    plan: payload.plan,
    features: payload.features,
    expires_at: isoFromUnix(payload.lat),
    updates_until: isoFromUnix(payload.upd),
    activations: rec.activations,
    max_activations: rec.max_activations,
    offline: mode === 'signed_offline' ? offline : null,
  }, mode);
  pluginEntitlements = plugins;
  return true;
}

function logUpgradeRequired() {
  if (!upgradeRequired) return;
  logger.warn(`License is for GateControl ${upgradeRequired.licensed}.x, this is ${upgradeRequired.installed}.x — upgrade required, running in Community mode`);
}

/**
 * The stored v2 token, verified. `grace` additionally accepts a passed `exp`
 * while the 14-day grace since the last successful validation runs.
 * @returns {Promise<{payload, rec}|null>}
 */
async function loadV2Token(fingerprint, { grace = false, eolMode = false } = {}) {
  const rec = v2.loadState(config.license.key);
  if (!rec) return null;
  const r = await v2.verifyToken(rec.token, { fingerprint, kind: 'app', allowExpired: grace || eolMode });
  if (!r.ok) return null;
  const now = Date.now();
  if (r.payload.lat > 0 && r.payload.lat * 1000 < now) return null;              // licence itself expired
  // end of life: only what the EOL covers, then without exp and without grace
  if (eolMode) return eol.covers(r.payload, now) ? { payload: r.payload, rec } : null;
  if (grace && r.payload.exp * 1000 <= now && now - Number(rec.last_ok_at || 0) > GRACE_MS) return null;
  return { payload: r.payload, rec };
}

/** When the offline grace of a stored token ends: its exp or GRACE_MS after the last success, whichever is later. */
function graceEnd(payload, rec) {
  return Math.max(Number(payload.exp) * 1000 || 0, Number(rec.last_ok_at || 0) + GRACE_MS);
}

function dropV2License(reason) {
  v2.clearState();
  deleteToken(); // the v1 token of a revoked licence must not resurrect it
  pluginEntitlements = [];
  upgradeRequired = null;
  fallbackReason = 'revoked';
  logger.warn(`License rejected by license server (${reason}) — running in Community mode`);
}

/**
 * One v2 round. Returns what the caller has to do:
 *   'applied'    a verified v2 licence is in force
 *   'community'  fall back to the community plan (revoked, or grace over)
 *   'v1'         v2 is not available and never succeeded here → legacy path
 */
async function validateV2(fingerprint, { useCache }) {
  // End of life: a stored licence the EOL covers needs no licence server any more.
  if (eol.isActive()) {
    const held = await loadV2Token(fingerprint, { eolMode: true });
    if (held) {
      const plugins = await verifyPlugins(held.rec.plugins, fingerprint, { allowExpired: false, eolMode: true, lastOkAt: held.rec.last_ok_at });
      const wasEol = cachedLicenseInfo?.verification === 'eol';
      if (!applyV2(held.payload, held.rec, plugins, { mode: 'eol' })) {
        fallbackReason = 'upgrade';
        logUpgradeRequired();
        return 'community';
      }
      if (!wasEol) logger.info(`License valid (end of life, no licence server needed) — Plan: ${held.payload.plan}`);
      return 'applied';
    }
  }

  if (useCache) {
    const cached = await loadV2Token(fingerprint);
    if (cached) {
      const plugins = await verifyPlugins(cached.rec.plugins, fingerprint, { allowExpired: false });
      // a token for an older main version: ask the licence server (an upgrade may be bought meanwhile)
      if (applyV2(cached.payload, cached.rec, plugins)) {
        logger.info(`License valid (cached, signed) — Plan: ${cached.payload.plan}`);
        refreshLicenseInBackground(fingerprint);
        return 'applied';
      }
    }
  }

  const res = await v2.validate({
    licenseKey: config.license.key,
    fingerprint,
    pluginKeys: v2.getPluginKeys(),
    productSlug: PRODUCT_SLUG,
  });

  if (res.status === 'ok') {
    const r = await v2.verifyToken(res.data.token, { fingerprint, kind: 'app' });
    if (r.ok) {
      const now = Date.now();
      const lic = res.data.license;
      const rec = { activations: lic.active_activations ?? null, max_activations: lic.max_activations ?? null };
      v2.saveState(config.license.key, { token: res.data.token, plugins: res.data.plugins, now, ...rec });
      v2.markActive();
      const plugins = await verifyPlugins(res.data.plugins, fingerprint, { allowExpired: false });
      noteCheck({ ok: true });
      if (!applyV2(r.payload, rec, plugins)) {
        fallbackReason = 'upgrade';
        logUpgradeRequired();
        return 'community';
      }
      logger.info(`License valid (online, signed) — Plan: ${r.payload.plan}`);
      return 'applied';
    }
    if (failStreak === 0) logger.warn(`License server returned a token that does not verify (${r.reason}) — ignored`);
    res.reason = `token ${r.reason}`;
  } else if (res.status === 'invalid') {
    noteCheck({ ok: false, reason: 'HTTP 403', retry: false });
    dropV2License(res.message);
    return 'community';
  }

  // unavailable / transient / unverifiable token
  if (!v2.isActive()) return 'v1'; // the v1 path records the check

  // no HTTP status: network error, timeout, malformed body or a token that does not verify
  const first = noteCheck({
    ok: false,
    reason: res.reason || res.status,
    retry: !Number.isInteger(res.http) || retryableStatus(res.http),
    retryAfterMs: res.retryAfterMs,
  });
  const grace = await loadV2Token(fingerprint, { grace: true });
  if (grace) {
    const plugins = await verifyPlugins(grace.rec.plugins, fingerprint, { allowExpired: true });
    const wasOffline = cachedLicenseInfo?.verification === 'signed_offline';
    const offline = {
      last_ok_at: grace.rec.last_ok_at ? new Date(Number(grace.rec.last_ok_at)).toISOString() : null,
      fallback_at: new Date(graceEnd(grace.payload, grace.rec)).toISOString(),
    };
    if (!applyV2(grace.payload, grace.rec, plugins, { mode: 'signed_offline', offline })) {
      fallbackReason = 'upgrade';
      logUpgradeRequired();
      return 'community';
    }
    // once per outage, not on every retry
    if (first || !wasOffline) logger.warn(`License server unreachable (${res.reason || res.status}), using cached signed token until ${offline.fallback_at} — Plan: ${grace.payload.plan}`);
    return 'applied';
  }
  if (first || cachedPlan !== 'community') logger.warn(`License server unreachable (${res.reason || res.status}) and offline grace exhausted — running in Community mode`);
  pluginEntitlements = [];
  // a stored token that is merely past its grace (not one of another key / a lapsed licence) → offline
  fallbackReason = v2.loadState(config.license.key) ? 'offline' : fallbackReason;
  return 'community';
}

// ─── Main Validation ────────────────────────────

async function validateLicense() {
  // 0. Load keys from DB if not set via env vars (UI-activated licenses)
  if (!config.license.key) {
    try {
      const settings = require('./settings');
      const { decrypt } = require('../utils/crypto');
      const dbKey = settings.get('license_key');
      const dbSigningKeyEnc = settings.get('license_signing_key_encrypted');
      if (dbKey) {
        config.license.key = dbKey;
        if (dbSigningKeyEnc) {
          try { config.license.signingKey = decrypt(dbSigningKeyEnc); } catch { /* invalid encryption key */ }
        }
        logger.info('License key loaded from database');
      }
    } catch {
      // DB not ready or settings not available
    }
  }

  // End of life: the file at GC_LICENSE_EOL_FILE, else an imported one (verified again)
  await eol.load();

  // 1. No license key → Unlicensed community mode
  if (!config.license.key) {
    unlicensed = true;
    fallbackReason = null;
    upgradeRequired = null;
    setCommunityMode();
    logger.info('No license key configured — running in unlicensed Community mode');
    logger.info('Register at https://callmetechie.de for a free Community license');
    await enforceLimitsInternal();
    return getLicenseInfo();
  }

  // From here on, a license key is present
  unlicensed = false;

  const fingerprint = getHardwareFingerprint();

  // 2. v2 (signed) — authoritative once it has succeeded on this install
  const outcome = await validateV2(fingerprint, { useCache: true });
  if (outcome === 'applied') {
    // what an earlier fallback switched off comes back on (within the limits)
    await enforceLimitsInternal({ restoreOnly: true });
  } else if (outcome === 'community') {
    setCommunityMode();
    await enforceLimitsInternal();
  } else {
    await validateLicenseV1(fingerprint);
    if (cachedPlan !== 'community') await enforceLimitsInternal({ restoreOnly: true });
  }
  // a published EOL file is looked for (throttled to twice a day, in the background) and kept
  if (needsEol()) fetchEolInBackground();
  return getLicenseInfo();
}

/** A licence key and no EOL in force: look for a published one (throttled in licenseEol). */
function needsEol() {
  return !!config.license.key && !eol.isActive();
}

/**
 * Look for a published EOL file without waiting for it. Started only after a
 * validation is complete; a file that newly applies re-validates once.
 */
function fetchEolInBackground({ force = false } = {}) {
  return eol.maybeFetch({ force })
    .then((found) => (found ? refreshLicenseInBackground() : null))
    .catch(() => { /* next time */ });
}

// Legacy v1 path (HS256), used only while v2 is not deployed.
async function validateLicenseV1(fingerprint) {
  // No signing key → Licensed but can't validate
  if (!config.license.signingKey) {
    setCommunityMode();
    logger.warn('GC_LICENSE_SIGNING_KEY not set — running in Community mode');
    await enforceLimitsInternal();
    return getLicenseInfo();
  }

  // Try cached token
  const cached = loadCachedToken(fingerprint);
  if (cached) {
    applyLicense(cached);
    logger.info(`License valid (cached) — Plan: ${cached.plan}`);
    refreshLicenseInBackground(fingerprint);
    return getLicenseInfo();
  }

  // Online validation
  try {
    const result = await validateOnline(fingerprint);
    applyLicense(result);
    noteCheck({ ok: true });
    logger.info(`License valid (online) — Plan: ${result.plan}`);
    return getLicenseInfo();
  } catch (err) {
    noteCheck(v1Failure(err));
    // Fallback to expired token
    const fallback = loadCachedToken(fingerprint, true);
    if (fallback) {
      applyLicense(fallback);
      logger.warn(`License server unreachable, using cached token — Plan: ${fallback.plan}`);
      return getLicenseInfo();
    }

    // All failed → Community mode
    setCommunityMode();
    logger.warn(`License validation failed: ${err.message} — running in Community mode`);
    await enforceLimitsInternal();
    return getLicenseInfo();
  }
}

function setCommunityMode() {
  previousPlan = cachedPlan;
  cachedPlan = 'community';
  cachedFeatures = { ...COMMUNITY_FALLBACK };
  cachedLicenseInfo = null;
  tokenFeatureKeys = null;
  pluginEntitlements = [];
  // Note: unlicensed flag is NOT set here — caller decides
}

/**
 * Boolean features the token does not mention at all (docs/feature-next-
 * package.md §S2.3). On every PAID plan (everything but `community`) they
 * count as enabled: a feature newer than the licence server would otherwise
 * fall back to the community value and look "not included" on a Pro licence.
 * Community keeps COMMUNITY_FALLBACK. Numeric limits (vpn_peers,
 * http_routes, …) are never derived — only booleans.
 * The derivation is a bridge, not a substitute for the licence server
 * (docs/release-checklist.md).
 * @param {string} plan
 * @param {object} tokenFeatures features the token carries
 * @returns {object} { <key>: true } for the derived keys
 */
function planDefaults(plan, tokenFeatures) {
  const out = {};
  if (!plan || plan === 'community') return out;
  const carried = tokenFeatures && typeof tokenFeatures === 'object' ? tokenFeatures : {};
  for (const [key, fallback] of Object.entries(COMMUNITY_FALLBACK)) {
    if (typeof fallback !== 'boolean') continue;                                  // limits stay as they are
    if (Object.prototype.hasOwnProperty.call(carried, key)) continue;             // the token decides
    out[key] = true;
  }
  return out;
}

function applyLicense(data, verification = 'legacy') {
  previousPlan = cachedPlan;
  unlicensed = false;
  cachedPlan = data.plan;
  // Merge COMMUNITY_FALLBACK as base so features NEW to the client
  // (not yet known to the license server) still work. License-returned
  // values override the fallback; in between, paid plans get the
  // plan default for booleans the token does not carry.
  const carried = currentFeatures(data.features);
  cachedFeatures = { ...COMMUNITY_FALLBACK, ...planDefaults(data.plan, carried), ...carried };
  tokenFeatureKeys = new Set(Object.keys(carried));
  cachedLicenseInfo = {
    // offline grace: { last_ok_at, fallback_at } (v2 'signed_offline' only)
    offline: data.offline || null,
    expires_at: data.expires_at || null,
    updates_until: data.updates_until || null,
    activations: data.activations || null,
    max_activations: data.max_activations || null,
    verification,
  };
}

// ─── Background Refresh ─────────────────────────

async function refreshLicenseInBackground(fingerprint) {
  try {
    if (!config.license.key) return;
    const fp = fingerprint || getHardwareFingerprint();
    const outcome = await validateV2(fp, { useCache: false });
    if (outcome === 'community') {
      setCommunityMode();
    } else if (outcome === 'v1') {
      let result;
      try {
        result = await validateOnline(fp);
      } catch (err) {
        noteCheck(v1Failure(err));
        throw err;
      }
      noteCheck({ ok: true });
      applyLicense(result);
    }
    if (previousPlan && previousPlan !== cachedPlan) {
      await enforceLimitsInternal();
    }
    if (needsEol()) fetchEolInBackground();
  } catch {
    // Silent failure — keep using cached data
  }
}

// Daily: a revoked licence is noticed within a day, and the offline grace
// is re-evaluated even while the licence server stays unreachable.
// A check that failed because the server could not be reached (network,
// timeout, 5xx, 429) is retried after 5 min, 15 min, 1 h, then hourly
// (utils/checkBackoff.js) — a short outage must not leave the install in
// offline grace ("Lizenzserver nicht erreichbar") for a whole day. A 4xx is
// the server's answer and waits for the next daily check. Every check — the
// timer's, a manual refresh, a plugin key — reschedules the one timer.
const ONE_DAY = 24 * 60 * 60 * 1000;

let lastCheck = null;    // { at, ok, reason } of the last online check
let failStreak = 0;      // retryable failures in a row
let nextDelay = ONE_DAY; // delay the last check asked for
let nextCheckAt = null;  // ms of the scheduled check (null: none scheduled)

/** "HTTP 500" / "timeout" / "ENOTFOUND" of a failed v1 request — nothing from the body. */
function v1Failure(err) {
  if (err && Number.isInteger(err.http)) {
    return { ok: false, reason: `HTTP ${err.http}`, retry: retryableStatus(err.http), retryAfterMs: err.retryAfterMs };
  }
  if (err && err.malformed) return { ok: false, reason: 'malformed response', retry: true };
  return { ok: false, reason: networkReason(err), retry: true };
}

/**
 * Record the result of an online check and plan the next one.
 * @param {{ok:boolean, reason?:string, retry?:boolean, retryAfterMs?:number|null}} r
 * @returns {boolean} true when a failure starts a new outage (log it), false otherwise
 */
function noteCheck(r) {
  const was = failStreak;
  lastCheck = { at: new Date().toISOString(), ok: !!r.ok, reason: r.ok ? null : String(r.reason || 'error').slice(0, 60) };
  if (r.ok || !r.retry) {
    if (r.ok && was > 0) logger.info(`License server reachable again after ${was} failed check(s)`);
    failStreak = 0;
    nextDelay = ONE_DAY;
  } else {
    failStreak += 1;
    nextDelay = backoffDelay(failStreak, r.retryAfterMs);
  }
  if (refreshActive) scheduleRefresh(nextDelay);
  return !r.ok && was === 0;
}

function scheduleRefresh(delay) {
  if (refreshTimer) clearTimeout(refreshTimer);
  nextCheckAt = Date.now() + delay;
  refreshTimer = setTimeout(runScheduledRefresh, delay);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

async function runScheduledRefresh() {
  refreshTimer = null;
  nextCheckAt = null;
  await refreshLicenseInBackground();
  // a check that recorded nothing (no key any more, unexpected error) keeps the rhythm
  if (refreshActive && !refreshTimer) scheduleRefresh(nextDelay);
}

function startLicenseRefresh() {
  if (!config.license.key || refreshActive) return;
  refreshActive = true;
  // a failed check at boot (before this ran) already asked for a retry
  scheduleRefresh(nextDelay);
}

function stopLicenseRefresh() {
  refreshActive = false;
  nextCheckAt = null;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function resetChecks() {
  lastCheck = null;
  failStreak = 0;
  nextDelay = ONE_DAY;
}

// ─── Enforce Limits (Soft-Lock) ─────────────────
//
// More peers / routes / pools enabled than the licence allows (licence
// removed, revoked, expired, or the licence server unreachable beyond the
// offline grace): the NEWEST ones over the limit are switched off — never
// deleted, their configuration stays — and marked `license_disabled`. As soon
// as a licence allows more again, the marked ones come back on, oldest first,
// up to the limit. Switching one on by hand clears the mark (SQL trigger of
// migration 162), so nothing an administrator turned off later comes back.

const LIMIT_KEYS = [
  { feature: 'vpn_peers', table: 'peers', type: 'peer', nameCol: 'name' },
  { feature: 'http_routes', table: 'routes', type: 'route', nameCol: 'domain', where: "(route_type = 'http' OR route_type IS NULL)" },
  { feature: 'l4_routes', table: 'routes', type: 'route', nameCol: 'domain', where: "route_type = 'l4'" },
];

async function syncAfterEnforcement(changed, removedPeerKeys) {
  if (changed.peer) {
    try {
      await require('./peers').rewriteWgConfig();
      for (const key of removedPeerKeys) {
        try { await require('./wireguard').removePeer(key); } catch { /* not on the running interface */ }
      }
    } catch (err) {
      logger.warn('WireGuard sync after license enforcement failed: ' + err.message);
    }
  }
  if (changed.route) {
    try {
      await require('./routes').syncToCaddy();
    } catch (err) {
      logger.warn('Caddy sync after license enforcement failed: ' + err.message);
    }
  }
  if (changed.peer || changed.route) {
    try { require('./dns').scheduleRebuild(); } catch { /* best effort */ }
  }
}

async function mailLimitAlert(text) {
  try {
    const settings = require('./settings');
    if (settings.get('email_alerts_enabled') !== 'true') return;
    const alertEmail = settings.get('alert_email');
    if (alertEmail) await require('./email').send(alertEmail, 'GateControl License Limit', text);
  } catch {
    // Email alert is best-effort
  }
}

/**
 * @param {{restoreOnly?: boolean}} [opts]  restoreOnly: only switch marked
 *   entries back on (a licence was just applied), never switch anything off
 */
async function enforceLimitsInternal({ restoreOnly = false } = {}) {
  if (enforcingLimits) return;
  enforcingLimits = true;

  try {
    const { getDb } = require('../db/connection');
    const db = getDb();
    const activity = require('./activity');
    const changed = { peer: false, route: false };
    const removedPeerKeys = [];

    for (const { feature, table, type, nameCol, where } of LIMIT_KEYS) {
      const limit = getFeatureLimit(feature);
      const cond = where ? ` AND ${where}` : '';
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE enabled = 1${cond}`).get().count;
      const keyCol = type === 'peer' ? ', public_key' : '';

      if (!restoreOnly && limit !== -1 && count > limit) {
        const excess = count - limit;
        const rows = db.prepare(
          `SELECT id, ${nameCol} as label${keyCol} FROM ${table} WHERE enabled = 1${cond} ORDER BY created_at DESC, id DESC LIMIT ?`
        ).all(excess);
        const off = db.prepare(`UPDATE ${table} SET enabled = 0, license_disabled = 1, updated_at = datetime('now') WHERE id = ?`);
        for (const row of rows) {
          off.run(row.id);
          if (row.public_key) removedPeerKeys.push(row.public_key);
          activity.log(`${type}_license_disabled`,
            `${type === 'peer' ? 'Peer' : 'Route'} "${row.label}" disabled — license limit (${limit}); it is switched on again when the licence allows it`,
            { severity: 'warning', details: { id: row.id, feature, limit } });
        }
        changed[type] = true;
        logger.warn(`License limit: disabled ${excess} ${type}(s) for ${feature} (limit: ${limit}), newest first — configuration kept`);
        await mailLimitAlert(`${excess} ${type}(s) were disabled because the ${feature} limit (${limit}) was exceeded after a license change. `
          + 'They are kept and switched on again automatically as soon as a valid licence allows it.');
        continue;
      }

      // room for marked entries: -1 = no limit (SQLite LIMIT -1)
      const room = limit === -1 ? -1 : limit - count;
      if (room === 0 || room < -1) continue;
      const back = db.prepare(
        `SELECT id, ${nameCol} as label FROM ${table} WHERE enabled = 0 AND license_disabled = 1${cond} ORDER BY created_at ASC, id ASC LIMIT ?`
      ).all(room);
      if (back.length === 0) continue;
      const on = db.prepare(`UPDATE ${table} SET enabled = 1, license_disabled = 0, updated_at = datetime('now') WHERE id = ?`);
      for (const row of back) {
        on.run(row.id);
        activity.log(`${type}_license_restored`,
          `${type === 'peer' ? 'Peer' : 'Route'} "${row.label}" enabled again — the licence allows it`,
          { severity: 'info', details: { id: row.id, feature } });
      }
      changed[type] = true;
      logger.info(`License: ${back.length} ${type}(s) for ${feature} switched on again`);
    }

    await syncAfterEnforcement(changed, removedPeerKeys);

    // ─── Pool enforcement ────────────────────────────
    let poolsChanged = false;
    if (!restoreOnly) {
      if (cachedFeatures.gateway_pools === false) {
        const result = db.prepare("UPDATE gateway_pools SET enabled = 0, license_disabled = 1 WHERE enabled = 1").run();
        if (result.changes > 0) {
          poolsChanged = true;
          activity.log(
            'pool_disabled_by_license_enforcement',
            `${result.changes} pool(s) disabled — gateway_pools feature revoked`,
            { source: 'system', severity: 'warn', details: { count: result.changes } },
          );
        }
      } else if (cachedFeatures.gateway_pool_load_balancing === false) {
        const result = db.prepare("UPDATE gateway_pools SET enabled = 0, license_disabled = 1 WHERE mode = 'load_balancing' AND enabled = 1").run();
        if (result.changes > 0) {
          poolsChanged = true;
          activity.log(
            'pool_disabled_by_license_enforcement',
            `${result.changes} LB pool(s) disabled — gateway_pool_load_balancing revoked`,
            { source: 'system', severity: 'warn', details: { count: result.changes } },
          );
        }
      }

      const poolsLimit = cachedFeatures.gateway_pools_limit ?? 0;
      if (poolsLimit > 0) {
        const overflow = db.prepare(`
          SELECT id FROM gateway_pools WHERE enabled = 1 ORDER BY created_at DESC LIMIT -1 OFFSET ?
        `).all(poolsLimit);
        if (overflow.length > 0) {
          poolsChanged = true;
          const ids = overflow.map(r => r.id);
          db.prepare(`UPDATE gateway_pools SET enabled = 0, license_disabled = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
          activity.log(
            'pool_disabled_by_license_enforcement',
            `${overflow.length} pool(s) over limit (${poolsLimit}) disabled`,
            { source: 'system', severity: 'warn', details: { ids, limit: poolsLimit } },
          );
        }
      }
    }

    // marked pools come back when the licence has pools again (load balancing only with its feature)
    if (cachedFeatures.gateway_pools === true) {
      const poolsLimit = cachedFeatures.gateway_pools_limit ?? 0;
      const enabledPools = db.prepare('SELECT COUNT(*) AS c FROM gateway_pools WHERE enabled = 1').get().c;
      const room = poolsLimit > 0 ? poolsLimit - enabledPools : -1;
      if (room > 0 || room === -1) {
        const lbCond = cachedFeatures.gateway_pool_load_balancing === false ? " AND mode != 'load_balancing'" : '';
        const back = db.prepare(
          `SELECT id FROM gateway_pools WHERE enabled = 0 AND license_disabled = 1${lbCond} ORDER BY created_at ASC, id ASC LIMIT ?`
        ).all(room);
        if (back.length > 0) {
          poolsChanged = true;
          const ids = back.map(r => r.id);
          db.prepare(`UPDATE gateway_pools SET enabled = 1, license_disabled = 0 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
          activity.log(
            'pool_license_restored',
            `${ids.length} pool(s) enabled again — the licence allows it`,
            { source: 'system', severity: 'info', details: { ids } },
          );
        }
      }
    }

    if (!restoreOnly || poolsChanged || changed.route) {
      try {
        await require('./caddyConfig').syncToCaddy();
      } catch (err) {
        logger.warn({ err: err.message }, 'caddy re-render after license enforcement failed');
      }
    }
  } catch (err) {
    // DB not available (tests, first boot) or other error — skip enforcement
    logger.debug?.('License limit enforcement skipped: ' + err.message);
  } finally {
    enforcingLimits = false;
  }
}

/**
 * Entries the licence fallback switched off and that wait to come back.
 * @returns {{peers:number, routes:number, pools:number}}
 */
function licenseDisabledCounts() {
  const out = { peers: 0, routes: 0, pools: 0 };
  try {
    const db = require('../db/connection').getDb();
    out.peers = db.prepare('SELECT COUNT(*) AS c FROM peers WHERE enabled = 0 AND license_disabled = 1').get().c;
    out.routes = db.prepare('SELECT COUNT(*) AS c FROM routes WHERE enabled = 0 AND license_disabled = 1').get().c;
    out.pools = db.prepare('SELECT COUNT(*) AS c FROM gateway_pools WHERE enabled = 0 AND license_disabled = 1').get().c;
  } catch { /* DB not ready */ }
  return out;
}

// ─── Feature Checks ─────────────────────────────

function hasFeature(key) {
  if (!cachedFeatures) return false;
  return cachedFeatures[key] === true;
}

function getFeatureLimit(key) {
  if (!cachedFeatures) return 0;
  const val = cachedFeatures[key];
  return typeof val === 'number' ? val : 0;
}

function isWithinLimit(key, currentCount) {
  const limit = getFeatureLimit(key);
  if (limit === -1) return true;
  if (limit === 0) return false;
  return currentCount < limit;
}

function getFeatures() {
  return cachedFeatures;
}

function getPlan() {
  return cachedPlan;
}

/**
 * Why each locked boolean feature is locked (docs/feature-release-b.md §11):
 *   'unlicensed'   no licence token applied (no key, or it could not be
 *                  validated) — the community fallback is in force
 *   'not_in_token' the token does not carry the key at all (a feature newer
 *                  than what the licence server delivers)
 *   'plan'         the token carries the key as false
 * Only boolean features that are not `true`; limits (numbers) never appear.
 */
function lockedFeatures() {
  const out = {};
  const keys = new Set([...Object.keys(COMMUNITY_FALLBACK), ...Object.keys(cachedFeatures || {})]);
  for (const key of [...keys].sort()) {
    const val = cachedFeatures ? cachedFeatures[key] : undefined;
    const isBool = typeof val === 'boolean' || (val === undefined && typeof COMMUNITY_FALLBACK[key] === 'boolean');
    if (!isBool || val === true) continue;
    if (unlicensed || tokenFeatureKeys === null) out[key] = 'unlicensed';
    else if (!tokenFeatureKeys.has(key)) out[key] = 'not_in_token';
    else out[key] = 'plan';
  }
  return out;
}

/**
 * Where each feature's value comes from (docs/feature-next-package.md §S2.3):
 *   'token'         the applied licence token carries the key
 *   'plan_default'  a boolean the token does not carry, derived from a paid
 *                   plan (planDefaults) — the UI says "derived from your plan"
 *   'community'     COMMUNITY_FALLBACK (no token, community plan, or a key
 *                   neither side knows)
 * Every key of cachedFeatures appears, limits included (their source is only
 * ever 'token' or 'community' — numbers are never derived).
 */
function featureSources() {
  const out = {};
  const keys = new Set([...Object.keys(COMMUNITY_FALLBACK), ...Object.keys(cachedFeatures || {})]);
  const derived = tokenFeatureKeys === null || unlicensed ? {} : planDefaults(cachedPlan, Object.fromEntries([...tokenFeatureKeys].map((k) => [k, true])));
  for (const key of [...keys].sort()) {
    if (tokenFeatureKeys && tokenFeatureKeys.has(key)) out[key] = 'token';
    else if (Object.prototype.hasOwnProperty.call(derived, key)) out[key] = 'plan_default';
    else out[key] = 'community';
  }
  return out;
}

function getLicenseInfo() {
  const keyRaw = config.license.key;
  let masked = null;
  if (keyRaw && keyRaw.length > 8) {
    const parts = keyRaw.split('-');
    if (parts.length >= 4) {
      masked = parts[0] + '-****-****-' + parts[parts.length - 1];
    }
  }

  return {
    plan: cachedPlan,
    features: cachedFeatures,
    valid: cachedPlan !== 'community' || !config.license.key,
    unlicensed,
    expires_at: cachedLicenseInfo?.expires_at || null,
    updates_until: cachedLicenseInfo?.updates_until || null,
    // 'signed' (v2, Ed25519), 'signed_offline' (v2 token in offline grace),
    // 'legacy' (v1, HS256) or null (no licence applied)
    verification: cachedLicenseInfo?.verification || null,
    activations: cachedLicenseInfo?.activations || null,
    max_activations: cachedLicenseInfo?.max_activations || null,
    license_key_masked: masked,
    // last online check { at, ok, reason } — reason short ("HTTP 500",
    // "timeout", "ENOTFOUND"), never a key or response content
    lastCheck: lastCheck ? { ...lastCheck } : null,
    nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : null,
    // offline grace ('signed_offline'): last success, when the fallback to
    // Community comes, and the whole days until then
    offline: offlineInfo(),
    // why a licence key runs in Community mode: 'offline' | 'revoked' | 'upgrade' | null
    fallback_reason: config.license.key && cachedPlan === 'community' ? fallbackReason : null,
    // { licensed, installed } — the token is for an older main version ("Upgrade nötig")
    upgrade_required: upgradeRequired ? { ...upgradeRequired } : null,
    major: ownMajor,
    // end of life (licenseEol.js): { issued_at, scope, message, source, … } or null
    eol: eol.state(),
    locked: lockedFeatures(),
    source: featureSources(),
  };
}

function offlineInfo(now = Date.now()) {
  const o = cachedLicenseInfo && cachedLicenseInfo.verification === 'signed_offline' ? cachedLicenseInfo.offline : null;
  if (!o || !o.fallback_at) return null;
  const ms = Date.parse(o.fallback_at) - now;
  return { last_ok_at: o.last_ok_at || null, fallback_at: o.fallback_at, days_left: Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000))) };
}

function isUnlicensedMode() {
  return unlicensed;
}

/** A GateControl licence key is configured (env or UI) — nothing about its validity. */
function hasLicenseKey() {
  return !!config.license.key;
}

// ─── Remove License ─────────────────────────────

/**
 * Free this install's activation slot on the licence server (v2). Best effort:
 * never throws, a network error just leaves the slot taken.
 * @returns {Promise<boolean>} true when the server confirmed
 */
async function deactivateLicense(key) {
  if (!key || typeof key !== 'string') return false;
  const r = await v2.deactivate({ licenseKey: key, fingerprint: getHardwareFingerprint() });
  if (!r.ok) logger.warn(`License deactivation not confirmed by license server (${r.status ?? 'network error'})`);
  return r.ok;
}

/**
 * Plugin entitlements of the last v2 validation, without tokens.
 * `tier` / `seats` (since 1.206.0): from the signed plugin token of a valid entry, else null.
 * @returns {{slug:string,name:string,source:'license'|'lifetime'|'plan',key_masked:string|null,valid:boolean,error:string|null,expires_at:string|null,updates_until:string|null,tier:'family'|'business'|'combo'|null,seats:{included:number,family:number,business:number}|null}[]}
 */
function getPluginEntitlements() {
  return pluginEntitlements.map(({ slug, name, source, key_masked, valid, error, expires_at, updates_until, tier, seats }) => (
    { slug, name, source, key_masked: key_masked || null, valid, error, expires_at, updates_until, tier: tier || null, seats: seats ? { ...seats } : null }
  ));
}

async function removeLicense() {
  const oldKey = config.license.key;
  if (oldKey) await deactivateLicense(oldKey);
  v2.clearState();
  deleteToken();
  stopLicenseRefresh();
  resetChecks();
  setCommunityMode();
  unlicensed = true;
  fallbackReason = null;
  upgradeRequired = null;

  // Clear runtime config
  config.license.key = '';
  config.license.signingKey = '';

  // Clear from settings if stored via UI
  try {
    const settings = require('./settings');
    settings.set('license_key', '');
    settings.set('license_signing_key_encrypted', '');
  } catch {
    // Settings may not be initialized
  }

  await enforceLimitsInternal();
}

function _overrideForTest(features) {
  Object.assign(cachedFeatures, features);
}

// Test seam: apply a licence payload as if it came from a token
// ({ plan, features }); `null` restores the unlicensed community mode.
function _applyLicenseForTest(data) {
  if (process.env.NODE_ENV !== 'test') return;
  if (data) { applyLicense(data, data.verification || 'legacy'); return; }
  setCommunityMode();
  unlicensed = true;
}

module.exports = {
  validateLicense,
  refreshLicenseInBackground,
  startLicenseRefresh,
  stopLicenseRefresh,
  enforceLimits: enforceLimitsInternal,
  hasFeature,
  getFeatureLimit,
  isWithinLimit,
  getFeatures,
  getPlan,
  getLicenseInfo,
  isUnlicensedMode,
  hasLicenseKey,
  removeLicense,
  COMMUNITY_FALLBACK,
  RETIRED_FEATURES,
  _getHardwareFingerprint: getHardwareFingerprint,
  _overrideForTest,
  _applyLicenseForTest,
  _resetV2ForTest: () => { v2._resetForTest(); eol._resetForTest(); pluginEntitlements = []; upgradeRequired = null; fallbackReason = null; stopLicenseRefresh(); resetChecks(); },
  // Test seam: plugin entitlements as a verified v2 validation would leave them.
  _setPluginEntitlementsForTest: (list) => { if (process.env.NODE_ENV === 'test') pluginEntitlements = Array.isArray(list) ? list : []; },
  deactivateLicense,
  getPluginEntitlements,
  setPluginKeys: v2.setPluginKeys,
  getPluginKeys: v2.getPluginKeys,
  GRACE_MS,
  lockedFeatures,
  featureSources,
  planDefaults,
  licenseDisabledCounts,
  OWN_MAJOR,
  fetchEolInBackground,
  _setOwnMajorForTest: (n) => { if (process.env.NODE_ENV === 'test') ownMajor = n == null ? OWN_MAJOR : n; },
};
