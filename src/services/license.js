'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const jwt = require('jsonwebtoken');
const config = require('../../config/default');
const logger = require('../utils/logger');

const PRODUCT_SLUG = 'gatecontrol';

// Hardcodierter Community-Fallback für den unlizenzierten Modus.
// Wird verwendet wenn KEIN Lizenzschlüssel konfiguriert ist.
// Nutzer mit Community-Lizenzschlüssel erhalten aktuelle Werte vom Server.
const COMMUNITY_FALLBACK = {
  vpn_peers: 3,
  http_routes: 1,
  l4_routes: 0,
  route_auth: false,
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
};

let cachedPlan = 'community';
let cachedFeatures = { ...COMMUNITY_FALLBACK };
let cachedLicenseInfo = null;
let previousPlan = null;
let refreshInterval = null;
let enforcingLimits = false;
let unlicensed = true; // true wenn ohne Lizenzschlüssel gestartet

// ─── Hardware Fingerprint ────────────────────────

function getHardwareFingerprint() {
  let raw;
  try {
    raw = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {
    raw = os.hostname() + JSON.stringify(os.cpus().map(c => c.model));
  }
  return crypto.createHash('sha256').update(raw).digest('hex');
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
      device_name: os.hostname(),
      product_slug: PRODUCT_SLUG,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  saveToken(data.token);

  return {
    plan: data.license.plan,
    features: data.license.features,
    expires_at: data.license.expires_at,
    activations: data.license.active_activations,
    max_activations: data.license.max_activations,
  };
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

  // 2. No signing key → Licensed but can't validate
  if (!config.license.signingKey) {
    setCommunityMode();
    logger.warn('GC_LICENSE_SIGNING_KEY not set — running in Community mode');
    await enforceLimitsInternal();
    return getLicenseInfo();
  }

  const fingerprint = getHardwareFingerprint();

  // 3. Try cached token
  const cached = loadCachedToken(fingerprint);
  if (cached) {
    applyLicense(cached);
    logger.info(`License valid (cached) — Plan: ${cached.plan}`);
    refreshLicenseInBackground(fingerprint);
    return getLicenseInfo();
  }

  // 4. Online validation
  try {
    const result = await validateOnline(fingerprint);
    applyLicense(result);
    logger.info(`License valid (online) — Plan: ${result.plan}`);
    return getLicenseInfo();
  } catch (err) {
    // 5. Fallback to expired token
    const fallback = loadCachedToken(fingerprint, true);
    if (fallback) {
      applyLicense(fallback);
      logger.warn(`License server unreachable, using cached token — Plan: ${fallback.plan}`);
      return getLicenseInfo();
    }

    // 6. All failed → Community mode
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
  // Note: unlicensed flag is NOT set here — caller decides
}

function applyLicense(data) {
  previousPlan = cachedPlan;
  unlicensed = false;
  cachedPlan = data.plan;
  cachedFeatures = data.features;
  cachedLicenseInfo = {
    expires_at: data.expires_at || null,
    activations: data.activations || null,
    max_activations: data.max_activations || null,
  };
}

// ─── Background Refresh ─────────────────────────

async function refreshLicenseInBackground(fingerprint) {
  try {
    const fp = fingerprint || getHardwareFingerprint();
    const result = await validateOnline(fp);
    applyLicense(result);
    if (previousPlan && previousPlan !== cachedPlan) {
      await enforceLimitsInternal();
    }
  } catch {
    // Silent failure — keep using cached data
  }
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function startLicenseRefresh() {
  if (!config.license.key) return;
  refreshInterval = setInterval(() => refreshLicenseInBackground(), SEVEN_DAYS);
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
    activations: cachedLicenseInfo?.activations || null,
    max_activations: cachedLicenseInfo?.max_activations || null,
    license_key_masked: masked,
  };
}

function isUnlicensedMode() {
  return unlicensed;
}

// ─── Remove License ─────────────────────────────

async function removeLicense() {
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
};
