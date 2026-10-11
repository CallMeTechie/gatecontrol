'use strict';

// Control events over the push stream (docs/feature-notification-center.md,
// "Vertrag", `event: control` and `hello.state`): policy_changed,
// support_bundle_requested, peer_state, config_changed — only to the
// affected devices, never failing the admin action that triggered them.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, server, port, stream, control, tokens, settings;
let anna, ben, groupA, groupB;
let annaPhone, annaLaptop, benPhone, loose;

before(async () => {
  ({ app, agent } = await setup());
  server = app.listen(0);
  port = server.address().port;
  stream = require('../src/services/notify/stream');
  control = require('../src/services/notify/control');
  tokens = require('../src/services/tokens');
  settings = require('../src/services/settings');
  require('../src/services/license')._overrideForTest({ custom_dns: true, split_tunnel_preset: true });
  anna = H.makeUser('anna');
  ben = H.makeUser('ben');
  groupA = H.makeGroup('ctl-a');
  groupB = H.makeGroup('ctl-b');
  annaPhone = H.makeDevice(anna, { name: 'ctl-anna-phone', groupId: groupA });
  annaLaptop = H.makeDevice(anna, { name: 'ctl-anna-laptop', platform: 'windows', groupId: groupB });
  benPhone = H.makeDevice(ben, { name: 'ctl-ben-phone', groupId: groupA });
  loose = H.makeDevice(ben, { name: 'ctl-loose' }); // no group
});
after(() => {
  stream._resetForTest();
  server.close();
  teardown();
});
beforeEach(() => { stream._resetForTest(); });

const csrf = () => getCsrf();
const client = (method, path, dev) => supertest(app)[method](path).set('X-API-Token', dev.raw).set('X-Client-Platform', 'android').set('X-Client-Version', '2.0.0');

/** Open streams for the given devices and wait for their hello. */
async function openAll(devs) {
  const out = new Map();
  for (const d of devs) {
    const s = await H.openStream(port, d.raw);
    assert.equal(s.status, 200);
    await s.waitFor((e) => e.event === 'hello');
    out.set(d, s);
  }
  return out;
}

let markSeq = 0;
/**
 * Everything written before this call has arrived: a marker event goes
 * down every stream after the action (TCP keeps the order).
 */
async function settle(streams) {
  markSeq += 1;
  const n = markSeq;
  for (const d of streams.keys()) stream.send(d.tokenId, 'marker', { n });
  for (const s of streams.values()) await s.waitFor((e) => e.event === 'marker' && e.data.n === n);
}

const controls = (s) => s.events.filter((e) => e.event === 'control');
const closeAll = (streams) => { for (const s of streams.values()) s.close(); };

describe('hello.state', () => {
  it('carries exactly what heartbeat, GET /client/policy and config/check report', async () => {
    const req = await agent.post(`/api/v1/peers/${annaPhone.peerId}/support-bundles/request`).set('X-CSRF-Token', csrf()).send({}).expect(200);
    try {
      const s = await H.openStream(port, annaPhone.raw);
      const hello = await s.waitFor((e) => e.event === 'hello');
      s.close();
      const st = hello.data.state;
      assert.deepEqual(Object.keys(st).sort(), ['config_hash', 'peer_enabled', 'policy_version', 'support_bundle_requested', 'support_bundle_requested_at']);

      const hb = await client('post', '/api/v1/client/heartbeat', annaPhone).send({ peerId: annaPhone.peerId, connected: true }).expect(200);
      assert.equal(st.policy_version, hb.body.policyVersion);
      assert.equal(st.peer_enabled, hb.body.peerEnabled);
      assert.equal(st.support_bundle_requested, hb.body.supportBundleRequested);
      assert.equal(st.support_bundle_requested_at, hb.body.supportBundleRequestedAt);
      assert.equal(st.support_bundle_requested, true);
      assert.equal(st.support_bundle_requested_at, req.body.requestedAt);

      const pol = await client('get', '/api/v1/client/policy', annaPhone).expect(200);
      assert.equal(st.policy_version, pol.body.version);
      assert.equal(pol.headers.etag, `"${st.policy_version}"`);

      const cfg = await client('get', `/api/v1/client/config/check?peerId=${annaPhone.peerId}`, annaPhone).expect(200);
      assert.equal(typeof st.config_hash, 'string');
      assert.equal(st.config_hash, cfg.body.hash);
      const same = await client('get', `/api/v1/client/config/check?peerId=${annaPhone.peerId}&hash=${st.config_hash}`, annaPhone).expect(200);
      assert.equal(same.body.updated, false, 'the app can feed hello.state.config_hash straight into config/check');
    } finally {
      await agent.delete(`/api/v1/peers/${annaPhone.peerId}/support-bundles/request`).set('X-CSRF-Token', csrf()).expect(200);
    }
  });

  it('a disabled peer and no open request', async () => {
    H.db().prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(loose.peerId);
    try {
      const s = await H.openStream(port, loose.raw);
      const hello = await s.waitFor((e) => e.event === 'hello');
      s.close();
      assert.equal(hello.data.state.peer_enabled, false);
      assert.equal(hello.data.state.support_bundle_requested, false);
      assert.equal(hello.data.state.support_bundle_requested_at, null);
    } finally { H.db().prepare('UPDATE peers SET enabled = 1 WHERE id = ?').run(loose.peerId); }
  });

  it('a token not bound to a peer: global policy version, nothing else', async () => {
    const t = tokens.create({ name: H.uniq('unbound'), scopes: ['client'], userId: anna }, '127.0.0.1');
    const s = await H.openStream(port, t.rawToken);
    const hello = await s.waitFor((e) => e.event === 'hello');
    s.close();
    const pol = await supertest(app).get('/api/v1/client/policy').set('X-API-Token', t.rawToken).expect(200);
    assert.deepEqual(hello.data.state, {
      policy_version: pol.body.version, peer_enabled: false,
      support_bundle_requested: false, support_bundle_requested_at: null, config_hash: null,
    });
  });
});

describe('event: control — policy_changed', () => {
  it('global policy → every open stream, each with its own effective version', async () => {
    const streams = await openAll([annaPhone, annaLaptop, benPhone, loose]);
    try {
      await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf()).send({ kill_switch: 'required' }).expect(200);
      await settle(streams);
      for (const [d, s] of streams) {
        const ev = controls(s);
        assert.equal(ev.length, 1, `one event for ${d.tokenId}`);
        assert.equal(ev[0].id, undefined, 'control events carry no SSE id');
        assert.equal(ev[0].data.type, 'policy_changed');
        const pol = await client('get', '/api/v1/client/policy', d).expect(200);
        assert.equal(ev[0].data.policy_version, pol.body.version);
      }
    } finally {
      closeAll(streams);
      await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf()).send({ kill_switch: 'user' }).expect(200);
    }
  });

  it('group policy → only the devices in that group', async () => {
    const streams = await openAll([annaPhone, annaLaptop, benPhone, loose]);
    try {
      await agent.put(`/api/v1/settings/client-policy/groups/${groupA}`).set('X-CSRF-Token', csrf()).send({ lock_server: true }).expect(200);
      await settle(streams);
      assert.equal(controls(streams.get(annaPhone)).length, 1);
      assert.equal(controls(streams.get(benPhone)).length, 1);
      assert.equal(controls(streams.get(annaLaptop)).length, 0, 'other group');
      assert.equal(controls(streams.get(loose)).length, 0, 'no group');
      const ev = controls(streams.get(benPhone))[0].data;
      const pol = await client('get', '/api/v1/client/policy', benPhone).expect(200);
      assert.deepEqual(ev, { type: 'policy_changed', policy_version: pol.body.version });
      assert.equal(pol.body.policy.lockServer, true);
    } finally {
      closeAll(streams);
      await agent.put(`/api/v1/settings/client-policy/groups/${groupA}`).set('X-CSRF-Token', csrf()).send({}).expect(200);
    }
  });

  it('peer policy → only that device; moving a peer to another group too', async () => {
    const streams = await openAll([annaPhone, annaLaptop, benPhone, loose]);
    try {
      await agent.put(`/api/v1/peers/${loose.peerId}`).set('X-CSRF-Token', csrf()).send({ client_policy: { autostart: 'required' } }).expect(200);
      await settle(streams);
      assert.equal(controls(streams.get(loose)).length, 1);
      for (const d of [annaPhone, annaLaptop, benPhone]) assert.equal(controls(streams.get(d)).length, 0);

      await agent.put(`/api/v1/peers/${loose.peerId}`).set('X-CSRF-Token', csrf()).send({ group_id: groupB }).expect(200);
      await settle(streams);
      const ev = controls(streams.get(loose));
      assert.equal(ev.length, 2);
      assert.equal(ev[1].data.type, 'policy_changed');
      for (const d of [annaPhone, annaLaptop, benPhone]) assert.equal(controls(streams.get(d)).length, 0);
    } finally {
      closeAll(streams);
      await agent.put(`/api/v1/peers/${loose.peerId}`).set('X-CSRF-Token', csrf()).send({ client_policy: null, group_id: null }).expect(200);
    }
  });

  it('deleting a group → its former members', async () => {
    const g = H.makeGroup('ctl-del');
    const member = H.makeDevice(anna, { name: 'ctl-member', groupId: g });
    const streams = await openAll([member, annaPhone]);
    try {
      await agent.delete(`/api/v1/peer-groups/${g}`).set('X-CSRF-Token', csrf()).expect(200);
      await settle(streams);
      assert.equal(controls(streams.get(member)).length, 1);
      assert.equal(controls(streams.get(member))[0].data.type, 'policy_changed');
      assert.equal(controls(streams.get(annaPhone)).length, 0);
    } finally { closeAll(streams); }
  });

  it('a token split-tunnel override → only that token (policy + config)', async () => {
    const streams = await openAll([annaPhone, annaLaptop]);
    try {
      tokens.update(annaLaptop.tokenId, { splitTunnelOverride: { mode: 'exclude', networks: [], locked: true } });
      await settle(streams);
      assert.deepEqual(controls(streams.get(annaLaptop)).map((e) => e.data.type).sort(), ['config_changed', 'policy_changed']);
      assert.equal(controls(streams.get(annaPhone)).length, 0);
    } finally {
      closeAll(streams);
      tokens.update(annaLaptop.tokenId, { splitTunnelOverride: null });
    }
  });
});

describe('event: control — support_bundle_requested', () => {
  it('only to the asked device, with the value the heartbeat reports', async () => {
    const streams = await openAll([annaPhone, annaLaptop, benPhone]);
    try {
      const r = await agent.post(`/api/v1/peers/${annaLaptop.peerId}/support-bundles/request`).set('X-CSRF-Token', csrf()).send({}).expect(200);
      await settle(streams);
      const ev = controls(streams.get(annaLaptop));
      assert.equal(ev.length, 1);
      assert.deepEqual(ev[0].data, { type: 'support_bundle_requested', requested_at: r.body.requestedAt });
      const hb = await client('post', '/api/v1/client/heartbeat', annaLaptop).send({ peerId: annaLaptop.peerId }).expect(200);
      assert.equal(ev[0].data.requested_at, hb.body.supportBundleRequestedAt);
      assert.equal(controls(streams.get(annaPhone)).length, 0, 'same person, other device');
      assert.equal(controls(streams.get(benPhone)).length, 0);
    } finally {
      closeAll(streams);
      await agent.delete(`/api/v1/peers/${annaLaptop.peerId}/support-bundles/request`).set('X-CSRF-Token', csrf()).expect(200);
    }
  });
});

describe('event: control — peer_state', () => {
  it('toggle off/on → only that device, before the stream goes away', async () => {
    const streams = await openAll([annaPhone, benPhone]);
    try {
      await agent.put(`/api/v1/peers/${benPhone.peerId}/toggle`).set('X-CSRF-Token', csrf()).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}/toggle`).set('X-CSRF-Token', csrf()).expect(200);
      await settle(streams);
      assert.deepEqual(controls(streams.get(benPhone)).map((e) => e.data), [
        { type: 'peer_state', enabled: false },
        { type: 'peer_state', enabled: true },
      ]);
      assert.equal(controls(streams.get(annaPhone)).length, 0);
    } finally { closeAll(streams); }
  });

  it('PUT /peers/:id {enabled} and batch enable/disable', async () => {
    const streams = await openAll([annaPhone, annaLaptop, benPhone]);
    try {
      await agent.put(`/api/v1/peers/${annaPhone.peerId}`).set('X-CSRF-Token', csrf()).send({ enabled: false }).expect(200);
      await settle(streams);
      assert.deepEqual(controls(streams.get(annaPhone)).map((e) => e.data), [{ type: 'peer_state', enabled: false }]);
      assert.equal(controls(streams.get(annaLaptop)).length, 0);

      await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf()).send({ action: 'enable', ids: [annaPhone.peerId, annaLaptop.peerId] }).expect(200);
      await settle(streams);
      assert.deepEqual(controls(streams.get(annaPhone)).map((e) => e.data).at(-1), { type: 'peer_state', enabled: true });
      assert.deepEqual(controls(streams.get(annaLaptop)).map((e) => e.data), [{ type: 'peer_state', enabled: true }]);
      assert.equal(controls(streams.get(benPhone)).length, 0);
    } finally {
      closeAll(streams);
      H.db().prepare('UPDATE peers SET enabled = 1 WHERE id IN (?, ?)').run(annaPhone.peerId, annaLaptop.peerId);
    }
  });

  it('an expired peer is disabled with peer_state false', async () => {
    const dev = H.makeDevice(ben, { name: 'ctl-expiring' });
    const streams = await openAll([dev, benPhone]);
    try {
      H.db().prepare("UPDATE peers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(dev.peerId);
      await require('../src/services/peers').checkExpiredPeers();
      await settle(streams);
      assert.deepEqual(controls(streams.get(dev)).map((e) => e.data), [{ type: 'peer_state', enabled: false }]);
      assert.equal(controls(streams.get(benPhone)).length, 0);
    } finally { closeAll(streams); }
  });
});

describe('event: control — config_changed', () => {
  it('peer edit that changes the client config → only that device; a name change does not', async () => {
    const streams = await openAll([annaPhone, benPhone]);
    try {
      const before = await client('get', `/api/v1/client/config/check?peerId=${benPhone.peerId}`, benPhone).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}`).set('X-CSRF-Token', csrf()).send({ dns: '9.9.9.9' }).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}`).set('X-CSRF-Token', csrf()).send({ persistentKeepalive: 40 }).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}`).set('X-CSRF-Token', csrf()).send({ description: 'just a label' }).expect(200);
      await settle(streams);
      assert.deepEqual(controls(streams.get(benPhone)).map((e) => e.data), [{ type: 'config_changed' }, { type: 'config_changed' }]);
      assert.equal(controls(streams.get(annaPhone)).length, 0);
      const afterCheck = await client('get', `/api/v1/client/config/check?peerId=${benPhone.peerId}&hash=${before.body.hash}`, benPhone).expect(200);
      assert.equal(afterCheck.body.updated, true, 'the event matches a real config change');
    } finally { closeAll(streams); }
  });

  it('server-wide DNS and split-tunnel preset → every open stream', async () => {
    const streams = await openAll([annaPhone, benPhone]);
    const prevPreset = settings.get('split_tunnel_preset', '');
    try {
      await agent.put('/api/v1/settings/dns').set('X-CSRF-Token', csrf()).send({ dns: '1.1.1.1' }).expect(200);
      await agent.put('/api/v1/settings/split-tunnel').set('X-CSRF-Token', csrf()).send({ mode: 'exclude', networks: [{ cidr: '192.168.0.0/16' }], locked: false }).expect(200);
      await settle(streams);
      for (const s of streams.values()) {
        assert.deepEqual(controls(s).map((e) => e.data.type), ['config_changed', 'config_changed', 'policy_changed']);
      }
    } finally {
      closeAll(streams);
      settings.set('custom_dns', '');
      settings.set('split_tunnel_preset', prevPreset);
    }
  });
});

describe('event: control — robustness', () => {
  it('the admin action succeeds when emitting throws', async () => {
    const saved = {};
    for (const k of ['policyChanged', 'supportBundleRequested', 'peerState', 'configChanged']) {
      saved[k] = control[k];
      control[k] = () => { throw new Error('boom'); };
    }
    const streams = await openAll([benPhone]);
    try {
      await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf()).send({ lock_settings: true }).expect(200);
      await agent.put(`/api/v1/settings/client-policy/groups/${groupA}`).set('X-CSRF-Token', csrf()).send({ autostart: 'forbidden' }).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}`).set('X-CSRF-Token', csrf()).send({ dns: '8.8.4.4', client_policy: { kill_switch: 'required' } }).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}/toggle`).set('X-CSRF-Token', csrf()).expect(200);
      assert.equal(H.db().prepare('SELECT enabled FROM peers WHERE id = ?').get(benPhone.peerId).enabled, 0);
      await agent.put(`/api/v1/peers/${benPhone.peerId}/toggle`).set('X-CSRF-Token', csrf()).expect(200);
      const r = await agent.post(`/api/v1/peers/${benPhone.peerId}/support-bundles/request`).set('X-CSRF-Token', csrf()).send({}).expect(200);
      assert.ok(r.body.requestedAt);
      await agent.put('/api/v1/settings/dns').set('X-CSRF-Token', csrf()).send({ dns: '' }).expect(200);
      await settle(streams);
      assert.equal(controls(streams.get(benPhone)).length, 0);
    } finally {
      closeAll(streams);
      Object.assign(control, saved);
      await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf()).send({ lock_settings: false }).expect(200);
      await agent.put(`/api/v1/settings/client-policy/groups/${groupA}`).set('X-CSRF-Token', csrf()).send({}).expect(200);
      await agent.put(`/api/v1/peers/${benPhone.peerId}`).set('X-CSRF-Token', csrf()).send({ client_policy: null }).expect(200);
      await agent.delete(`/api/v1/peers/${benPhone.peerId}/support-bundles/request`).set('X-CSRF-Token', csrf()).expect(200);
    }
  });

  it('a failing stream registry does not escape the emitters', () => {
    const list = stream.list;
    stream.list = () => { throw new Error('boom'); };
    try {
      assert.equal(control.policyChanged({ all: true }), 0);
      assert.equal(control.peerState([1], false), 0);
      assert.equal(control.supportBundleRequested(1, null), 0);
      assert.equal(control.configChanged({ all: true }), 0);
    } finally { stream.list = list; }
  });

  it('no open stream: nothing to do, no database work', () => {
    assert.equal(stream.count(), 0);
    const getDb = require('../src/db/connection').getDb;
    let queried = false;
    const conn = require('../src/db/connection');
    conn.getDb = () => { queried = true; return getDb(); };
    try {
      assert.equal(control.policyChanged({ all: true }), 0);
      assert.equal(control.configChanged({ peerIds: [1] }), 0);
    } finally { conn.getDb = getDb; }
    assert.equal(queried, false);
  });

  it('under backpressure the newest event per type waits for drain', () => {
    const written = [];
    const conn = { tokenId: 999999, closed: false, lagging: true, res: { write: (c) => { written.push(c); return true; } } };
    control.write(conn, { type: 'policy_changed', policy_version: 'a' });
    control.write(conn, { type: 'policy_changed', policy_version: 'b' });
    control.write(conn, { type: 'config_changed' });
    assert.equal(written.length, 0);
    conn.lagging = false;
    control.flush(conn);
    assert.deepEqual(written.map((c) => JSON.parse(/data: (.*)\n/.exec(c)[1])), [
      { type: 'policy_changed', policy_version: 'b' },
      { type: 'config_changed' },
    ]);
    assert.ok(written.every((c) => c.startsWith('event: control\n')), 'no id line');
  });
});
