'use strict';

// Lokale KI (phase 3c, step 3 — public/js/settings-ai.js, gateway-net.js):
// Einstellungen › KI-Anbieter › "Lokale KI einrichten" / "Wofür die lokale KI?"
// and the row "Lokale KI" with the memory bar in Gateway › Funktionen.
//
// The seeded gateway "e2e-gw-home" gets a known gateway token and reports like
// a real gateway 1.26.0 on a NAS (15.5 GB RAM, 4 cores, no GPU) with the
// service ki running and Llama 3.2 3B in memory. Setup, mode and the switch
// are real requests; only the live state the gateway would answer over its
// tunnel (download progress) is answered by the page's network layer
// (page.route) — there is no tunnel in the test. The test button goes the
// real way and meets an unreachable gateway: the page says so. Light/dark,
// 390 px without sideways scroll.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function withDb(fn) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); }
}

const GB = 1024 ** 3;
const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'storage', 'timezone', 'print', 'radio', 'ai'];

function aiTel(extra) {
  return {
    enabled: true, source: 'service', service: 'managed', state: 'running', version: '0.40.8',
    models: [{ name: 'llama3.2:3b', size: 2019393189 }], loaded: [{ name: 'llama3.2:3b', size: 2.55 * GB, vram: 0 }],
    pull: null, host: { memTotal: 15.5 * GB, cores: 4, arch: 'x64', gpu: [] }, lan: null, error: null, ...(extra || {}),
  };
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api } = ctx;
  const until = (page, fn, arg, ms = 12000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const goTab = async (page, id, tab) => {
    await page.evaluate(([i, tb]) => { location.hash = '#gw/' + i + '/' + tb; }, [id, tab]);
    return until(page, (tb) => { const b = document.getElementById('gwe-tab-' + tb); return b && b.getAttribute('aria-selected') === 'true' && !document.querySelector('#gwe-tabpanel .gwe-loading'); }, tab);
  };
  const view = async (page, name, height) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: height || 1600 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await shot(page, name, false);
    await page.setViewportSize(vp);
  };

  return {
    async gatewayai(page) {
      const GW = FIXTURES.gateways.home;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const token = 'gc_gw_' + crypto.randomBytes(32).toString('hex');
      const hash = 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
      const old = withDb((db) => {
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        const r = db.prepare('SELECT api_token_hash, last_health, last_seen_at, first_seen_at, alive FROM gateway_meta WHERE peer_id = ?').get(GW);
        const f = db.prepare('SELECT settings FROM gateway_features WHERE peer_id = ?').get(GW);
        db.prepare('UPDATE gateway_meta SET api_token_hash = ? WHERE peer_id = ?').run(hash, GW);
        return r ? { ...r, features: f ? f.settings : null } : null;
      });
      step('ai: seeded gateway prepared with a known token', !!(old && old.api_token_hash));
      const gw = async (p, body) => (await page.request.fetch(BASE + '/api/v1/gateway' + p, { method: 'POST', data: body, headers: { Authorization: 'Bearer ' + token } })).status();
      const heartbeat = (ai) => gw('/heartbeat', { uptime_s: 3600, telemetry: {
        gateway_version: '1.26.0', node_version: 'v20.19.0', cpu_cores: 4, mem_total: 15.5 * GB, mem_used: 3 * GB, arch: 'x64',
        hardware: { model: 'DS918+', cpu_cores: 4, mem_total: 15.5 * GB, arch: 'x64', storage: { total: 4e12, free: 2e12 }, radios: [] },
        lan_ip: '192.168.1.23', default_gateway_ip: '192.168.1.1', state_dir_writable: true, capabilities: CAPS,
        features: { ai },
      } });
      // the gateway's live answer over the tunnel: a download in progress, then done
      let pull = { model: 'llama3.2:3b', state: 'pulling', completed: 1.3e9, total: 2.0e9, error: null };
      await page.route('**/api/v1/ai/local/status*', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, online: true, status: { ...aiTel({ models: [], loaded: [], pull }), memFree: 9 * GB } }) }));
      await page.route('**/api/v1/ai/local/pull', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
      await page.route('**/api/v1/ai/local/pull/cancel', (route) => { pull = { ...pull, state: 'cancelled' }; return route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }); });
      await page.goto(BASE + '/settings/ki');
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('ai: page in German for the run', langSet.status === 200, 'status ' + langSet.status);
      try {
        step('ai: heartbeat of a 1.26.0 gateway with the service ki', await heartbeat(aiTel()) === 200);
        await page.reload();
        await theme(page, 'light');
        step('ai: the provider list starts with "Lokale KI" (not set up)', await until(page, () => {
          const r = document.querySelector('#ai-providers .ai-prov');
          return !!r && r.dataset.provider === 'local' && /Lokale KI/.test(r.textContent) && /Nicht eingerichtet/.test(r.textContent);
        }, null, 15000));
        step('ai: "Lokale KI einrichten": "Auf einem Gateway" chosen, the gateway with RAM, cores, no GPU', await until(page, () => {
          const b = document.querySelector('#ai-local [data-source="service"]');
          const sel = document.getElementById('ai-local-gw');
          return !!b && b.getAttribute('aria-pressed') === 'true' && !!sel && /e2e-gw-home – 15,5 GB RAM, 4 Kerne, keine Grafikkarte/.test(sel.options[sel.selectedIndex].text);
        }));
        step('ai: the models with size and fit: Llama 3.2 3B "empfohlen", Qwen 2.5 7B "passt", Gemma 2 9B "nicht empfohlen"', await page.evaluate(() => {
          const fit = (id) => { const r = document.querySelector('#ai-local [data-model="' + id + '"]'); return r ? r.getAttribute('data-fit') + '|' + r.textContent : ''; };
          return /^recommended\|Llama 3\.2 3B · 2,0 GB.*empfohlen/.test(fit('llama3.2:3b')) && /^fits\|Qwen 2\.5 7B · 4,7 GB.*passt/.test(fit('qwen2.5:7b'))
            && /^not_recommended\|Gemma 2 9B · 5,4 GB.*nicht empfohlen/.test(fit('gemma2:9b')) && document.querySelector('#ai-local input[value="llama3.2:3b"]').checked;
        }));
        step('ai: the note about the compose file (service „ki“)', await page.evaluate(() => /Compose-Datei des Gateways \(Dienst „ki“\)/.test(document.getElementById('ai-local').textContent)));
        await page.click('#ai-local-save');
        step('ai: "Speichern" (real PUT) → "Lokale KI · e2e-gw-home", Standard, 0 € · bleibt zu Hause', await until(page, () => {
          const r = document.querySelector('#ai-providers .ai-prov[data-provider="local"]');
          return !!r && /Lokale KI · e2e-gw-home/.test(r.textContent) && /Standard/.test(r.textContent) && /0 € · bleibt zu Hause/.test(r.textContent);
        }, null, 15000));
        const cfg = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('ai: the config pull carries features.ai', !!(cfg.features && cfg.features.ai && cfg.features.ai.enabled === true && cfg.features.ai.source === 'service'));
        step('ai: the download "Modell wird geladen: 1,3 von 2,0 GB" with "Abbrechen"', await until(page, () => {
          const d = document.querySelector('#ai-local [data-pull="pulling"]');
          return !!d && /Modell wird geladen: 1,3 von 2,0 GB/.test(d.textContent) && !!document.getElementById('ai-local-cancel');
        }));
        await view(page, 'gwai-settings-light');
        await page.click('#ai-local-cancel');
        step('ai: "Abbrechen" → cancelled, resumable later', await until(page, () => !!document.querySelector('#ai-local [data-pull="cancelled"]')));
        pull = null;
        step('ai: "Wofür die lokale KI?" with three modes, "Für alles" chosen', await page.evaluate(() => {
          const ins = [...document.querySelectorAll('#ai-use input[name="ai-use"]')];
          return ins.map((x) => x.value).join() === 'all,private,fallback' && ins[0].checked && /Nur für private Inhalte/.test(document.getElementById('ai-use').textContent)
            && /Monatsbudget der Cloud/.test(document.getElementById('ai-use').textContent);
        }));
        await page.click('#ai-use-private');
        await page.click('#ai-use-save');
        step('ai: mode "Nur für private Inhalte" saved (real PUT) → the row says "Private Inhalte"', await until(page, () => {
          const r = document.querySelector('#ai-providers .ai-prov[data-provider="local"]');
          return !!r && /Private Inhalte/.test(r.textContent);
        }));
        const v = await api(page, 'GET', '/api/v1/ai');
        step('ai: GET /api/v1/ai → localUse private', !!(v.body && v.body.localUse === 'private'));
        await page.click('#ai-local-test');
        step('ai: "Testen: „Fasse diese Mail zusammen“" goes the real way — no tunnel here: "nicht erreichbar"', await until(page, () => /nicht erreichbar/.test((document.getElementById('ai-test-out') || {}).textContent || ''), null, 20000));
        await theme(page, 'dark');
        await view(page, 'gwai-settings-dark');
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o1 = await overflow(page);
        step('ai: 390 px, KI-Anbieter: no sideways scroll', o1 <= 0, 'overflow ' + o1);
        await view(page, 'gwai-settings-390-dark', 3200);
        await page.setViewportSize({ width: 1440, height: 1000 });

        // ── Gateway › Funktionen: the row "Lokale KI", the memory bar ──
        await page.goto(`${BASE}/gateways#gw/${GW}/features`);
        await theme(page, 'light');
        await goTab(page, GW, 'features');
        step('ai: the row "Lokale KI" in "Geräte im Heimnetz", after "Drucken & Scannen" (and "Kameras")', await until(page, () => {
          const g = document.querySelector('[data-fgroup="devices"]');
          if (!g) return false;
          const keys = [...g.querySelectorAll('[data-feature]')].map((x) => x.getAttribute('data-feature'));
          // phase 3c, step 4: the row "Kameras" sits between printing and the local AI
          const prev = keys.indexOf('cameras') >= 0 ? 'cameras' : 'print';
          return keys.indexOf('ai') === keys.indexOf(prev) + 1 && /Lokale KI/.test(g.textContent);
        }));
        step('ai: the row: on, the model (2 GB Download, ≈ 2,5 GB im Speicher), ≈ GB in blue, the way to the KI-Anbieter', await page.evaluate(() => {
          const r = document.querySelector('[data-fgroup="devices"] [data-feature="ai"]');
          if (!r) return false;
          const sw = r.querySelector('[role="switch"]');
          const tag = r.querySelector('.gwn-fr-mem');
          const m = r.querySelector('[data-ai-model]');
          return sw.getAttribute('aria-checked') === 'true' && !!m && /Llama 3\.2 3B/.test(m.textContent) && /\(2 GB Download, ≈ 2,5 GB im Speicher\)/.test(m.textContent)
            && !!tag && tag.classList.contains('tag-blue') && /≈ 2,\d GB/.test(tag.textContent)
            && !!r.querySelector('a[data-ai-link][href="/settings/ki"]');
        }));
        step('ai: the memory bar: green features, blue the model, "reicht"-level, legend', await page.evaluate(() => {
          const bar = document.querySelector('.gwn-membar');
          return !!bar && !!bar.querySelector('[data-membar="ai"]') && /Blau: lokale KI \(Modell im Speicher\)/.test(bar.textContent)
            && /Speicher für die Funktionen: etwa/.test(bar.textContent);
        }));
        step('ai: the hints "Ein Schalter genügt." and "Hinweise statt Verbote:"', await page.evaluate(() => {
          const t = (document.querySelector('.gwn-fhints') || {}).textContent || '';
          return /Ein Schalter genügt\./.test(t) && /Hinweise statt Verbote:/.test(t);
        }));
        await view(page, 'gwai-features-light');
        // the switch off (real PUT) → the config pull says so
        await page.click('[data-fgroup="devices"] [data-feature="ai"] [role="switch"]');
        step('ai: switched off in "Funktionen" (real PUT)', await until(page, () => {
          const sw = document.querySelector('[data-fgroup="devices"] [data-feature="ai"] [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'false' && !sw.disabled;
        }));
        const cfg2 = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('ai: … and the config pull says features.ai off', !!(cfg2.features && cfg2.features.ai && cfg2.features.ai.enabled === false));
        await theme(page, 'dark');
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o2 = await overflow(page);
        step('ai: 390 px, tab Funktionen: no sideways scroll', o2 <= 0, 'overflow ' + o2);
        await view(page, 'gwai-features-390-dark', 3000);
        await page.setViewportSize({ width: 1440, height: 1000 });
      } finally {
        await page.unroute('**/api/v1/ai/local/status*').catch(() => {});
        await page.unroute('**/api/v1/ai/local/pull').catch(() => {});
        await page.unroute('**/api/v1/ai/local/pull/cancel').catch(() => {});
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        withDb((db) => {
          if (old) {
            db.prepare('UPDATE gateway_meta SET api_token_hash = ?, last_health = ?, last_seen_at = ?, first_seen_at = ?, alive = ? WHERE peer_id = ?')
              .run(old.api_token_hash, old.last_health, old.last_seen_at, old.first_seen_at, old.alive, GW);
            if (old.features) db.prepare('UPDATE gateway_features SET settings = ? WHERE peer_id = ?').run(old.features, GW);
            else db.prepare('DELETE FROM gateway_features WHERE peer_id = ?').run(GW);
          }
          db.prepare("DELETE FROM ai_providers WHERE id = 'local'").run();
          db.prepare("DELETE FROM settings WHERE key IN ('ai.local_peer', 'ai.local_use')").run();
        });
      }
    },
  };
};
