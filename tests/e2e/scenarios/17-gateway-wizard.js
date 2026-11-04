'use strict';

// Gateways › "Gateway hinzufügen" (docs/feature-gateway-wizard.md): the
// waiting cards of the seeded gateways (never reported), the assistant for a
// Raspberry Pi (field checks, licence refusal from the real API, creation,
// gatecontrol-setup.zip built in the browser — downloaded, unpacked, checked),
// the live status (first a real, then a mocked "connected" status with
// hardware + RaspBee II), "Fertig" → detail view; "Einrichtung fortsetzen"
// on an older gateway → platform Synology → the real package from the server
// (unpacked, checked); the Peers page points to the assistant; Escape,
// keyboard, light/dark and 390 px.
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
        await stepShown(page, 1) && await page.$eval('#gwz-name', (n) => n.disabled && n.value === 'e2e-gw-home') && await visible(page, '#gwz-created-note'));
      await page.click('#gwz-overlay label.gwz-plat:has(input[value="synology"])');
      await page.click('#gwz-next');
      step('platform stored → Synology instructions (step 3)', await stepShown(page, 3, 'synology'));
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
      await page.keyboard.press('Escape');
      step('Escape closes the assistant and clears the address',
        await until(page, () => document.getElementById('gwz-overlay').style.display !== 'flex' && !/#(add|setup)/.test(location.hash)));

      // ── Peers page: no gateway checkbox, a pointer to the assistant ──
      await page.goto(BASE + '/peers');
      await page.click('#btn-add-peer');
      step('Peers › add: hint + link to /gateways#add instead of the gateway checkbox',
        await visible(page, '#add-peer-gateway-moved') && await page.$('#add-peer-is-gateway') === null
        && (await page.getAttribute('#add-peer-gateway-moved a', 'href')) === '/gateways#add');
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
