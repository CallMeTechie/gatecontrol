'use strict';

// Server part of the radio test plugin (tests/gateway_radio.test.js): gc.radio
// through its admin API (/api/v1/plugins/radio-demo/api/…).

module.exports = {
  async request(req, gc) {
    if (req.path === '/has') return { json: { ok: true, radio: !!gc.radio } };
    if (req.path === '/sensors') {
      try { return { json: { ok: true, result: await gc.radio.sensors() } }; } catch (e) { return { json: { ok: false, code: e.code || null } }; }
    }
    return { status: 404, json: { ok: false } };
  },
};
