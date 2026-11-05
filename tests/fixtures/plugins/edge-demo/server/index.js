'use strict';

// Server part of the edge test plugin (tests/edge_*.test.js): exercises gc.edge
// and gc.mqtt.accounts through its admin API (/api/v1/plugins/edge-demo/api/…).

const received = [];
let release = null; // a pending "slow" event waits for /release

async function attempt(fn) {
  try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, code: e.code || null, error: e.message }; }
}

module.exports = {
  async start(gc) {
    gc.edge.on('*', async (ev) => {
      if (ev.name === 'slow') await new Promise((r) => { release = r; });
      if (ev.name === 'boom') throw new Error('handler failed on purpose');
      received.push({ gatewayId: ev.gatewayId, name: ev.name, data: ev.data, seq: ev.seq });
    });
    for (const n of ['$online', '$offline', '$started']) {
      gc.edge.on(n, (ev) => { received.push({ gatewayId: ev.gatewayId, name: ev.name, seq: ev.seq }); });
    }
  },

  async request(req, gc) {
    const b = req.body || {};
    switch (req.path) {
      case '/gateways': return { json: await attempt(() => gc.edge.gateways()) };
      case '/call': return { json: await attempt(() => gc.edge.call(b.gatewayId, b.method, b.params, { timeoutMs: b.timeoutMs })) };
      case '/configure': return { json: await attempt(() => gc.edge.configure(b.gatewayId, b.data)) };
      case '/events': return { json: { ok: true, events: received } };
      case '/release': if (release) { release(); release = null; } return { json: { ok: true } };
      case '/mqtt/create': return { json: await attempt(() => gc.mqtt.accounts.create(b.gatewayId, b.opts)) };
      case '/mqtt/list': return { json: await attempt(() => gc.mqtt.accounts.list(b.gatewayId)) };
      case '/mqtt/remove': return { json: await attempt(() => gc.mqtt.accounts.remove(b.gatewayId, b.username)) };
      case '/features': return { json: { ok: true, edge: !!gc.edge, mqtt: !!gc.mqtt } };
      default: return { status: 404, json: { ok: false } };
    }
  },
};
