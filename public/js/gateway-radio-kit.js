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
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayRadioKit = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const SMARTHOME = 'gatecontrol-smarthome';
  const MAC_RE = /^([0-9A-Fa-f]{2}:){5,7}[0-9A-Fa-f]{2}$/;

  function zigbeeTone(state) {
    if (state === 'running') return 'green';
    if (state === 'starting' || state === 'key_needed' || state === 'service_missing') return 'amber';
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
    if (s.zigbee === 'error' || s.ble === 'error' || s.zigbee === 'key_needed') return { tone: 'red', key: 'gwr.tabs.problem', params: {} };
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

  return { zigbeeTone, zigbeeText, bleTone, valueParts, sensorTags, secondsLeft, sinceMinutes, badge, rowSticks, smarthomeLink, SMARTHOME };
});
