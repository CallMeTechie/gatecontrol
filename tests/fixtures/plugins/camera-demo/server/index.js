'use strict';

// Server part of the camera test plugin (tests/home_cameras.test.js): gc.cameras
// through its admin API (/api/v1/plugins/camera-demo/api/…), the hook cameraEvent
// kept in gc.storage.

module.exports = {
  async start(gc) {
    // one after the other: two hooks at once would both read the old list
    let chain = Promise.resolve();
    if (gc.cameras) gc.cameras.on((ev) => { chain = chain.then(async () => { const l = (await gc.storage.get('events')) || []; l.push(ev); await gc.storage.set('events', l); }); return chain; });
  },
  async request(req, gc) {
    const run = async (fn) => { try { return { json: { ok: true, result: await fn() } }; } catch (e) { return { json: { ok: false, code: e.code || null, message: e.message } }; } };
    const b = req.body || {};
    switch (req.path) {
      case '/has': return { json: { ok: true, cameras: !!gc.cameras } };
      case '/available': return run(() => gc.cameras.available());
      case '/list': return run(() => gc.cameras.list());
      case '/discover': return run(() => gc.cameras.discover(b));
      case '/add': return run(() => gc.cameras.add(b));
      case '/update': return run(() => gc.cameras.update(b.id, b.patch));
      case '/snapshot': return run(() => gc.cameras.snapshot(b.id));
      case '/snapshotUrl': return run(() => gc.cameras.snapshotUrl(b.id));
      case '/live': return run(() => gc.cameras.live(b.id, req));
      case '/events': return run(() => gc.cameras.events(b));
      case '/remove': return run(() => gc.cameras.remove(b.id));
      case '/hooked': return run(async () => (await gc.storage.get('events')) || []);
      default: return { status: 404, json: { ok: false } };
    }
  },
};
