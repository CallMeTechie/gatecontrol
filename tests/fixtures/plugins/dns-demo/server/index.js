'use strict';

// Server part of the DNS protection test plugin (tests/vpn_dns.test.js):
// passes calls through to gc.vpnDns and remembers the events it got.

const events = [];

async function attempt(fn) {
  try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, code: e.code || null, error: e.message }; }
}

module.exports = {
  async start(gc) {
    if (gc.vpnDns) gc.vpnDns.on((ev) => { events.push(ev); });
  },
  async request(req, gc) {
    const b = req.body || {};
    const V = gc.vpnDns;
    switch (req.path) {
      case '/has': return { json: { ok: true, vpnDns: !!V, version: V ? V.version : null, methods: V ? Object.keys(V).sort() : [] } };
      case '/me': return { json: { ok: true, user: req.user } };
      case '/events': return { json: { ok: true, events } };
      case '/call': {
        // { op, args: [...] } → gc.vpnDns[op](...args); a GET is no changing request
        const op = req.method === 'GET' ? req.query.op : b.op;
        const args = req.method === 'GET' ? [] : (Array.isArray(b.args) ? b.args : []);
        if (!V || typeof V[op] !== 'function' || op === 'on') return { json: { ok: false, code: 'no_such_op' } };
        return { json: await attempt(() => V[op](...args)) };
      }
      default: return { status: 404, json: { ok: false } };
    }
  },
};
