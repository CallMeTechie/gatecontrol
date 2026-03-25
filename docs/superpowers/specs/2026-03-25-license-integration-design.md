# GateControl — License Integration Design

## Overview

Integrate license validation with callmetechie.de into GateControl. Unlicensed instances run in Community mode with feature/resource limits. Licensed instances (Pro/Lifetime) unlock all features.

## Decisions

| Decision | Result |
|---|---|
| Doc adherence | Guideline — adapt to existing patterns |
| No license key | Community mode (limits active) |
| UI placement | Settings tab "License" |
| Locked features | Visible with lock icon + tooltip |
| Downgrade/expiry | Soft-lock (disable oldest over limit) |
| API endpoint | Full (`GET /api/v1/license`) |
| Refresh interval | Startup + every 7 days |
| JWT library | `jsonwebtoken` npm package |

## Architecture

```
Startup
  ├── validateLicense()
  │     ├── GC_LICENSE_KEY not set → Community mode
  │     ├── Cached token valid → use cached features
  │     ├── Online validation → cache token + features
  │     └── All failed → Community mode + warn
  └── startLicenseRefresh() (7-day interval)

Request Flow
  ├── license middleware → res.locals.license = {plan, features, hasFeature, isWithinLimit}
  ├── API guard: requireFeature('webhooks') → 403 or next
  ├── API guard: requireLimit('vpn_peers', countFn) → 403 or next
  └── Template: {% if license.features.webhooks %} → feature or lock icon
```

---

## 1. Service — `src/services/license.js`

### State

```javascript
let cachedPlan = 'community';
let cachedFeatures = COMMUNITY_FEATURES;
let cachedLicenseInfo = null;
```

### Community Features (Constant)

From `license-validation-api.md` feature matrix:

```javascript
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
```

### Exported Functions

| Function | Description |
|---|---|
| `validateLicense()` | Startup: token cache → online → fallback → community |
| `refreshLicenseInBackground()` | 7-day interval, silent failure |
| `hasFeature(key)` | Boolean check (`cachedFeatures[key] === true`) |
| `getFeatureLimit(key)` | Number check (-1 unlimited, 0 disabled, >0 limit) |
| `isWithinLimit(key, currentCount)` | `limit === -1 || currentCount < limit` |
| `getFeatures()` | Full feature object |
| `getPlan()` | Plan slug ('community', 'pro', 'lifetime') |
| `getLicenseInfo()` | Full details for API/Settings UI |

### Validation Flow

> **Deviation from `integration-gatecontrol.md`:** The reference guide checks for a cached token before checking `LICENSE_KEY`, which would throw an error if no key is set and no token exists. Our implementation checks `GC_LICENSE_KEY` first to ensure Community mode works without any license key configured.

1. `GC_LICENSE_KEY` not set → set Community features, return
2. `GC_LICENSE_SIGNING_KEY` not set → log warning, Community mode, return
3. Read token file (`config.license.tokenPath`), verify with `GC_LICENSE_SIGNING_KEY`
   - Valid + fingerprint matches + `lat` not expired → cache features, start background refresh
4. Online validation: `POST https://callmetechie.de/api/licenses/validate`
   - Body: `{license_key, hardware_fingerprint, device_name, product_slug: 'gatecontrol'}`
5. Success → write token file (chmod 600), cache plan + features, call `enforceLimits()` if plan changed
6. Failure + old token exists + not expired → fallback to old token
7. All failed → Community mode, log warning

### `getLicenseInfo()` Return Shape

```javascript
{
  plan: 'pro',                    // 'community', 'pro', 'lifetime'
  features: { ... },              // Full feature object
  valid: true,                    // Whether license is currently valid
  expires_at: '2027-03-21T...',   // License expiry (null for lifetime)
  activations: 1,                 // Current activation count
  max_activations: 3,             // Max allowed activations
  license_key_masked: 'GATE-****-****-E5F6',  // Masked key for display
}
```

### Hardware Fingerprint

SHA-256 of `/etc/machine-id` (Linux), fallback to `hostname + JSON(cpus)`.

### Activity Log Events

| Event | Severity | When |
|---|---|---|
| `license_activated` | info | License key activated via UI/API |
| `license_removed` | info | License removed, reverted to Community |
| `license_refresh_success` | info | Background refresh succeeded |
| `license_refresh_failed` | warning | Background refresh failed |
| `license_expired` | warning | License expiry detected |
| `peer_license_disabled` | warning | Peer disabled due to limit enforcement |
| `route_license_disabled` | warning | Route disabled due to limit enforcement |

---

## 2. Soft-Lock — `enforceLimits()`

Called after every successful license validation when plan changes.

### Logic

```
For each number feature key (vpn_peers, http_routes, l4_routes):
  1. Get current count from DB
  2. Get new limit from features
  3. If limit >= 0 AND count > limit:
     - excess = count - limit
     - Get oldest N enabled entries (ORDER BY created_at ASC)
     - Set enabled = 0
     - Activity log: "peer_license_disabled" / "route_license_disabled" (severity: warning)
     - Trigger WireGuard/Caddy sync
     - Send email alert if configured
```

### Behavior

- Only deactivate, never delete
- Only trigger when plan actually changed (compare previous vs new)
- Log with severity `warning` for audit trail
- Email alert: "X peers were disabled due to license downgrade"
- **Mutex guard:** `let enforcingLimits = false` flag prevents concurrent execution (e.g., startup + manual refresh racing)

---

## 3. Middleware + Feature Guards

### A) License Middleware (`src/middleware/license.js`)

Mounted in `app.js` after i18n/locals, before route handlers.

```javascript
res.locals.license = {
  plan: getPlan(),
  features: getFeatures(),
  hasFeature,
  isWithinLimit,
};
```

No DB access, no async — reads in-memory cache only.

### B) API Feature Guards

**`requireFeature(featureKey)`** — for boolean features:

```javascript
function requireFeature(featureKey) {
  return (req, res, next) => {
    if (!hasFeature(featureKey)) {
      return res.status(403).json({
        ok: false,
        error: req.t('error.license.feature_not_available'),
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}
```

**`requireLimit(featureKey, countFn)`** — for number features:

> **`countFn` must be synchronous.** GateControl uses better-sqlite3 which is synchronous. All count queries (e.g., `db.prepare('SELECT COUNT(*) ...').get()`) return immediately. Do NOT pass async functions — the guard does not await.

```javascript
function requireLimit(featureKey, countFn) {
  return (req, res, next) => {
    const limit = getFeatureLimit(featureKey);
    if (limit === -1) return next();
    if (limit === 0) {
      return res.status(403).json({
        ok: false,
        error: req.t('error.license.feature_not_available'),
        feature: featureKey,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    const count = countFn();
    if (count >= limit) {
      return res.status(403).json({
        ok: false,
        error: req.t('error.license.limit_reached'),
        feature: featureKey,
        current: count,
        limit,
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    next();
  };
}
```

### C) Guard Placement

Added as middleware in existing API router files before existing handlers:

```javascript
// src/routes/api/webhooks.js
router.post('/', requireFeature('webhooks'), async (req, res) => { ... });

// src/routes/api/peers.js
router.post('/', requireLimit('vpn_peers', peerCountFn), async (req, res) => { ... });
```

### Feature-to-Route Mapping

| Feature Key | Guard Type | Routes |
|---|---|---|
| `vpn_peers` | requireLimit | `POST /api/v1/peers` |
| `http_routes` | requireLimit | `POST /api/v1/routes` (type=http) |
| `l4_routes` | requireLimit | `POST /api/v1/routes` (type=l4) |
| `route_auth` | requireFeature | `POST /api/v1/route-auth`, `PUT /api/v1/route-auth` |
| `custom_branding` | requireFeature | `POST /api/v1/routes/:id/branding/logo`, route create/update with `branding_*` fields |
| `ip_access_control` | requireFeature | Route create/update with `ip_filter_enabled` |
| `peer_acl` | requireFeature | Route create/update with `acl_enabled` |
| `rate_limiting` | requireFeature | Route create/update with `rate_limit_enabled` |
| `compression` | — | Always available (community feature) |
| `custom_headers` | requireFeature | Route create/update with `custom_headers` |
| `load_balancing` | requireFeature | Route create/update with `backends` |
| `retry_on_error` | requireFeature | Route create/update with `retry_enabled` |
| `circuit_breaker` | requireFeature | Route create/update with `circuit_breaker_enabled` |
| `request_mirroring` | requireFeature | Route create/update with `mirror_enabled` |
| `uptime_monitoring` | requireFeature | Route create/update with `monitoring_enabled` |
| `traffic_history` | — | Always available (community feature) |
| `prometheus_metrics` | requireFeature | `GET /metrics` (special case: guard inside existing handler in `src/routes/index.js`, not via standard middleware — endpoint has its own auth flow) |
| `log_export` | requireFeature | `GET /api/v1/logs/*/export` |
| `backup_restore` | — | Always available (community feature) |
| `scheduled_backups` | requireFeature | `PUT /api/v1/settings/autobackup`, `POST /api/v1/settings/autobackup/run` |
| `email_alerts` | requireFeature | Settings update with email alert config |
| `webhooks` | requireFeature | `POST /api/v1/webhooks` |
| `api_tokens` | requireFeature | `POST /api/v1/tokens` |

Note: Features like `ip_access_control`, `rate_limiting`, etc. are toggled within the route create/update payload. The guard checks the relevant field in `req.body` before allowing the operation — no separate endpoint needed.

> **`l4_routes` is a number feature, not boolean.** Do NOT use `hasFeature()` for number-typed features (`vpn_peers`, `http_routes`, `l4_routes`). Always use `requireLimit()` or `getFeatureLimit()`. The reference `integration-gatecontrol.md` has a bug at line 315 where it uses `hasFeature('l4_routes')` — this would always return false since the value is a number, not `true`.

---

## 4. UI — Settings Tab + Lock Icons

### A) Settings Tab "License"

New tab in `/settings` page following the existing tab pattern.

**Content:**

| Section | Content |
|---|---|
| **Status Card** | Plan badge (Community/Pro/Lifetime), valid until date, activations (1/3) |
| **License Key** | Input field + "Activate" button. When active: masked display (GATE-\*\*\*\*-\*\*\*\*-E5F6) |
| **Signing Key** | Input field for `GC_LICENSE_SIGNING_KEY` (masked, paste-only, **encrypted at rest** using existing AES-256-GCM encryption service) |
| **Feature Overview** | Table of all 22 features with checkmark/lock icon per feature |
| **Actions** | "Refresh License" button, "Remove License" button |

When no key is set: hint "Running in Community mode" with link to pricing page.

### B) Lock Icons in Existing UI

Locked features get a lock icon + tooltip. Three places:

1. **Route forms** — Locked toggles/fieldsets (Rate Limiting, Custom Headers, etc.) are `disabled` with lock icon and tooltip "Requires Pro license"
2. **Sidebar** — No hiding. All pages accessible. Lock icon next to locked feature counts if applicable
3. **Peers/Routes page** — "Add" button shows limit info when limit reached: "5/5 Peers — Upgrade for unlimited"

### C) CSS

Single `.feature-locked` class:

```css
.feature-locked {
  opacity: 0.6;
  pointer-events: none;
  position: relative;
}
.feature-locked::before {
  content: '\f023'; /* lock icon */
  font-family: 'Font Awesome', sans-serif;
  position: absolute;
  /* positioning */
}
```

Tooltip via `title` attribute. No new CSS framework, no JS widget.

### D) Template Pattern

```nunjucks
{# Boolean feature gate #}
{% if license.features.webhooks %}
  <fieldset>
    <legend>Webhooks</legend>
    ...
  </fieldset>
{% else %}
  <fieldset class="feature-locked" title="{{ t('license.requires_pro') }}">
    <legend>Webhooks <span class="lock-icon"></span></legend>
    ...
  </fieldset>
{% endif %}

{# Limit display (with null safety) #}
{% if license.features.vpn_peers is defined and license.features.vpn_peers != -1 %}
  <span class="limit-badge">{{ peerCount }} / {{ license.features.vpn_peers }}</span>
{% endif %}
```

---

## 5. Config, i18n, API, Startup

### A) Config (`config/default.js`)

```javascript
license: {
  key: env('GC_LICENSE_KEY', ''),
  signingKey: env('GC_LICENSE_SIGNING_KEY', ''),
  server: env('GC_LICENSE_SERVER', 'https://callmetechie.de/api/licenses/validate'),
  tokenPath: path.join(env('GC_DATA_PATH', '/data'), '.license-token'),
},
```

No `GC_LICENSE_ENABLED` — licensing is active when `GC_LICENSE_KEY !== ''`.

Token path reads from `config.license.tokenPath` — not duplicated in the service.

### B) i18n Keys (~30 new keys, EN + DE)

```
license.title, license.status, license.plan, license.plan_community,
license.plan_pro, license.plan_lifetime, license.valid_until,
license.activations, license.features, license.activate,
license.refresh, license.remove, license.community_mode,
license.community_hint, license.requires_pro, license.limit_reached,
license.limit_display, license.upgrade, license.upgrade_url,
license.key_placeholder, license.signing_key_placeholder,
license.refresh_success, license.refresh_failed, license.activated,
license.removed, license.feature_enabled, license.feature_disabled,
error.license.invalid, error.license.expired, error.license.activation_limit,
error.license.feature_not_available, error.license.limit_reached,
error.license.validation_failed
```

### C) API Endpoints (`src/routes/api/license.js`)

| Method | Path | Scope | Description |
|---|---|---|---|
| `GET` | `/api/v1/license` | `settings` | Full license info (plan, features, expiry, activations) |
| `POST` | `/api/v1/license/activate` | `settings` | Activate license (accepts key + signing key in body). **Rate limited: max 1 call per 60 seconds** (upstream API has 60 req/min limit). Signing key encrypted at rest via existing AES-256-GCM service. |
| `POST` | `/api/v1/license/refresh` | `settings` | Manual online validation. **Rate limited: max 1 call per 60 seconds.** |
| `DELETE` | `/api/v1/license` | `settings` | Remove license, revert to Community. Sequence: (1) delete token file, (2) clear in-memory cache to Community defaults, (3) remove key/signing key from settings table, (4) call `enforceLimits()`, (5) log `license_removed` activity event. |

### D) Startup Integration (`server.js`)

```
1. validateConfig()
2. runMigrations(), seedAdminUser()
3. validateLicense()                    ← NEW
4. createApp(), server.listen()
5. startCollector(), startPoller(), ...
6. startLicenseRefresh()                ← NEW (7-day interval)
```

On license error: log warning, Community mode, app starts normally.

### D2) Shutdown Integration

`stopLicenseRefresh()` clears the 7-day interval. Called in `shutdown()` handler alongside existing `stopCollector()`, `stopPoller()`, etc.

### E) .env.example

```bash
# ─── License ──────────────────────────────────
# GC_LICENSE_KEY=GATE-XXXX-XXXX-XXXX
# GC_LICENSE_SIGNING_KEY=
# GC_LICENSE_SERVER=https://callmetechie.de/api/licenses/validate
```

### F) entrypoint.sh

No changes. License key and signing key come as normal env vars via Docker env/secrets.

### G) Database

No new migration. License state is:
- Token file on disk (`/data/.license-token`)
- In-memory cache at runtime
- Settings table for key (plaintext) and signing key (**encrypted** via AES-256-GCM) when set via UI

### H) Dependencies

```bash
npm install jsonwebtoken
```

---

## Files Changed/Created

| Action | File | Description |
|---|---|---|
| **Create** | `src/services/license.js` | License validation service |
| **Create** | `src/middleware/license.js` | License middleware + feature guards |
| **Create** | `src/routes/api/license.js` | License API endpoints |
| **Edit** | `src/server.js` | Add validateLicense() + startLicenseRefresh() |
| **Edit** | `src/app.js` | Mount license middleware + license API routes |
| **Edit** | `config/default.js` | Add license config section |
| **Edit** | `src/i18n/en.json` | Add ~30 license keys |
| **Edit** | `src/i18n/de.json` | Add ~30 license keys |
| **Edit** | `.env.example` | Add license env vars |
| **Edit** | `package.json` | Add jsonwebtoken dependency |
| **Edit** | `templates/default/pages/settings.njk` | Add License tab |
| **Edit** | `public/css/app.css` | Add .feature-locked styles |
| **Edit** | `public/js/settings.js` | Add license tab JS |
| **Edit** | Various route files | Add requireFeature/requireLimit guards |
| **Edit** | Various template files | Add lock icons + limit displays |

## Out of Scope

- License key generation/management (handled by callmetechie.de)
- Payment/billing integration
- Per-user licensing (single instance license)
- Custom feature plans beyond the 3 defined (Community/Pro/Lifetime)
