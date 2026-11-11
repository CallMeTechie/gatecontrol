'use strict';

// Gateways › "Gateway hinzufügen" (docs/feature-gateway-wizard.md): the
// waiting cards of the seeded gateways (never reported), the assistant for a
// Raspberry Pi (field checks, licence refusal from the real API, creation,
// gatecontrol-setup.zip built in the browser — downloaded, unpacked, checked),
// the live status (first a real, then a mocked "connected" status with
// hardware + RaspBee II), "Fertig" → detail view; "Einrichtung fortsetzen"
// on an older gateway → platform Synology → the set-up through the setup page
// of the gateway (compose without access data, server address + setup code
// in two fields, a new code, the package without gateway.env; the code is
// redeemed like the gateway does and the step goes on by itself), the file
// way behind its link → the real package from the server (unpacked, checked);
// "Zugang erneuern" in the gateway management (asks first, the old token is
// refused, code + server address) and the switch "Statusseite im Heimnetz";
// the Peers page adds devices only; Escape, keyboard, light/dark and 390 px.
//
// The app runs with the community licence (one gateway) and the seed has two,
// so creating a gateway is refused by the real API — that refusal is checked,
// then POST /api/v1/peers is answered by page.route with the seeded gateway
// "e2e-gw-nas" (the following steps use the real API for it).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzip } = require(path.join(__dirname, '..', '..', 'helpers', 'unzip.js'));

function sshString(buf) { const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([l, buf]); }
function ed25519Line() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return 'ssh-ed25519 ' + Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(x)]).toString('base64') + ' e2e@test';
}

// The app starts with the community licence and disables what exceeds it
// (license.enforceLimits at boot) — the seeded gateways included. The
// scenario switches them on again in the database (like 05-dashboard writes
// its traffic rows); the check runs only at start-up.
function enableSeededGateways(ids) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return 0;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    const st = db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'");
    return ids.reduce((n, id) => n + st.run(id).changes, 0);
  } finally { db.close(); }
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, shot, api } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const stepShown = (page, n, platform) => until(page, ([s, p]) => {
    const sec = [...document.querySelectorAll('#gwz-overlay .gwz-step')].filter((x) => !x.hidden);
    return sec.length === 1 && sec[0].dataset.step === String(s) && (!p || sec[0].dataset.platform === p);
  }, [n, platform || null]);
  // step 3 of Synology/Linux: 'code' = setup page of the gateway, 'file' = gateway.env as before
  const wayShown = (page, w) => until(page, (way) => {
    const sec = [...document.querySelectorAll('#gwz-overlay .gwz-step')].filter((x) => !x.hidden);
    return sec.length === 1 && sec[0].dataset.step === '3' && sec[0].dataset.way === way;
  }, w);
  const CODE_RE = /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/;
  // the server address the assistant shows: the host of GC_BASE_URL (as the admin opens GateControl)
  const SERVER = new URL(process.env.GC_BASE_URL || 'http://localhost:3000').host;
  const download = async (page, sel) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click(sel)]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };

  return {
    async gatewaywizard(page) {
      const GW = FIXTURES.gateways;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      step('seeded gateways enabled for this scenario', enableSeededGateways([GW.home, GW.nas]) === 2);

      // ── Fleet: waiting cards ──
      await page.goto(BASE + '/gateways');
      step('gateway page: "Gateway hinzufügen" button', await visible(page, '#btn-add-gateway'));
      step('the seeded gateways never reported → "wartet auf ersten Start" cards with "Einrichtung fortsetzen"',
        await until(page, (ids) => ids.every((id) => document.querySelector(`#fleet-grid .gw-waiting[data-id="${id}"] .gw-resume`)), [GW.home, GW.nas]));
      await theme(page, 'dark');
      await shot(page, 'gwz-fleet-dark');

      // ── Step 1 ──
      await page.click('#btn-add-gateway');
      step('#add opens the assistant at step 1', await visible(page, '#gwz-overlay') && await stepShown(page, 1) && /#add$/.test(page.url()));
      step('dialog semantics: role=dialog, aria-modal, labelled by the title',
        await page.$eval('#gwz-overlay .gwz', (n) => n.getAttribute('role') === 'dialog' && n.getAttribute('aria-modal') === 'true' && !!document.getElementById(n.getAttribute('aria-labelledby'))));
      await page.click('#gwz-next');
      step('"Weiter" without a name → field error', await visible(page, '#gwz-name-err') && await page.$eval('#gwz-name', (n) => n.getAttribute('aria-invalid') === 'true'));
      await page.fill('#gwz-name', 'Pi E2E');
      await page.click('#gwz-next');
      step('… then without a platform → platform error', await visible(page, '#gwz-platform-err'));
      // keyboard: focus the first platform radio and pick the Pi with the keyboard
      await page.focus('#gwz-overlay input[name="gwz-platform"][value="rpi"]');
      await page.keyboard.press('Space');
      step('platform card marks the choice', await until(page, () => document.querySelector('.gwz-plat.on input[value="rpi"]')));
      await shot(page, 'gwz-step1-dark');
      await page.click('#gwz-next');

      // ── Step 2 (Pi) ──
      step('Pi → step 2 "Raspberry Pi einstellen"', await stepShown(page, 2));
      step('host name prefilled from the name', (await page.inputValue('#gwz-hostname').catch(() => '')) === 'gc-pi-e2e');
      await page.click('#gwz-overlay label:has(input[name="gwz-net"][value="wifi"])');
      step('WLAN shows SSID + password', await visible(page, '#gwz-ssid') && await visible(page, '#gwz-psk'));
      await page.fill('#gwz-ssid', 'E2E-WLAN #1');
      await page.fill('#gwz-psk', 'short');
      await page.click('#gwz-next');
      step('PSK 8–63 checked in the browser', await visible(page, '#gwz-psk-err'));
      await page.fill('#gwz-psk', 'geheim-e2e-123');
      await page.click('#gwz-advanced summary');
      await page.fill('#gwz-ssh', 'ssh-rsa AAAAB3NzaC1yc2E');
      await page.click('#gwz-next');
      step('SSH key format checked', await visible(page, '#gwz-ssh-err'));
      const key = ed25519Line();
      await page.fill('#gwz-ssh', key);
      await theme(page, 'light');
      await shot(page, 'gwz-step2-light');

      // creation: the real API refuses (community licence: one gateway)
      await page.click('#gwz-next');
      step('licence limit from the real API is shown, the assistant stays on step 2',
        await visible(page, '#gwz-error') && await stepShown(page, 2));
      ctx.allow((p) => p.kind === 'http' && p.status === 403 && p.url === '/api/v1/peers');
      ctx.allow((p) => p.kind === 'console' && /403/.test(p.text));

      const ENV = '# e2e\nGC_SERVER_URL=http://localhost:3000\nGC_API_TOKEN=gc_gw_' + 'e'.repeat(64) + '\n';
      let createBody = null;
      await page.route('**/api/v1/peers', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        createBody = route.request().postDataJSON();
        await route.fulfill({ status: 201, contentType: 'application/json',
          body: JSON.stringify({ ok: true, peer: { id: GW.nas, name: 'Pi E2E', peer_type: 'gateway' }, gateway: { apiToken: 'x', pushToken: 'y', envContent: ENV } }) });
      });
      await page.click('#gwz-next');
      step('"Gateway anlegen" posts to the existing endpoint with is_gateway + platform, no WLAN data',
        await stepShown(page, 3, 'rpi') && createBody && createBody.is_gateway === true && createBody.platform === 'rpi'
        && !JSON.stringify(createBody).includes('geheim') && !JSON.stringify(createBody).includes('ssh-'), JSON.stringify(createBody));
      await page.unroute('**/api/v1/peers');
      step('after creation the address continues the set-up (#setup/<id>)', page.url().endsWith('#setup/' + GW.nas), page.url());

      // ── Step 3 (Pi) ──
      const imgHref = await page.getAttribute('#gwz-pi-image', 'href');
      step('Pi image links to the gateway releases', /^https:\/\/github\.com\/CallMeTechie\/gatecontrol-gateway\/releases\//.test(imgHref || ''), imgHref);
      // the handbook inside the app, chapter 3.3 of this gateway's handbook (gateway-docs.js), in a new tab
      const piGuide = await page.$eval('section[data-platform="rpi"] a[data-guide="gw.rpi"]', (x) => ({ href: x.href, target: x.target })).catch(() => ({}));
      step('Pi instructions link to the handbook inside the app (chapter 3.3 of this gateway)', piGuide.href === BASE + '/gateways#gw/' + GW.nas + '/handbook/3-3-raspberry-pi' && piGuide.target === '_blank', piGuide.href);
      {
        const [hbPage] = await Promise.all([page.context().waitForEvent('page'), page.click('section[data-platform="rpi"] a[data-guide="gw.rpi"]')]);
        const opened = await hbPage.waitForFunction(() => {
          const view = document.getElementById('gw-docs-view');
          const head = document.getElementById('hb-3-3-raspberry-pi');
          return !!view && !view.hidden && !!head && document.querySelector('#gwd-tab-handbook[aria-selected="true"]') && head.getBoundingClientRect().top < window.innerHeight;
        }, null, { timeout: 10000 }).then(() => true).catch(() => false);
        step('"Detailed instructions" opens the handbook of the app at "3.3 Raspberry Pi" in a new tab; the assistant stays open', opened
          && await stepShown(page, 3, 'rpi'), hbPage.url());
        await hbPage.close();
      }
      step('Imager repository URL in the collapsed block',
        (await page.textContent('#gwz-imager-url')) === 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/latest/download/gatecontrol-rpi-imager.json');
      const zip = await download(page, '#gwz-pi-setup');
      let entries = [];
      try { entries = unzip(zip.data); } catch (e) { step('gatecontrol-setup.zip unpacks', false, String(e)); }
      const byName = Object.fromEntries(entries.map((e) => [e.name, e.data.toString('utf8')]));
      const settings = byName['gatecontrol/settings.txt'] || '';
      step('gatecontrol-setup.zip: gatecontrol/gateway.env + settings.txt',
        zip.name === 'gatecontrol-setup.zip' && byName['gatecontrol/gateway.env'] === ENV && !!settings, entries.map((e) => e.name).join(','));
      step('settings.txt carries host name, Zigbee, time zone, WLAN and SSH key per the contract',
        /^HOSTNAME=gc-pi-e2e$/m.test(settings) && /^ZIGBEE=auto$/m.test(settings) && /^TIMEZONE=\S+$/m.test(settings)
        && /^WIFI_SSID=E2E-WLAN #1$/m.test(settings) && /^WIFI_PSK=geheim-e2e-123$/m.test(settings)
        && /^WIFI_COUNTRY=[A-Z]{2}$/m.test(settings) && /^WIFI_HIDDEN=0$/m.test(settings) && settings.includes('SSH_AUTHORIZED_KEY=' + key), settings);
      await theme(page, 'dark');
      await shot(page, 'gwz-step3-pi-dark');

      // ── Step 4: real status first, then a mocked "connected" one ──
      await page.click('#gwz-next');
      step('step 4: created ✓, waiting for the first contact',
        await stepShown(page, 4) && await until(page, () => document.querySelector('[data-check="created"]').dataset.state === 'done'
          && document.querySelector('[data-check="contact"]').dataset.state === 'wait'));
      await page.route(new RegExp(`/api/v1/gateways/${GW.nas}/setup-status`), (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, gateway: {
        peer_id: GW.nas, name: 'Pi E2E', platform: 'rpi', enabled: true, created_at: Date.now() - 600000, first_seen_at: Date.now() - 60000,
        connected: true, tunnel_up: true, status: 'online', gateway_version: '1.17.0', hostname: 'gc-pi-e2e', lan_ip: '192.168.20.5',
        hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', cpu_cores: 4, mem_total: 948000000, storage_free: 22e9 }, hardware_supported: true,
        radios: [], zigbee: { kind: 'zigbee', type: 'raspbee2-conbee2', device: '/dev/ttyAMA0', detected: true, enabled: true, label: 'RaspBee II' },
        deconz: null, smarthome: { installed: false, target_declared: false, assigned: false, index: null, plugin_url: null },
      } }) }));
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway', { detail: {} })));
      step('live update: contact ✓ (tunnel), hardware ✓, Zigbee row with RaspBee II',
        await until(page, () => ['contact', 'hardware'].every((c) => document.querySelector(`[data-check="${c}"]`).dataset.state === 'done')
          && !document.querySelector('[data-check="zigbee"]').hidden
          && /RaspBee II/.test(document.querySelector('[data-check="zigbee"] [data-title]').textContent), null, 10000));
      step('no Phoscon route → home-network hint http://<host>:8090; plugin missing → install link',
        await until(page, () => !document.getElementById('gwz-phoscon-lan').hidden && /http:\/\/gc-pi-e2e:8090/.test(document.getElementById('gwz-phoscon-lan').textContent)
          && !document.getElementById('gwz-phoscon').offsetParent && !document.getElementById('gwz-smarthome').offsetParent
          && !!document.getElementById('gwz-smarthome-open').offsetParent));
      await shot(page, 'gwz-step4-dark');
      await page.click('#gwz-next');
      step('"Fertig – zum Gateway" closes and opens the detail view',
        await until(page, () => document.getElementById('gwz-overlay').style.display !== 'flex') && /#gw\//.test(page.url())
        && await visible(page, '#gw-detail-view .gw-detail'));
      await page.unroute(new RegExp(`/api/v1/gateways/${GW.nas}/setup-status`));

      // ── Resume an older gateway (no platform) → Synology package from the server ──
      await page.goto(BASE + '/gateways');
      await until(page, (id) => document.querySelector(`.gw-waiting[data-id="${id}"] .gw-resume`), GW.home);
      await page.click(`.gw-waiting[data-id="${GW.home}"] .gw-resume`);
      step('"Einrichtung fortsetzen" of a gateway without platform → step 1, name fixed, platform to choose',
        await stepShown(page, 1) && await until(page, () => { const n = document.getElementById('gwz-name'); return n.disabled && n.value === 'e2e-gw-home'; })
        && await visible(page, '#gwz-created-note'));
      await page.click('#gwz-overlay label.gwz-plat:has(input[value="synology"])');
      await page.click('#gwz-next');
      step('platform stored → Synology: set-up through the setup page of the gateway (step 3)', await wayShown(page, 'code'));
      const cw = async () => page.evaluate(() => ({
        server: document.getElementById('gwz-cw-server').textContent, code: document.getElementById('gwz-cw-code').textContent,
        left: document.getElementById('gwz-cw-countdown').textContent, compose: document.getElementById('gwz-cw-compose').textContent,
        url: document.getElementById('gwz-cw-url').textContent, title: document.getElementById('gwz-cw-s1-title').textContent,
      }));
      await until(page, (re) => new RegExp(re).test(document.getElementById('gwz-cw-code').textContent), CODE_RE.source);
      const c1 = await cw();
      step('server address and setup code in two fields, with a countdown', c1.server === SERVER && CODE_RE.test(c1.code) && /\d:\d\d/.test(c1.left), JSON.stringify([c1.server, c1.left]));
      step('the compose file carries no access data and a writable config folder',
        /\n {6}- \.\/config:\/config /.test(c1.compose) && /GC_SETUP_PORT/.test(c1.compose) && !/gc_gw_|GC_API_TOKEN|WG_PRIVATE_KEY|config:\/config:ro/.test(c1.compose));
      step('step 2 names the setup page (port 8642), step 1 the Container Manager', /:8642$/.test(c1.url) && /Container Manager/.test(c1.title), c1.url);
      const cwGuide = await page.$eval('section[data-way="code"] a[data-guide="gw.setup_page"]', (x) => x.href).catch(() => '');
      step('the instructions link to the handbook inside the app (the setup page of the gateway)', cwGuide === BASE + '/gateways#gw/' + GW.home + '/handbook/the-setup-page-of-the-gateway', cwGuide);
      const yml = await download(page, '#gwz-cw-download');
      step('"Herunterladen" → docker-compose.yml, the same text', yml.name === 'docker-compose.yml' && yml.data.toString() === c1.compose);
      const pkg = await download(page, '#gwz-cw-package');
      let pkgNames = [];
      try { pkgNames = unzip(pkg.data).map((e) => e.name); } catch (e) { step('package unpacks', false, String(e)); }
      step('the package brings compose, update.sh and the empty folders — no gateway.env',
        pkg.name === 'gatecontrol-gateway-nas.zip' && ['docker-compose.yml', 'config/', 'gateway-state/', 'gateway-cache/', 'update.sh'].every((n) => pkgNames.includes(n))
        && !pkgNames.includes('config/gateway.env') && !/gc_gw_/.test(pkg.data.toString('latin1')), pkgNames.join(','));
      await theme(page, 'light');
      await shot(page, 'gwz-step3-code-nas-light');
      await theme(page, 'dark');
      await shot(page, 'gwz-step3-code-nas-dark');
      // the lower half: server address + code, the waiting line, the link to the file way
      await page.$eval('#gwz-overlay .gwz-body', (b) => { b.scrollTop = b.scrollHeight; });
      await shot(page, 'gwz-step3-code-nas-code-dark');
      await theme(page, 'light');
      await shot(page, 'gwz-step3-code-nas-code-light');
      await page.click('#gwz-cw-regen');
      await until(page, (old) => { const t = document.getElementById('gwz-cw-code').textContent; return t !== old && /^[A-F0-9]{4}-/.test(t); }, c1.code);
      const c2 = await cw();
      step('"Neuen Code erzeugen" shows another code', CODE_RE.test(c2.code) && c2.code !== c1.code);
      const stale = await page.request.post(BASE + '/api/v1/gateway/pair', { data: { code: c1.code } });
      step('the code before no longer works', stale.status() === 400);
      // the gateway redeems the code on its setup page (the public endpoint it calls)
      const paired = await page.request.post(BASE + '/api/v1/gateway/pair', { data: { code: c2.code } });
      const pairedEnv = paired.status() === 200 ? (await paired.json()).envContent : '';
      const gwToken = (/^GC_API_TOKEN=(gc_gw_[0-9a-f]{64})$/m.exec(pairedEnv) || [])[1] || '';
      step('redeemed by the gateway → gateway.env', !!gwToken);
      step('the assistant goes on by itself (step 4)', await stepShown(page, 4) || await until(page, () => {
        const sec = [...document.querySelectorAll('#gwz-overlay .gwz-step')].filter((x) => !x.hidden);
        return sec.length === 1 && sec[0].dataset.step === '4';
      }, null, 12000));
      await page.click('#gwz-back');
      step('"Anleitung nochmal" → back at the setup page way with a fresh code', await wayShown(page, 'code')
        && await until(page, (old) => { const t = document.getElementById('gwz-cw-code').textContent; return /^[A-F0-9]{4}-/.test(t) && t !== old; }, c2.code));
      await page.setViewportSize({ width: 390, height: 844 });
      const ovCw = await overflow(page);
      step('390 px: no horizontal scrolling in the setup page way', ovCw <= 0, `overflow ${ovCw}px`);
      await shot(page, 'gwz-step3-code-nas-390-dark');
      await theme(page, 'light');
      await shot(page, 'gwz-step3-code-nas-390-light');
      await page.$eval('#gwz-overlay .gwz-body', (b) => { b.scrollTop = b.scrollHeight; });
      await shot(page, 'gwz-step3-code-nas-code-390-light');
      await page.setViewportSize({ width: 1440, height: 1000 });
      // the way before stays one click away
      await page.click('section[data-way="code"] [data-gwz-way="file"]');
      step('"Lieber die Datei gateway.env herunterladen" → the Synology instructions as before', await stepShown(page, 3, 'synology') && await wayShown(page, 'file'));
      const nasGuide = await page.$eval('section[data-platform="synology"] a[data-guide="gw.synology"]', (x) => x.href).catch(() => '');
      step('Synology instructions link to the handbook inside the app (chapter 3.2 of this gateway)', nasGuide === BASE + '/gateways#gw/' + GW.home + '/handbook/3-2-synology-nas', nasGuide);
      const plat = await api(page, 'GET', `/api/v1/gateways/${GW.home}/setup-status`);
      step('API: platform synology stored', plat.body && plat.body.gateway && plat.body.gateway.platform === 'synology');
      step('task scheduler command matches the folder', /GATEWAY_STATE_DIR=\/volume1\/docker\/gatecontrol-gateway\/gateway-state GC_GW_COMPOSE_DIR=\/volume1\/docker\/gatecontrol-gateway bash \/volume1\/docker\/gatecontrol-gateway\/update\.sh/.test(await page.textContent('#gwz-nas-cmd')));
      const nas = await download(page, '#gwz-nas-bundle');
      let nasEntries = [];
      try { nasEntries = unzip(nas.data); } catch (e) { step('NAS package unpacks', false, String(e)); }
      const nasNames = nasEntries.map((e) => e.name);
      const nasEnv = (nasEntries.find((e) => e.name === 'config/gateway.env') || { data: Buffer.alloc(0) }).data.toString();
      step('gatecontrol-gateway-nas.zip: compose, config/gateway.env (fresh token), update.sh',
        nas.name === 'gatecontrol-gateway-nas.zip' && ['docker-compose.yml', 'config/gateway.env', 'update.sh'].every((n) => nasNames.includes(n))
        && /^GC_API_TOKEN=gc_gw_[0-9a-f]{64}$/m.test(nasEnv), nasNames.join(','));
      await theme(page, 'light');
      await shot(page, 'gwz-step3-nas-light');
      await page.click('section[data-platform="synology"] [data-gwz-way="code"]');
      step('and back to the set-up without a file', await wayShown(page, 'code'));
      await page.keyboard.press('Escape');
      step('Escape closes the assistant and clears the address',
        await until(page, () => document.getElementById('gwz-overlay').style.display !== 'flex' && !/#(add|setup)/.test(location.hash)));

      // ── Linux: the same three steps, network mode, docker compose up ──
      await page.goto(BASE + '/gateways');
      await api(page, 'PUT', `/api/v1/gateways/${GW.home}/platform`, { platform: 'linux' });
      await page.goto(BASE + `/gateways#setup/${GW.home}`);
      step('Linux: set-up through the setup page, compose with kernel WireGuard', await wayShown(page, 'code')
        && await until(page, () => /Linux kernel WireGuard/.test(document.getElementById('gwz-cw-compose').textContent) && !document.getElementById('gwz-cw-up').hidden
          && !document.getElementById('gwz-cw-net').hidden && document.getElementById('gwz-cw-package').hidden));
      await page.click('#gwz-cw-net label:has(input[value="bridge"])');
      step('Linux bridge: the port of the setup page is published', await until(page, () => /"8642:8642"/.test(document.getElementById('gwz-cw-compose').textContent)));
      await page.click('#gwz-cw-net label:has(input[value="host"])');
      await theme(page, 'light');
      await shot(page, 'gwz-step3-code-linux-light');
      await page.keyboard.press('Escape');
      await api(page, 'PUT', `/api/v1/gateways/${GW.home}/platform`, { platform: 'synology' });

      // ── "Zugang erneuern" and "Statusseite im Heimnetz" (a gateway that knows the setup page) ──
      const tokenOf = (env) => (/^GC_API_TOKEN=(gc_gw_[0-9a-f]{64})$/m.exec(env || '') || [])[1] || '';
      const beat = (token) => page.request.post(BASE + '/api/v1/gateway/heartbeat', { headers: { Authorization: 'Bearer ' + token },
        data: { http_proxy_healthy: true, tcp_listeners: [], wg_handshake_age_s: 5, uptime_s: 60, hostname: 'nas',
          telemetry: { gateway_version: '1.35.0', capabilities: ['netwatch', 'inetq', 'presence', 'ups', 'setup-page'], lan_ip: '192.168.178.20' } } });
      // the file way above rotated the tokens once more: a fresh code, redeemed like the gateway does
      const fresh = await api(page, 'POST', `/api/v1/peers/${GW.home}/gateway-pairing-code`, {});
      const env3 = await (await page.request.post(BASE + '/api/v1/gateway/pair', { data: { code: fresh.body.code } })).json();
      const token3 = tokenOf(env3.envContent);
      step('the gateway reports in (heartbeat with the capability setup-page)', (await beat(token3)).status() === 200);
      await page.goto(BASE + `/gateways#gw/${GW.home}`);
      await page.reload();
      await until(page, () => document.querySelector('#gw-detail-view #gw-more-btn'));
      await page.click('#gw-more-btn');
      step('"Mehr" has "Zugang erneuern"', await until(page, () => !!document.querySelector('#gw-more-menu [data-act="gm-renew"]')));
      await page.click('#gw-more-menu [data-act="gm-renew"]');
      step('it asks first — the running gateway loses its connection', await until(page, () => {
        const d = document.querySelector('.zn-dialog'); return d && /e2e-gw-home/.test(d.textContent) && !!d.querySelector('.gcd-ok');
      }));
      step('before the answer nothing changed', (await beat(token3)).status() === 200);
      await theme(page, 'light');
      await shot(page, 'gwm-renew-confirm-light');
      await page.click('.zn-dialog .gcd-ok');
      step('then: server address and setup code with a countdown, the page of the gateway by its LAN address', await until(page, (srv) => {
        const d = document.querySelector('.gwm-renew');
        return d && document.getElementById('gwm-renew-server').textContent === srv && /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/.test(document.getElementById('gwm-renew-code').textContent)
          && /\d:\d\d/.test(document.getElementById('gwm-renew-left').textContent) && /http:\/\/192\.168\.178\.20:8642/.test(d.textContent);
      }, SERVER));
      const refused = await beat(token3);
      step('the old access is refused with invalid_token (the gateway then asks for the code)', refused.status() === 403 && (await refused.json()).error === 'invalid_token');
      await shot(page, 'gwm-renew-light');
      await theme(page, 'dark');
      await shot(page, 'gwm-renew-dark');
      await page.setViewportSize({ width: 390, height: 844 });
      const ovRenew = await overflow(page);
      step('390 px: the dialog fits', ovRenew <= 0, `overflow ${ovRenew}px`);
      await shot(page, 'gwm-renew-390-dark');
      await page.setViewportSize({ width: 1440, height: 1000 });
      const renewCode = await page.textContent('#gwm-renew-code');
      const env4 = await (await page.request.post(BASE + '/api/v1/gateway/pair', { data: { code: renewCode } })).json();
      const token4 = tokenOf(env4.envContent);
      step('the gateway redeems the code → the dialog says so, the new access works',
        await until(page, () => document.querySelector('.gwm-renew .gwz-wait.done'), null, 12000) && (await beat(token4)).status() === 200);
      await page.click('#gwm-renew-close');

      await page.goto(BASE + `/gateways#gw/${GW.home}/features`);
      step('tab "Funktionen": the switch "Statusseite im Heimnetz" is on, with the address in the home network', await until(page, () => {
        const r = document.querySelector('[data-feature="setuppage"]');
        const sw = r && r.querySelector('[data-fk="gwn-f-setuppage"]');
        return sw && !sw.disabled && sw.getAttribute('aria-checked') === 'true' && /192\.168\.178\.20:8642/.test(r.textContent);
      }, null, 12000));
      await page.$eval('[data-feature="setuppage"]', (n) => n.scrollIntoView({ block: 'center' }));
      await theme(page, 'light');
      await shot(page, 'gwn-setuppage-light', false);
      await page.click('[data-fk="gwn-f-setuppage"]');
      await until(page, () => { const sw = document.querySelector('[data-fk="gwn-f-setuppage"]'); return sw && sw.getAttribute('aria-checked') === 'false' && !sw.disabled; });
      const feat = await api(page, 'GET', `/api/v1/gateways/${GW.home}/features`);
      step('switched off → stored and delivered with the config pull', feat.body.gateway.features.setupPage.status === false);
      const cfg = await (await page.request.get(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token4 } })).json();
      step('config pull: features.setup_page.status = false', cfg.features && cfg.features.setup_page && cfg.features.setup_page.status === false);
      await api(page, 'PUT', `/api/v1/gateways/${GW.home}/features`, { setupPage: { status: true } });
      // an older gateway (no capability): the switch is greyed out with the hint
      await page.goto(BASE + `/gateways#gw/${GW.nas}/features`);
      step('older gateway: the switch is greyed out with a hint', await until(page, () => {
        const r = document.querySelector('[data-feature="setuppage"]');
        const sw = r && r.querySelector('[data-fk="gwn-f-setuppage"]');
        return sw && sw.disabled && !!r.querySelector('[data-setuppage-old]');
      }, null, 12000));
      await page.$eval('[data-feature="setuppage"]', (n) => n.scrollIntoView({ block: 'center' }));
      await shot(page, 'gwn-setuppage-old-light', false);
      ctx.allow((p) => p.kind === 'console' && /403|400/.test(p.text));

      // ── Peers page: devices only — no gateway checkbox and no gateway hint
      //    (docs/feature-peers-page.md; gateways are added here) ──
      await page.goto(BASE + '/peers');
      await page.click('#btn-add-peer');
      step('Peers › add: neither the gateway checkbox nor a gateway hint',
        await visible(page, '#add-peer-name') && await page.$('#add-peer-is-gateway') === null && await page.$('#add-peer-gateway-moved') === null);
      await page.keyboard.press('Escape');

      // ── 390 px ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + '/gateways#add');
      step('390 px: assistant opens from the address', await visible(page, '#gwz-overlay') && await stepShown(page, 1));
      await page.fill('#gwz-name', 'Mobil');
      await page.click('#gwz-overlay label.gwz-plat:has(input[value="rpi"])');
      await page.click('#gwz-next');
      await stepShown(page, 2);
      const ov = await overflow(page);
      step('390 px: no horizontal scrolling in step 2', ov <= 0, `overflow ${ov}px`);
      await theme(page, 'dark');
      await shot(page, 'gwz-step2-390-dark');
      await page.click('#gwz-overlay [data-gwz-close]');
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  };
};
