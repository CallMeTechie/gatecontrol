# DNS-Integration (Pi-Hole/AdGuard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add UI controls for configuring custom DNS servers (global + per-peer) for WireGuard peers, enabling Pi-Hole/AdGuard ad-blocking.

**Architecture:** Global DNS setting stored in the settings DB table, per-peer DNS override in existing peers.dns column. Peer config generator uses fallback chain: peer.dns → custom_dns setting → GC_WG_DNS env var. Feature is license-gated.

**Tech Stack:** Express.js, Nunjucks templates, vanilla JS, SQLite settings store

**Spec:** `docs/superpowers/specs/2026-03-29-dns-integration-design.md`

---

### Task 1: License feature key

**Files:**
- Modify: `src/services/license.js:40` (after `bot_blocking: false,`)

- [ ] **Step 1: Add custom_dns to COMMUNITY_FALLBACK**

After `bot_blocking: false,` add:

```javascript
  custom_dns: false,
```

- [ ] **Step 2: Commit**

```bash
git add src/services/license.js
git commit -m "feat: add custom_dns license feature key"
```

---

### Task 2: i18n keys

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English keys**

Add settings DNS keys (alphabetically near other `settings.*` keys):

```json
  "settings.dns": "DNS Server",
  "settings.dns_desc": "Custom DNS for VPN peers (e.g. Pi-Hole). Existing peers must re-download their config.",
  "settings.dns_saved": "DNS settings saved",
```

Add peers DNS keys (alphabetically near other `peers.*` keys):

```json
  "peers.dns_override": "DNS Server (Override)",
  "peers.dns_override_hint": "Leave empty for global DNS. Overrides global DNS for this peer only.",
  "peers.dns_placeholder": "e.g. 10.8.0.50",
```

- [ ] **Step 2: Add German keys**

Settings:
```json
  "settings.dns": "DNS-Server",
  "settings.dns_desc": "Eigener DNS für VPN-Peers (z.B. Pi-Hole). Bestehende Peers müssen ihre Konfiguration neu herunterladen.",
  "settings.dns_saved": "DNS-Einstellungen gespeichert",
```

Peers:
```json
  "peers.dns_override": "DNS-Server (Override)",
  "peers.dns_override_hint": "Leer lassen für globalen DNS. Überschreibt den globalen DNS nur für diesen Peer.",
  "peers.dns_placeholder": "z.B. 10.8.0.50",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat: add i18n keys for DNS integration (EN + DE)"
```

---

### Task 3: Settings API — DNS endpoint

**Files:**
- Modify: `src/routes/api/settings.js`

- [ ] **Step 1: Add GET and PUT endpoints for DNS**

Follow the existing pattern (like `/data` or `/security`). Add after the last settings endpoint, before `module.exports`:

```javascript
// GET /settings/dns — read custom DNS setting
router.get('/dns', (req, res) => {
  res.json({
    ok: true,
    data: {
      dns: settings.get('custom_dns') || config.wireguard.dns.join(','),
      is_custom: !!settings.get('custom_dns'),
      default_dns: config.wireguard.dns.join(','),
    },
  });
});

// PUT /settings/dns — update custom DNS setting
router.put('/dns', requireFeature('custom_dns'), (req, res) => {
  try {
    const { dns } = req.body;
    if (dns !== undefined) {
      const value = String(dns).trim();
      if (value) {
        // Validate: comma-separated IPv4 addresses
        const ips = value.split(',').map(s => s.trim()).filter(Boolean);
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        for (const ip of ips) {
          if (!ipv4Regex.test(ip)) {
            return res.status(400).json({ ok: false, error: 'Invalid IP address: ' + ip });
          }
        }
        settings.set('custom_dns', ips.join(','));
      } else {
        // Empty = reset to default
        settings.set('custom_dns', '');
      }
    }
    activity.log('dns_settings_updated', 'DNS settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});
```

Make sure `requireFeature` is imported at the top of the file. Check if it's already imported — if not, add:
```javascript
const { requireFeature } = require('../../middleware/license');
```

Also ensure `config` is imported:
```javascript
const config = require('../../../config/default');
```

Check the existing imports at the top of the file and add only what's missing.

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/settings.js
git commit -m "feat: add DNS settings GET/PUT API endpoint"
```

---

### Task 4: Peer config generator — DNS fallback chain

**Files:**
- Modify: `src/services/peers.js:286-291`

- [ ] **Step 1: Update getClientConfig to use settings fallback**

Find line 286-291 in `getClientConfig`:
```javascript
const dns = peer.dns || config.wireguard.dns.join(',');
```

Replace with:
```javascript
const settings = require('./settings');
const customDns = settings.get('custom_dns');
const dns = peer.dns || customDns || config.wireguard.dns.join(',');
```

Note: `require('./settings')` is fine inline since Node.js caches module requires. Alternatively, add it as a top-level require if the file already imports other local modules at the top.

- [ ] **Step 2: Commit**

```bash
git add src/services/peers.js
git commit -m "feat: DNS fallback chain peer.dns → custom_dns → GC_WG_DNS"
```

---

### Task 5: Peer API — add dns to POST (create)

**Files:**
- Modify: `src/routes/api/peers.js:85-97`

- [ ] **Step 1: Add dns to POST destructuring and create call**

Find the POST handler destructuring (line 85):
```javascript
const { name, description, tags, expires_at, group_id } = req.body;
```

Change to:
```javascript
const { name, description, tags, expires_at, group_id, dns } = req.body;
```

Find the `peers.create()` call (around line 97) and add `dns`:
```javascript
const peer = await peers.create({ name, description, tags, expiresAt: expires_at || null, groupId: group_id !== undefined ? group_id : null, dns });
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/peers.js
git commit -m "feat: accept dns field in POST /api/peers (create)"
```

---

### Task 6: Settings UI — DNS field in General tab

**Files:**
- Modify: `templates/default/pages/settings.njk`

- [ ] **Step 1: Add DNS card in General tab**

Find the General tab panel. After the App Info card (ends around line 188) and before the Data Retention card (starts around line 191), insert a new DNS card:

```nunjucks
  <div class="card">
    <div class="card-head">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
      <span class="card-title">{{ t('settings.dns') }}</span>
    </div>
    <div class="card-body">
      {% if license.features.custom_dns %}
      <div style="margin-bottom:8px">
        <input type="text" id="settings-dns-input" placeholder="{{ t('peers.dns_placeholder') }}" style="width:100%;padding:8px 12px;font-size:12.5px;font-family:var(--font-mono)">
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:12px">{{ t('settings.dns_desc') }}</div>
      <div style="display:flex;justify-content:flex-end">
        <button class="btn btn-primary" id="btn-dns-save">{{ t('data.save') or 'Save' }}</button>
      </div>
      {% else %}
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0">
        <span style="font-size:13px;color:var(--text-2)">{{ t('settings.dns') }} <span class="lock-icon"></span></span>
        <code style="font-family:var(--font-mono);font-size:12px;color:var(--text-3)">{{ wgDns }}</code>
      </div>
      <div style="font-size:11px;color:var(--text-3)">{{ t('settings.dns_desc') }}</div>
      {% endif %}
    </div>
  </div>
```

Also ensure `wgDns` is passed to the template. Check the route handler in `src/routes/index.js` that renders the settings page — add `wgDns: config.wireguard.dns.join(',')` to the render context if not already present. Alternatively, pass it via `res.locals` in the middleware.

- [ ] **Step 2: Commit**

```bash
git add templates/default/pages/settings.njk
git commit -m "feat: add DNS settings card in General tab"
```

---

### Task 7: Peer-Add Modal — DNS override field

**Files:**
- Modify: `templates/default/partials/modals/peer-add.njk`

- [ ] **Step 1: Add DNS field after Tags**

Find the Tags field (around line 24-26) and after it (before the Expires section), add:

```nunjucks
      {% if license.features.custom_dns %}
      <div class="form-group">
        <label class="form-label">{{ t('peers.dns_override') }}</label>
        <input type="text" id="add-peer-dns" placeholder="{{ t('peers.dns_placeholder') }}" style="font-family:var(--font-mono)">
        <small class="form-hint">{{ t('peers.dns_override_hint') }}</small>
      </div>
      {% endif %}
```

- [ ] **Step 2: Commit**

```bash
git add templates/default/partials/modals/peer-add.njk
git commit -m "feat: add DNS override field to peer-add modal"
```

---

### Task 8: Peer-Edit Modal — DNS override field

**Files:**
- Modify: `templates/default/partials/modals/peer-edit.njk`

- [ ] **Step 1: Add DNS field after Tags**

Same position as add modal — after Tags, before Expires:

```nunjucks
      {% if license.features.custom_dns %}
      <div class="form-group">
        <label class="form-label">{{ t('peers.dns_override') }}</label>
        <input type="text" id="edit-peer-dns" placeholder="{{ t('peers.dns_placeholder') }}" style="font-family:var(--font-mono)">
        <small class="form-hint">{{ t('peers.dns_override_hint') }}</small>
      </div>
      {% endif %}
```

- [ ] **Step 2: Commit**

```bash
git add templates/default/partials/modals/peer-edit.njk
git commit -m "feat: add DNS override field to peer-edit modal"
```

---

### Task 9: Settings JavaScript — DNS save handler

**Files:**
- Modify: `public/js/settings.js`

- [ ] **Step 1: Add DNS save handler and initial load**

Add after the existing settings handlers:

```javascript
// ─── DNS Settings ─────────────────────────────
(function () {
  var dnsInput = document.getElementById('settings-dns-input');
  var dnsSaveBtn = document.getElementById('btn-dns-save');

  // Load current DNS setting
  if (dnsInput) {
    api.get('/api/v1/settings/dns').then(function(data) {
      if (data.ok) dnsInput.value = data.data.dns || '';
    }).catch(function() {});
  }

  // Save DNS setting
  if (dnsSaveBtn) {
    dnsSaveBtn.addEventListener('click', async function() {
      var btn = this;
      btnLoading(btn);
      try {
        var data = await api.put('/api/v1/settings/dns', { dns: dnsInput.value.trim() });
        if (data.ok) {
          showToast(GC.t['settings.dns_saved'] || 'DNS settings saved');
        } else {
          showToast(data.error || 'Error', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      } finally {
        btnReset(btn);
      }
    });
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add public/js/settings.js
git commit -m "feat: add DNS settings save handler"
```

---

### Task 10: Peers JavaScript — DNS in create/edit payload

**Files:**
- Modify: `public/js/peers.js`

- [ ] **Step 1: Add dns to create payload**

Find the add peer form submit handler (around line 404). In the `api.post('/api/peers', {...})` call, add the dns field:

```javascript
var dns = document.getElementById('add-peer-dns')?.value.trim() || undefined;
```

Then add `dns: dns` to the payload object:
```javascript
var data = await api.post('/api/peers', { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id, dns: dns });
```

- [ ] **Step 2: Populate dns in edit modal**

In the `showEditModal` function (around line 425), add after the other field populations:

```javascript
  var editDns = document.getElementById('edit-peer-dns');
  if (editDns) editDns.value = peer.dns || '';
```

- [ ] **Step 3: Add dns to edit payload**

In the edit peer submit handler (around line 471), read the dns field and add to payload:

```javascript
var dns = document.getElementById('edit-peer-dns')?.value.trim() || undefined;
```

Add to the `api.put` payload:
```javascript
var data = await api.put('/api/peers/' + id, { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id, dns: dns });
```

- [ ] **Step 4: Commit**

```bash
git add public/js/peers.js
git commit -m "feat: add DNS field to peer create/edit UI"
```

---

### Task 11: Pass wgDns to settings template

**Files:**
- Modify: `src/routes/index.js` or `src/middleware/locals.js`

- [ ] **Step 1: Ensure wgDns is available in template**

Check if `wgDns` is already passed to templates. If not, find where other WireGuard values (`wgHost`, `wgPort`, `wgSubnet`) are passed to the template context and add:

```javascript
wgDns: config.wireguard.dns.join(','),
```

This might be in `src/middleware/locals.js` or directly in the route handler in `src/routes/index.js`.

- [ ] **Step 2: Commit**

```bash
git add src/routes/index.js  # or src/middleware/locals.js
git commit -m "feat: pass wgDns to template context"
```

---

### Task 12: Build, deploy, and verify

- [ ] **Step 1: Build container**

Run: `docker compose build --no-cache 2>&1 | tail -5`

- [ ] **Step 2: Deploy**

Run: `docker compose down && docker compose up -d`

- [ ] **Step 3: Export image**

Run: `docker save gatecontrol:latest | gzip > gatecontrol-image.tar.gz`

- [ ] **Step 4: Test in browser**

1. Settings → General tab → DNS card visible with current DNS?
2. Enter Pi-Hole IP (e.g. `10.8.0.50`), save → success toast?
3. Peers → Add peer → DNS Override field visible?
4. Peers → Edit peer → DNS Override field with current value?
5. Download peer config → DNS line shows custom DNS?
6. QR code → contains custom DNS?
7. Community license → DNS field shows lock icon?

- [ ] **Step 5: Commit and push**

```bash
git push
```
