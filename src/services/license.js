'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const jwt = require('jsonwebtoken');
const config = require('../../config/default');
const logger = require('../utils/logger');
const v2 = require('./licenseV2');

const PRODUCT_SLUG = 'gatecontrol';

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
  pihole_integration: false,
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
};

let cachedPlan = 'community';
let cachedFeatures = { ...COMMUNITY_FALLBACK };
let cachedLicenseInfo = null;
let previousPlan = null;
let refreshInterval = null;
let enforcingLimits = false;
let unlicensed = true; // true wenn ohne Lizenzschlüssel gestartet
// Feature keys the applied licence token actually carried (null = no token
// applied: community fallback). Lets getLicenseInfo() tell a feature the plan
// switches off from one the licence server does not deliver yet (release B §11).
let tokenFeatureKeys = null;
// Plugin entitlements of the last applied v2 validation (empty without v2).
let pluginEntitlements = [];

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
    throw new Error(err.error || `HTTP ${res.status}`);
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
    throw new Error('License server returned malformed response');
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
async function verifyPlugins(plugins, fingerprint, { allowExpired }) {
  const out = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (!p || typeof p !== 'object' || typeof p.slug !== 'string') continue;
    const entry = {
      slug: p.slug,
      name: typeof p.name === 'string' ? p.name : p.slug,
      source: p.source === 'lifetime' ? 'lifetime' : 'license',
      key_masked: typeof p.key_masked === 'string' ? p.key_masked : null,
      valid: false,
      error: typeof p.error === 'string' ? p.error : null,
      expires_at: p.expires_at || null,
      updates_until: p.updates_until || null,
    };
    if (p.valid === true) {
      const r = await v2.verifyToken(p.token, { fingerprint, kind: 'plugin', allowExpired });
      if (!r.ok) {
        entry.error = 'token_invalid';
      } else if (r.payload.lat > 0 && r.payload.lat < nowSec) {
        entry.error = 'expired';
      } else {
        entry.valid = true;
        entry.error = null;
        entry.expires_at = isoFromUnix(r.payload.lat);
        entry.updates_until = isoFromUnix(r.payload.upd);
      }
    }
    out.push(entry);
  }
  return out;
}

function applyV2(payload, rec, plugins, { offline = false } = {}) {
  applyLicense({
    plan: payload.plan,
    features: payload.features,
    expires_at: isoFromUnix(payload.lat),
    updates_until: isoFromUnix(payload.upd),
    activations: rec.activations,
    max_activations: rec.max_activations,
  }, offline ? 'signed_offline' : 'signed');
  pluginEntitlements = plugins;
}

/**
 * The stored v2 token, verified. `grace` additionally accepts a passed `exp`
 * while the 14-day grace since the last successful validation runs.
 * @returns {Promise<{payload, rec}|null>}
 */
async function loadV2Token(fingerprint, { grace = false } = {}) {
  const rec = v2.loadState(config.license.key);
  if (!rec) return null;
  const r = await v2.verifyToken(rec.token, { fingerprint, kind: 'app', allowExpired: grace });
  if (!r.ok) return null;
  const now = Date.now();
  if (r.payload.lat > 0 && r.payload.lat * 1000 < now) return null;              // licence itself expired
  if (grace && r.payload.exp * 1000 <= now && now - Number(rec.last_ok_at || 0) > GRACE_MS) return null;
  return { payload: r.payload, rec };
}

function dropV2License(reason) {
  v2.clearState();
  deleteToken(); // the v1 token of a revoked licence must not resurrect it
  pluginEntitlements = [];
  logger.warn(`License rejected by license server (${reason}) — running in Community mode`);
}

/**
 * One v2 round. Returns what the caller has to do:
 *   'applied'    a verified v2 licence is in force
 *   'community'  fall back to the community plan (revoked, or grace over)
 *   'v1'         v2 is not available and never succeeded here → legacy path
 */
async function validateV2(fingerprint, { useCache }) {
  if (useCache) {
    const cached = await loadV2Token(fingerprint);
    if (cached) {
      const plugins = await verifyPlugins(cached.rec.plugins, fingerprint, { allowExpired: false });
      applyV2(cached.payload, cached.rec, plugins);
      logger.info(`License valid (cached, signed) — Plan: ${cached.payload.plan}`);
      refreshLicenseInBackground(fingerprint);
      return 'applied';
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
      applyV2(r.payload, rec, plugins);
      logger.info(`License valid (online, signed) — Plan: ${r.payload.plan}`);
      return 'applied';
    }
    logger.warn(`License server returned a token that does not verify (${r.reason}) — ignored`);
  } else if (res.status === 'invalid') {
    dropV2License(res.message);
    return 'community';
  }

  // unavailable / transient / unverifiable token
  if (!v2.isActive()) return 'v1';

  const grace = await loadV2Token(fingerprint, { grace: true });
  if (grace) {
    const plugins = await verifyPlugins(grace.rec.plugins, fingerprint, { allowExpired: true });
    applyV2(grace.payload, grace.rec, plugins, { offline: true });
    logger.warn(`License server unreachable (${res.reason || res.status}), using cached signed token — Plan: ${grace.payload.plan}`);
    return 'applied';
  }
  pluginEntitlements = [];
  logger.warn(`License server unreachable (${res.reason || res.status}) and offline grace exhausted — running in Community mode`);
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

  // 1. No license key → Unlicensed community mode
  if (!config.license.key) {
    unlicensed = true;
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
  if (outcome === 'applied') return getLicenseInfo();
  if (outcome === 'community') {
    setCommunityMode();
    await enforceLimitsInternal();
    return getLicenseInfo();
  }

  return validateLicenseV1(fingerprint);
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
    logger.info(`License valid (online) — Plan: ${result.plan}`);
    return getLicenseInfo();
  } catch (err) {
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
  cachedFeatures = { ...COMMUNITY_FALLBACK, ...planDefaults(data.plan, data.features), ...data.features };
  tokenFeatureKeys = new Set(Object.keys(data.features || {}));
  cachedLicenseInfo = {
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
      const result = await validateOnline(fp);
      applyLicense(result);
    }
    if (previousPlan && previousPlan !== cachedPlan) {
      await enforceLimitsInternal();
    }
  } catch {
    // Silent failure — keep using cached data
  }
}

// Daily: a revoked licence is noticed within a day, and the offline grace
// is re-evaluated even while the licence server stays unreachable.
const ONE_DAY = 24 * 60 * 60 * 1000;

function startLicenseRefresh() {
  if (!config.license.key || refreshInterval) return;
  refreshInterval = setInterval(() => refreshLicenseInBackground(), ONE_DAY);
  if (typeof refreshInterval.unref === 'function') refreshInterval.unref();
}

function stopLicenseRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// ─── Enforce Limits (Soft-Lock) ─────────────────

async function enforceLimitsInternal() {
  if (enforcingLimits) return;
  enforcingLimits = true;

  try {
    const { getDb } = require('../db/connection');
    const db = getDb();
    const activity = require('./activity');

    const limitKeys = [
      { feature: 'vpn_peers', table: 'peers', type: 'peer', nameCol: 'name' },
      { feature: 'http_routes', table: 'routes', type: 'route', nameCol: 'domain', where: "(route_type = 'http' OR route_type IS NULL)" },
      { feature: 'l4_routes', table: 'routes', type: 'route', nameCol: 'domain', where: "route_type = 'l4'" },
    ];

    for (const { feature, table, type, nameCol, where } of limitKeys) {
      const limit = getFeatureLimit(feature);
      if (limit === -1) continue;

      const whereClause = where ? `WHERE enabled = 1 AND ${where}` : 'WHERE enabled = 1';
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${table} ${whereClause}`).get().count;

      if (count > limit) {
        const excess = count - limit;
        const rows = db.prepare(
          `SELECT id, ${nameCol} as label FROM ${table} ${whereClause} ORDER BY created_at ASC LIMIT ?`
        ).all(excess);

        for (const row of rows) {
          db.prepare(`UPDATE ${table} SET enabled = 0, updated_at = datetime('now') WHERE id = ?`).run(row.id);
          activity.log(`${type}_license_disabled`, `${type === 'peer' ? 'Peer' : 'Route'} "${row.label}" disabled — license limit (${limit})`, { severity: 'warning' });
        }

        logger.warn(`License limit: disabled ${excess} ${type}(s) for ${feature} (limit: ${limit})`);

        // Sync to WireGuard/Caddy so disabled entries are actually removed
        if (type === 'peer') {
          try {
            const wireguard = require('./wireguard');
            await wireguard.syncConfig();
          } catch (err) {
            logger.warn('WireGuard sync after license enforcement failed: ' + err.message);
          }
        } else {
          try {
            const routes = require('./routes');
            await routes.syncToCaddy();
          } catch (err) {
            logger.warn('Caddy sync after license enforcement failed: ' + err.message);
          }
        }

        // Send email alert if configured
        try {
          const email = require('./email');
          const settings = require('./settings');
          if (settings.get('email_alerts_enabled') === 'true') {
            const alertEmail = settings.get('alert_email');
            if (alertEmail) {
              await email.send(alertEmail, 'GateControl License Limit',
                `${excess} ${type}(s) were disabled because the ${feature} limit (${limit}) was exceeded after a license change.`);
            }
          }
        } catch {
          // Email alert is best-effort
        }
      }
    }
    // ─── Pool enforcement ────────────────────────────
    if (cachedFeatures.gateway_pools === false) {
      const result = db.prepare("UPDATE gateway_pools SET enabled = 0 WHERE enabled = 1").run();
      if (result.changes > 0) {
        activity.log(
          'pool_disabled_by_license_enforcement',
          `${result.changes} pool(s) disabled — gateway_pools feature revoked`,
          { source: 'system', severity: 'warn', details: { count: result.changes } },
        );
      }
    } else if (cachedFeatures.gateway_pool_load_balancing === false) {
      const result = db.prepare("UPDATE gateway_pools SET enabled = 0 WHERE mode = 'load_balancing' AND enabled = 1").run();
      if (result.changes > 0) {
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
        const ids = overflow.map(r => r.id);
        db.prepare(`UPDATE gateway_pools SET enabled = 0 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        activity.log(
          'pool_disabled_by_license_enforcement',
          `${overflow.length} pool(s) over limit (${poolsLimit}) disabled`,
          { source: 'system', severity: 'warn', details: { ids, limit: poolsLimit } },
        );
      }
    }

    try {
      await require('./caddyConfig').syncToCaddy();
    } catch (err) {
      logger.warn({ err: err.message }, 'caddy re-render after license enforcement failed');
    }
  } catch (err) {
    // DB not available (tests, first boot) or other error — skip enforcement
    logger.debug?.('License limit enforcement skipped: ' + err.message);
  } finally {
    enforcingLimits = false;
  }
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
    locked: lockedFeatures(),
    source: featureSources(),
  };
}

function isUnlicensedMode() {
  return unlicensed;
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
 * @returns {{slug:string,name:string,source:'license'|'lifetime',valid:boolean,error:string|null,expires_at:string|null,updates_until:string|null}[]}
 */
function getPluginEntitlements() {
  return pluginEntitlements.map(({ slug, name, source, valid, error, expires_at, updates_until }) => (
    { slug, name, source, valid, error, expires_at, updates_until }
  ));
}

async function removeLicense() {
  const oldKey = config.license.key;
  if (oldKey) await deactivateLicense(oldKey);
  v2.clearState();
  deleteToken();
  stopLicenseRefresh();
  setCommunityMode();
  unlicensed = true;

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
  removeLicense,
  COMMUNITY_FALLBACK,
  _getHardwareFingerprint: getHardwareFingerprint,
  _overrideForTest,
  _applyLicenseForTest,
  _resetV2ForTest: () => { v2._resetForTest(); pluginEntitlements = []; },
  deactivateLicense,
  getPluginEntitlements,
  setPluginKeys: v2.setPluginKeys,
  getPluginKeys: v2.getPluginKeys,
  GRACE_MS,
  lockedFeatures,
  featureSources,
  planDefaults,
};
