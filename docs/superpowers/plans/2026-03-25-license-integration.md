# License Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate license validation with callmetechie.de so unlicensed GateControl instances run in Community mode (5 peers, 3 HTTP routes, limited features) while licensed instances unlock everything.

**Architecture:** Service with in-memory cache (`src/services/license.js`) validates against remote API on startup + every 7 days, falls back to cached JWT token offline, defaults to Community mode. Middleware injects license state into `res.locals`. Feature guards (`requireFeature`, `requireLimit`) protect API routes. UI shows lock icons on locked features.

**Tech Stack:** Node.js 20, Express 4.21, better-sqlite3, jsonwebtoken, Nunjucks templates, node:test + supertest

**Spec:** `docs/superpowers/specs/2026-03-25-license-integration-design.md`

**Reference Docs:** `LizenzDokumentation/license-validation-api.md`, `LizenzDokumentation/client-integration.md`, `LizenzDokumentation/integration-gatecontrol.md`

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `src/services/license.js` | License validation, token caching, feature checks, enforce limits |
| Create | `src/middleware/license.js` | Inject `res.locals.license`, export `requireFeature()` + `requireLimit()` |
| Create | `src/routes/api/license.js` | License API endpoints (GET, POST activate/refresh, DELETE) |
| Create | `tests/license.test.js` | Unit + integration tests for license service + API |
| Edit | `config/default.js` | Add `license` config section (after line 102) |
| Edit | `src/server.js` | Add `validateLicense()` at startup, `startLicenseRefresh()` background task |
| Edit | `src/app.js` | Mount license middleware (after line 85) + license API routes |
| Edit | `src/middleware/locals.js` | No change needed — license middleware is separate |
| Edit | `src/i18n/en.json` | Add ~30 license i18n keys |
| Edit | `src/i18n/de.json` | Add ~30 license i18n keys |
| Edit | `.env.example` | Add license env vars |
| Edit | `package.json` | Add jsonwebtoken dependency |
| Edit | `src/routes/api/peers.js` | Add `requireLimit('vpn_peers', ...)` guard on POST |
| Edit | `src/routes/api/routes.js` | Add `requireLimit` + `requireFeature` guards |
| Edit | `src/routes/api/webhooks.js` | Add `requireFeature('webhooks')` guard |
| Edit | `src/routes/api/tokens.js` | Add `requireFeature('api_tokens')` guard |
| Edit | `src/routes/api/routeAuth.js` | Add `requireFeature('route_auth')` guard |
| Edit | `src/routes/api/settings.js` | Add `requireFeature('scheduled_backups')` on autobackup endpoints |
| Edit | `src/routes/api/logs.js` | Add `requireFeature('log_export')` on export endpoints |
| Edit | `src/routes/index.js` | Add `hasFeature('prometheus_metrics')` check inside /metrics handler |
| Edit | `templates/default/pages/settings.njk` | Add License tab |
| Edit | `public/js/settings.js` | Add license tab JS logic |
| Edit | `public/css/app.css` | Add `.feature-locked` styles |
| Edit | `templates/default/pages/routes.njk` | Add lock icons on locked feature toggles |
| Edit | `templates/default/pages/peers.njk` | Add limit display on peer count |

---

## Task 1: Install dependency + config

**Files:**
- Modify: `package.json`
- Modify: `config/default.js:96-114`
- Modify: `.env.example`

- [ ] **Step 1: Install jsonwebtoken**

```bash
cd /root/gatecontrol && npm install jsonwebtoken
```

- [ ] **Step 2: Add license config section to `config/default.js`**

Add after the `timeouts` section (after line 102), before `module.exports`:

```javascript
  license: {
    key: env('GC_LICENSE_KEY', ''),
    signingKey: env('GC_LICENSE_SIGNING_KEY', ''),
    server: env('GC_LICENSE_SERVER', 'https://callmetechie.de/api/licenses/validate'),
    tokenPath: path.join(env('GC_DATA_PATH', '/data'), '.license-token'),
  },
```

Note: `path` is already imported at line 4 as `const path = require('node:path')` — do NOT add a duplicate import.

- [ ] **Step 3: Add license env vars to `.env.example`**

Add at the end of the file:

```bash

# ─── License ──────────────────────────────────
# GC_LICENSE_KEY=GATE-XXXX-XXXX-XXXX
# GC_LICENSE_SIGNING_KEY=
# GC_LICENSE_SERVER=https://callmetechie.de/api/licenses/validate
```

- [ ] **Step 4: Verify config loads**

```bash
node -e "const c = require('./config/default'); console.log(c.license);"
```

Expected: `{ key: '', signingKey: '', server: 'https://callmetechie.de/api/licenses/validate', tokenPath: '/data/.license-token' }`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json config/default.js .env.example
git commit -m "feat(license): add jsonwebtoken dependency + license config section"
```

---

## Task 2: License service — core module

**Files:**
- Create: `src/services/license.js`
- Test: `tests/license.test.js`

- [ ] **Step 1: Write failing tests for license service**

Create `tests/license.test.js`:

```javascript
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// We test the exported functions by manipulating the module's state
// Since the service uses in-memory cache, we test via the public API

describe('License Service', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-license-'));
  const tokenPath = path.join(tmpDir, '.license-token');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Community mode (no license key)', () => {
    let license;

    before(async () => {
      // Clear env to simulate no license
      delete process.env.GC_LICENSE_KEY;
      delete process.env.GC_LICENSE_SIGNING_KEY;

      // Re-require to get fresh module with test config
      delete require.cache[require.resolve('../src/services/license')];
      license = require('../src/services/license');
      await license.validateLicense();
    });

    it('should return community plan', () => {
      assert.equal(license.getPlan(), 'community');
    });

    it('should have community feature limits', () => {
      const features = license.getFeatures();
      assert.equal(features.vpn_peers, 5);
      assert.equal(features.http_routes, 3);
      assert.equal(features.l4_routes, 0);
    });

    it('should have compression enabled (community feature)', () => {
      assert.equal(license.hasFeature('compression'), true);
    });

    it('should have webhooks disabled', () => {
      assert.equal(license.hasFeature('webhooks'), false);
    });

    it('should report correct limits', () => {
      assert.equal(license.getFeatureLimit('vpn_peers'), 5);
      assert.equal(license.getFeatureLimit('http_routes'), 3);
      assert.equal(license.getFeatureLimit('l4_routes'), 0);
    });

    it('should check isWithinLimit correctly', () => {
      assert.equal(license.isWithinLimit('vpn_peers', 3), true);
      assert.equal(license.isWithinLimit('vpn_peers', 5), false);
      assert.equal(license.isWithinLimit('vpn_peers', 6), false);
      assert.equal(license.isWithinLimit('l4_routes', 0), false);
    });

    it('should return license info', () => {
      const info = license.getLicenseInfo();
      assert.equal(info.plan, 'community');
      assert.equal(info.valid, true);
      assert.equal(info.features.vpn_peers, 5);
    });
  });

  describe('Hardware fingerprint', () => {
    it('should return a 64-char hex string', () => {
      const license = require('../src/services/license');
      const fp = license._getHardwareFingerprint();
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it('should be stable across calls', () => {
      const license = require('../src/services/license');
      const fp1 = license._getHardwareFingerprint();
      const fp2 = license._getHardwareFingerprint();
      assert.equal(fp1, fp2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --test-name-pattern "License"
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/services/license.js`**

```javascript
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const jwt = require('jsonwebtoken');
const config = require('../../config/default');
const logger = require('../utils/logger');

const PRODUCT_SLUG = 'gatecontrol';

const COMMUNITY_FEATURES = {
  vpn_peers: 5,
  http_routes: 3,
  l4_routes: 0,
  route_auth: false,
  custom_branding: false,
  ip_access_control: false,
  peer_acl: false,
  rate_limiting: false,
  compression: true,
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
};

let cachedPlan = 'community';
let cachedFeatures = { ...COMMUNITY_FEATURES };
let cachedLicenseInfo = null;
let previousPlan = null;
let refreshInterval = null;
let enforcingLimits = false;

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
  // 1. No license key → Community mode
  if (!config.license.key) {
    setCommunityMode();
    logger.info('No license key configured — running in Community mode');
    return getLicenseInfo();
  }

  // 2. No signing key → Community mode with warning
  if (!config.license.signingKey) {
    setCommunityMode();
    logger.warn('GC_LICENSE_SIGNING_KEY not set — running in Community mode');
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
    return getLicenseInfo();
  }
}

function setCommunityMode() {
  previousPlan = cachedPlan;
  cachedPlan = 'community';
  cachedFeatures = { ...COMMUNITY_FEATURES };
  cachedLicenseInfo = null;
}

function applyLicense(data) {
  previousPlan = cachedPlan;
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
      await enforceLimits();
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

async function enforceLimits() {
  if (enforcingLimits) return;
  enforcingLimits = true;

  try {
    const { getDb } = require('../db/connection');
    const activity = require('./activity');
    const db = getDb();

    const limitKeys = [
      { feature: 'vpn_peers', table: 'peers', type: 'peer' },
      { feature: 'http_routes', table: 'routes', type: 'route', where: "route_type = 'http'" },
      { feature: 'l4_routes', table: 'routes', type: 'route', where: "route_type = 'l4'" },
    ];

    for (const { feature, table, type, where } of limitKeys) {
      const limit = getFeatureLimit(feature);
      if (limit === -1) continue;

      const whereClause = where ? `WHERE enabled = 1 AND ${where}` : 'WHERE enabled = 1';
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${table} ${whereClause}`).get().count;

      if (count > limit) {
        const excess = count - limit;
        const rows = db.prepare(
          `SELECT id, name FROM ${table} ${whereClause} ORDER BY created_at ASC LIMIT ?`
        ).all(excess);

        for (const row of rows) {
          db.prepare(`UPDATE ${table} SET enabled = 0, updated_at = datetime('now') WHERE id = ?`).run(row.id);
          activity.log(`${type}_license_disabled`, `${type === 'peer' ? 'Peer' : 'Route'} "${row.name}" disabled — license limit (${limit})`, { severity: 'warning' });
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
    expires_at: cachedLicenseInfo?.expires_at || null,
    activations: cachedLicenseInfo?.activations || null,
    max_activations: cachedLicenseInfo?.max_activations || null,
    license_key_masked: masked,
  };
}

// ─── Remove License ─────────────────────────────

async function removeLicense() {
  deleteToken();
  stopLicenseRefresh();
  setCommunityMode();

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

  await enforceLimits();
}

module.exports = {
  validateLicense,
  refreshLicenseInBackground,
  startLicenseRefresh,
  stopLicenseRefresh,
  enforceLimits,
  hasFeature,
  getFeatureLimit,
  isWithinLimit,
  getFeatures,
  getPlan,
  getLicenseInfo,
  removeLicense,
  COMMUNITY_FEATURES,
  _getHardwareFingerprint: getHardwareFingerprint,
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --test-name-pattern "License"
```

Expected: PASS for community mode tests and fingerprint tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/license.js tests/license.test.js
git commit -m "feat(license): add license service with community mode + feature checks"
```

---

## Task 3: License middleware + feature guards

**Files:**
- Create: `src/middleware/license.js`
- Modify: `src/app.js:85`

- [ ] **Step 1: Create `src/middleware/license.js`**

```javascript
'use strict';

const { getPlan, getFeatures, hasFeature, getFeatureLimit, isWithinLimit } = require('../services/license');

/**
 * Middleware: injects license state into res.locals for templates.
 */
function injectLicense(req, res, next) {
  res.locals.license = {
    plan: getPlan(),
    features: getFeatures(),
    hasFeature,
    isWithinLimit,
  };
  next();
}

/**
 * Guard: blocks requests if a boolean feature is not licensed.
 * @param {string} featureKey - Feature key (e.g., 'webhooks')
 */
function requireFeature(featureKey) {
  return (req, res, next) => {
    if (!hasFeature(featureKey)) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.feature_not_available') : 'Feature not available in your plan',
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}

/**
 * Guard: blocks requests if a number feature limit is reached.
 * countFn MUST be synchronous (better-sqlite3 is sync).
 * @param {string} featureKey - Feature key (e.g., 'vpn_peers')
 * @param {Function} countFn - Synchronous function returning current count
 */
function requireLimit(featureKey, countFn) {
  return (req, res, next) => {
    const limit = getFeatureLimit(featureKey);
    if (limit === -1) return next();
    if (limit === 0) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.feature_not_available') : 'Feature not available in your plan',
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    const count = countFn();
    if (count >= limit) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.limit_reached') : 'Limit reached',
        feature: featureKey,
        current: count,
        limit,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}

/**
 * Guard: checks a boolean feature field in req.body before allowing route create/update.
 * Used for features toggled within the route payload (e.g., rate_limit_enabled).
 * Passes through if the feature field is not set or false in the body.
 * @param {string} bodyField - Field name in req.body (e.g., 'rate_limit_enabled')
 * @param {string} featureKey - License feature key (e.g., 'rate_limiting')
 */
function requireFeatureField(bodyField, featureKey) {
  return (req, res, next) => {
    if (req.body && req.body[bodyField] && !hasFeature(featureKey)) {
      return res.status(403).json({
        ok: false,
        error: req.t ? req.t('error.license.feature_not_available') : 'Feature not available in your plan',
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}

module.exports = { injectLicense, requireFeature, requireLimit, requireFeatureField };
```

- [ ] **Step 2: Mount middleware in `src/app.js`**

After line 85 (`app.use(injectLocals);`), add:

```javascript
  const { injectLicense } = require('./middleware/license');
  app.use(injectLicense);
```

- [ ] **Step 3: Verify app starts**

```bash
node -e "const app = require('./src/app'); console.log('OK');"
```

Expected: `OK` (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/middleware/license.js src/app.js
git commit -m "feat(license): add license middleware + feature guard functions"
```

---

## Task 4: License API endpoints

**Files:**
- Create: `src/routes/api/license.js`
- Modify: `src/routes/api/index.js` (mount the new route)

- [ ] **Step 1: Create `src/routes/api/license.js`**

```javascript
'use strict';

const { Router } = require('express');
const license = require('../../services/license');
const settings = require('../../services/settings');
const { encrypt } = require('../../utils/crypto');
const activity = require('../../services/activity');
const config = require('../../../config/default');
const router = Router();

let lastActivateCall = 0;
let lastRefreshCall = 0;
const COOLDOWN = 60000; // 60 seconds

// GET /api/v1/license — Full license info
router.get('/', (req, res) => {
  res.json({ ok: true, ...license.getLicenseInfo() });
});

// POST /api/v1/license/activate — Activate license
router.post('/activate', async (req, res) => {
  const now = Date.now();
  if (now - lastActivateCall < COOLDOWN) {
    return res.status(429).json({
      ok: false,
      error: req.t('error.license.rate_limited') || 'Please wait before trying again',
    });
  }
  lastActivateCall = now;

  const { license_key, signing_key } = req.body;
  if (!license_key) {
    return res.status(400).json({ ok: false, error: req.t('error.license.key_required') || 'License key is required' });
  }
  if (!signing_key) {
    return res.status(400).json({ ok: false, error: req.t('error.license.signing_key_required') || 'Signing key is required' });
  }

  // Store in settings (signing key encrypted at rest)
  settings.set('license_key', license_key);
  settings.set('license_signing_key_encrypted', encrypt(signing_key));

  // Update runtime config
  config.license.key = license_key;
  config.license.signingKey = signing_key;

  try {
    await license.validateLicense();
    activity.log('license_activated', `License activated — Plan: ${license.getPlan()}`);
    license.startLicenseRefresh();
    res.json({ ok: true, ...license.getLicenseInfo() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/v1/license/refresh — Manual refresh
router.post('/refresh', async (req, res) => {
  const now = Date.now();
  if (now - lastRefreshCall < COOLDOWN) {
    return res.status(429).json({
      ok: false,
      error: req.t('error.license.rate_limited') || 'Please wait before trying again',
    });
  }
  lastRefreshCall = now;

  try {
    await license.refreshLicenseInBackground();
    activity.log('license_refresh_success', `License refreshed — Plan: ${license.getPlan()}`);
    res.json({ ok: true, ...license.getLicenseInfo() });
  } catch (err) {
    activity.log('license_refresh_failed', `License refresh failed: ${err.message}`, { severity: 'warning' });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/v1/license — Remove license
router.delete('/', async (req, res) => {
  await license.removeLicense();
  activity.log('license_removed', 'License removed — reverted to Community mode');
  res.json({ ok: true, ...license.getLicenseInfo() });
});

module.exports = router;
```

- [ ] **Step 2: Mount in `src/routes/api/index.js`**

Find the existing router mounts and add:

```javascript
router.use('/license', require('./license'));
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All existing tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/license.js src/routes/api/index.js
git commit -m "feat(license): add license API endpoints (GET, activate, refresh, delete)"
```

---

## Task 5: Startup + shutdown integration

**Files:**
- Modify: `src/server.js:18-57` (startup) and `src/server.js:142-167` (shutdown)

- [ ] **Step 1: Add license validation to startup in `src/server.js`**

Add import at top:

```javascript
const { validateLicense, startLicenseRefresh, stopLicenseRefresh } = require('./services/license');
```

After `seedAdminUser()` (line 33) and before `createApp()`, add:

```javascript
    // Validate license (never throws — falls back to Community mode internally)
    const licenseInfo = await validateLicense();
    logger.info(`License: ${licenseInfo.plan} plan`);
```

After the background tasks block (after line 57), add:

```javascript
    startLicenseRefresh();
```

- [ ] **Step 2: Add shutdown cleanup**

In the `shutdown()` function, alongside the other `stop*()` calls (around lines 144-148), add:

```javascript
    stopLicenseRefresh();
```

- [ ] **Step 3: Verify server starts**

```bash
GC_SECRET=test GC_ADMIN_PASSWORD=test123 timeout 5 node src/server.js 2>&1 || true
```

Expected: Log output includes "License: community plan" and server starts.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(license): integrate license validation into startup + shutdown"
```

---

## Task 6: i18n keys

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English license keys to `src/i18n/en.json`**

Add these keys (in the appropriate alphabetical position within the JSON):

```json
"license.title": "License",
"license.status": "License Status",
"license.plan": "Plan",
"license.plan_community": "Community",
"license.plan_pro": "Pro",
"license.plan_lifetime": "Lifetime",
"license.valid_until": "Valid until",
"license.activations": "Activations",
"license.features": "Features",
"license.activate": "Activate License",
"license.refresh": "Refresh License",
"license.remove": "Remove License",
"license.remove_confirm": "Remove license and revert to Community mode?",
"license.community_mode": "Community Mode",
"license.community_hint": "Running in Community mode. Upgrade for unlimited peers, routes, and all features.",
"license.requires_pro": "Requires Pro or Lifetime license",
"license.limit_reached": "Limit reached",
"license.limit_display": "{current} / {limit}",
"license.upgrade": "Upgrade",
"license.key_label": "License Key",
"license.key_placeholder": "GATE-XXXX-XXXX-XXXX",
"license.signing_key_label": "Signing Key",
"license.signing_key_placeholder": "Paste signing key from admin panel",
"license.refresh_success": "License refreshed successfully",
"license.refresh_failed": "License refresh failed",
"license.activated": "License activated successfully",
"license.removed": "License removed",
"license.feature_enabled": "Included",
"license.feature_disabled": "Not included",
"license.unlimited": "Unlimited",
"error.license.invalid": "Invalid license key",
"error.license.expired": "License has expired",
"error.license.activation_limit": "Activation limit reached",
"error.license.feature_not_available": "This feature requires a Pro or Lifetime license",
"error.license.limit_reached": "Resource limit reached — upgrade for unlimited",
"error.license.validation_failed": "License validation failed",
"error.license.key_required": "License key is required",
"error.license.signing_key_required": "Signing key is required",
"error.license.rate_limited": "Please wait before trying again",
"settings.tab_license": "License"
```

- [ ] **Step 2: Add German license keys to `src/i18n/de.json`**

> **Note:** The strings below use ASCII approximations for umlauts (e.g., "ue" for "u"). In the actual JSON file, use proper UTF-8 characters: Gueltig → Gültig, Lizenzschluessel → Lizenzschlüssel, etc.

```json
"license.title": "Lizenz",
"license.status": "Lizenzstatus",
"license.plan": "Plan",
"license.plan_community": "Community",
"license.plan_pro": "Pro",
"license.plan_lifetime": "Lifetime",
"license.valid_until": "Gueltig bis",
"license.activations": "Aktivierungen",
"license.features": "Features",
"license.activate": "Lizenz aktivieren",
"license.refresh": "Lizenz aktualisieren",
"license.remove": "Lizenz entfernen",
"license.remove_confirm": "Lizenz entfernen und auf Community-Modus zuruecksetzen?",
"license.community_mode": "Community-Modus",
"license.community_hint": "Community-Modus aktiv. Upgrade fuer unbegrenzte Peers, Routen und alle Features.",
"license.requires_pro": "Erfordert Pro- oder Lifetime-Lizenz",
"license.limit_reached": "Limit erreicht",
"license.limit_display": "{current} / {limit}",
"license.upgrade": "Upgrade",
"license.key_label": "Lizenzschluessel",
"license.key_placeholder": "GATE-XXXX-XXXX-XXXX",
"license.signing_key_label": "Signaturschluessel",
"license.signing_key_placeholder": "Signaturschluessel aus dem Admin-Panel einfuegen",
"license.refresh_success": "Lizenz erfolgreich aktualisiert",
"license.refresh_failed": "Lizenzaktualisierung fehlgeschlagen",
"license.activated": "Lizenz erfolgreich aktiviert",
"license.removed": "Lizenz entfernt",
"license.feature_enabled": "Enthalten",
"license.feature_disabled": "Nicht enthalten",
"license.unlimited": "Unbegrenzt",
"error.license.invalid": "Ungueltiger Lizenzschluessel",
"error.license.expired": "Lizenz ist abgelaufen",
"error.license.activation_limit": "Aktivierungslimit erreicht",
"error.license.feature_not_available": "Diese Funktion erfordert eine Pro- oder Lifetime-Lizenz",
"error.license.limit_reached": "Ressourcenlimit erreicht — Upgrade fuer unbegrenzt",
"error.license.validation_failed": "Lizenzvalidierung fehlgeschlagen",
"error.license.key_required": "Lizenzschluessel ist erforderlich",
"error.license.signing_key_required": "Signaturschluessel ist erforderlich",
"error.license.rate_limited": "Bitte warten Sie, bevor Sie es erneut versuchen",
"settings.tab_license": "Lizenz"
```

- [ ] **Step 3: Verify both files are valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/i18n/en.json')); console.log('en.json OK');"
node -e "JSON.parse(require('fs').readFileSync('src/i18n/de.json')); console.log('de.json OK');"
```

Expected: Both `OK`

- [ ] **Step 4: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat(license): add i18n keys for license UI (EN + DE)"
```

---

## Task 7: Feature guards on existing API routes

**Files:**
- Modify: `src/routes/api/peers.js:79` — Add limit guard on POST
- Modify: `src/routes/api/routes.js:202` — Add limit + feature guards on POST/PUT
- Modify: `src/routes/api/webhooks.js:37` — Add feature guard on POST
- Modify: `src/routes/api/tokens.js:26` — Add feature guard on POST
- Modify: `src/routes/api/routeAuth.js:42` — Add feature guard on POST
- Modify: `src/routes/api/settings.js` — Add feature guard on autobackup endpoints
- Modify: `src/routes/api/logs.js` — Add feature guard on export endpoints
- Modify: `src/routes/index.js:16-70` — Add feature check inside /metrics handler

- [ ] **Step 1: Add guards to `src/routes/api/peers.js`**

Add import at top:
```javascript
const { requireLimit } = require('../../middleware/license');
const { getDb } = require('../../db/connection');
```

Add guard before the POST handler (line 79):
```javascript
const peerCountFn = () => getDb().prepare('SELECT COUNT(*) as count FROM peers').get().count;

// Change: router.post('/', async (req, res) => {
// To:     router.post('/', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
```

- [ ] **Step 2: Add guards to `src/routes/api/routes.js`**

Add import at top:
```javascript
const { requireLimit, requireFeatureField } = require('../../middleware/license');
const { getDb } = require('../../db/connection');
```

Add count functions:
```javascript
const httpRouteCountFn = () => getDb().prepare("SELECT COUNT(*) as count FROM routes WHERE route_type = 'http' OR route_type IS NULL").get().count;
const l4RouteCountFn = () => getDb().prepare("SELECT COUNT(*) as count FROM routes WHERE route_type = 'l4'").get().count;
```

On the POST route (line 202), add middleware chain:
```javascript
router.post('/',
  (req, res, next) => {
    const rt = req.body.route_type || 'http';
    if (rt === 'l4') return requireLimit('l4_routes', l4RouteCountFn)(req, res, next);
    return requireLimit('http_routes', httpRouteCountFn)(req, res, next);
  },
  requireFeatureField('acl_enabled', 'peer_acl'),
  requireFeatureField('ip_filter_enabled', 'ip_access_control'),
  requireFeatureField('rate_limit_enabled', 'rate_limiting'),
  // NOTE: compression is a community feature — no guard needed
  requireFeatureField('custom_headers', 'custom_headers'),
  requireFeatureField('retry_enabled', 'retry_on_error'),
  requireFeatureField('circuit_breaker_enabled', 'circuit_breaker'),
  requireFeatureField('mirror_enabled', 'request_mirroring'),
  requireFeatureField('monitoring_enabled', 'uptime_monitoring'),
  requireFeatureField('backends', 'load_balancing'),
  async (req, res) => { /* existing handler */ }
);
```

Apply the same `requireFeatureField` guards to the PUT route for route updates.

Also guard branding fields in route create/update:
```javascript
requireFeatureField('branding_title', 'custom_branding'),
```

And guard the branding logo upload endpoint:
```javascript
router.post('/:id/branding/logo', requireFeature('custom_branding'), multerUpload, async (req, res) => { ... });
```

- [ ] **Step 3: Add guards to remaining routes**

**`src/routes/api/webhooks.js`:**
```javascript
const { requireFeature } = require('../../middleware/license');
router.post('/', requireFeature('webhooks'), (req, res) => { ... });
```

**`src/routes/api/tokens.js`:**
```javascript
const { requireFeature } = require('../../middleware/license');
router.post('/', requireFeature('api_tokens'), (req, res) => { ... });
```

**`src/routes/api/routeAuth.js`:**
```javascript
const { requireFeature } = require('../../middleware/license');
router.post('/', requireFeature('route_auth'), (req, res) => { ... });
router.put('/', requireFeature('route_auth'), (req, res) => { ... });
```

**`src/routes/api/settings.js`** — on autobackup + email alert endpoints:
```javascript
const { requireFeature } = require('../../middleware/license');

// Guard autobackup endpoints:
router.put('/autobackup', requireFeature('scheduled_backups'), (req, res) => { ... });
router.post('/autobackup/run', requireFeature('scheduled_backups'), (req, res) => { ... });

// Guard email alert settings:
// In the PUT handler for monitoring/alert settings, add:
router.put('/monitoring', requireFeature('email_alerts'), (req, res) => { ... });
```

**`src/routes/api/logs.js`** — on export endpoints:
```javascript
const { requireFeature } = require('../../middleware/license');

// Guard export endpoints:
router.get('/activity/export', requireFeature('log_export'), (req, res) => { ... });
router.get('/access/export', requireFeature('log_export'), (req, res) => { ... });
```

- [ ] **Step 4: Add metrics guard in `src/routes/index.js`**

Inside the `/metrics` handler (around line 19), after the `metrics_enabled` check, add:

```javascript
const { hasFeature } = require('../services/license');
// After line 22 (metrics_enabled check):
if (!hasFeature('prometheus_metrics')) {
  return res.status(403).json({ ok: false, error: 'Prometheus metrics requires a Pro or Lifetime license' });
}
```

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: All tests pass. Existing functionality unaffected (Community mode has compression/traffic_history/backup_restore enabled by default).

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/peers.js src/routes/api/routes.js src/routes/api/webhooks.js \
  src/routes/api/tokens.js src/routes/api/routeAuth.js src/routes/api/settings.js \
  src/routes/api/logs.js src/routes/index.js
git commit -m "feat(license): add feature guards to all protected API routes"
```

---

## Task 8: Settings UI — License tab

**Files:**
- Modify: `templates/default/pages/settings.njk`
- Modify: `public/js/settings.js`
- Modify: `public/css/app.css`

- [ ] **Step 1: Add License tab button to `templates/default/pages/settings.njk`**

In the tabs section (around lines 140-158), add the license tab alongside existing tabs:

```html
<div class="tab" data-settings-tab="license">{{ t('settings.tab_license') }}</div>
```

Add in both the mobile dropdown and the desktop tab bar.

- [ ] **Step 2: Add License tab panel to `templates/default/pages/settings.njk`**

After the last existing panel, add:

```html
<div class="settings-panel" data-settings-panel="license" style="display:none">
  <!-- Status Card -->
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <h3 style="margin:0">{{ t('license.status') }}</h3>
      <span class="badge {% if license.plan == 'pro' %}badge-green{% elif license.plan == 'lifetime' %}badge-blue{% else %}badge-grey{% endif %}">
        {{ t('license.plan_' + license.plan) }}
      </span>
    </div>
    {% if license.expires_at %}
      <p style="margin:4px 0;color:var(--text-2)">{{ t('license.valid_until') }}: {{ license.expires_at }}</p>
    {% endif %}
    {% if license.activations %}
      <p style="margin:4px 0;color:var(--text-2)">{{ t('license.activations') }}: {{ license.activations }} / {{ license.max_activations }}</p>
    {% endif %}
    {% if license.plan == 'community' %}
      <p style="margin:12px 0 0;color:var(--text-2)">{{ t('license.community_hint') }}</p>
    {% endif %}
  </div>

  <!-- Activate / Key Input -->
  <div class="card" style="margin-bottom:20px">
    <h3 style="margin:0 0 16px">{% if license.license_key_masked %}{{ t('license.key_label') }}: {{ license.license_key_masked }}{% else %}{{ t('license.activate') }}{% endif %}</h3>
    <form id="license-form">
      <div style="margin-bottom:12px">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">{{ t('license.key_label') }}</label>
        <input type="text" name="license_key" placeholder="{{ t('license.key_placeholder') }}" class="input" style="width:100%">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">{{ t('license.signing_key_label') }}</label>
        <input type="password" name="signing_key" placeholder="{{ t('license.signing_key_placeholder') }}" class="input" style="width:100%">
      </div>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary">{{ t('license.activate') }}</button>
        {% if license.license_key_masked %}
          <button type="button" class="btn btn-secondary" id="license-refresh-btn">{{ t('license.refresh') }}</button>
          <button type="button" class="btn btn-danger" id="license-remove-btn">{{ t('license.remove') }}</button>
        {% endif %}
      </div>
    </form>
  </div>

  <!-- Feature Overview -->
  <div class="card">
    <h3 style="margin:0 0 16px">{{ t('license.features') }}</h3>
    <table style="width:100%;font-size:13px">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:8px 0">Feature</th>
          <th style="padding:8px 0">{{ t('license.status') }}</th>
        </tr>
      </thead>
      <tbody>
        {% for key, value in license.features %}
        <tr style="border-bottom:1px solid var(--border-light)">
          <td style="padding:8px 0">{{ key | replace("_", " ") | capitalize }}</td>
          <td style="padding:8px 0">
            {% if value == true %}
              <span style="color:var(--green)">{{ t('license.feature_enabled') }}</span>
            {% elif value == false %}
              <span style="color:var(--text-3)">{{ t('license.feature_disabled') }}</span>
            {% elif value == -1 %}
              <span style="color:var(--green)">{{ t('license.unlimited') }}</span>
            {% elif value == 0 %}
              <span style="color:var(--text-3)">{{ t('license.feature_disabled') }}</span>
            {% else %}
              <span>{{ value }}</span>
            {% endif %}
          </td>
        </tr>
        {% endfor %}
      </tbody>
    </table>
  </div>
</div>
```

- [ ] **Step 3: Add license tab JS to `public/js/settings.js`**

Add at the end of the file:

```javascript
// ─── License Tab ─────────────────────────────────
(function () {
  var licenseForm = document.getElementById('license-form');
  var refreshBtn = document.getElementById('license-refresh-btn');
  var removeBtn = document.getElementById('license-remove-btn');

  if (licenseForm) {
    licenseForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(licenseForm);
      fetch('/api/v1/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken },
        body: JSON.stringify({
          license_key: fd.get('license_key'),
          signing_key: fd.get('signing_key'),
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            showToast(window.t('license.activated'));
            setTimeout(function () { location.reload(); }, 1000);
          } else {
            showToast(data.error, 'error');
          }
        })
        .catch(function () { showToast('Error', 'error'); });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      fetch('/api/v1/license/refresh', {
        method: 'POST',
        headers: { 'X-CSRF-Token': window.csrfToken },
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            showToast(window.t('license.refresh_success'));
            setTimeout(function () { location.reload(); }, 1000);
          } else {
            showToast(data.error, 'error');
          }
        });
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', function () {
      if (!confirm(window.t('license.remove_confirm'))) return;
      fetch('/api/v1/license', {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': window.csrfToken },
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            showToast(window.t('license.removed'));
            setTimeout(function () { location.reload(); }, 1000);
          } else {
            showToast(data.error, 'error');
          }
        });
    });
  }
})();
```

- [ ] **Step 4: Commit**

```bash
git add templates/default/pages/settings.njk public/js/settings.js
git commit -m "feat(license): add License tab to Settings UI"
```

---

## Task 9: Lock icons + CSS

**Files:**
- Modify: `public/css/app.css`
- Modify: `templates/default/pages/routes.njk`
- Modify: `templates/default/pages/peers.njk`

- [ ] **Step 1: Add `.feature-locked` CSS to `public/css/app.css`**

Add at the end of the file:

```css
/* ─── License Feature Lock ────────────────────── */
.feature-locked {
  opacity: 0.5;
  pointer-events: none;
  position: relative;
}
.feature-locked .lock-icon {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 6px;
  vertical-align: middle;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Crect x='3' y='11' width='18' height='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E") no-repeat center;
  background-size: contain;
}
.limit-badge {
  font-size: 12px;
  color: var(--text-2);
  margin-left: 8px;
}
.limit-badge.at-limit {
  color: var(--orange);
  font-weight: 600;
}
```

- [ ] **Step 2: Add lock icons to route feature toggles in `templates/default/pages/routes.njk`**

For each toggle that maps to a licensed feature, wrap in a conditional:

```nunjucks
{# Example: Rate Limiting toggle #}
{% if license.features.rate_limiting %}
  <div style="...">
    <div>{{ t('routes.rate_limiting') }}</div>
    <div class="toggle" data-field="rate_limit_enabled"></div>
  </div>
{% else %}
  <div style="..." class="feature-locked" title="{{ t('license.requires_pro') }}">
    <div>{{ t('routes.rate_limiting') }} <span class="lock-icon"></span></div>
    <div class="toggle" data-field="rate_limit_enabled"></div>
  </div>
{% endif %}
```

Apply this pattern for: `rate_limiting`, `custom_headers`, `load_balancing`, `retry_on_error`, `circuit_breaker`, `request_mirroring`, `uptime_monitoring`, `ip_access_control`, `peer_acl`, `custom_branding`, `route_auth`.

Note: `compression` is always unlocked (community feature).

- [ ] **Step 3: Add limit display to `templates/default/pages/peers.njk`**

Near the peer count / add button area, add:

```nunjucks
{% if license.features.vpn_peers is defined and license.features.vpn_peers != -1 %}
  <span class="limit-badge {% if peerCount >= license.features.vpn_peers %}at-limit{% endif %}">
    {{ peerCount }} / {{ license.features.vpn_peers }}
  </span>
{% endif %}
```

Similar pattern for routes page with `http_routes` and `l4_routes`.

- [ ] **Step 4: Commit**

```bash
git add public/css/app.css templates/default/pages/routes.njk templates/default/pages/peers.njk
git commit -m "feat(license): add lock icons + limit badges to UI"
```

---

## Task 10: Integration tests

**Files:**
- Modify: `tests/license.test.js`

- [ ] **Step 1: Add API integration tests**

Extend `tests/license.test.js` with API endpoint tests:

```javascript
const request = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

describe('License API', () => {
  let app, sessionCookie, csrfToken;

  before(async () => {
    app = await setup();
    const agent = getAgent(app);
    // Login to get session + CSRF (follows existing test pattern)
    const loginRes = await agent.post('/auth/login').send({
      username: process.env.GC_ADMIN_USER || 'admin',
      password: process.env.GC_ADMIN_PASSWORD || 'admin',
    });
    sessionCookie = loginRes.headers['set-cookie'];
    csrfToken = getCsrf(loginRes);
  });

  after(async () => {
    await teardown();
  });

  it('GET /api/v1/license — returns community plan when no key', async () => {
    const res = await request(app)
      .get('/api/v1/license')
      .set('Cookie', sessionCookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.plan, 'community');
    assert.equal(res.body.features.vpn_peers, 5);
  });

  it('POST /api/v1/license/activate — requires license_key', async () => {
    const res = await request(app)
      .post('/api/v1/license/activate')
      .set('Cookie', sessionCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('POST /api/v1/license/activate — rate limited', async () => {
    // First call
    await request(app)
      .post('/api/v1/license/activate')
      .set('Cookie', sessionCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ license_key: 'test', signing_key: 'test' });
    // Second call within 60s
    const res = await request(app)
      .post('/api/v1/license/activate')
      .set('Cookie', sessionCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ license_key: 'test', signing_key: 'test' });
    assert.equal(res.status, 429);
  });

  it('Feature guard blocks webhooks in community mode', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('Cookie', sessionCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ url: 'https://example.com/hook', events: ['peer_created'] });
    assert.equal(res.status, 403);
    assert.ok(res.body.upgrade_url);
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/license.test.js
git commit -m "test(license): add integration tests for license API + feature guards"
```

---

## Task 11: Final verification + push

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 2: Verify app starts in community mode**

```bash
GC_SECRET=test GC_ADMIN_PASSWORD=test123 timeout 5 node src/server.js 2>&1 || true
```

Expected: "License: community plan" in logs, server starts.

- [ ] **Step 3: Push all changes**

```bash
git push
```

- [ ] **Step 4: Build and deploy Docker image**

```bash
docker build -t gatecontrol . && docker save gatecontrol | gzip > gatecontrol-image.tar.gz
```
