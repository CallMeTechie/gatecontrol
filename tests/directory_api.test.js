'use strict';

// Admin API /api/v1/directories (admin session only), the page
// /directory and the account source on the user profile API.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => {
  require('../src/services/directory/adapters')._setFactory(null);
  teardown();
});

function db() { return require('../src/db/connection').getDb(); }
const api = (method, path) => agent[method](path).set('X-CSRF-Token', csrf);

const fake = { users: new Map(), groups: new Map(), fail: false };
function installFake() {
  require('../src/services/directory/adapters')._setFactory(() => ({
    async test() { if (fake.fail) { const e = new Error('connect ECONNREFUSED'); throw e; } return { ok: true, details: { sampleGroups: fake.groups.size } }; },
    async searchGroups(q) {
      if (fake.fail) throw new Error('connect ECONNREFUSED');
      return [...fake.groups.entries()].filter(([, g]) => !q || g.name.toLowerCase().includes(q.toLowerCase()))
        .map(([id, g]) => ({ externalId: id, name: g.name, dn: `CN=${g.name}`, description: null }));
    },
    async fetch(selected) {
      if (fake.fail) throw new Error('connect ECONNREFUSED');
      const users = new Map();
      const groups = selected.map((s) => {
        const g = fake.groups.get(s.externalId);
        if (!g) return { externalId: s.externalId, name: s.name, found: false, members: [] };
        g.members.forEach((m) => users.set(m, fake.users.get(m)));
        return { externalId: s.externalId, name: g.name, found: true, members: [...g.members] };
      });
      return { groups, users: [...users.values()] };
    },
    async authenticate() { return { ok: false, reason: 'invalid' }; },
  }));
}

const AD = {
  kind: 'ad', name: 'Corp AD', secret: 'Svc!Secret99',
  config: { host: 'dc01.corp.local', security: 'ldaps', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' },
};

async function waitIdle(id) {
  for (let i = 0; i < 100; i++) {
    const r = await api('get', `/api/v1/directories/${id}`);
    if (!r.body.running) return r.body;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('sync did not finish');
}

describe('access', () => {
  it('admin session only: member 403, API token 403, nobody 401; the page redirects members', async () => {
    const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
    db().prepare("INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES ('dir-member', ?, 'user', 1)").run(hash);
    const a = supertest.agent(app);
    const page = await a.get('/login');
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    await a.post('/login').type('form').send({ username: 'dir-member', password: 'Plain!Pass1234', _csrf: c }).expect(302);
    assert.equal((await a.get('/api/v1/directories')).status, 403);
    const p = await a.get('/directory');
    assert.equal(p.status, 302);
    const token = require('../src/services/tokens').create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    assert.equal((await supertest(app).get('/api/v1/directories').set('Authorization', `Bearer ${token}`)).status, 403);
    assert.ok([401, 302].includes((await supertest(app).get('/api/v1/directories')).status));
  });

  it('renders the admin page with its strings and the sidebar entry', async () => {
    const r = await agent.get('/directory').expect(200);
    assert.match(r.text, /id="dir-page"/);
    assert.match(r.text, /id="dir-i18n"/);
    assert.match(r.text, /href="\/directory"/);
    assert.match(r.text, /\/js\/directory\.js/);
  });
});

describe('CRUD, test, groups, sync, runs, conflicts', () => {
  let id;
  before(() => {
    installFake();
    fake.users.set('anna', { externalId: 'anna', loginName: 'anna', upn: 'anna@corp.local', email: 'anna@firma.de', displayName: 'Anna', enabled: true });
    fake.users.set('jk', { externalId: 'jk', loginName: 'jk', email: 'j.keller@firma.de', displayName: 'J. Keller', enabled: true });
    fake.groups.set('g1', { name: 'Buchhaltung', members: new Set(['anna', 'jk']) });
    fake.groups.set('g2', { name: 'Einkauf', members: new Set(['anna']) });
  });

  it('creates a directory; the secret is never returned', async () => {
    const r = await api('post', '/api/v1/directories').send(AD).expect(201);
    id = r.body.directory.id;
    assert.equal(r.body.directory.hasSecret, true);
    assert.equal(JSON.stringify(r.body).includes('Svc!Secret99'), false);
    const list = await api('get', '/api/v1/directories').expect(200);
    assert.equal(JSON.stringify(list.body).includes('Svc!Secret99'), false);
    assert.equal(list.body.directories.find((d) => d.id === id).config.port, 636);
    const bad = await api('post', '/api/v1/directories').send({ ...AD, config: { ...AD.config, security: 'none' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_SECURITY');
    const noCsrf = await agent.post('/api/v1/directories').send(AD);
    assert.equal(noCsrf.status, 403);
  });

  it('tests the connection (stored and unsaved settings) and reports failures safely', async () => {
    const ok = await api('post', `/api/v1/directories/${id}/test`).expect(200);
    assert.equal(ok.body.ok, true);
    const draft = await api('post', '/api/v1/directories/test').send({ kind: 'ldap', config: { host: 'nas.local', security: 'starttls', baseDn: 'dc=nas', bindDn: 'uid=root,cn=users,dc=nas' }, secret: 'x' }).expect(200);
    assert.equal(draft.body.ok, true);
    fake.fail = true;
    const down = await api('post', `/api/v1/directories/${id}/test`).expect(200);
    assert.equal(down.body.ok, false);
    assert.ok(down.body.error);
    const search = await api('get', `/api/v1/directories/${id}/groups?q=buch`);
    assert.equal(search.status, 502);
    fake.fail = false;
  });

  it('searches directory groups and saves the selection', async () => {
    const s = await api('get', `/api/v1/directories/${id}/groups?q=buch`).expect(200);
    assert.deepEqual(s.body.groups.map((g) => g.name), ['Buchhaltung']);
    assert.equal(s.body.groups[0].selected, false);
    const p = await api('patch', `/api/v1/directories/${id}`).send({ selectedGroups: [{ externalId: 'g1', name: 'Buchhaltung' }], intervalMin: 30, secret: '' }).expect(200);
    assert.equal(p.body.directory.intervalMin, 30);
    assert.equal(p.body.directory.selectedGroups.length, 1);
    assert.equal(require('../src/services/directory/store').secretOf(require('../src/services/directory/store').load(id)), 'Svc!Secret99', 'empty secret keeps it');
    const bad = await api('patch', `/api/v1/directories/${id}`).send({ intervalMin: 3 });
    assert.equal(bad.body.code, 'INVALID_INTERVAL');
    const full = await api('patch', `/api/v1/directories/${id}`).send({ fullSyncHours: 12 }).expect(200);
    assert.equal(full.body.directory.fullSyncHours, 12);
    const badFull = await api('patch', `/api/v1/directories/${id}`).send({ fullSyncHours: 0 });
    assert.equal(badFull.status, 400);
    assert.equal(badFull.body.code, 'INVALID_FULL_INTERVAL');
  });

  it('syncs in the background, lists runs with details, shows and resolves conflicts', async () => {
    db().prepare("INSERT INTO users (username, password_hash, role, email) VALUES ('jkeller', '!', 'user', 'j.keller@firma.de')").run();
    await api('post', `/api/v1/directories/${id}/sync`).expect(202);
    await waitIdle(id);
    const runs = await api('get', `/api/v1/directories/${id}/runs`).expect(200);
    assert.equal(runs.body.runs[0].status, 'ok');
    assert.equal(runs.body.runs[0].summary.created, 1);
    const run = await api('get', `/api/v1/directories/${id}/runs/${runs.body.runs[0].id}`).expect(200);
    assert.equal(run.body.run.details.created[0].username, 'anna');
    assert.equal(run.body.run.details.conflicts.length, 1);
    const conflicts = await api('get', `/api/v1/directories/${id}/conflicts`).expect(200);
    assert.equal(conflicts.body.conflicts.length, 1);
    const cid = conflicts.body.conflicts[0].id;
    const merged = await api('post', `/api/v1/directories/${id}/conflicts/${cid}/merge`).expect(200);
    assert.equal(merged.body.conflict.status, 'merged');
    const again = await api('post', `/api/v1/directories/${id}/conflicts/${cid}/separate`);
    assert.equal(again.status, 409);
    const dir = await api('get', `/api/v1/directories/${id}`).expect(200);
    assert.equal(dir.body.directory.stats.linked, 2);
    // "Vollständig abgleichen"
    const forced = await api('post', `/api/v1/directories/${id}/sync`).send({ full: true }).expect(202);
    assert.equal(forced.body.full, true);
    const after = await waitIdle(id);
    assert.equal(after.directory.lastRunMode, 'full');
    const last = await api('get', `/api/v1/directories/${id}/runs?limit=1`).expect(200);
    assert.equal(last.body.runs[0].mode, 'full');
  });

  it('the user profile API shows the account source', async () => {
    const anna = db().prepare("SELECT id FROM users WHERE username = 'anna'").get().id;
    const r = await api('get', `/api/v1/users/${anna}`).expect(200);
    assert.equal(r.body.directory.name, 'Corp AD');
    assert.equal(r.body.directory.kind, 'ad');
    const admin = await api('get', '/api/v1/users/1').expect(200);
    assert.equal(admin.body.directory, null);
  });

  it('confirms and discards a stopped mass change over the API', async () => {
    for (let i = 0; i < 5; i++) {
      fake.users.set(`p${i}`, { externalId: `p${i}`, loginName: `p${i}`, email: null, displayName: `P${i}`, enabled: true });
      fake.groups.get('g1').members.add(`p${i}`);
    }
    await api('post', `/api/v1/directories/${id}/sync`).expect(202);
    await waitIdle(id);
    fake.groups.get('g1').members.clear();
    await api('post', `/api/v1/directories/${id}/sync`).expect(202);
    const d = await waitIdle(id);
    assert.ok(d.directory.pendingRun);
    const runId = d.directory.pendingRun.id;
    const discard = await api('post', `/api/v1/directories/${id}/runs/${runId}/discard`).expect(200);
    assert.equal(discard.body.run.status, 'discarded');
    await api('post', `/api/v1/directories/${id}/sync`).expect(202);
    const d2 = await waitIdle(id);
    const conf = await api('post', `/api/v1/directories/${id}/runs/${d2.directory.pendingRun.id}/confirm`).expect(200);
    assert.equal(conf.body.run.status, 'ok');
    assert.ok(conf.body.run.summary.disabled >= 5);
    const notPending = await api('post', `/api/v1/directories/${id}/runs/${runId}/confirm`);
    assert.equal(notPending.status, 409);
  });

  it('deletes only with the name typed', async () => {
    const wrong = await api('delete', `/api/v1/directories/${id}?confirm=nope`);
    assert.equal(wrong.status, 400);
    await api('delete', `/api/v1/directories/${id}?confirm=${encodeURIComponent('Corp AD')}`).expect(200);
    assert.equal((await api('get', `/api/v1/directories/${id}`)).status, 404);
  });
});
