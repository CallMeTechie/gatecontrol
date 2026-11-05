'use strict';

// Server part of the presence test plugin (tests/gateway_presence.test.js):
// exercises gc.homeNetwork.presence through its admin API
// (/api/v1/plugins/presence-demo/api/…) and records the events of on().

const events = [];
let later = null;

async function attempt(fn) {
  try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, code: e.code || null, error: e.message }; }
}

module.exports = {
  async start(gc) {
    if (gc.homeNetwork) gc.homeNetwork.presence.on((ev) => { events.push(ev); });
  },

  async request(req, gc) {
    const b = req.body || {};
    const q = req.query || {};
    const P = gc.homeNetwork ? gc.homeNetwork.presence : null;
    switch (req.path) {
      case '/has': return { json: { ok: true, homeNetwork: !!gc.homeNetwork } };
      case '/list': return { json: await attempt(() => P.list()) };
      case '/consent':
        if (req.method === 'GET') return { json: await attempt(() => (q.set ? P.setConsent(Number(q.userId), q.set === '1') : P.consent(Number(q.userId)))) };
        return { json: await attempt(() => P.setConsent(b.userId, b.enabled)) };
      case '/devices': return { json: await attempt(() => P.devices(Number(b.userId != null ? b.userId : q.userId))) };
      case '/counts': return { json: await attempt(() => P.setCounts(b.userId, b.deviceId, b.counts)) };
      case '/later':
        // outside of any request of the person: a moment after the answer
        later = null;
        setTimeout(() => { attempt(() => P.setConsent(b.userId, true)).then((r) => { later = r; }); }, 50);
        return { json: { ok: true } };
      case '/later-result': return { json: { ok: true, result: later } };
      case '/events': return { json: { ok: true, events } };
      default: return { status: 404, json: { ok: false } };
    }
  },
};
