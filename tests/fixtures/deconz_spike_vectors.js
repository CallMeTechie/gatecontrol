'use strict';
// Echte deCONZ-Response-Samples aus Task-0-Live-Spike (Phoscon 2.24.2).
// Beleg: docs/superpowers/specs/2026-06-30-smarthome-tp3-spike.md.
module.exports = {
  // POST /rules Erfolgs-Envelope.
  createRuleSuccess: [{ success: { id: '21' } }],
  // POST /schedules bzw. POST /sensors (CLIP) Erfolgs-Envelope.
  createScheduleSuccess: [{ success: { id: '1' } }],
  createClipSuccess: [{ success: { id: '21' } }],
  setClipStateSuccess: [{ success: { '/sensors/21/state/flag': true } }],
  // DELETE nicht-existent → idempotent zu ignorieren (Client-Code DECONZ_HTTP_404).
  deleteMissing: { status: 404, body: [{ error: { address: '/rules/21', description: 'resource, /rules/21, not available', type: 3 } }] },
  // Regellimit: nicht live provoziert; defensive Repräsentation der 200-Body-Error-Form.
  ruleLimitError: { status: 503, body: [{ error: { type: 601, address: '/rules', description: 'rule limit reached' } }] },

  // Echter ZHASwitch (RWL021, /sensors/19) — modelid → buttonCode-Formel (button*1000+offset).
  zhaSwitchSample: {
    id: '19', type: 'ZHASwitch', modelid: 'RWL021', manufacturername: 'Philips', name: 'Schalter Wohnzimmer',
    state: { buttonevent: 4002, eventduration: 0, lastupdated: '2026-05-14T02:11:35.744' },
  },
  // Aqara-Einzeltaste (lumi.sensor_switch, /sensors/16) — hat nativen Doppelklick.
  zhaSwitchAqaraSample: {
    id: '16', type: 'ZHASwitch', modelid: 'lumi.sensor_switch', name: 'Smart Switch',
    state: { buttonevent: 1001, lastupdated: '2023-02-11T17:12:04.559' },
  },

  // Echter Daylight-Sensor (/sensors/1) — Feld `daylight` (bool) treibt sunrise/sunset.
  daylightSample: {
    id: '1', type: 'Daylight', modelid: 'PHDL00', name: 'Daylight',
    state: { dark: false, daylight: true, status: 160, sunrise: '2026-07-01T03:25:21', sunset: '2026-07-01T19:41:36', lastupdated: '2026-07-01T04:16:39.342' },
    config: { configured: true, on: true, sunriseoffset: 30, sunsetoffset: -30 },
  },

  // GET /schedules/:id — command.address trägt /api/<apiKey>-Präfix (Wire-Format-Fund Step 4).
  scheduleGetSample: {
    activation: 'start', autodelete: false, status: 'disabled', time: 'PT00:05:00',
    command: { address: '/api/4BD54DF895/sensors/21/state', body: { flag: false }, method: 'PUT' },
  },
};
