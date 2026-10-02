'use strict';

// Client policies ("Client-Richtlinien vom Server"):
//   - resolution defaults <- global <- peer group <- peer, a locked
//     split-tunnel preset narrows the allowed modes
//   - GET /api/v1/client/policy (ETag / 304), policyVersion in the heartbeat
//     and /permissions answers
//   - admin API: /api/v1/settings/client-policy (+ /groups/:id) and the
//     client_policy field on PUT /api/v1/peers/:id — admin session only,
//     validated, audited

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let app;
let getDb;
let tokens;
let clientPolicy;

function seedPeer(name, groupId = null) {
  return getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, group_id) VALUES (?, ?, '10.8.0.30/32', 1, ?)")
    .run(`${name}-${crypto.randomBytes(3).toString('hex')}`, `PUB_${name}_${crypto.randomBytes(4).toString('hex')}=`, groupId).lastInsertRowid;
}
function seedGroup(name) {
  return getDb().prepare('INSERT INTO peer_groups (name, color) VALUES (?, ?)')
    .run(`${name}-${crypto.randomBytes(3).toString('hex')}`, '#123456').lastInsertRowid;
}
function tokenFor(peerId, scopes = ['client'], extra = {}) {
  return tokens.create({ name: `t-${peerId}-${crypto.randomBytes(3).toString('hex')}`, scopes, peerId, ...extra }, '127.0.0.1').rawToken;
}
const getPolicy = (token) => supertest(app).get('/api/v1/client/policy').set('X-API-Token', token);

before(async () => {
  const ctx = await setup();
  app = ctx.app;
  getDb = require('../src/db/connection').getDb;
  tokens = require('../src/services/tokens');
  clientPolicy = require('../src/services/clientPolicy');
});
after(() => teardown());

beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key IN ('client_policy', 'split_tunnel_preset')").run();
  getDb().prepare('UPDATE peer_groups SET client_policy = NULL').run();
});

describe('service: resolution', () => {
  it('never-configured server → unrestricted defaults, managed=false', () => {
    const r = clientPolicy.forClient(null);
    assert.deepEqual(r.policy, {
      killSwitch: 'user', autoConnect: 'user', autostart: 'user',
      splitTunnelModes: ['off', 'exclude', 'include'],
      lockSettings: false, lockServer: false, splitTunnelLocked: false,
    });
    assert.equal(r.managed, false);
    assert.match(r.version, /^[0-9a-f]{16}$/);
    assert.equal(r.sources.killSwitch, 'default');
  });

  it('global <- group <- peer, per field', () => {
    clientPolicy.saveGlobal({ ...clientPolicy.getGlobal(), kill_switch: 'required', lock_settings: true });
    const g = seedGroup('res');
    clientPolicy.setGroupOverride(g, { auto_connect: 'always_on', lock_settings: false });
    const p = seedPeer('res', g);
    clientPolicy.setPeerOverride(p, { split_tunnel_modes: ['include', 'off'] });
    const peer = getDb().prepare('SELECT * FROM peers WHERE id = ?').get(p);
    const r = clientPolicy.forClient(peer);
    assert.equal(r.policy.killSwitch, 'required');
    assert.equal(r.sources.killSwitch, 'global');
    assert.equal(r.policy.autoConnect, 'always_on');
    assert.equal(r.sources.autoConnect, 'group');
    assert.equal(r.policy.lockSettings, false);
    assert.equal(r.sources.lockSettings, 'group');
    assert.deepEqual(r.policy.splitTunnelModes, ['off', 'include']); // canonical order
    assert.equal(r.sources.splitTunnelModes, 'peer');
    assert.equal(r.managed, true);
  });

  it('a locked split-tunnel preset narrows the modes to its own', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('split_tunnel_preset', ?)")
      .run(JSON.stringify({ mode: 'exclude', networks: [{ cidr: '192.168.0.0/16' }], locked: true }));
    const r = clientPolicy.forClient(null);
    assert.deepEqual(r.policy.splitTunnelModes, ['exclude']);
    assert.equal(r.policy.splitTunnelLocked, true);
    assert.equal(r.sources.splitTunnelModes, 'preset');
    assert.equal(r.managed, true);
  });

  it('an unlocked preset does not narrow, but a conflict is reported to the admin', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('split_tunnel_preset', ?)")
      .run(JSON.stringify({ mode: 'exclude', networks: [], locked: false }));
    clientPolicy.saveGlobal({ ...clientPolicy.getGlobal(), split_tunnel_modes: ['off'] });
    const r = clientPolicy.forClient(null);
    assert.deepEqual(r.policy.splitTunnelModes, ['off']);
    assert.equal(r.policy.splitTunnelLocked, false);
    assert.deepEqual(clientPolicy.warningsFor(clientPolicy.getGlobal()), ['split_tunnel_preset_conflict']);
  });

  it('damaged stored JSON / invalid values inherit instead of locking', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_policy', '{not json')").run();
    assert.equal(clientPolicy.forClient(null).managed, false);
    assert.deepEqual(clientPolicy.parseOverride({ kill_switch: 'maybe', lock_server: 'yes', split_tunnel_modes: [], foo: 1, autostart: 'forbidden' }),
      { autostart: 'forbidden' });
  });

  it('validateInput: global rejects null / bad values, override treats null as inherit', () => {
    const current = clientPolicy.getGlobal();
    assert.equal(clientPolicy.validateInput({ kill_switch: null }, { mode: 'global', current }).error, 'invalid_value');
    assert.equal(clientPolicy.validateInput({ split_tunnel_modes: [] }, { mode: 'global', current }).error, 'invalid_value');
    assert.equal(clientPolicy.validateInput({ split_tunnel_modes: ['off', 'tunnel'] }, { mode: 'global', current }).error, 'invalid_value');
    assert.equal(clientPolicy.validateInput({ lock_settings: 'true' }, { mode: 'global', current }).error, 'invalid_value');
    assert.deepEqual(clientPolicy.validateInput({ nope: 1 }, { mode: 'global', current }), { error: 'unknown_field', field: 'nope' });
    assert.equal(clientPolicy.validateInput([], { mode: 'global', current }).error, 'invalid_policy');

    const ov = clientPolicy.validateInput({ kill_switch: 'required', autostart: null }, { mode: 'override', current: { autostart: 'forbidden' } });
    assert.deepEqual(ov.next, { kill_switch: 'required' });
    assert.deepEqual(ov.changes, { kill_switch: { from: null, to: 'required' }, autostart: { from: 'forbidden', to: null } });
    assert.deepEqual(clientPolicy.validateInput(null, { mode: 'override', current: {} }).next, {});
  });

  it('version changes with the policy and is stable otherwise', () => {
    const v1 = clientPolicy.forClient(null).version;
    assert.equal(clientPolicy.forClient(null).version, v1);
    clientPolicy.saveGlobal({ ...clientPolicy.getGlobal(), lock_server: true });
    assert.notEqual(clientPolicy.forClient(null).version, v1);
  });
});

describe('client API', () => {
  it('GET /client/policy returns the effective policy of the token peer, with ETag/304', async () => {
    const g = seedGroup('api');
    clientPolicy.setGroupOverride(g, { kill_switch: 'required' });
    const p = seedPeer('api', g);
    const token = tokenFor(p);

    const res = await getPolicy(token).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.policy.killSwitch, 'required');
    assert.equal(res.body.sources.killSwitch, 'group');
    assert.equal(res.body.managed, true);
    assert.equal(res.headers.etag, `"${res.body.version}"`);

    const cached = await getPolicy(token).set('If-None-Match', `"${res.body.version}"`);
    assert.equal(cached.status, 304);

    clientPolicy.setPeerOverride(p, { kill_switch: 'user' });
    const changed = await getPolicy(token).set('If-None-Match', `"${res.body.version}"`).expect(200);
    assert.equal(changed.body.policy.killSwitch, 'user');
    assert.notEqual(changed.body.version, res.body.version);
  });

  it('a token not bound to a peer gets the global policy', async () => {
    clientPolicy.saveGlobal({ ...clientPolicy.getGlobal(), autostart: 'required' });
    const raw = tokens.create({ name: `unbound-${crypto.randomBytes(3).toString('hex')}`, scopes: ['client'] }, '127.0.0.1').rawToken;
    const res = await getPolicy(raw).expect(200);
    assert.equal(res.body.policy.autostart, 'required');
  });

  it('the token split-tunnel override (locked) applies to that token only', async () => {
    const p = seedPeer('st');
    const token = tokenFor(p, ['client'], { splitTunnelOverride: JSON.stringify({ mode: 'include', networks: [], locked: true }) });
    const res = await getPolicy(token).expect(200);
    assert.deepEqual(res.body.policy.splitTunnelModes, ['include']);
    assert.equal(res.body.policy.splitTunnelLocked, true);
    const st = await supertest(app).get('/api/v1/client/split-tunnel').set('X-API-Token', token).expect(200);
    assert.deepEqual({ mode: st.body.mode, locked: st.body.locked, source: st.body.source }, { mode: 'include', locked: true, source: 'token' });
  });

  it('heartbeat and permissions carry the policy version', async () => {
    const p = seedPeer('hb');
    const token = tokenFor(p);
    clientPolicy.saveGlobal({ ...clientPolicy.getGlobal(), lock_settings: true });
    const pol = await getPolicy(token).expect(200);
    const hb = await supertest(app).post('/api/v1/client/heartbeat').set('X-API-Token', token)
      .send({ peerId: p, connected: true }).expect(200);
    assert.equal(hb.body.policyVersion, pol.body.version);
    const perm = await supertest(app).get('/api/v1/client/permissions').set('X-API-Token', token).expect(200);
    assert.equal(perm.body.policyVersion, pol.body.version);
  });

  it('split-tunnel endpoint behaves as before (no preset → off)', async () => {
    const p = seedPeer('st-off');
    const res = await supertest(app).get('/api/v1/client/split-tunnel').set('X-API-Token', tokenFor(p)).expect(200);
    assert.deepEqual(res.body, { ok: true, mode: 'off', networks: [], locked: false, source: 'none' });
  });
});

describe('admin API', () => {
  it('GET/PUT /settings/client-policy validates, saves and audits', async () => {
    const agent = getAgent();
    const csrf = getCsrf();
    const get = await agent.get('/api/v1/settings/client-policy').expect(200);
    assert.deepEqual(get.body.data.global, clientPolicy.DEFAULTS);

    await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf)
      .send({ kill_switch: 'sometimes' }).expect(400);
    await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf)
      .send({ split_tunnel_modes: [] }).expect(400);
    const unknown = await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf)
      .send({ hack: true }).expect(400);
    assert.equal(unknown.body.field, 'hack');

    const put = await agent.put('/api/v1/settings/client-policy').set('X-CSRF-Token', csrf)
      .send({ kill_switch: 'required', split_tunnel_modes: ['off'] }).expect(200);
    assert.equal(put.body.data.global.kill_switch, 'required');
    assert.deepEqual(put.body.data.global.split_tunnel_modes, ['off']);
    assert.equal(put.body.data.global.autostart, 'user');

    const log = getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'client_policy_updated' ORDER BY id DESC LIMIT 1").get();
    const details = JSON.parse(log.details);
    assert.deepEqual(details.kill_switch, { from: 'user', to: 'required' });
    assert.deepEqual(details.split_tunnel_modes, { from: ['off', 'exclude', 'include'], to: ['off'] });
  });

  it('group overrides: set, inherit with null, clear with {}', async () => {
    const agent = getAgent();
    const csrf = getCsrf();
    const g = seedGroup('admin');
    await agent.put('/api/v1/settings/client-policy/groups/999999').set('X-CSRF-Token', csrf).send({}).expect(404);
    const put = await agent.put(`/api/v1/settings/client-policy/groups/${g}`).set('X-CSRF-Token', csrf)
      .send({ lock_server: true, kill_switch: null }).expect(200);
    const group = put.body.data.groups.find(x => x.id === g);
    assert.deepEqual(group.policy, { lock_server: true });
    const log = getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'client_policy_group_updated' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(log.details).groupId, g);

    const cleared = await agent.put(`/api/v1/settings/client-policy/groups/${g}`).set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.deepEqual(cleared.body.data.groups.find(x => x.id === g).policy, {});
    assert.equal(getDb().prepare('SELECT client_policy FROM peer_groups WHERE id = ?').get(g).client_policy, null);
  });

  it('settings routes reject API tokens (session only), reads too', async () => {
    const raw = tokens.create({ name: `settings-${crypto.randomBytes(3).toString('hex')}`, scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).put('/api/v1/settings/client-policy').set('X-API-Token', raw)
      .send({ kill_switch: 'required' }).expect(403);
    const g = seedGroup('tok');
    await supertest(app).put(`/api/v1/settings/client-policy/groups/${g}`).set('X-API-Token', raw)
      .send({ kill_switch: 'required' }).expect(403);
    await supertest(app).get('/api/v1/settings/client-policy').set('X-API-Token', raw).expect(403);
    assert.equal(clientPolicy.getGlobal().kill_switch, 'user');
  });

  it('PUT /peers/:id client_policy: validated, audited, session only; GET /peers/:id/client-policy', async () => {
    const agent = getAgent();
    const csrf = getCsrf();
    const created = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'policy-peer' }).expect(201);
    const id = created.body.peer.id;
    clientPolicy.saveGlobal({ ...clientPolicy.getGlobal(), autostart: 'forbidden' });

    await agent.put(`/api/v1/peers/${id}`).set('X-CSRF-Token', csrf)
      .send({ name: 'policy-peer', client_policy: { autostart: 'never' } }).expect(400);

    const ok = await agent.put(`/api/v1/peers/${id}`).set('X-CSRF-Token', csrf)
      .send({ name: 'policy-peer', client_policy: { kill_switch: 'required', lock_settings: true } }).expect(200);
    assert.deepEqual(ok.body.peer.client_policy, { kill_switch: 'required', lock_settings: true });
    const log = getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'peer_client_policy_changed' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(log.details).changes.kill_switch, { from: null, to: 'required' });

    const view = await agent.get(`/api/v1/peers/${id}/client-policy`).expect(200);
    assert.equal(view.body.data.inherited.autostart, 'forbidden');
    assert.equal(view.body.data.inherited_sources.autostart, 'global');
    assert.equal(view.body.data.inherited.kill_switch, 'user');
    assert.equal(view.body.data.effective.kill_switch, 'required');
    assert.equal(view.body.data.sources.kill_switch, 'peer');

    const raw = tokens.create({ name: `peers-${crypto.randomBytes(3).toString('hex')}`, scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).put(`/api/v1/peers/${id}`).set('X-API-Token', raw)
      .send({ client_policy: null }).expect(403);
    assert.ok(getDb().prepare('SELECT client_policy FROM peers WHERE id = ?').get(id).client_policy);

    const cleared = await agent.put(`/api/v1/peers/${id}`).set('X-CSRF-Token', csrf)
      .send({ name: 'policy-peer', client_policy: null }).expect(200);
    assert.equal(cleared.body.peer.client_policy, null);

    const list = await agent.get('/api/v1/peers').expect(200);
    const row = list.body.peers.find(p => p.id === id);
    assert.equal(row.client_policy, null);
  });
});
