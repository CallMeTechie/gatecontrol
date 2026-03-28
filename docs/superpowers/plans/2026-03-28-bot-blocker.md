# AI-Bot-Blocker (caddy-defender) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-route AI bot blocking via caddy-defender plugin with mode selection and a blocked-bots counter badge in the route list.

**Architecture:** caddy-defender plugin blocks requests from known AI crawler IP ranges. A background task periodically counts 403 responses per route from the Caddy access log and stores the count in the DB. The UI shows a toggle + mode selection and a bot counter badge.

**Tech Stack:** caddy-defender (Caddy plugin), Express.js API, Nunjucks templates, vanilla JS, SQLite

**Spec:** `docs/superpowers/specs/2026-03-28-bot-blocker-design.md`

---

### Task 1: Add caddy-defender plugin to Dockerfile

**Files:**
- Modify: `Dockerfile:5-11`

- [ ] **Step 1: Add caddy-defender to xcaddy build**

Add `--with github.com/JasonLovesDoggo/caddy-defender \` as the first `--with` line (after `--output`):

```dockerfile
RUN cd /tmp/caddy-mirror && go mod tidy && cd / && \
    xcaddy build \
    --output /usr/bin/caddy \
    --with github.com/JasonLovesDoggo/caddy-defender \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/greenpau/caddy-trace \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add caddy-defender plugin to Caddy build"
```

---

### Task 2: Database migration

**Files:**
- Modify: `src/db/migrations.js` (before the closing `];` of the migrations array, around line 459)

- [ ] **Step 1: Add migration version 28**

After the version 27 entry, add:

```javascript
    {
      version: 28,
      name: 'add_bot_blocker',
      sql: `
        ALTER TABLE routes ADD COLUMN bot_blocker_enabled INTEGER DEFAULT 0;
        ALTER TABLE routes ADD COLUMN bot_blocker_mode TEXT DEFAULT 'block';
        ALTER TABLE routes ADD COLUMN bot_blocker_count INTEGER DEFAULT 0;
        ALTER TABLE routes ADD COLUMN bot_blocker_config TEXT;
      `,
      detect: (db) => hasColumn(db, 'routes', 'bot_blocker_enabled'),
    },
```

- [ ] **Step 2: Commit**

```bash
git add src/db/migrations.js
git commit -m "feat: add bot_blocker columns (migration 28)"
```

---

### Task 3: License feature key

**Files:**
- Modify: `src/services/license.js:39` (after `request_debugging: false,`)

- [ ] **Step 1: Add bot_blocking to COMMUNITY_FALLBACK**

After `request_debugging: false,` add:

```javascript
  bot_blocking: false,
```

- [ ] **Step 2: Commit**

```bash
git add src/services/license.js
git commit -m "feat: add bot_blocking license feature key"
```

---

### Task 4: i18n keys

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English keys**

Add in alphabetical position (after any `batch.*` keys, before `circuit_breaker.*` keys):

```json
  "bot_blocker.badge": "bots blocked",
  "bot_blocker.message": "Response message",
  "bot_blocker.mode": "Mode",
  "bot_blocker.mode_block": "Block (403)",
  "bot_blocker.mode_custom": "Custom response",
  "bot_blocker.mode_drop": "Drop (close connection)",
  "bot_blocker.mode_garbage": "Garbage (random data)",
  "bot_blocker.mode_redirect": "Redirect (308)",
  "bot_blocker.mode_tarpit": "Tarpit (slow response)",
  "bot_blocker.status_code": "Status code",
  "bot_blocker.title": "AI Bot Blocker",
  "bot_blocker.toggle_desc": "Block AI crawlers from known IP ranges",
  "bot_blocker.url": "Redirect URL",
```

- [ ] **Step 2: Add German keys**

```json
  "bot_blocker.badge": "Bots geblockt",
  "bot_blocker.message": "Antwortnachricht",
  "bot_blocker.mode": "Modus",
  "bot_blocker.mode_block": "Blockieren (403)",
  "bot_blocker.mode_custom": "Eigene Antwort",
  "bot_blocker.mode_drop": "Drop (Verbindung trennen)",
  "bot_blocker.mode_garbage": "Garbage (Zufallsdaten)",
  "bot_blocker.mode_redirect": "Weiterleitung (308)",
  "bot_blocker.mode_tarpit": "Tarpit (langsame Antwort)",
  "bot_blocker.status_code": "Statuscode",
  "bot_blocker.title": "AI-Bot-Blocker",
  "bot_blocker.toggle_desc": "AI-Crawler von bekannten IP-Bereichen blockieren",
  "bot_blocker.url": "Weiterleitungs-URL",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat: add i18n keys for bot blocker (EN + DE)"
```

---

### Task 5: Route service — defender handler + CREATE/UPDATE

**Files:**
- Modify: `src/services/routes.js`

- [ ] **Step 1: Add defender handler to routeHandlers**

Find the trace handler push (around line 229). BEFORE it, add the defender handler:

```javascript
    // Bot blocker — must be first handler to block bots before any processing
    if (route.bot_blocker_enabled) {
      const defenderConfig = {
        handler: 'defender',
        raw_responder: route.bot_blocker_mode || 'block',
        ranges: ['openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud'],
      };
      const bbConfig = route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : {};
      if (bbConfig.message) defenderConfig.message = bbConfig.message;
      if (bbConfig.status_code) defenderConfig.status_code = bbConfig.status_code;
      if (bbConfig.url) defenderConfig.url = bbConfig.url;
      routeHandlers.push(defenderConfig);
    }
```

Note: Since both defender and trace use push here (before any other handlers), defender is pushed first and will be at index 0, trace at index 1. Correct order.

- [ ] **Step 2: Add defender handler to authHandlers**

Find the trace unshift for authHandlers (around line 386). AFTER the trace unshift block, add:

```javascript
      // Bot blocker for auth routes — unshift AFTER trace so defender ends up at index 0
      if (route.bot_blocker_enabled) {
        const defenderConfig = {
          handler: 'defender',
          raw_responder: route.bot_blocker_mode || 'block',
          ranges: ['openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud'],
        };
        const bbConfig = route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : {};
        if (bbConfig.message) defenderConfig.message = bbConfig.message;
        if (bbConfig.status_code) defenderConfig.status_code = bbConfig.status_code;
        if (bbConfig.url) defenderConfig.url = bbConfig.url;
        authHandlers.unshift(defenderConfig);
      }
```

- [ ] **Step 3: Add bot_blocker fields to CREATE function**

In the `create` function, add `bot_blocker_enabled`, `bot_blocker_mode`, `bot_blocker_config` to:
1. Destructuring of `data` (alongside `debug_enabled`)
2. INSERT column list (after `debug_enabled`)
3. VALUES placeholders (3 more `?`)
4. Values array:
```javascript
    data.bot_blocker_enabled ? 1 : 0,
    data.bot_blocker_mode || 'block',
    data.bot_blocker_config || null,
```

- [ ] **Step 4: Add bot_blocker fields to UPDATE function**

In the `update` function, add to:
1. SET clause (after `debug_enabled`):
```sql
    bot_blocker_enabled = COALESCE(?, bot_blocker_enabled),
    bot_blocker_mode = COALESCE(?, bot_blocker_mode),
    bot_blocker_config = COALESCE(?, bot_blocker_config),
```
2. Values array:
```javascript
    data.bot_blocker_enabled !== undefined ? (data.bot_blocker_enabled ? 1 : 0) : null,
    data.bot_blocker_mode !== undefined ? data.bot_blocker_mode : null,
    data.bot_blocker_config !== undefined ? data.bot_blocker_config : null,
```

- [ ] **Step 5: Add validation**

In the `create` and `update` functions, add mode validation before the INSERT/UPDATE:

```javascript
    const VALID_BOT_MODES = ['block', 'tarpit', 'drop', 'garbage', 'redirect', 'custom'];
    if (data.bot_blocker_mode && !VALID_BOT_MODES.includes(data.bot_blocker_mode)) {
      throw new Error('Invalid bot blocker mode');
    }
    if (data.bot_blocker_config) {
      const bbCfg = typeof data.bot_blocker_config === 'string' ? JSON.parse(data.bot_blocker_config) : data.bot_blocker_config;
      if (data.bot_blocker_mode === 'redirect' && (!bbCfg.url || !/^https?:\/\//.test(bbCfg.url))) {
        throw new Error('Redirect mode requires a valid URL');
      }
      if (data.bot_blocker_mode === 'custom') {
        if (bbCfg.status_code && (bbCfg.status_code < 100 || bbCfg.status_code > 599)) {
          throw new Error('Invalid status code');
        }
        if (bbCfg.message && bbCfg.message.length > 500) {
          throw new Error('Message too long');
        }
      }
      data.bot_blocker_config = typeof data.bot_blocker_config === 'string' ? data.bot_blocker_config : JSON.stringify(data.bot_blocker_config);
    }
```

- [ ] **Step 6: Commit**

```bash
git add src/services/routes.js
git commit -m "feat: integrate caddy-defender handler in route service"
```

---

### Task 6: API routes — feature guard + destructuring

**Files:**
- Modify: `src/routes/api/routes.js`

- [ ] **Step 1: Add requireFeatureField guard to POST and PUT**

After the existing `requireFeatureField('debug_enabled', 'request_debugging')` line in both POST and PUT middleware chains, add:

```javascript
  requireFeatureField('bot_blocker_enabled', 'bot_blocking'),
```

- [ ] **Step 2: Add bot_blocker fields to POST destructuring**

After `debug_enabled` in the POST destructuring, add:

```javascript
  mirror_enabled, mirror_targets, debug_enabled,
  bot_blocker_enabled, bot_blocker_mode, bot_blocker_config } = req.body;
```

- [ ] **Step 3: Add bot_blocker fields to routes.create() call**

After `debug_enabled` in the create call:

```javascript
  debug_enabled,
  bot_blocker_enabled, bot_blocker_mode, bot_blocker_config,
});
```

- [ ] **Step 4: Add bot_blocker fields to PUT destructuring**

Same pattern as POST:

```javascript
  mirror_enabled, mirror_targets, debug_enabled,
  bot_blocker_enabled, bot_blocker_mode, bot_blocker_config } = req.body;
```

- [ ] **Step 5: Add bot_blocker fields to routes.update() call**

```javascript
  debug_enabled,
  bot_blocker_enabled, bot_blocker_mode, bot_blocker_config,
});
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/routes.js
git commit -m "feat: add bot_blocker API guards and destructuring"
```

---

### Task 7: Bot counter background task

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add bot counter task**

After the existing background tasks (around line 132), add a new periodic task:

```javascript
// ─── Bot blocker counter (every 60s) ──────────────
let lastBotCountTs = 0;
setInterval(() => {
  try {
    const fs = require('fs');
    const logPath = '/data/caddy/access.log';
    if (!fs.existsSync(logPath)) return;

    const db = require('./db/connection')();
    const enabledRoutes = db.prepare(
      'SELECT id, domain FROM routes WHERE bot_blocker_enabled = 1'
    ).all();
    if (enabledRoutes.length === 0) return;

    const domainMap = new Map();
    for (const r of enabledRoutes) {
      domainMap.set(r.domain.toLowerCase(), r.id);
    }

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const counts = new Map();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.status !== 403) continue;
        const ts = entry.ts || 0;
        if (ts <= lastBotCountTs) continue;
        if (ts > lastBotCountTs) lastBotCountTs = ts;

        const host = (entry.request?.host || '').split(':')[0].toLowerCase();
        const routeId = domainMap.get(host);
        if (!routeId) continue;
        counts.set(routeId, (counts.get(routeId) || 0) + 1);
      } catch { /* skip */ }
    }

    const update = db.prepare(
      'UPDATE routes SET bot_blocker_count = bot_blocker_count + ? WHERE id = ?'
    );
    for (const [routeId, count] of counts) {
      update.run(count, routeId);
    }
  } catch (err) {
    require('./utils/logger').warn('Bot counter error: ' + err.message);
  }
}, 60000);
```

- [ ] **Step 2: Commit**

```bash
git add src/server.js
git commit -m "feat: add bot counter background task (60s interval)"
```

---

### Task 8: Backup/Restore

**Files:**
- Modify: `src/services/backup.js`

- [ ] **Step 1: Add bot_blocker fields to export**

After `debug_enabled` in the export map, add:

```javascript
      bot_blocker_enabled: r.bot_blocker_enabled || 0,
      bot_blocker_mode: r.bot_blocker_mode || 'block',
      bot_blocker_config: r.bot_blocker_config || null,
```

Note: `bot_blocker_count` is intentionally NOT exported.

- [ ] **Step 2: Add bot_blocker fields to restore INSERT**

Add `bot_blocker_enabled`, `bot_blocker_mode`, `bot_blocker_config` to the column list, VALUES placeholders, and `.run()` values:

```javascript
        r.bot_blocker_enabled ? 1 : 0,
        r.bot_blocker_mode || 'block',
        r.bot_blocker_config || null,
```

- [ ] **Step 3: Commit**

```bash
git add src/services/backup.js
git commit -m "feat: add bot_blocker fields to backup/restore"
```

---

### Task 9: Create-Route template — bot blocker toggle + mode

**Files:**
- Modify: `templates/default/pages/routes.njk` (after debug toggle, before save button)

- [ ] **Step 1: Add bot blocker toggle with mode selection**

After the debug `{% endif %}` (around line 465) and before the save button, add:

```nunjucks
        {% if license.features.bot_blocking %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('bot_blocker.title') }}</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('bot_blocker.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="create-route-bot-blocker"></div>
        </div>
        <div id="create-bot-blocker-fields" style="display:none;margin-bottom:14px">
          <div style="margin-bottom:8px">
            <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.mode') }}</label>
            <select id="create-bot-blocker-mode" style="width:100%;padding:6px 10px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-xs)">
              <option value="block">{{ t('bot_blocker.mode_block') }}</option>
              <option value="tarpit">{{ t('bot_blocker.mode_tarpit') }}</option>
              <option value="drop">{{ t('bot_blocker.mode_drop') }}</option>
              <option value="garbage">{{ t('bot_blocker.mode_garbage') }}</option>
              <option value="redirect">{{ t('bot_blocker.mode_redirect') }}</option>
              <option value="custom">{{ t('bot_blocker.mode_custom') }}</option>
            </select>
          </div>
          <div id="create-bot-blocker-redirect" style="display:none;margin-bottom:8px">
            <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.url') }}</label>
            <input type="url" id="create-bot-blocker-url" placeholder="https://example.com" style="width:100%;padding:6px 10px;font-size:12px">
          </div>
          <div id="create-bot-blocker-custom" style="display:none">
            <div style="margin-bottom:8px">
              <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.message') }}</label>
              <input type="text" id="create-bot-blocker-message" placeholder="Access denied" maxlength="500" style="width:100%;padding:6px 10px;font-size:12px">
            </div>
            <div>
              <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.status_code') }}</label>
              <input type="number" id="create-bot-blocker-status" value="403" min="100" max="599" style="width:100%;padding:6px 10px;font-size:12px">
            </div>
          </div>
        </div>
        {% else %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px" class="feature-locked" title="{{ t('license.requires_pro') }}">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('bot_blocker.title') }} <span class="lock-icon"></span></div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('bot_blocker.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="create-route-bot-blocker"></div>
        </div>
        {% endif %}
```

- [ ] **Step 2: Commit**

```bash
git add templates/default/pages/routes.njk
git commit -m "feat: add bot blocker toggle + mode to create-route card"
```

---

### Task 10: Edit-Route modal — bot blocker in Security tab

**Files:**
- Modify: `templates/default/partials/modals/route-edit.njk`

- [ ] **Step 1: Add bot blocker toggle to Security tab**

Find the Security tab panel (`data-panel="security"`). Before the closing `</div>` of the security panel, add the bot blocker toggle with the same structure as Task 9 but with `edit-` prefixed IDs:

```nunjucks
        {% if license.features.bot_blocking %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-top:14px">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('bot_blocker.title') }}</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('bot_blocker.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="edit-route-bot-blocker"></div>
        </div>
        <div id="edit-bot-blocker-fields" style="display:none;margin-top:10px">
          <div style="margin-bottom:8px">
            <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.mode') }}</label>
            <select id="edit-bot-blocker-mode" style="width:100%;padding:6px 10px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-xs)">
              <option value="block">{{ t('bot_blocker.mode_block') }}</option>
              <option value="tarpit">{{ t('bot_blocker.mode_tarpit') }}</option>
              <option value="drop">{{ t('bot_blocker.mode_drop') }}</option>
              <option value="garbage">{{ t('bot_blocker.mode_garbage') }}</option>
              <option value="redirect">{{ t('bot_blocker.mode_redirect') }}</option>
              <option value="custom">{{ t('bot_blocker.mode_custom') }}</option>
            </select>
          </div>
          <div id="edit-bot-blocker-redirect" style="display:none;margin-bottom:8px">
            <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.url') }}</label>
            <input type="url" id="edit-bot-blocker-url" placeholder="https://example.com" style="width:100%;padding:6px 10px;font-size:12px">
          </div>
          <div id="edit-bot-blocker-custom" style="display:none">
            <div style="margin-bottom:8px">
              <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.message') }}</label>
              <input type="text" id="edit-bot-blocker-message" placeholder="Access denied" maxlength="500" style="width:100%;padding:6px 10px;font-size:12px">
            </div>
            <div>
              <label style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600">{{ t('bot_blocker.status_code') }}</label>
              <input type="number" id="edit-bot-blocker-status" value="403" min="100" max="599" style="width:100%;padding:6px 10px;font-size:12px">
            </div>
          </div>
        </div>
        {% else %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-top:14px" class="feature-locked" title="{{ t('license.requires_pro') }}">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('bot_blocker.title') }} <span class="lock-icon"></span></div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('bot_blocker.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="edit-route-bot-blocker"></div>
        </div>
        {% endif %}
```

- [ ] **Step 2: Commit**

```bash
git add templates/default/partials/modals/route-edit.njk
git commit -m "feat: add bot blocker to Security tab in edit-route modal"
```

---

### Task 11: JavaScript — toggle logic, mode switching, badge, payload

**Files:**
- Modify: `public/js/routes.js`

- [ ] **Step 1: Add bot blocker badge to route list**

After the debugTag block (around line 139), add:

```javascript
      let botTag = '';
      if (r.bot_blocker_enabled && r.route_type !== 'l4') {
        var botCount = r.bot_blocker_count || 0;
        var botSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16.01"/><line x1="16" y1="16" x2="16" y2="16.01"/></svg>';
        if (botCount > 0) {
          botTag = '<span class="tag tag-orange" style="margin-left:4px">' + botSvg + ' ' + botCount + '</span>';
        } else {
          botTag = '<span class="tag tag-orange" style="margin-left:4px;opacity:0.6">' + botSvg + '</span>';
        }
      }
```

Include `botTag` in the tags concatenation alongside `debugTag`.

- [ ] **Step 2: Add bot blocker to create form submission**

After the `createDebug` line (around line 312), add:

```javascript
      const createBotBlocker = document.getElementById('create-route-bot-blocker')?.classList.contains('on') || false;
      const createBotMode = document.getElementById('create-bot-blocker-mode')?.value || 'block';
      let createBotConfig = null;
      if (createBotMode === 'redirect') {
        createBotConfig = JSON.stringify({ url: document.getElementById('create-bot-blocker-url')?.value || '' });
      } else if (createBotMode === 'custom') {
        createBotConfig = JSON.stringify({
          message: document.getElementById('create-bot-blocker-message')?.value || '',
          status_code: parseInt(document.getElementById('create-bot-blocker-status')?.value) || 403,
        });
      }
```

Add to the create payload:

```javascript
        bot_blocker_enabled: createBotBlocker,
        bot_blocker_mode: createBotBlocker ? createBotMode : 'block',
        bot_blocker_config: createBotBlocker ? createBotConfig : null,
```

- [ ] **Step 3: Add bot blocker to edit form submission**

After the `debugEnabled` line in edit submit, add:

```javascript
      const botBlockerEnabled = document.getElementById('edit-route-bot-blocker')?.classList.contains('on') || false;
      const botBlockerMode = document.getElementById('edit-bot-blocker-mode')?.value || 'block';
      let botBlockerConfig = null;
      if (botBlockerMode === 'redirect') {
        botBlockerConfig = JSON.stringify({ url: document.getElementById('edit-bot-blocker-url')?.value || '' });
      } else if (botBlockerMode === 'custom') {
        botBlockerConfig = JSON.stringify({
          message: document.getElementById('edit-bot-blocker-message')?.value || '',
          status_code: parseInt(document.getElementById('edit-bot-blocker-status')?.value) || 403,
        });
      }
```

Add to edit payload:

```javascript
        bot_blocker_enabled: botBlockerEnabled,
        bot_blocker_mode: botBlockerEnabled ? botBlockerMode : undefined,
        bot_blocker_config: botBlockerEnabled ? botBlockerConfig : undefined,
```

- [ ] **Step 4: Populate bot blocker in edit modal**

After the debug toggle population (around line 905), add:

```javascript
      // Bot blocker toggle + mode
      var bbToggle = document.getElementById('edit-route-bot-blocker');
      var bbFields = document.getElementById('edit-bot-blocker-fields');
      if (bbToggle) {
        if (route.bot_blocker_enabled) bbToggle.classList.add('on'); else bbToggle.classList.remove('on');
        bbToggle.setAttribute('aria-checked', route.bot_blocker_enabled ? 'true' : 'false');
        if (bbFields) bbFields.style.display = route.bot_blocker_enabled ? '' : 'none';
      }
      var bbModeSelect = document.getElementById('edit-bot-blocker-mode');
      if (bbModeSelect) bbModeSelect.value = route.bot_blocker_mode || 'block';
      // Populate config fields
      var bbCfg = {};
      try { bbCfg = route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : {}; } catch {}
      var bbUrl = document.getElementById('edit-bot-blocker-url');
      if (bbUrl) bbUrl.value = bbCfg.url || '';
      var bbMsg = document.getElementById('edit-bot-blocker-message');
      if (bbMsg) bbMsg.value = bbCfg.message || '';
      var bbStatus = document.getElementById('edit-bot-blocker-status');
      if (bbStatus) bbStatus.value = bbCfg.status_code || 403;
      // Show/hide mode-specific fields
      updateBotBlockerFields('edit');
```

- [ ] **Step 5: Add toggle and mode-switch listeners**

```javascript
    // Bot blocker toggle (create)
    var createBbToggle = document.getElementById('create-route-bot-blocker');
    var createBbFields = document.getElementById('create-bot-blocker-fields');
    if (createBbToggle) {
      createBbToggle.classList.remove('on');
      createBbToggle.addEventListener('click', function() {
        setTimeout(function() {
          if (createBbFields) createBbFields.style.display = createBbToggle.classList.contains('on') ? '' : 'none';
        }, 0);
      });
    }

    // Bot blocker toggle (edit)
    var editBbToggle = document.getElementById('edit-route-bot-blocker');
    var editBbFields = document.getElementById('edit-bot-blocker-fields');
    if (editBbToggle && editBbFields) {
      editBbToggle.addEventListener('click', function() {
        setTimeout(function() {
          editBbFields.style.display = editBbToggle.classList.contains('on') ? '' : 'none';
        }, 0);
      });
    }

    // Mode-switch field visibility helper
    function updateBotBlockerFields(prefix) {
      var mode = document.getElementById(prefix + '-bot-blocker-mode')?.value || 'block';
      var redirectDiv = document.getElementById(prefix + '-bot-blocker-redirect');
      var customDiv = document.getElementById(prefix + '-bot-blocker-custom');
      if (redirectDiv) redirectDiv.style.display = mode === 'redirect' ? '' : 'none';
      if (customDiv) customDiv.style.display = mode === 'custom' ? '' : 'none';
    }

    // Mode change listeners
    var createBbMode = document.getElementById('create-bot-blocker-mode');
    if (createBbMode) createBbMode.addEventListener('change', function() { updateBotBlockerFields('create'); });
    var editBbMode = document.getElementById('edit-bot-blocker-mode');
    if (editBbMode) editBbMode.addEventListener('change', function() { updateBotBlockerFields('edit'); });
```

- [ ] **Step 6: Commit**

```bash
git add public/js/routes.js
git commit -m "feat: add bot blocker toggle, mode switching, badge and payload"
```

---

### Task 12: Build, deploy, and verify

- [ ] **Step 1: Build container**

Run: `docker compose build --no-cache 2>&1 | tail -5`

- [ ] **Step 2: Deploy**

Run: `docker compose down && docker compose up -d`

- [ ] **Step 3: Verify caddy-defender module**

Run: `docker exec gatecontrol caddy list-modules 2>&1 | grep defender`
Expected: `http.handlers.defender`

- [ ] **Step 4: Verify migration**

Run: `docker logs gatecontrol 2>&1 | grep -i "migration\|bot_blocker"`

- [ ] **Step 5: Export image**

Run: `docker save gatecontrol:latest | gzip > gatecontrol-image.tar.gz`

- [ ] **Step 6: Test in browser**

1. Routes page — bot blocker toggle in "Neue Route anlegen" sichtbar?
2. Mode-Auswahl erscheint bei aktivem Toggle?
3. Redirect-/Custom-Felder erscheinen bei jeweiligem Modus?
4. Edit modal → Security tab → Bot Blocker Toggle + Mode?
5. Bot aktivieren, speichern, mit Bot-User-Agent testen:
   `curl -A "GPTBot/1.0" https://route.example.com/` → 403?
6. Nach 60s: Bot-Badge in Routen-Liste sichtbar?

- [ ] **Step 7: Commit and push**

```bash
git push
```
