'use strict';

// Server part of the home network test plugin (tests/gateway_home_plugins.test.js):
// exercises gc.homeNetwork.internet and gc.homeCache through its admin API
// (/api/v1/plugins/home-demo/api/…). Never sees a MAC address.

let later = null;

async function attempt(fn) {
  try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, code: e.code || null, error: e.message }; }
}

module.exports = {
  async request(req, gc) {
    const b = req.body || {};
    const q = req.query || {};
    const I = gc.homeNetwork && gc.homeNetwork.internet;
    const C = gc.homeCache;
    switch (req.path) {
      case '/has': return { json: { ok: true, internet: !!I, presence: !!(gc.homeNetwork && gc.homeNetwork.presence), cache: !!C, homeRef: typeof req.homeRef === 'string' } };
      case '/status': return { json: await attempt(() => I.status(Number(q.userId || b.userId))) };
      case '/pause':
        // a GET is no changing request: refused
        if (req.method === 'GET') return { json: await attempt(() => I.pause(Number(q.userId), 30)) };
        return { json: await attempt(() => I.pause(b.userId, b.until)) };
      case '/resume': return { json: await attempt(() => I.resume(b.userId)) };
      case '/extend': return { json: await attempt(() => I.extend(b.userId, b.minutes)) };
      case '/later':
        // outside of any request of a person: a moment after the answer
        later = null;
        setTimeout(() => { attempt(() => I.pause(b.userId, 10)).then((r) => { later = r; }); }, 50);
        return { json: { ok: true } };
      case '/later-result': return { json: { ok: true, result: later } };
      case '/offer': return { json: await attempt(() => C.offer(b)) };
      case '/withdraw': return { json: await attempt(() => C.withdraw(b.mediaId)) };
      case '/hint': return { json: await attempt(() => C.lanHint(b.mediaId ? { mediaId: b.mediaId } : (b.sha256 || q.sha256), req)) };
      case '/hint-noreq': return { json: await attempt(() => C.lanHint(b.sha256, {})) };
      default: return { status: 404, json: { ok: false } };
    }
  },
};
