# Machine Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind API tokens to the client machine's fingerprint so stolen tokens cannot be used from other devices.

**Architecture:** The Windows client sends `SHA256(MachineGuid)` as `X-Machine-Fingerprint` header on every request. The server stores the fingerprint on first registration and validates it on subsequent requests. The admin controls binding behavior via a `machine_binding.mode` setting (off/global/individual). Feature requires `machine_binding` license key.

**Tech Stack:** Node.js/Express (server), Electron/Axios (client), better-sqlite3 (DB), Nunjucks (templates)

**Spec:** `docs/superpowers/specs/2026-03-31-machine-binding-design.md`

---

### Task 1: Database Migration + License Feature Key

**Files:**
- Modify: `src/db/migrations.js` (after line 475, append migration 30)
- Modify: `src/services/license.js` (line 41, add to COMMUNITY_FALLBACK)

- [ ] **Step 1: Add migration 30**

In `src/db/migrations.js`, add after the `add_token_peer_binding` migration (version 29) and before the closing `];`:

```javascript
  {
    version: 30,
    name: 'add_machine_binding',
    sql: `
      ALTER TABLE api_tokens ADD COLUMN machine_fingerprint TEXT;
      ALTER TABLE api_tokens ADD COLUMN machine_binding_enabled INTEGER DEFAULT 0;
    `,
    detect: (db) => hasColumn(db, 'api_tokens', 'machine_fingerprint'),
  },
```

- [ ] **Step 2: Add feature key to COMMUNITY_FALLBACK**

In `src/services/license.js`, add `machine_binding: false,` after the `custom_dns: false,` line (line 41) inside `COMMUNITY_FALLBACK`:

```javascript
  custom_dns: false,
  machine_binding: false,
};
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations.js src/services/license.js
git commit -m "feat(machine-binding): add migration and license feature key"
```

---

### Task 2: Token Service — Fingerprint Methods

**Files:**
- Modify: `src/services/tokens.js`

- [ ] **Step 1: Add FINGERPRINT_RE constant**

After line 9 (`const TOKEN_BYTES = 48;`), add:

```javascript
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
```

- [ ] **Step 2: Add validateFingerprint function**

After the `validateScopes` function (after line 68), add:

```javascript
/**
 * Validate a machine fingerprint (SHA256 hex string)
 */
function validateFingerprint(fp) {
  if (!fp || typeof fp !== 'string') return 'Fingerprint is required';
  if (!FINGERPRINT_RE.test(fp)) return 'Invalid fingerprint format (expected SHA256 hex)';
  return null;
}
```

- [ ] **Step 3: Add bindMachineFingerprint function**

After the `getBoundPeerId` function, add:

```javascript
/**
 * Store a machine fingerprint on a token (one-time binding)
 * Returns true if bound, false if already bound to a different machine
 */
function bindMachineFingerprint(tokenId, fingerprint) {
  const db = getDb();
  const row = db.prepare('SELECT machine_fingerprint FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) return false;

  if (row.machine_fingerprint === fingerprint) return true;
  if (row.machine_fingerprint != null) return false;

  db.prepare('UPDATE api_tokens SET machine_fingerprint = ? WHERE id = ?').run(fingerprint, tokenId);
  logger.info({ tokenId, fingerprint: fingerprint.substring(0, 8) }, 'Token bound to machine');
  return true;
}

/**
 * Clear machine fingerprint (admin reset)
 */
function resetMachineBinding(tokenId) {
  const db = getDb();
  const row = db.prepare('SELECT machine_fingerprint, name FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) throw new Error('Token not found');
  db.prepare('UPDATE api_tokens SET machine_fingerprint = NULL WHERE id = ?').run(tokenId);
  logger.info({ tokenId }, 'Machine binding reset');
  return true;
}
```

- [ ] **Step 4: Update formatToken to include new fields**

In the `formatToken` function, add after `peer_id: row.peer_id || null,`:

```javascript
    machine_fingerprint: row.machine_fingerprint || null,
    machine_binding_enabled: row.machine_binding_enabled === 1,
```

- [ ] **Step 5: Update module.exports**

Add to `module.exports`:

```javascript
  bindMachineFingerprint,
  resetMachineBinding,
  validateFingerprint,
```

- [ ] **Step 6: Commit**

```bash
git add src/services/tokens.js
git commit -m "feat(machine-binding): add fingerprint bind/reset/validate to token service"
```

---

### Task 3: Token API — Create with machine_binding_enabled + Reset Endpoint

**Files:**
- Modify: `src/routes/api/tokens.js`
- Modify: `src/services/tokens.js` (create function)

- [ ] **Step 1: Extend token create to accept machine_binding_enabled**

In `src/services/tokens.js`, update the `create` function signature (line 97):

```javascript
function create({ name, scopes, expiresAt, machineBindingEnabled }, ipAddress) {
```

And replace the INSERT (lines 119-127):

```javascript
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_tokens (name, token_hash, scopes, expires_at, machine_binding_enabled)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    tokenHash,
    JSON.stringify(scopes),
    expiresAt || null,
    machineBindingEnabled ? 1 : 0
  );
```

- [ ] **Step 2: Pass machine_binding_enabled from route handler**

In `src/routes/api/tokens.js`, in the POST handler, update the destructure (line 36):

```javascript
    const { name, scopes, expires_at, machine_binding_enabled } = req.body;
```

And the create call:

```javascript
    const result = tokens.create({
      name: name.trim(),
      scopes,
      expiresAt: expires_at || null,
      machineBindingEnabled: machine_binding_enabled || false,
    }, req.ip);
```

- [ ] **Step 3: Add activity import and DELETE /:id/binding endpoint**

In `src/routes/api/tokens.js`, add import at line 4:

```javascript
const activity = require('../../services/activity');
```

Add before `module.exports = router;`:

```javascript
/**
 * DELETE /api/v1/tokens/:id/binding — Reset machine binding
 */
router.delete('/:id/binding', requireFeature('machine_binding'), (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }

  try {
    const id = parseInt(req.params.id, 10);
    const token = tokens.getById(id);
    if (!token) {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }

    tokens.resetMachineBinding(id);

    activity.log('machine_binding_reset', `Machine binding for token "${token.name}" reset`, {
      tokenId: id,
    }, {
      source: 'user',
      ipAddress: req.ip,
      severity: 'warning',
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to reset machine binding');
    res.status(500).json({ ok: false, error: req.t('error.tokens.binding_reset_failed') });
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add src/services/tokens.js src/routes/api/tokens.js
git commit -m "feat(machine-binding): token create with binding flag + reset endpoint"
```

---

### Task 4: Client Routes — verifyMachineBinding Helper

**Files:**
- Modify: `src/routes/api/client.js`

- [ ] **Step 1: Add settings and license imports**

After the `const { getDb } = require('../../db/connection');` import (line 13), add:

```javascript
const settings = require('../../services/settings');
const { hasFeature } = require('../../services/license');
```

- [ ] **Step 2: Add isBindingActive and verifyMachineBinding helpers**

After the `requirePeerOwnership` function (after line 43), add:

```javascript
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

/**
 * Check if machine binding is active for a token.
 */
function isBindingActive(req) {
  if (!req.tokenAuth) return false;
  if (!hasFeature('machine_binding')) return false;

  const mode = settings.get('machine_binding.mode', 'off');
  if (mode === 'off') return false;
  if (mode === 'global') return true;
  if (mode === 'individual') {
    const token = tokens.getById(req.tokenId);
    return token && token.machine_binding_enabled;
  }
  return false;
}

/**
 * Verify machine fingerprint for bound tokens.
 * Returns true if OK to proceed, false if response was sent (error).
 */
function verifyMachineBinding(req, res) {
  if (!isBindingActive(req)) return true;

  const fingerprint = req.headers['x-machine-fingerprint'];
  const token = tokens.getById(req.tokenId);
  const stored = token?.machine_fingerprint;

  if (!stored) {
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.binding_not_registered') : 'Token is not bound. Register first.' });
    return false;
  }

  if (!fingerprint) {
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_required') : 'Machine fingerprint required' });
    return false;
  }

  if (!FINGERPRINT_RE.test(fingerprint)) {
    res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Invalid machine fingerprint format' });
    return false;
  }

  if (fingerprint !== stored) {
    logger.warn({ tokenId: req.tokenId, stored: stored.substring(0, 8), received: fingerprint.substring(0, 8) }, 'Machine fingerprint mismatch');
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.binding_mismatch') : 'Token is bound to a different machine' });
    return false;
  }

  return true;
}
```

- [ ] **Step 3: Add machine binding to register endpoint**

In the register handler, replace the existing re-registration block (lines 97-113) with:

```javascript
    // If token is already bound to a peer, only allow re-registration for that peer
    if (req.tokenAuth && req.tokenPeerId != null) {
      const boundPeer = peers.getById(req.tokenPeerId);
      if (!boundPeer) {
        return res.status(404).json({ ok: false, error: 'Bound peer no longer exists' });
      }

      // Verify machine binding on re-registration
      if (!verifyMachineBinding(req, res)) return;

      // Update description with latest client version
      const db = getDb();
      try {
        db.prepare('UPDATE peers SET description = ? WHERE id = ?')
          .run(`Desktop Client (${platform || 'unknown'}, v${clientVersion || '?'})`, boundPeer.id);
      } catch {}

      const peerConfig = await peers.getClientConfig(boundPeer.id);
      const hash = hashConfig(peerConfig);
      return res.json({ ok: true, peerId: boundPeer.id, peerName: boundPeer.name, config: peerConfig, hash });
    }
```

Then in the first-time registration path, replace the token bind block (around line 162-167) with:

```javascript
    // Bind token to peer (one-time)
    if (req.tokenAuth) {
      const bound = tokens.bindPeer(req.tokenId, peer.id);
      if (!bound) {
        return res.status(403).json({ ok: false, error: 'Token is already bound to a different peer' });
      }
      logger.info({ tokenId: req.tokenId, peerId: peer.id }, 'Token bound to peer on registration');

      // Bind machine fingerprint if binding is active
      if (isBindingActive(req)) {
        const fingerprint = req.headers['x-machine-fingerprint'];
        if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
          return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Valid machine fingerprint required for binding' });
        }
        tokens.bindMachineFingerprint(req.tokenId, fingerprint);
      }
    }
```

- [ ] **Step 4: Add verifyMachineBinding to all data endpoints**

In each of these endpoints, add `if (!verifyMachineBinding(req, res)) return;` right after the `requirePeerOwnership` check:

**GET /config:**
```javascript
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;
```

**GET /config/check:**
```javascript
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;
```

**POST /heartbeat:**
```javascript
    const validatedPeerId = requirePeerOwnership(req, res);
    if (validatedPeerId == null) return;
    if (!verifyMachineBinding(req, res)) return;
```

**POST /status:**
```javascript
    const validatedPeerId = requirePeerOwnership(req, res);
    if (validatedPeerId == null) return;
    if (!verifyMachineBinding(req, res)) return;
```

**GET /peer-info:**
```javascript
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;
```

**GET /traffic:**
```javascript
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/client.js
git commit -m "feat(machine-binding): verify fingerprint on all client endpoints"
```

---

### Task 5: Settings API — Machine Binding Mode

**Files:**
- Modify: `src/routes/api/settings.js`

- [ ] **Step 1: Verify requireFeature import exists**

Check if `requireFeature` is already imported in `src/routes/api/settings.js`. If not, add:

```javascript
const { requireFeature } = require('../../middleware/license');
```

- [ ] **Step 2: Add GET and PUT handlers for machine binding settings**

After the `PUT /security` handler (around line 336), add:

```javascript
// ─── Machine Binding Settings ──────────────────────────

/**
 * GET /api/settings/machine-binding — Get machine binding settings
 */
router.get('/machine-binding', (req, res) => {
  res.json({
    ok: true,
    data: {
      mode: settings.get('machine_binding.mode', 'off'),
    },
  });
});

/**
 * PUT /api/settings/machine-binding — Update machine binding settings
 */
router.put('/machine-binding', requireFeature('machine_binding'), (req, res) => {
  try {
    const { mode } = req.body;

    if (mode !== undefined) {
      if (!['off', 'global', 'individual'].includes(mode)) {
        return res.status(400).json({ ok: false, error: req.t('error.settings.machine_binding_mode_invalid') });
      }
      settings.set('machine_binding.mode', mode);
    }

    activity.log('machine_binding_settings_updated', `Machine binding mode set to "${mode}"`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/settings.js
git commit -m "feat(machine-binding): settings API for binding mode"
```

---

### Task 6: i18n — German + English Keys

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English keys**

Add after the existing `security.saved` key:

```json
  "security.machine_binding.title": "Machine Binding",
  "security.machine_binding.description": "Binds API tokens to the client machine. Stolen tokens cannot be used from other devices.",
  "security.machine_binding.mode": "Binding Mode",
  "security.machine_binding.mode_off": "Off",
  "security.machine_binding.mode_global": "Global (all client tokens)",
  "security.machine_binding.mode_individual": "Individual (per token)",
  "security.machine_binding.saved": "Machine binding settings saved",
```

Add after the existing `tokens.scope_*` keys:

```json
  "tokens.machine_binding": "Bind to machine",
  "tokens.bound": "Bound",
  "tokens.unbound": "Unbound",
  "tokens.reset_binding": "Reset Binding",
  "tokens.reset_binding_confirm": "The binding will be released. The next client request will bind the new machine.",
  "tokens.binding_reset_success": "Machine binding reset",
```

Add to the error section:

```json
  "error.client.fingerprint_required": "Machine fingerprint required",
  "error.client.fingerprint_invalid": "Invalid machine fingerprint format",
  "error.client.binding_mismatch": "Token is bound to a different machine",
  "error.client.binding_not_registered": "Token is not bound. Register first.",
  "error.tokens.binding_reset_failed": "Failed to reset machine binding",
  "error.settings.machine_binding_mode_invalid": "Mode must be off, global or individual",
```

- [ ] **Step 2: Add German keys**

Add after the existing `security.saved` key:

```json
  "security.machine_binding.title": "Maschinen-Bindung",
  "security.machine_binding.description": "Bindet API-Tokens an die Client-Maschine. Gestohlene Tokens können nicht von anderen Geräten genutzt werden.",
  "security.machine_binding.mode": "Bindungsmodus",
  "security.machine_binding.mode_off": "Aus",
  "security.machine_binding.mode_global": "Global (alle Client-Tokens)",
  "security.machine_binding.mode_individual": "Individuell (pro Token)",
  "security.machine_binding.saved": "Maschinen-Bindung gespeichert",
```

Add after the existing `tokens.scope_*` keys:

```json
  "tokens.machine_binding": "An Maschine binden",
  "tokens.bound": "Gebunden",
  "tokens.unbound": "Ungebunden",
  "tokens.reset_binding": "Binding zurücksetzen",
  "tokens.reset_binding_confirm": "Das Binding wird gelöst. Beim nächsten Client-Request wird die neue Maschine gebunden.",
  "tokens.binding_reset_success": "Maschinen-Binding zurückgesetzt",
```

Add to the error section:

```json
  "error.client.fingerprint_required": "Maschinen-Fingerprint erforderlich",
  "error.client.fingerprint_invalid": "Ungültiges Fingerprint-Format",
  "error.client.binding_mismatch": "Token ist an eine andere Maschine gebunden",
  "error.client.binding_not_registered": "Token ist nicht gebunden. Zuerst registrieren.",
  "error.tokens.binding_reset_failed": "Maschinen-Binding konnte nicht zurückgesetzt werden",
  "error.settings.machine_binding_mode_invalid": "Modus muss aus, global oder individuell sein",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat(machine-binding): add i18n keys for DE and EN"
```

---

### Task 7: Admin UI — Settings Section

**Files:**
- Modify: `templates/default/pages/settings.njk`

- [ ] **Step 1: Add machine binding settings card**

Find the security settings card in `settings.njk`. Add a new card after it:

```html
{# ── Machine Binding ──────────────────────────────────── #}
{% set mbLocked = not license.hasFeature('machine_binding') %}
<div class="card" id="machine-binding-card" style="{% if mbLocked %}opacity:0.6{% endif %}">
  <h3>{{ t('security.machine_binding.title') }}</h3>
  <p style="font-size:12px;color:var(--text-3);margin-bottom:12px">{{ t('security.machine_binding.description') }}</p>

  {% if mbLocked %}
  <div class="tag tag-yellow" style="margin-bottom:12px">
    <a href="https://callmetechie.de/products/gatecontrol/pricing" target="_blank" style="color:inherit">Upgrade required</a>
  </div>
  {% endif %}

  <div class="form-group">
    <label>{{ t('security.machine_binding.mode') }}</label>
    <select id="mb-mode" {% if mbLocked %}disabled{% endif %}>
      <option value="off">{{ t('security.machine_binding.mode_off') }}</option>
      <option value="global">{{ t('security.machine_binding.mode_global') }}</option>
      <option value="individual">{{ t('security.machine_binding.mode_individual') }}</option>
    </select>
  </div>

  <button class="btn btn-primary" id="mb-save" {% if mbLocked %}disabled{% endif %}>
    {{ t('security.save') }}
  </button>
  <span id="mb-msg" style="margin-left:8px;font-size:12px;color:var(--success)"></span>
</div>
```

- [ ] **Step 2: Add inline script for machine binding settings**

Add to the page's script block:

```javascript
// ── Machine Binding Settings ──────────────────────────
(async function () {
  var modeSelect = document.getElementById('mb-mode');
  var saveBtn = document.getElementById('mb-save');
  var msg = document.getElementById('mb-msg');
  if (!modeSelect) return;

  try {
    var res = await api.get('/api/v1/settings/machine-binding');
    if (res.ok) modeSelect.value = res.data.mode;
  } catch {}

  saveBtn.addEventListener('click', async function () {
    try {
      await api.put('/api/v1/settings/machine-binding', { mode: modeSelect.value });
      msg.textContent = GC.t['security.machine_binding.saved'] || 'Saved';
      msg.style.color = 'var(--success)';
      setTimeout(function () { msg.textContent = ''; }, 3000);
    } catch (err) {
      msg.style.color = 'var(--danger)';
      msg.textContent = err.message || 'Error';
    }
  });
})();
```

- [ ] **Step 3: Commit**

```bash
git add templates/default/pages/settings.njk
git commit -m "feat(machine-binding): admin UI settings section"
```

---

### Task 8: Admin UI — Token List Badges + Reset Button + Create Checkbox

**Files:**
- Modify: `public/js/tokens.js`
- Modify: `templates/default/pages/settings.njk` (token create form)

- [ ] **Step 1: Add binding badge to token list**

In `public/js/tokens.js`, in the `renderTokens` function, after the expiry tag block (after `row.appendChild(expTag);` around line 134), add:

```javascript
      // Machine binding badge
      if (tk.machine_fingerprint) {
        var boundTag = document.createElement('span');
        boundTag.className = 'tag tag-green';
        boundTag.style.fontSize = '10px';
        boundTag.title = tk.machine_fingerprint;
        boundTag.textContent = (GC.t['tokens.bound'] || 'Bound') + ' ' + tk.machine_fingerprint.substring(0, 8);
        row.appendChild(boundTag);
      } else if (tk.machine_binding_enabled) {
        var unboundTag = document.createElement('span');
        unboundTag.className = 'tag tag-yellow';
        unboundTag.style.fontSize = '10px';
        unboundTag.textContent = GC.t['tokens.unbound'] || 'Unbound';
        row.appendChild(unboundTag);
      }
```

- [ ] **Step 2: Add reset binding button**

After the binding badge code, before the delete button (before `var delBtn = document.createElement('button');`), add:

```javascript
      // Reset binding button
      if (tk.machine_fingerprint) {
        var resetBtn = document.createElement('button');
        resetBtn.className = 'icon-btn';
        resetBtn.title = GC.t['tokens.reset_binding'] || 'Reset Binding';
        resetBtn.dataset.tokenAction = 'reset-binding';
        resetBtn.dataset.tokenId = tk.id;
        resetBtn.style.cssText = 'width:24px;height:24px;flex-shrink:0';
        var rSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        rSvg.setAttribute('viewBox', '0 0 24 24');
        rSvg.setAttribute('width', '14');
        rSvg.setAttribute('height', '14');
        rSvg.setAttribute('fill', 'none');
        rSvg.setAttribute('stroke', 'currentColor');
        rSvg.setAttribute('stroke-width', '2');
        var rPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        rPath.setAttribute('d', 'M1 4v6h6M23 20v-6h-6');
        rSvg.appendChild(rPath);
        var rPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        rPath2.setAttribute('d', 'M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15');
        rSvg.appendChild(rPath2);
        resetBtn.appendChild(rSvg);
        row.appendChild(resetBtn);
      }
```

- [ ] **Step 3: Add reset binding click handler**

In the token list `click` event listener (around line 164), add before the existing delete handler:

```javascript
    var resetAction = e.target.closest('[data-token-action="reset-binding"]');
    if (resetAction) {
      var id = resetAction.dataset.tokenId;
      var confirmMsg = GC.t['tokens.reset_binding_confirm'] || 'The binding will be released. The next client request will bind the new machine.';
      if (!confirm(confirmMsg)) return;

      try {
        await api.del('/api/v1/tokens/' + id + '/binding');
        loadTokens();
      } catch (err) {
        alert(err.message || 'Failed to reset binding');
      }
      return;
    }
```

- [ ] **Step 4: Add machine_binding_enabled checkbox to token create form**

In `templates/default/pages/settings.njk`, in the token creation form, after the client scope sub-scopes section, add a checkbox (visible only in individual mode):

```html
<div id="token-mb-wrap" style="display:none;margin-top:8px">
  <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
    <input type="checkbox" id="token-machine-binding">
    {{ t('tokens.machine_binding') }}
  </label>
</div>
```

- [ ] **Step 5: Update create handler to include machine_binding_enabled**

In `public/js/tokens.js`, in the create token handler, add before the API call:

```javascript
      var mbCheckbox = document.getElementById('token-machine-binding');
      var machineBindingEnabled = mbCheckbox ? mbCheckbox.checked : false;
```

Include in the POST body:

```javascript
        machine_binding_enabled: machineBindingEnabled,
```

- [ ] **Step 6: Toggle checkbox visibility based on binding mode**

In `public/js/tokens.js` or inline script, after loading machine binding settings, show/hide the checkbox:

```javascript
// Show machine_binding checkbox in token create form when mode is 'individual'
(async function () {
  var mbWrap = document.getElementById('token-mb-wrap');
  if (!mbWrap) return;
  try {
    var res = await api.get('/api/v1/settings/machine-binding');
    if (res.ok && res.data.mode === 'individual') {
      mbWrap.style.display = '';
    }
  } catch {}
})();
```

- [ ] **Step 7: Commit**

```bash
git add public/js/tokens.js templates/default/pages/settings.njk
git commit -m "feat(machine-binding): token list badges, reset button, create checkbox"
```

---

### Task 9: Windows Client — Send Machine Fingerprint

**Files:**
- Create: `/root/windows-client/src/services/machine-id.js`
- Modify: `/root/windows-client/src/services/api-client.js`

- [ ] **Step 1: Create machine-id module**

Create `/root/windows-client/src/services/machine-id.js`:

```javascript
'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

let cachedFingerprint = null;

/**
 * Read Windows MachineGuid from registry and return SHA256 hash.
 * Falls back to hostname-based ID on non-Windows or if registry read fails.
 */
function getMachineFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;

  let machineGuid = null;

  try {
    const output = execFileSync('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v', 'MachineGuid',
    ], { encoding: 'utf-8', timeout: 5000 });
    const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
    if (match) machineGuid = match[1].trim();
  } catch {}

  if (!machineGuid) {
    machineGuid = require('os').hostname() + '-fallback';
  }

  cachedFingerprint = crypto.createHash('sha256').update(machineGuid).digest('hex');
  return cachedFingerprint;
}

module.exports = { getMachineFingerprint };
```

- [ ] **Step 2: Add fingerprint header to API client**

In `/root/windows-client/src/services/api-client.js`, add the import at the top (after existing requires):

```javascript
const { getMachineFingerprint } = require('./machine-id');
```

In the `_createClient()` method, add `X-Machine-Fingerprint` to the default headers:

```javascript
      headers: {
        'Content-Type': 'application/json',
        'X-API-Token': this.apiKey,
        'X-Client-Version': require('../../package.json').version,
        'X-Client-Platform': 'windows',
        'X-Machine-Fingerprint': getMachineFingerprint(),
      },
```

- [ ] **Step 3: Commit**

```bash
cd /root/windows-client
git add src/services/machine-id.js src/services/api-client.js
git commit -m "feat(machine-binding): send SHA256(MachineGuid) fingerprint header"
```

---

### Task 10: Tests

**Files:**
- Modify: `/root/gatecontrol/tests/tokens.test.js`

- [ ] **Step 1: Add fingerprint validation tests**

In `tests/tokens.test.js`, add a new describe block inside the `Token Scope Logic` suite (after the `VALID_SCOPES` describe):

```javascript
  describe('validateFingerprint', () => {
    it('should accept valid SHA256 hex', () => {
      assert.equal(tokens.validateFingerprint('a'.repeat(64)), null);
      assert.equal(tokens.validateFingerprint('0123456789abcdef'.repeat(4)), null);
    });

    it('should reject empty/null', () => {
      assert.notEqual(tokens.validateFingerprint(''), null);
      assert.notEqual(tokens.validateFingerprint(null), null);
      assert.notEqual(tokens.validateFingerprint(undefined), null);
    });

    it('should reject invalid format', () => {
      assert.notEqual(tokens.validateFingerprint('tooshort'), null);
      assert.notEqual(tokens.validateFingerprint('g'.repeat(64)), null);
      assert.notEqual(tokens.validateFingerprint('A'.repeat(64)), null);
      assert.notEqual(tokens.validateFingerprint('a'.repeat(63)), null);
      assert.notEqual(tokens.validateFingerprint('a'.repeat(65)), null);
    });
  });
```

- [ ] **Step 2: Run tests**

```bash
cd /root/gatecontrol
node --test tests/tokens.test.js tests/validate.test.js
```

Expected: All tests pass including new fingerprint validation tests.

- [ ] **Step 3: Commit**

```bash
git add tests/tokens.test.js
git commit -m "test(machine-binding): add fingerprint validation tests"
```

---

### Task 11: Build, Deploy, Push

- [ ] **Step 1: Run full test suite**

```bash
cd /root/gatecontrol
node --test tests/validate.test.js tests/tokens.test.js
```

Expected: All tests pass.

- [ ] **Step 2: Build and deploy server**

```bash
cd /root/gatecontrol
docker compose build
docker save gatecontrol:latest | gzip > gatecontrol-image.tar.gz
docker compose up -d
```

- [ ] **Step 3: Verify container is healthy**

```bash
sleep 35 && docker ps --filter name=gatecontrol --format '{{.Status}}'
```

Expected: `Up X seconds (healthy)`

- [ ] **Step 4: Check migration ran**

```bash
docker logs gatecontrol 2>&1 | grep -i "machine_binding\|migration"
```

Expected: `Applying migration` with version 30, `add_machine_binding`

- [ ] **Step 5: Push both repos**

```bash
cd /root/gatecontrol && git push
cd /root/windows-client && git push
```
