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
//
// Then the open items of phase 3c (gateway 1.31.0): the gateway reports an
// NVIDIA card — "Grafikkarte nutzen" with the hints (suggested, compose file
// too old, "bereit" once the service sees the card with 12 GB, the model fit
// by graphics memory), the compose download with the device reservation, the
// row "Lokale KI" with the card; and a LAN server by name with an API key:
// "Verbindung testen" (answered by the page's network layer — no tunnel),
// the key stored encrypted, only its revision in the config pull, the key
// for this gateway from /api/v1/gateway/ai/credentials.

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
const SUPPORTS = ['gpu', 'lanKey', 'lanHost', 'probe'];
const NV = { vendor: 'nvidia', driver: 'nvidia', vramMb: null, integrated: false, name: 'NVIDIA GeForce RTX 3060' };
const GPU_HOST = { memTotal: 15.5 * GB, cores: 4, arch: 'x64', gpu: [NV], nvidiaDriver: '550.54.14', kfd: false, render: true };
const LAN_KEY = 'sk-e2e-lan-key-4711';

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
      const heartbeat = (ai, version = '1.26.0') => gw('/heartbeat', { uptime_s: 3600, telemetry: {
        gateway_version: version, node_version: 'v20.19.0', cpu_cores: 4, mem_total: 15.5 * GB, mem_used: 3 * GB, arch: 'x64',
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

        // ── "Grafikkarte nutzen" (gateway 1.31.0): an NVIDIA card with its driver, the service ki still without a GPU ──
        const noGpu = { mode: 'none', devices: [], access: null, cards: [], used: false };
        step('ai gpu: heartbeat of a 1.31.0 gateway with an NVIDIA card (driver 550)', await heartbeat(aiTel({ host: GPU_HOST, gpu: noGpu, supports: SUPPORTS }), '1.31.0') === 200);
        await page.reload();
        await theme(page, 'light');
        step('ai gpu: "Grafikkarte nutzen" with the card found, suggested (not switched on), the gateway label', await until(page, () => {
          const sel = document.getElementById('ai-local-gpu');
          const info = document.getElementById('ai-local-gpu-info');
          const gw = document.getElementById('ai-local-gw');
          return !!sel && sel.value === 'off' && !!info && /Erkannt: NVIDIA GeForce RTX 3060/.test(info.textContent) && /Treiber 550\.54\.14/.test(info.textContent)
            && !!document.querySelector('#ai-local [data-gpu-hint="available"]') && /Grafikkarte NVIDIA/.test(gw.options[gw.selectedIndex].text);
        }, null, 15000));
        await page.selectOption('#ai-local-gpu', 'nvidia');
        step('ai gpu: NVIDIA chosen → "after saving: the new compose file", the suggestion hint gone', await until(page, () => {
          const box = document.querySelector('#ai-local [data-gpu="nvidia"]');
          return !!box && /Nach dem Speichern: einmal die neue Compose-Datei herunterladen/.test(box.textContent) && !document.querySelector('#ai-local [data-gpu-hint="available"]');
        }));
        await page.click('#ai-local-save');
        step('ai gpu: saved (real PUT) → the running service has no GPU yet: the compose download for the card', await until(page, () => {
          const c = document.querySelector('#ai-local [data-compose="gpu"]');
          return !!c && /neue Compose-Datei/.test(c.textContent) && !!c.querySelector('#ai-local-compose') && !!document.querySelector('#ai-local [data-gpu-hint="compose"]');
        }, null, 15000));
        const feat = await api(page, 'GET', `/api/v1/gateways/${GW}/features`);
        const fa = feat.body && feat.body.gateway && feat.body.gateway.ai;
        step('ai gpu: GET …/features → gpu choice nvidia, compose "compose_gpu"', !!(fa && fa.gpu && fa.gpu.choice === 'nvidia' && fa.compose === 'compose_gpu'), JSON.stringify(fa && fa.gpu));
        const csrfTok = await page.evaluate(() => window.GC && window.GC.csrfToken);
        const compose = await (await page.request.fetch(BASE + `/api/v1/gateways/${GW}/compose`, { method: 'POST', data: { platform: 'linux' }, headers: { 'X-CSRF-Token': csrfTok } })).text();
        step('ai gpu: the downloaded docker-compose.yml gives the service ki the NVIDIA card', /\n {2}ki:\n/.test(compose) && /- GC_KI_GPU=nvidia/.test(compose) && /- driver: nvidia\n {14}count: all\n {14}capabilities: \[gpu\]/.test(compose));
        // the new compose file is up: the service sees the card, nvidia-smi says 12 GB
        step('ai gpu: heartbeat — the service sees the card (12 GB)', await heartbeat(aiTel({ host: GPU_HOST, supports: SUPPORTS,
          gpu: { mode: 'nvidia', devices: ['nvidia'], access: true, cards: [{ name: 'NVIDIA GeForce RTX 3060', vramMb: 12288, driver: '550.54.14' }], used: false } }), '1.31.0') === 200);
        await page.reload();
        step('ai gpu: "bereit", 12 GB graphics memory; Qwen 2.5 14B fits into it and is recommended, Llama 3.2 3B stays chosen', await until(page, () => {
          const info = document.getElementById('ai-local-gpu-info');
          const q = document.querySelector('#ai-local [data-model="qwen2.5:14b"]');
          return !!document.querySelector('#ai-local [data-gpu-state="ready"]') && !!info && /12,0 GB Grafikspeicher/.test(info.textContent)
            && !!q && q.getAttribute('data-fit') === 'recommended' && /im Grafikspeicher/.test(q.textContent)
            && document.querySelector('#ai-local input[value="llama3.2:3b"]').checked && !document.querySelector('#ai-local [data-compose="gpu"]');
        }, null, 15000));
        await view(page, 'gwai-gpu-light');
        await theme(page, 'dark');
        await view(page, 'gwai-gpu-dark');
        await theme(page, 'light');

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
        step('ai gpu: the row "Lokale KI" shows the card: "Grafikkarte: NVIDIA GeForce RTX 3060 (12 GB) – bereit"', await page.evaluate(() => {
          const r = document.querySelector('[data-fgroup="devices"] [data-feature="ai"] [data-ai-gpu]');
          return !!r && r.getAttribute('data-ai-gpu') === 'ready' && /Grafikkarte: NVIDIA GeForce RTX 3060 \(12 GB\) – bereit/.test(r.textContent);
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

        // ── a LAN server by name with an API key: "Verbindung testen", the key never in the config pull ──
        let probed = null;
        await page.route('**/api/v1/ai/local/probe', async (route) => {
          probed = JSON.parse(route.request().postData() || '{}');
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, probe: { reachable: true, url: 'http://ki-pc.local:8000', api: 'openai', version: null,
            models: [{ name: 'qwen2.5-14b-instruct', size: 0 }, { name: 'llama-3.2-3b-instruct', size: 0 }], auth: true, error: null } }) });
        });
        await page.goto(BASE + '/settings/ki');
        await theme(page, 'light');
        await until(page, () => !!document.querySelector('#ai-local [data-source="lan"]'), null, 15000);
        await page.click('#ai-local [data-source="lan"]');
        await until(page, () => !!document.getElementById('ai-local-url'));
        await page.fill('#ai-local-url', 'http://ki-pc.local:8000/v1');
        await page.selectOption('#ai-local-api', 'openai');
        await page.fill('#ai-local-key', LAN_KEY);
        step('ai lan: address by name, API key field, the hint for a key over http://', await until(page, () => {
          const b = document.getElementById('ai-local-connect');
          return !!b && b.textContent.trim() === 'Verbindung testen' && /Name im Heimnetz/.test(document.getElementById('ai-local').textContent)
            && document.getElementById('ai-local-key').type === 'password';
        }));
        await page.click('#ai-local-connect');
        step('ai lan: "Verbindung testen" → connected, 2 models in the list (nothing saved yet)', await until(page, () => {
          const ok = document.querySelector('#ai-local [data-probe="ok"]');
          const sel = document.getElementById('ai-local-lanmodel');
          return !!ok && /Verbunden mit http:\/\/ki-pc\.local:8000 – 2 Modelle/.test(ok.textContent) && !!sel && !sel.disabled && sel.options.length === 3
            && !!document.querySelector('#ai-local [data-key-http]');
        }));
        step('ai lan: the test sent the typed key along to the server (→ gateway)', !!(probed && probed.lanKey === LAN_KEY && probed.lanUrl === 'http://ki-pc.local:8000/v1' && probed.lanApi === 'openai'));
        await view(page, 'gwai-lan-light');
        await page.selectOption('#ai-local-lanmodel', 'qwen2.5-14b-instruct');
        await page.click('#ai-local-save');
        step('ai lan: saved (real PUT) → the key field says "gespeichert (…4711)", the typed key is gone', await until(page, () => {
          const k = document.getElementById('ai-local-key');
          return !!k && k.value === '' && /gespeichert \(…4711\)/.test(k.placeholder) && !!document.getElementById('ai-local-key-remove');
        }, null, 15000));
        const cfg3 = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        const lan3 = cfg3.features && cfg3.features.ai && cfg3.features.ai.lan;
        step('ai lan: the config pull: the name, openai, a key revision — never the key', !!(lan3 && lan3.url === 'http://ki-pc.local:8000' && lan3.api === 'openai' && /^[0-9a-f]{16}$/.test(lan3.keyRev || '')) && !JSON.stringify(cfg3).includes(LAN_KEY));
        const cred = await (await page.request.fetch(BASE + '/api/v1/gateway/ai/credentials', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('ai lan: the forwarding gateway fetches the key itself', cred.key === LAN_KEY && cred.rev === lan3.keyRev);
        const pageText = await page.evaluate(() => document.documentElement.outerHTML);
        step('ai lan: the key is nowhere in the page', !pageText.includes(LAN_KEY));
        await theme(page, 'dark');
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o3 = await overflow(page);
        step('ai lan: 390 px, the LAN server with key: no sideways scroll', o3 <= 0, 'overflow ' + o3);
        await view(page, 'gwai-lan-390-dark', 3200);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`${BASE}/gateways#gw/${GW}/features`);
        await goTab(page, GW, 'features');
        step('ai lan: the row "Lokale KI": forwards to ki-pc.local, with an API key', await until(page, () => {
          const r = document.querySelector('[data-fgroup="devices"] [data-feature="ai"]');
          return !!r && /leitet an den KI-Server im Heimnetz weiter \(http:\/\/ki-pc\.local:8000, mit API-Schlüssel\)/.test(r.textContent);
        }));
      } finally {
        await page.unroute('**/api/v1/ai/local/probe').catch(() => {});
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
