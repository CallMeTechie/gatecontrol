'use strict';

// Pure helpers of the gateway tab "Funk" (phase 3c, step 2 — no DOM), shared by
// public/js/gateway-radio.js and tests/gateway_radio_kit.test.js.
//
//   zigbeeTone(state)          tag colour of a Zigbee state
//   zigbeeText(radio)          { key, params } of the status tag ("läuft · 14 Geräte")
//   bleTone(state)
//   valueParts(values)         [{ key, value, unit }] of a sensor's values, in a fixed order
//   sensorTags(values)         [{ tone, key, params }] — "Feuchte hoch", "Batterie 82 %", …
//   secondsLeft(iso, now)      seconds of the pairing window still open (0 when closed)
//   sinceMinutes(iso, now)
//   badge(d)                   { tone, key, params } of the tab badge, or null (d = the features overview)
//   rowSticks(sticks)          the names for "Gefunden: …" of the row "Funk"
//   smarthomeLink(kind, mac)   the deep link "In Smart Home benennen"
//   stackFor(stick)            'deconz' | 'zigbee2mqtt' | 'thread' | null — what fits a stick best
//   stickHint(stick, stack)    { key } of "Dieser Stick passt zu zigbee2mqtt" … or null
//   smallBoard(gateway)        Pi 3 / Zero (≤ 1 GB): hint before zigbee2mqtt / Thread (never a ban)
//   threadTone(state) / keyTone(keyState) / matterReady(thread) / validKey(text)
//   STICK_CHOICES              the choices per stick: auto (default) | zigbee | thread | none
//   stickHintKeys(row, stack)  the i18n keys of the hints of a row of "Funksticks" (stickPlan of the server)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayRadioKit = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const SMARTHOME = 'gatecontrol-smarthome';
  const MAC_RE = /^([0-9A-Fa-f]{2}:){5,7}[0-9A-Fa-f]{2}$/;

  function zigbeeTone(state) {
    if (state === 'running') return 'green';
    if (state === 'starting' || state === 'key_needed' || state === 'service_missing' || state === 'stick_missing') return 'amber';
    if (state === 'error') return 'red';
    return 'grey';
  }
  function zigbeeText(z) {
    const s = z && z.state;
    if (s === 'running') return Number.isInteger(z.devices) ? { key: z.devices === 1 ? 'gwr.zb.running_one' : 'gwr.zb.running_n', params: { n: z.devices } } : { key: 'gwr.zb.running', params: {} };
    return { key: 'gwr.zb.state.' + (s || 'off'), params: {} };
  }
  function bleTone(state) {
    if (state === 'running') return 'green';
    if (state === 'starting') return 'amber';
    if (state === 'error') return 'red';
    return 'grey';
  }

  const ORDER = [
    ['temperature', '°C', 1], ['humidity', '%', 0], ['pressure', 'hPa', 0], ['co2', 'ppm', 0], ['illuminance', 'lx', 0],
    ['moisture', '%', 0], ['pm25', 'µg/m³', 0], ['uv', 'UV', 1], ['power', 'W', 1],
  ];
  const FLAGS = ['window', 'door', 'opening', 'motion', 'occupancy', 'presence', 'moisture_wet', 'smoke', 'vibration', 'tamper'];

  /** The values of a sensor for one line: numbers first (fixed order), then flags that are set. */
  function valueParts(values) {
    const v = values && typeof values === 'object' ? values : {};
    const out = [];
    ORDER.forEach(([k, unit, digits]) => { if (typeof v[k] === 'number' && isFinite(v[k])) out.push({ key: k, value: v[k], unit, digits }); });
    FLAGS.forEach((k) => { if (typeof v[k] === 'boolean') out.push({ key: k, flag: v[k] }); });
    return out;
  }

  /** The small tags next to a sensor (warnings first). */
  function sensorTags(values) {
    const v = values && typeof values === 'object' ? values : {};
    const out = [];
    if (typeof v.humidity === 'number' && v.humidity >= 70) out.push({ tone: 'amber', key: 'gwr.ble.humid_high', params: {} });
    if (v.battery_low === true || (typeof v.battery === 'number' && v.battery < 15)) out.push({ tone: 'red', key: 'gwr.ble.battery_low', params: {} });
    else if (typeof v.battery === 'number') out.push({ tone: 'grey', key: 'gwr.ble.battery', params: { n: Math.round(v.battery) } });
    if (v.smoke === true || v.moisture_wet === true) out.push({ tone: 'red', key: v.smoke ? 'gwr.ble.smoke' : 'gwr.ble.wet', params: {} });
    return out;
  }

  function secondsLeft(iso, now) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return 0;
    return Math.max(0, Math.round((t - (now == null ? Date.now() : now)) / 1000));
  }
  function sinceMinutes(iso, now) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return null;
    return Math.max(0, Math.floor(((now == null ? Date.now() : now) - t) / 60000));
  }

  /** Tab badge from the features overview (d.radio): a problem, new sensors, else what runs. */
  function badge(d) {
    const r = d && d.radio;
    if (!r || !r.enabled || !r.state) return null;
    const s = r.state;
    if (s.zigbee === 'error' || s.ble === 'error' || s.zigbee === 'key_needed' || s.threadState === 'error') return { tone: 'red', key: 'gwr.tabs.problem', params: {} };
    if (r.sensors && r.sensors.fresh > 0 && r.ble) return { tone: 'amber', key: 'gwr.tabs.new', params: { n: r.sensors.fresh } };
    const n = (s.zigbee === 'running' && Number.isInteger(s.devices) ? s.devices : 0) + (r.ble && r.sensors ? r.sensors.accepted : 0);
    if (n > 0) return { tone: 'grey', key: 'gwr.tabs.count', params: { n } };
    return null;
  }

  /** "ConBee II (USB)", "RaspBee II (GPIO)", "Bluetooth (eingebaut)" … as { model, bus } for the row text. */
  function rowSticks(sticks) {
    return (Array.isArray(sticks) ? sticks : []).filter((s) => s && typeof s === 'object').map((s) => ({ model: s.model || null, bus: s.bus, kind: s.kind }));
  }

  /** /plugins/gatecontrol-smarthome?focus=<kind>:<mac> (docs/plugins.md "Radio sensors") or null. */
  function smarthomeLink(kind, mac) {
    if ((kind !== 'zigbee' && kind !== 'ble') || !MAC_RE.test(String(mac || ''))) return null;
    return '/plugins/' + SMARTHOME + '?focus=' + encodeURIComponent(kind + ':' + String(mac).toLowerCase());
  }

  /** What fits a stick: deCONZ for dresden elektronik, zigbee2mqtt for other Zigbee sticks, Thread for RCP-only ones. */
  function stackFor(s) {
    if (!s || typeof s !== 'object' || s.kind === 'bluetooth') return null;
    if (s.deconz) return 'deconz';
    if (s.z2m) return 'zigbee2mqtt';
    if (s.thread || s.kind === 'thread') return 'thread';
    return null;
  }

  /** The hint next to a stick for the chosen Zigbee stack (null when it fits). */
  function stickHint(s, stack) {
    const fit = stackFor(s);
    if (!fit) return null;
    if (fit === 'thread') return { key: 'gwr.stick.hint.thread_only' };
    if (stack === 'deconz' && !s.deconz) return { key: s.z2m ? 'gwr.stick.hint.use_z2m' : 'gwr.stick.hint.unsupported' };
    if (stack === 'zigbee2mqtt' && !s.z2m) return { key: 'gwr.stick.hint.unsupported' };
    return null;
  }

  /** A small board (≤ 1 GB, Pi 3 / Zero): zigbee2mqtt and the border router still run, but memory gets tight. */
  function smallBoard(g) {
    const mem = g && Number(g.memTotal);
    if (Number.isFinite(mem) && mem > 0 && mem <= 1.1 * 1024 ** 3) return true;
    return /raspberry pi (3|zero)/i.test(String((g && g.model) || ''));
  }

  function threadTone(state) {
    if (state === 'running') return 'green';
    if (state === 'starting' || state === 'stick_busy' || state === 'stick_missing' || state === 'no_network' || state === 'detached' || state === 'service_missing' || state === 'no_lan') return 'amber';
    if (state === 'error') return 'red';
    return 'grey';
  }
  function keyTone(k) { return k === 'ok' ? 'green' : (k === 'wrong_key' ? 'red' : (k === 'no_key' || k === 'unsupported' ? 'amber' : 'grey')); }
  /** Ready for Matter over Thread: the network runs and the host forwards IPv6 into the LAN. */
  function matterReady(th) { return !!(th && th.state === 'running' && th.forwarding === true); }
  /** 32 hex digits, with or without colons/spaces (BTHome key, Xiaomi bindkey). */
  function validKey(v) { return /^[0-9a-f]{32}$/.test(String(v || '').toLowerCase().replace(/[\s:-]/g, '')); }

  const STICK_CHOICES = ['auto', 'zigbee', 'thread', 'none'];
  const STICK_HINTS = ['missing', 'second', 'radio_off', 'fit', 'no_adapter', 'firmware', 'port'];
  /** Hints of a stick set by hand (hints, never bans): 'fit' says which service it does not fit. */
  function stickHintKeys(row, stack) {
    const out = [];
    for (const h of (row && Array.isArray(row.hints) ? row.hints : [])) {
      if (!STICK_HINTS.includes(h)) continue;
      let key = 'gwr.stick.hint.' + h;
      if (h === 'fit') key = row.choice === 'thread' ? 'gwr.stick.hint.fit_thread' : (stack === 'zigbee2mqtt' ? 'gwr.stick.hint.fit_zigbee' : 'gwr.stick.hint.fit_deconz');
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }

  return { zigbeeTone, zigbeeText, bleTone, valueParts, sensorTags, secondsLeft, sinceMinutes, badge, rowSticks, smarthomeLink, stackFor, stickHint, smallBoard, threadTone, keyTone, matterReady, validKey,
    stickHintKeys, STICK_CHOICES, SMARTHOME };
});
