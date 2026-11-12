'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { createChainWatch, probeDns, INTERVAL_MS, RETRY_MS, TIMEOUT_MS, DOWN_AFTER } = require('../src/services/dnsChainWatch');

// The state machine of the chain watch with ONE provider and the default
// cadence and hysteresis (dnsChainWatch.js) — a resolver somewhere in the
// network. deps.loadConfig() says whether the provider wants the chain.
function createDnsWatch(deps) {
  const provider = {
    id: 'vpnfilter',
    label: 'filter',
    targets() {
      const config = deps.loadConfig();
      return (config.enabled && config.manage_dns_chain && config.instances) || [];
    },
    probe: deps.probe,
    onChange: deps.onChange || (() => {}),
  };
  const watch = createChainWatch({ providers: () => [provider], chain: deps.dnsChain, now: deps.now });
  const status = () => watch.statusFor('vpnfilter');
  return { tick: () => watch.tick().then(status), status, isFallback: () => status().state === 'fallback' };
}

const INST = { id: 'p1', label: 'Resolver DS918+', dns_ip: '10.8.0.2', dns_port: 5335 };

function harness({ instances = [INST], config = {} } = {}) {
  const h = { alive: { p1: true }, calls: [], changes: [], cfg: { enabled: true, manage_dns_chain: true, instances, ...config } };
  h.watch = createDnsWatch({
    loadConfig: () => h.cfg,
    dnsChain: { apply: (t) => h.calls.push(['apply', t.join(',')]), revert: () => h.calls.push(['revert']) },
    probe: async (inst) => {
      if (h.alive[inst.id] === 'throw') throw new Error('probe broke');
      return !!h.alive[inst.id];
    },
    onChange: (state, status) => h.changes.push([state, status.state]),
    now: () => 1000,
  });
  return h;
}

test('worst case stays below ten seconds of probing', () => {
  // wait for the next round + a timed-out round + the quick retry + its timeout
  assert.ok(INTERVAL_MS + TIMEOUT_MS + (DOWN_AFTER - 1) * (RETRY_MS + TIMEOUT_MS) <= 10000);
});

test('healthy resolver: chain applied, stays, default upstreams never used', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.watch.tick();
  assert.deepEqual(h.calls, [['apply', '10.8.0.2#5335']]);
  assert.equal(h.watch.status().state, 'vpnfilter');
  assert.deepEqual(h.watch.status().targets, [{ id: 'p1', label: 'Resolver DS918+', dns: '10.8.0.2#5335', ok: true }]);
  assert.deepEqual(h.changes, [], 'switching on is not an outage/recovery event');
});

test('outage: one failed round is tolerated, the second reverts; recovery needs three good rounds', async () => {
  const h = harness();
  await h.watch.tick();
  h.calls.length = 0;

  h.alive.p1 = false;
  await h.watch.tick();
  assert.deepEqual(h.calls, [], 'a single lost probe does not restart dnsmasq');
  assert.equal(h.watch.status().state, 'vpnfilter');
  await h.watch.tick();
  assert.deepEqual(h.calls, [['revert']]);
  assert.equal(h.watch.status().state, 'fallback');
  assert.equal(h.watch.isFallback(), true);
  assert.equal(h.watch.status().since, 1000);
  assert.deepEqual(h.changes, [['fallback', 'fallback']]);

  await h.watch.tick();
  await h.watch.tick();
  assert.deepEqual(h.calls, [['revert']], 'reverted once, not every round');

  h.alive.p1 = true;
  await h.watch.tick();
  await h.watch.tick();
  assert.equal(h.watch.status().state, 'fallback', 'two good rounds are not enough');
  await h.watch.tick();
  assert.deepEqual(h.calls, [['revert'], ['apply', '10.8.0.2#5335']]);
  assert.equal(h.watch.status().state, 'vpnfilter');
  assert.deepEqual(h.changes, [['fallback', 'fallback'], ['vpnfilter', 'vpnfilter']]);
});

test('a single failed round between good ones does nothing', async () => {
  const h = harness();
  await h.watch.tick();
  for (let i = 0; i < 4; i++) {
    h.alive.p1 = false; await h.watch.tick();
    h.alive.p1 = true; await h.watch.tick();
  }
  assert.deepEqual(h.calls, [['apply', '10.8.0.2#5335']]);
});

test('flapping resolver does not get the chain back', async () => {
  const h = harness();
  await h.watch.tick();
  h.alive.p1 = false;
  await h.watch.tick(); await h.watch.tick();
  h.calls.length = 0;
  for (let i = 0; i < 4; i++) {
    h.alive.p1 = true; await h.watch.tick(); await h.watch.tick();
    h.alive.p1 = false; await h.watch.tick();
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.watch.status().state, 'fallback');
});

test('start with a dead resolver: reverted in the first round (boot with the gateway off)', async () => {
  const h = harness();
  h.alive.p1 = false;
  await h.watch.tick();
  assert.deepEqual(h.calls, [['revert']]);
  assert.equal(h.watch.status().state, 'fallback');
  assert.deepEqual(h.changes, [['fallback', 'fallback']]);
});

test('two instances: fallback only when none answers', async () => {
  const two = [INST, { id: 'p2', dns_ip: '192.168.1.5' }];
  const h = harness({ instances: two });
  h.alive.p2 = true;
  await h.watch.tick();
  h.alive.p1 = false;
  for (let i = 0; i < 4; i++) await h.watch.tick();
  assert.deepEqual(h.calls, [['apply', '10.8.0.2#5335,192.168.1.5']]);
  assert.equal(h.watch.status().targets[0].ok, false);
  assert.equal(h.watch.status().targets[1].ok, true);
  h.alive.p2 = false;
  await h.watch.tick(); await h.watch.tick();
  assert.equal(h.watch.status().state, 'fallback');
});

test('a throwing probe counts as no answer', async () => {
  const h = harness();
  await h.watch.tick();
  h.alive.p1 = 'throw';
  await h.watch.tick(); await h.watch.tick();
  assert.equal(h.watch.status().state, 'fallback');
});

test('chain not managed / disabled / no DNS address: off, nothing probed, no event', async () => {
  for (const config of [{ manage_dns_chain: false }, { enabled: false }, { instances: [{ id: 'p1', url: 'http://x' }] }]) {
    const h = harness({ config });
    await h.watch.tick();
    assert.equal(h.watch.status().state, 'off');
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.changes, []);
  }
});

test('switched off while fallen back: state off; switched on again asks the DNS first', async () => {
  const h = harness();
  h.alive.p1 = false;
  await h.watch.tick();
  h.cfg = { ...h.cfg, manage_dns_chain: false };
  await h.watch.tick();
  assert.equal(h.watch.status().state, 'off');
  assert.deepEqual(h.calls, [['revert'], ['revert']]);
  h.cfg = { ...h.cfg, manage_dns_chain: true };
  h.alive.p1 = true;
  await h.watch.tick();
  assert.equal(h.watch.status().state, 'vpnfilter');
  assert.deepEqual(h.calls[2], ['apply', '10.8.0.2#5335']);
});

test('a failing chain write does not kill the watch', async () => {
  let fail = true;
  const watch = createDnsWatch({
    loadConfig: () => ({ enabled: true, manage_dns_chain: true, instances: [INST] }),
    dnsChain: { apply: () => { if (fail) throw new Error('ENOENT'); }, revert: () => {} },
    probe: async () => true,
  });
  await assert.doesNotReject(watch.tick());
  assert.equal(watch.status().state, 'off');
  fail = false;
  await watch.tick();
  assert.equal(watch.status().state, 'vpnfilter');
});

// ─── probeDns against a real UDP socket ─────────────────────────────────────
function fakeResolver(mode) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (mode === 'silent') return;
    const hdr = Buffer.from(msg.subarray(0, 12));
    hdr[2] = 0x81;
    hdr[3] = mode === 'servfail' ? 0x82 : mode === 'refused' ? 0x85 : 0x80;
    hdr.writeUInt16BE(mode === 'ok' ? 1 : 0, 6);
    hdr.writeUInt16BE(0, 8); hdr.writeUInt16BE(0, 10);
    const question = msg.subarray(12, 12 + 5); // root name (1 byte) + type + class
    const answer = mode === 'ok'
      ? Buffer.from([0x00, 0, 2, 0, 1, 0, 0, 0, 60, 0, 3, 1, 0x61, 0]) // . NS a.
      : Buffer.alloc(0);
    sock.send(Buffer.concat([hdr, question, answer]), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve(sock)));
}

test('probeDns: an answering resolver on a custom port is alive', async () => {
  const sock = await fakeResolver('ok');
  try {
    assert.equal(await probeDns({ dns_ip: '127.0.0.1', dns_port: sock.address().port }, 500), true);
  } finally { sock.close(); }
});

test('probeDns: silence, SERVFAIL, REFUSED and a closed port all count as dead', async () => {
  for (const mode of ['silent', 'servfail', 'refused']) {
    const sock = await fakeResolver(mode);
    try {
      assert.equal(await probeDns({ dns_ip: '127.0.0.1', dns_port: sock.address().port }, 300), false, mode);
    } finally { sock.close(); }
  }
  const closed = await fakeResolver('silent');
  const port = closed.address().port;
  closed.close();
  assert.equal(await probeDns({ dns_ip: '127.0.0.1', dns_port: port }, 300), false, 'closed port');
});

test('probeDns: no or unusable address is dead, never throws', async () => {
  assert.equal(await probeDns({}), false);
  assert.equal(await probeDns(null), false);
  assert.equal(await probeDns({ dns_ip: 'not an ip' }, 200), false);
});

test('no dnsmasq.conf on this host: the watch stays off and reports no outage', async () => {
  const changes = [];
  const watch = createDnsWatch({
    loadConfig: () => ({ enabled: true, manage_dns_chain: true, instances: [INST] }),
    dnsChain: { apply: () => { throw new Error('ENOENT'); }, revert: () => { throw new Error('ENOENT'); } },
    probe: async () => false,
    onChange: (s) => changes.push(s),
  });
  await watch.tick(); await watch.tick();
  assert.equal(watch.status().state, 'off');
  assert.deepEqual(changes, []);
});
