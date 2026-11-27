'use strict';

// Server part of the conversion test plugin (tests/home_transcode.test.js): gc.transcode
// through its admin API (/api/v1/plugins/transcode-demo/api/…), the hook transcodeChanged
// kept in gc.storage.

module.exports = {
  async start(gc) {
    let chain = Promise.resolve();
    if (gc.transcode) {
      gc.transcode.on((ev) => {
        chain = chain.then(async () => { const l = (await gc.storage.get('events')) || []; l.push(ev); await gc.storage.set('events', l); });
        return chain;
      });
    }
  },
  async request(req, gc) {
    const run = async (fn) => { try { return { json: { ok: true, result: await fn() } }; } catch (e) { return { json: { ok: false, code: e.code || null, reason: e.reason || null, message: e.message } }; } };
    const b = req.body || {};
    const t = gc.transcode;
    switch (req.path) {
      case '/has': return { json: { ok: true, transcode: !!t } };
      case '/available': return run(() => t.available());
      case '/report': return run(() => t.report(b.gatewayId));
      case '/status': return run(() => t.status(b.gatewayId));
      case '/probe': return run(() => t.probe(b.gatewayId, b.path));
      case '/submit': return run(() => t.submit(b));
      case '/cancel': return run(() => t.cancel(b.gatewayId, b.id));
      case '/pause': return run(() => t.pause(b.gatewayId, b.opts));
      case '/resume': return run(() => t.resume(b.gatewayId, b.opts));
      case '/ack': return run(() => t.ack(b.gatewayId, b.ids));
      case '/restore': return run(() => t.restore(b.gatewayId, b.id));
      case '/purge': return run(() => t.purge(b.gatewayId, b.opts));
      case '/settings': return run(() => t.settings(b.gatewayId, b.opts));
      case '/hooked': return run(async () => (await gc.storage.get('events')) || []);
      default: return { status: 404, json: { ok: false } };
    }
  },
};
