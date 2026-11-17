'use strict';

// Server part of the remote access test plugin (tests/remote_host_api.test.js): gc.remote through its
// admin API (/api/v1/plugins/gatecontrol-remote/api/…), the hooks remoteSession, legacyImport and
// clientFacade (its answer is set through /facade and kept in gc.storage).

const CALLS = {
  session: (gc, a) => gc.remote.session(a),
  end: (gc, a) => gc.remote.end(a),
  sessions: (gc, a) => gc.remote.sessions(a),
  'vault.put': (gc, a) => gc.remote.vault.put(a),
  'vault.remove': (gc, a) => gc.remote.vault.remove(a.handle),
  'vault.info': (gc, a) => gc.remote.vault.info(a.handle),
  'vault.list': (gc) => gc.remote.vault.list(),
  probe: (gc, a) => gc.remote.probe(a),
  wake: (gc, a) => (a.user != null ? gc.remote.wake(a.target, { user: a.user }) : gc.remote.wake(a)),
  listener: (gc, a) => gc.remote.listener(a),
  'listener.remove': (gc, a) => gc.remote.listener.remove(a.key),
  listeners: (gc) => gc.remote.listeners(),
  gateways: (gc) => gc.remote.gateways(),
  hubAddress: (gc) => gc.remote.hubAddress(),
  peerAddress: (gc, a) => gc.remote.peerAddress(a.userId, a.deviceId),
  notify: (gc, a) => gc.notify(a),
  'recordings.available': (gc) => gc.remote.recordings.available(),
  'recordings.list': (gc, a) => gc.remote.recordings.list(a),
  'recordings.stream': (gc, a) => gc.remote.recordings.stream(a.id, { user: a.user }),
  // version 3 (stage 3)
  'vault.generate': (gc, a) => gc.remote.vault.generate(a),
  'tmux.list': (gc, a) => gc.remote.tmux.list(a.target, { credential: a.credential }),
  'hostKeys.pin': (gc, a) => gc.remote.hostKeys.pin(a),
  'hostKeys.list': (gc) => gc.remote.hostKeys.list(),
  'hostKeys.remove': (gc, a) => gc.remote.hostKeys.remove(a.targetId),
  'recordings.remove': (gc, a) => gc.remote.recordings.remove(a.id),
  // version 4 (stage 5)
  screen: (gc, a) => gc.remote.screen(a),
  // version 7 (Gerät hinzufügen)
  candidates: (gc, a) => gc.remote.candidates(a),
  scan: (gc, a) => gc.remote.scan(a.target, a.ports),
  // version 9 (Schlüssel automatisch einrichten, tmux windows / kill, codes of the Linux agent)
  'tmux.listWindows': (gc, a) => gc.remote.tmux.list(a.target, { credential: a.credential, windows: true }),
  'tmux.kill': (gc, a) => gc.remote.tmux.kill(a.target, { credential: a.credential, session: a.session, window: a.window }),
  'hostKeys.scan': (gc, a) => gc.remote.hostKeys.scan(a.target),
  installKey: (gc, a) => gc.remote.installKey(a.target, a.opts),
  testKey: (gc, a) => gc.remote.testKey(a.target, { credential: a.credential }),
  removeKey: (gc, a) => gc.remote.removeKey(a.target, { credential: a.credential }),
  'enrollment.create': (gc, a) => gc.remote.enrollment.create(a),
  'enrollment.status': (gc, a) => gc.remote.enrollment.status(a.ticket),
  'enrollment.revoke': (gc, a) => gc.remote.enrollment.revoke(a.ticket),
};

let chain = Promise.resolve();
const keep = (gc, key, v) => { chain = chain.then(async () => { const l = (await gc.storage.get(key)) || []; l.push(v); await gc.storage.set(key, l); }); return chain; };

module.exports = {
  async start(gc) {
    if (gc.remote) gc.remote.on('session', (ev) => keep(gc, 'events', ev));
  },
  async request(req, gc) {
    const b = req.body || {};
    // the app API (version 2): the asking device with its VPN address, and peerAddress inside the person's request
    if (req.path === '/me') return { json: { ok: true, user: req.user } };
    if (req.path === '/myAddress') {
      try { return { json: { ok: true, result: await gc.remote.peerAddress(req.user.id, req.user.device && req.user.device.id) } }; } catch (e) { return { json: { ok: false, code: e.code || null } }; }
    }
    if (req.path === '/has') return { json: { ok: true, remote: !!gc.remote, version: gc.remote ? gc.remote.version : null } };
    if (req.path === '/events') return { json: { ok: true, result: (await gc.storage.get('events')) || [] } };
    if (req.path === '/snapshot') return { json: { ok: true, result: (await gc.storage.get('snapshot')) || null } };
    if (req.path === '/facade') { await gc.storage.set('facade', b.answer === undefined ? null : b.answer); return { json: { ok: true } }; }
    if (req.path === '/facadeCalls') return { json: { ok: true, result: (await gc.storage.get('facadeCalls')) || [] } };
    if (req.path === '/call') {
      const fn = CALLS[b.api];
      if (!fn) return { status: 404, json: { ok: false } };
      try { return { json: { ok: true, result: await fn(gc, b.args || {}) } }; } catch (e) { return { json: { ok: false, code: e.code || null, message: e.message } }; }
    }
    return { status: 404, json: { ok: false } };
  },
  async legacyImport(snapshot, gc) {
    await gc.storage.set('snapshot', snapshot);
    return { ok: true };
  },
  async clientFacade(payload, gc) {
    await keep(gc, 'facadeCalls', { op: payload.op, id: payload.id, query: payload.query, user: payload.user, server: payload.server || null });
    const a = await gc.storage.get('facade');
    return a || { handled: false };
  },
};
