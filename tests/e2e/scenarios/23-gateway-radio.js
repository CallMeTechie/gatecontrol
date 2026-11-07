'use strict';

// Gateways › detail › tab "Funk" (public/js/gateway-radio.js, phase 3c step 2)
// and the row "Funk (Zigbee, Bluetooth, Thread)" in "Geräte im Heimnetz".
//
// No mocks: the seeded gateway "e2e-gw-home" gets a known gateway token and
// reports like a real gateway — first as 1.24.0 without the capability
// `radio` ("Gateway zu alt – ab 1.25.0"), then as 1.25.0 with a ConBee II
// (deCONZ running, 14 devices, a device just paired), a ZBT-1 (Thread: "kommt
// später") and built-in Bluetooth. Bluetooth is switched on with a real PUT,
// the gateway reports two sensors, one is taken over with a name ("Übernehmen")
// and then shows its values. Light/dark, 390 px without sideways scroll.
// Then the follow-ups as a gateway with the capability radio-stacks: "zigbee2mqtt" chosen with
// a real click (MQTT off → "Edge und MQTT einschalten", a real PUT), the
// devices it reports, Thread switched on with the border router running
// (network data, IPv6 hint, Matter readiness), an encrypted Bluetooth sensor
// taken over together with its key (the config pull names only the stand, the
// gateway gets the key from /radio/ble/keys).

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

const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'storage', 'timezone', 'print'];

function radioTel(now, ble) {
  return {
    enabled: true,
    sticks: [{ kind: 'zigbee', model: 'ConBee II', bus: 'usb', tty: 'ttyACM0', deconz: true }, { kind: 'multi', model: 'Home Assistant Connect ZBT-1', bus: 'usb', tty: 'ttyUSB0', deconz: false },
      { kind: 'bluetooth', model: null, bus: 'builtin', tty: 'hci0', deconz: false }],
    zigbee: { mode: 'auto', want: true, service: 'managed', state: 'running', model: 'ConBee II', device: 'ttyACM0', firmware: '0x26780700', channel: 15, devices: 14, permitUntil: null,
      recent: [{ mac: '00:15:8d:00:0a:0b:0c:0d', type: 'sensor', name: 'Temperature 9', model: 'Aqara Temperatursensor', manufacturer: 'LUMI', at: new Date(now).toISOString() }], error: null },
    ble: { enabled: !!ble, state: ble ? 'running' : 'off', mode: ble ? 'legacy' : null, adapter: { name: 'hci0', bus: 'builtin', model: null }, sensors: ble ? 2 : 0, lastAt: null, error: null },
    thread: { sticks: 1, models: ['Home Assistant Connect ZBT-1'], otbr: false },
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
  const fresh = (page) => page.evaluate(() => {
    for (const k of ['GCGatewayHome', 'GCGatewayNet']) {
      const c = window[k] && window[k]._cache;
      if (c) Object.keys(c).forEach((x) => { Object.keys(c[x]).forEach((y) => delete c[x][y]); });
    }
    const r = window.GCGatewayRadio && window.GCGatewayRadio._cache;
    if (r) Object.keys(r).forEach((x) => delete r[x]);
  });
  const view = async (page, name, height) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: height || 1500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await shot(page, name, false);
    await page.setViewportSize(vp);
  };
  const row = '.gwn-features [data-feature="radio"]';

  return {
    async gatewayradio(page) {
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
        db.prepare('DELETE FROM gateway_ble_sensors WHERE peer_id = ?').run(GW);
        db.prepare('DELETE FROM gateway_zigbee_devices WHERE peer_id = ?').run(GW);
        const e = db.prepare('SELECT edge_enabled, mqtt_enabled FROM gateway_edge WHERE peer_id = ?').get(GW);
        return r ? { ...r, features: f ? f.settings : null, edge: e || null } : null;
      });
      step('radio: seeded gateway prepared with a known token', !!(old && old.api_token_hash));
      const gw = async (p, body) => (await page.request.fetch(BASE + '/api/v1/gateway' + p, { method: 'POST', data: body, headers: { Authorization: 'Bearer ' + token } })).status();
      const heartbeat = (version, caps, radio) => gw('/heartbeat', { uptime_s: 3600, telemetry: {
        gateway_version: version, node_version: 'v20.19.0', cpu_cores: 4, mem_total: 4 * 1024 ** 3, mem_used: 1024 ** 3,
        hardware: { model: 'Raspberry Pi 4 Model B Rev 1.4', cpu_cores: 4, mem_total: 4 * 1024 ** 3, storage: { total: 64e9, free: 40e9 }, radios: [], platform: 'rpi-image', image_version: version },
        lan_ip: '192.168.1.23', default_gateway_ip: '192.168.1.1', state_dir_writable: true, capabilities: caps,
        features: radio ? { radio } : {},
      } });
      await page.goto(BASE + '/gateways');
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('radio: page in German for the run', langSet.status === 200, 'status ' + langSet.status);
      try {
        // ── an older gateway: no capability `radio` ──
        step('radio: heartbeat of a 1.24.0 gateway (no capability radio)', await heartbeat('1.24.0', CAPS, null) === 200);
        await page.goto(`${BASE}/gateways#gw/${GW}/features`);
        await page.reload();
        await theme(page, 'dark');
        await goTab(page, GW, 'features');
        step('radio: the row "Funk (Zigbee, Bluetooth, Thread)" in "Geräte im Heimnetz", after "Drucken & Scannen", "Kameras" and "Lokale KI"', await until(page, () => {
          const g = document.querySelector('[data-fgroup="devices"]');
          if (!g) return false;
          const keys = [...g.querySelectorAll('[data-feature]')].map((x) => x.getAttribute('data-feature'));
          // phase 3c, step 4: the row "Kameras" sits between printing and the local AI
          const prev = keys.indexOf('cameras') >= 0 ? 'cameras' : 'print';
          return keys.indexOf('radio') === keys.indexOf('ai') + 1 && keys.indexOf('ai') === keys.indexOf(prev) + 1 && /Funk \(Zigbee, Bluetooth, Thread\)/.test(g.textContent)
            && !document.querySelector('[data-fgroup="ext"] [data-feature="zigbee"]');
        }));
        step('radio: too old → "Gateway zu alt – ab 1.25.0", switch disabled', await page.evaluate((sel) => {
          const r = document.querySelector(sel);
          const sw = r && r.querySelector('[role="switch"]');
          const hint = r && r.querySelector('[data-radio-old]');
          return !!sw && sw.disabled && !!hint && /Gateway zu alt – ab 1\.25\.0/.test(hint.textContent);
        }, row));
        step('radio: the row links to the user guide (chapter 5)', await page.evaluate((sel) => {
          const a = document.querySelector(sel + ' a[data-guide="feat.radio"]');
          return !!a && /05-funktionen\.md#funk-zigbee-bluetooth-thread$/.test(a.href);
        }, row));
        step('radio: the tab "Funk" sits between "Zwischenspeicher" and "Edge-Plugins"', await page.evaluate(() => {
          const ids = [...document.querySelectorAll('.gwe-tabs [data-tab]')].map((b) => b.getAttribute('data-tab'));
          return ids.indexOf('radio') === ids.indexOf('cache') + 1 && ids.indexOf('edge') === ids.indexOf('radio') + 1
            && /Funk/.test(document.getElementById('gwe-tab-radio').textContent);
        }));
        await goTab(page, GW, 'radio');
        step('radio: tab of an old gateway says what it needs', await until(page, () => /Funk braucht Gateway 1\.25\.0/.test(document.getElementById('gwe-tabpanel').textContent)));

        // ── 1.25.0 with radio: ConBee running, ZBT-1, built-in Bluetooth ──
        step('radio: heartbeat of a 1.25.0 gateway with radio', await heartbeat('1.25.0', [...CAPS, 'radio'], radioTel(Date.now(), false)) === 200);
        await fresh(page);
        await page.reload();
        await goTab(page, GW, 'radio');
        step('radio: Zigbee "läuft · 14 Geräte", ConBee II (USB) · Firmware · Kanal 15, Anlernen', await until(page, () => {
          const c = document.querySelector('[data-radio="zigbee"]');
          if (!c) return false;
          const st = c.querySelector('[data-radio-state]');
          return st && st.getAttribute('data-radio-state') === 'running' && /läuft · 14 Geräte/.test(st.textContent)
            && /ConBee II \(USB\) · Firmware 26780700 · Kanal 15/.test(c.textContent) && /Anlernen starten/.test(c.textContent)
            && c.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true';
        }, null, 20000));
        step('radio: the device just paired, with the way to Smart Home', await page.evaluate(() => {
          const r = document.querySelector('[data-radio-recent="00:15:8d:00:0a:0b:0c:0d"]');
          return !!r && /neu/.test(r.textContent) && /Aqara Temperatursensor/.test(r.textContent) && /gerade eben angelernt/.test(r.textContent) && !!r.querySelector('a, button');
        }));
        step('radio: Thread on a 1.25.0 gateway: "Gateway-Update nötig" with the ZBT-1', await page.evaluate(() => {
          const c = document.querySelector('[data-radio="thread"]');
          return !!c && /Gateway-Update nötig/.test(c.textContent) && /Home Assistant Connect ZBT-1/.test(c.textContent) && /nach 1\.31\.0/.test(c.textContent);
        }));
        step('radio: zigbee2mqtt needs a newer gateway (choice disabled, hint)', await page.evaluate(() => {
          const b = document.querySelector('[data-radio="zigbee"] [data-stack="zigbee2mqtt"]');
          return !!b && b.disabled && !!document.querySelector('[data-radio-stack-old]');
        }));
        // Bluetooth on (real PUT)
        await page.click('[data-radio="ble"] [role="switch"]');
        step('radio: Bluetooth switched on (real PUT)', await until(page, () => {
          const sw = document.querySelector('[data-radio="ble"] [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'true';
        }));
        const cfg = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('radio: the config pull carries features.radio', !!(cfg.features && cfg.features.radio && cfg.features.radio.ble === true && cfg.features.radio.zigbee === null));
        const now = Date.now();
        step('radio: heartbeat with Bluetooth running', await heartbeat('1.25.0', [...CAPS, 'radio'], radioTel(now, true)) === 200);
        step('radio: the gateway reports two Bluetooth sensors', await gw('/radio/ble', { scannedAt: new Date(now).toISOString(), adapter: { name: 'hci0', bus: 'builtin' }, sensors: [
          { mac: '7C:C6:B6:00:11:22', format: 'bthome', encrypted: false, name: 'SBHT-003C', values: { battery: 100, humidity: 71, temperature: 14.2 }, rssi: -60, firstSeen: new Date(now - 600000).toISOString(), seenAt: new Date(now).toISOString() },
          { mac: 'A4:C1:38:11:22:33', format: 'pvvx', encrypted: false, name: null, values: { temperature: 8.9, humidity: 64, battery: 82 }, rssi: -75, firstSeen: new Date(now - 120000).toISOString(), seenAt: new Date(now).toISOString() },
        ] }) === 200);
        await fresh(page);
        await page.reload();
        await goTab(page, GW, 'radio');
        step('radio: unknown sensors with "Übernehmen"', await until(page, () => {
          const r = document.querySelector('[data-radio-sensor="A4:C1:38:11:22:33"]');
          return !!r && /unbekannt · A4:C1:38:…/.test(r.textContent) && /sendet seit 2 Min\./.test(r.textContent) && /Übernehmen/.test(r.textContent);
        }, null, 20000));
        await page.click('[data-radio-sensor="A4:C1:38:11:22:33"] button');
        await page.fill('#gwr-sname', 'Gartenhaus');
        await page.click('[data-fk="gwr-sname-ok"]');
        step('radio: taken over → name, values "8,9 °C · 64 %", "Batterie 82 %"', await until(page, () => {
          const r = document.querySelector('[data-radio-sensor="A4:C1:38:11:22:33"]');
          return !!r && /Gartenhaus/.test(r.textContent) && /8,9 °C · 64 %/.test(r.textContent) && /Batterie 82 %/.test(r.textContent) && !/Übernehmen/.test(r.textContent);
        }, null, 20000));
        step('radio: Bluetooth "1 Sensor", eingebaut im Pi', await page.evaluate(() => {
          const c = document.querySelector('[data-radio="ble"]');
          return !!c && /1 Sensor/.test(c.querySelector('[data-radio-state]').textContent) && /eingebaut im Pi · hört nur zu/.test(c.textContent);
        }));
        step('radio: the tab badge says what is new', await until(page, () => /neu/.test((document.querySelector('#gwe-tab-radio .gwe-tab-badge') || {}).textContent || '')));
        await view(page, 'gwradio-dark');
        await theme(page, 'light');
        await view(page, 'gwradio-light');
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o = await overflow(page);
        step('radio: 390 px, tab Funk: no sideways scroll', o <= 0, 'overflow ' + o);
        await view(page, 'gwradio-390-light', 2600);
        await page.setViewportSize({ width: 1440, height: 1000 });
        // the row in "Funktionen": found sticks, on, memory
        await goTab(page, GW, 'features');
        step('radio: the row names the sticks, is on and shows the memory', await until(page, (sel) => {
          const r = document.querySelector(sel);
          const f = r && r.querySelector('[data-radio-found]');
          return !!f && /ConBee II \(USB\)/.test(f.textContent) && r.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true' && !!r.querySelector('.gwn-fr-mem');
        }, row));
        await view(page, 'gwradio-features-light');
        await theme(page, 'dark');

        // ── follow-ups: a gateway with radio-stacks (zigbee2mqtt, Thread, keys) ──
        const NEW = '1.32.0';
        const z2mTel = (state, extra = {}) => ({
          ...radioTel(Date.now(), true),
          stack: 'zigbee2mqtt',
          sticks: [{ kind: 'multi', model: 'Sonoff ZBDongle-E', bus: 'usb', tty: 'ttyACM1', deconz: false, z2m: 'ember', thread: true, use: state === 'off' ? null : 'zigbee2mqtt' },
            { kind: 'multi', model: 'Home Assistant Connect ZBT-1', bus: 'usb', tty: 'ttyUSB0', deconz: false, z2m: 'ember', thread: true, use: extra.thread ? 'thread' : null },
            { kind: 'bluetooth', model: null, bus: 'builtin', tty: 'hci0', deconz: false, z2m: null, thread: false, use: null }],
          zigbee: { stack: 'zigbee2mqtt', mode: 'off', want: false, service: 'managed', state: 'off', recent: [], error: null },
          zigbee2mqtt: { want: true, service: 'managed', state, broker: state === 'mqtt_off' ? 'mqtt_off' : 'ok', model: 'Sonoff ZBDongle-E', device: 'ttyACM1', adapter: 'ember',
            version: '2.14.2', firmware: '7.4.4.0', channel: 15, devices: state === 'running' ? 3 : null, permitUntil: null, recent: [], error: null },
          thread: extra.thread
            ? { sticks: 2, models: ['Sonoff ZBDongle-E', 'Home Assistant Connect ZBT-1'], otbr: true, want: true, service: 'managed', state: 'running', role: 'leader', model: 'Home Assistant Connect ZBT-1',
              device: 'ttyUSB0', infra: 'eth0', network: { name: 'GateControl', channel: 25, panId: 4660, extPanId: 'dead00beef00cafe' }, routers: 1, forwarding: false, error: null }
            : { sticks: 2, models: ['Sonoff ZBDongle-E', 'Home Assistant Connect ZBT-1'], otbr: false, want: false, service: 'missing', state: 'off', role: null, network: null, error: null },
        });
        step('radio: heartbeat of a gateway with the capability radio-stacks', await heartbeat(NEW, [...CAPS, 'radio', 'radio-stacks'], z2mTel('off')) === 200);
        await fresh(page);
        await page.reload();
        await goTab(page, GW, 'radio');
        step('radio: the Zigbee service can be chosen: deCONZ | zigbee2mqtt', await until(page, () => {
          const b = document.querySelector('[data-radio="zigbee"] [data-stack="zigbee2mqtt"]');
          return !!b && !b.disabled && document.querySelector('[data-radio="zigbee"] [data-stack="deconz"]').getAttribute('aria-pressed') === 'true';
        }, null, 20000));
        step('radio: the stick list says what fits ("passt zu zigbee2mqtt", one stick one radio)', await page.evaluate(() => {
          const l = document.querySelector('[data-radio-sticks]');
          return !!l && /Sonoff ZBDongle-E \(USB\)/.test(l.textContent) && /passt zu zigbee2mqtt/.test(l.textContent) && /Ein Stick bedient immer nur einen Funk/.test(l.parentNode.textContent);
        }));
        await page.click('[data-radio="zigbee"] [data-stack="zigbee2mqtt"]');
        step('radio: zigbee2mqtt chosen (real PUT) → config pull with stack', await until(page, () => {
          const b = document.querySelector('[data-radio="zigbee"] [data-stack="zigbee2mqtt"]');
          return !!b && b.getAttribute('aria-pressed') === 'true';
        }, null, 15000) && (await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json()).features.radio.stack === 'zigbee2mqtt');
        step('radio: heartbeat: zigbee2mqtt waits for MQTT', await heartbeat(NEW, [...CAPS, 'radio', 'radio-stacks'], z2mTel('mqtt_off')) === 200);
        await fresh(page);
        await page.reload();
        await goTab(page, GW, 'radio');
        step('radio: "MQTT aus" with "Edge und MQTT einschalten"', await until(page, () => {
          const c = document.querySelector('[data-radio="zigbee"]');
          return !!c && c.querySelector('[data-radio-state]').getAttribute('data-radio-state') === 'mqtt_off' && !!c.querySelector('[data-radio-mqtt-off]') && /Edge und MQTT einschalten/.test(c.textContent);
        }, null, 20000));
        await page.click('[data-fk="gwr-mqtt-on"]');
        const edgeOn = await until(page, () => !document.querySelector('[data-radio-mqtt-off]') || /eingeschaltet/.test(document.body.textContent), null, 15000);
        const es = withDb((db) => db.prepare('SELECT edge_enabled, mqtt_enabled FROM gateway_edge WHERE peer_id = ?').get(GW));
        step('radio: edge and MQTT switched on (real PUT)', edgeOn && !!es && es.edge_enabled === 1 && es.mqtt_enabled === 1, JSON.stringify(es));
        // zigbee2mqtt runs, reports its devices; Thread switched on and running
        step('radio: heartbeat: zigbee2mqtt running', await heartbeat(NEW, [...CAPS, 'radio', 'radio-stacks'], z2mTel('running')) === 200);
        const seen = new Date().toISOString();
        step('radio: the gateway reports its zigbee2mqtt devices', await gw('/radio/zigbee', { stack: 'zigbee2mqtt', devices: [
          { ieee: '00:17:88:01:0b:2c:3d:4e', name: 'Wohnzimmer Decke', model: '9290012573A', vendor: 'Philips', kind: 'light', caps: { bri: true, ct: true, color: 'xy' }, values: { on: true, bri: 50 }, type: 'router', supported: true, interview: 'done', seenAt: seen },
          { ieee: '00:0d:6f:ff:fe:1a:2b:3c', name: 'Steckdose Kaffee', model: 'E1603', vendor: 'IKEA', kind: 'plug', caps: {}, values: { on: false }, type: 'router', supported: true, interview: 'done', seenAt: seen },
          { ieee: '00:15:8d:00:01:a2:b3:c4', name: 'Bad Klima', model: 'WSDCGQ11LM', vendor: 'Aqara', kind: 'sensor', caps: { battery: true }, values: { temperature: 21.4, humidity: 55, battery: 100 }, type: 'end_device', power: 'Battery', supported: true, interview: 'done', seenAt: seen },
        ] }) === 200);
        await fresh(page);
        await page.reload();
        await goTab(page, GW, 'radio');
        step('radio: zigbee2mqtt "läuft · 3 Geräte", the devices with values and "Entfernen"', await until(page, () => {
          const c = document.querySelector('[data-radio="zigbee"]');
          if (!c) return false;
          const st = c.querySelector('[data-radio-state]');
          const bulb = c.querySelector('[data-radio-device="00:17:88:01:0b:2c:3d:4e"]');
          const klima = c.querySelector('[data-radio-device="00:15:8d:00:01:a2:b3:c4"]');
          return st.getAttribute('data-radio-state') === 'running' && /läuft · 3 Geräte/.test(st.textContent) && /zigbee2mqtt 2\.14\.2/.test(c.textContent)
            && !!bulb && /Wohnzimmer Decke/.test(bulb.textContent) && /an 50 %/.test(bulb.textContent) && /Entfernen/.test(bulb.textContent)
            && !!klima && /21,4 °C · 55 %/.test(klima.textContent) && /Anlernen starten/.test(c.textContent);
        }, null, 20000));
        await page.click('[data-radio="thread"] [role="switch"]');
        step('radio: Thread switched on (real PUT)', await until(page, () => {
          const sw = document.querySelector('[data-radio="thread"] [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'true';
        }, null, 15000));
        const cfg2 = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('radio: the config pull carries thread', cfg2.features.radio.thread === true, JSON.stringify(cfg2.features.radio));
        step('radio: heartbeat: border router running', await heartbeat(NEW, [...CAPS, 'radio', 'radio-stacks'], z2mTel('running', { thread: true })) === 200);
        // an encrypted Bluetooth sensor (BTHome with key)
        const n2 = Date.now();
        step('radio: the gateway reports an encrypted sensor without a key', await gw('/radio/ble', { scannedAt: new Date(n2).toISOString(), adapter: { name: 'hci0', bus: 'builtin' }, sensors: [
          { mac: '54:48:E6:8F:80:A5', format: 'bthome', encrypted: true, keyState: 'no_key', name: 'SBHT-003C', values: {}, rssi: -60, firstSeen: new Date(n2 - 300000).toISOString(), seenAt: new Date(n2).toISOString() },
        ] }) === 200);
        await fresh(page);
        await page.reload();
        await goTab(page, GW, 'radio');
        step('radio: Thread "läuft · Leader", network data, IPv6 hint, Matter not ready yet', await until(page, () => {
          const c = document.querySelector('[data-radio="thread"]');
          return !!c && /läuft · Leader/.test(c.querySelector('[data-radio-state]').textContent) && /Netz „GateControl“ · Kanal 25 · PAN 0x1234/.test(c.textContent)
            && !!c.querySelector('[data-radio-forwarding]') && c.querySelector('[data-radio-matter]').getAttribute('data-radio-matter') === 'not_ready' && /Datensatz anzeigen/.test(c.textContent);
        }, null, 20000));
        step('radio: the encrypted sensor says "verschlüsselt – Schlüssel fehlt"', await page.evaluate(() => {
          const r = document.querySelector('[data-radio-sensor="54:48:E6:8F:80:A5"]');
          return !!r && /verschlüsselt – Schlüssel fehlt/.test(r.textContent);
        }));
        await page.click('[data-radio-sensor="54:48:E6:8F:80:A5"] button');
        await page.fill('#gwr-sname', 'Bad oben');
        await page.fill('#gwr-skey', 'zu kurz');
        await page.click('[data-fk="gwr-sname-ok"]');
        const refused = await until(page, () => /Der Schlüssel hat 32 Zeichen/.test(document.body.textContent));
        step('radio: a key that is no key is refused in the dialog', refused, refused ? '' : await page.evaluate(() => JSON.stringify({ errs: [...document.querySelectorAll('.gwe-err')].map((e) => [e.hidden, e.textContent]), keys: document.querySelectorAll('#gwr-skey').length, oks: document.querySelectorAll('[data-fk="gwr-sname-ok"]').length })));
        await page.fill('#gwr-skey', '23:1D:39:C1:D7:CC:1A:B1:AE:E2:24:CD:09:6D:B9:32');
        await page.click('[data-fk="gwr-sname-ok"]');
        step('radio: taken over with the key → "Schlüssel gespeichert – wartet auf das nächste Paket"', await until(page, () => {
          const r = document.querySelector('[data-radio-sensor="54:48:E6:8F:80:A5"]');
          return !!r && /Bad oben/.test(r.textContent) && /Schlüssel gespeichert/.test(r.textContent) && /Schlüssel ändern/.test(r.textContent);
        }, null, 20000));
        const cfg3 = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        const keys = await (await page.request.fetch(BASE + '/api/v1/gateway/radio/ble/keys', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('radio: config pull names only the stand; the gateway gets the key separately', /^[0-9a-f]{32}$/.test(cfg3.features.radio.bleKeys || '') && !/231d39c1/.test(JSON.stringify(cfg3))
          && keys.keys && keys.keys['54:48:E6:8F:80:A5'] === '231d39c1d7cc1ab1aee224cd096db932', JSON.stringify(cfg3.features.radio));
        await view(page, 'gwradio-z2m-thread-dark', 2400);
        await theme(page, 'light');
        await view(page, 'gwradio-z2m-thread-light', 2400);
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o2 = await overflow(page);
        step('radio: 390 px with zigbee2mqtt and Thread: no sideways scroll', o2 <= 0, 'overflow ' + o2);
        await view(page, 'gwradio-z2m-390-light', 3600);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await theme(page, 'dark');
      } finally {
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        withDb((db) => {
          if (old) {
            db.prepare('UPDATE gateway_meta SET api_token_hash = ?, last_health = ?, last_seen_at = ?, first_seen_at = ?, alive = ? WHERE peer_id = ?')
              .run(old.api_token_hash, old.last_health, old.last_seen_at, old.first_seen_at, old.alive, GW);
            if (old.features) db.prepare('UPDATE gateway_features SET settings = ? WHERE peer_id = ?').run(old.features, GW);
            else db.prepare('DELETE FROM gateway_features WHERE peer_id = ?').run(GW);
          }
          db.prepare('DELETE FROM gateway_ble_sensors WHERE peer_id = ?').run(GW);
          db.prepare('DELETE FROM gateway_zigbee_devices WHERE peer_id = ?').run(GW);
          if (old && old.edge) db.prepare('UPDATE gateway_edge SET edge_enabled = ?, mqtt_enabled = ? WHERE peer_id = ?').run(old.edge.edge_enabled, old.edge.mqtt_enabled, GW);
          else db.prepare('DELETE FROM gateway_edge WHERE peer_id = ?').run(GW);
        });
      }
    },
  };
};
