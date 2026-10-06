'use strict';

// Device binding (licence feature machine_binding) on the Users page:
// API fields of the token lists, per-token switch (only in the "individual"
// mode), reset, machine_bound_at + activity events, licence gate, the
// templates (Users page area, Settings → Gerätebindung) without raw keys.

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

const FP_A = 'ab12cd34' + 'e'.repeat(56);
const FP_B = '9f3e7a01' + 'c'.repeat(56);

let agent;
let csrf;
let license;
let settings;
let tokens;
let users;
let db;

function setMode(mode) { settings.set('machine_binding.mode', mode); }
function rawToken(id) { return db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id); }
function events(type) { return db.prepare('SELECT * FROM activity_log WHERE event_type = ? ORDER BY id').all(type); }

// A client user with one client token (binding switched on) and one
// read-only token.
function fixture() {
  const u = users.createClientUser({ username: 'anna', displayName: 'Anna' });
  const client = tokens.create({ name: 'Anna Laptop', scopes: ['client'], machineBindingEnabled: true, userId: u.id }, '127.0.0.1').token.id;
  const other = tokens.create({ name: 'Anna Tablet', scopes: ['client'], machineBindingEnabled: false, userId: u.id }, '127.0.0.1').token.id;
  return { userId: u.id, client, other };
}

beforeEach(async () => {
  ({ agent, csrfToken: csrf } = await setup());
  license = require('../src/services/license');
  settings = require('../src/services/settings');
  tokens = require('../src/services/tokens');
  users = require('../src/services/users');
  db = require('../src/db/connection').getDb();
  license._overrideForTest({ machine_binding: true });
  setMode('individual');
});
afterEach(() => {
  license._overrideForTest({ machine_binding: false });
  teardown();
});

describe('migration 88 add_machine_bound_at', () => {
  it('adds api_tokens.machine_bound_at', () => {
    const cols = db.prepare('PRAGMA table_info(api_tokens)').all().map((c) => c.name);
    assert.ok(cols.includes('machine_bound_at'));
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 88);
    assert.equal(m.name, 'add_machine_bound_at');
  });
});

describe('tokens service: binding timestamp + activity', () => {
  it('bindMachineFingerprint stamps machine_bound_at and logs machine_binding_bound once', () => {
    const { client } = fixture();
    assert.equal(rawToken(client).machine_bound_at, null);
    assert.equal(tokens.bindMachineFingerprint(client, FP_A), true);
    const row = rawToken(client);
    assert.equal(row.machine_fingerprint, FP_A);
    assert.match(row.machine_bound_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    // same device again: no second event, timestamp unchanged
    assert.equal(tokens.bindMachineFingerprint(client, FP_A), true);
    assert.equal(rawToken(client).machine_bound_at, row.machine_bound_at);
    // another device: refused, nothing logged
    assert.equal(tokens.bindMachineFingerprint(client, FP_B), false);
    const ev = events('machine_binding_bound');
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0].details).tokenId, client);
    assert.ok(!ev[0].message.includes(FP_A), 'the full fingerprint is not logged');
  });

  it('resetMachineBinding clears fingerprint and machine_bound_at; the next binding is logged again', () => {
    const { client } = fixture();
    tokens.bindMachineFingerprint(client, FP_A);
    tokens.resetMachineBinding(client);
    const row = rawToken(client);
    assert.equal(row.machine_fingerprint, null);
    assert.equal(row.machine_bound_at, null);
    assert.equal(tokens.bindMachineFingerprint(client, FP_B), true);
    assert.equal(events('machine_binding_bound').length, 2);
  });

  it('isMachineBindingActive follows licence and mode', () => {
    const on = { machine_binding_enabled: true };
    const off = { machine_binding_enabled: false };
    assert.equal(tokens.isMachineBindingActive(on, { licensed: true, mode: 'individual' }), true);
    assert.equal(tokens.isMachineBindingActive(off, { licensed: true, mode: 'individual' }), false);
    assert.equal(tokens.isMachineBindingActive(off, { licensed: true, mode: 'global' }), true);
    assert.equal(tokens.isMachineBindingActive(on, { licensed: true, mode: 'off' }), false);
    assert.equal(tokens.isMachineBindingActive(on, { licensed: false, mode: 'global' }), false);
  });

  it('client requests bind on first use (verifyMachineBinding) and refuse another device', () => {
    const { verifyMachineBinding } = require('../src/routes/api/client/helpers');
    const { client } = fixture();
    const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
    const req = (fp) => ({ tokenAuth: true, tokenId: client, headers: fp ? { 'x-machine-fingerprint': fp } : {}, t: (k) => k });
    assert.equal(verifyMachineBinding(req(FP_A), res()), true);
    assert.ok(rawToken(client).machine_bound_at);
    const r = res();
    assert.equal(verifyMachineBinding(req(FP_B), r), false);
    assert.equal(r.code, 403);
    assert.equal(events('machine_binding_bound').length, 1);
  });
});

describe('API: token lists carry the binding state', () => {
  it('GET /api/v1/users/:id — shortened fingerprint, flags, bound-at, effective state', async () => {
    const { userId, client, other } = fixture();
    tokens.bindMachineFingerprint(client, FP_A);
    const res = await agent.get(`/api/v1/users/${userId}`).expect(200);
    assert.deepEqual(res.body.machine_binding, { licensed: true, mode: 'individual' });
    const a = res.body.tokens.find((t) => t.id === client);
    const b = res.body.tokens.find((t) => t.id === other);
    assert.equal(a.machine_fingerprint, 'ab12cd34');
    assert.equal(a.machine_binding_enabled, true);
    assert.ok(a.machine_bound_at);
    assert.equal(a.machine_binding_mode, 'individual');
    assert.equal(a.machine_binding_active, true);
    assert.equal(b.machine_fingerprint, null);
    assert.equal(b.machine_bound_at, null);
    assert.equal(b.machine_binding_active, false);
    assert.ok(!res.text.includes(FP_A), 'the full fingerprint never leaves the server');
  });

  it('GET /api/v1/tokens and /users/unassigned-tokens use the same shape', async () => {
    const { client } = fixture();
    tokens.bindMachineFingerprint(client, FP_A);
    const loose = tokens.create({ name: 'loose', scopes: ['client'] }, '127.0.0.1').token.id;
    tokens.bindMachineFingerprint(loose, FP_B);
    const all = await agent.get('/api/v1/tokens').expect(200);
    assert.equal(all.body.tokens.find((t) => t.id === client).machine_fingerprint, 'ab12cd34');
    assert.ok(!all.text.includes(FP_A) && !all.text.includes(FP_B));
    const un = await agent.get('/api/v1/users/unassigned-tokens').expect(200);
    const l = un.body.tokens.find((t) => t.id === loose);
    assert.equal(l.machine_fingerprint, '9f3e7a01');
    assert.equal(l.machine_binding_mode, 'individual');
    assert.ok(!un.text.includes(FP_B));
  });

  it('global mode: every token is active, whatever its own flag', async () => {
    const { userId, other } = fixture();
    setMode('global');
    const res = await agent.get(`/api/v1/users/${userId}`).expect(200);
    const b = res.body.tokens.find((t) => t.id === other);
    assert.equal(b.machine_binding_enabled, false);
    assert.equal(b.machine_binding_active, true);
    assert.equal(b.machine_binding_mode, 'global');
  });
});

describe('API: per-token switch', () => {
  it('individual mode: an admin switches the binding of another user\'s token', async () => {
    const { other } = fixture();
    const res = await agent.put(`/api/v1/tokens/${other}/binding`).set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.token.machine_binding_enabled, true);
    assert.equal(res.body.token.machine_binding_active, true);
    assert.equal(rawToken(other).machine_binding_enabled, 1);
    const ev = events('machine_binding_toggled');
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0].details).tokenId, other);
    assert.equal(ev[0].source, 'admin');

    await agent.put(`/api/v1/tokens/${other}/binding`).set('X-CSRF-Token', csrf).send({ enabled: false }).expect(200);
    assert.equal(rawToken(other).machine_binding_enabled, 0);
  });

  it('global and off: the switch is refused (409 binding_mode), the flag stays', async () => {
    const { other } = fixture();
    for (const mode of ['global', 'off']) {
      setMode(mode);
      const res = await agent.put(`/api/v1/tokens/${other}/binding`).set('X-CSRF-Token', csrf).send({ enabled: true }).expect(409);
      assert.equal(res.body.code, 'binding_mode');
      assert.equal(res.body.mode, mode);
      assert.ok(res.body.error && !res.body.error.startsWith('error.'), 'translated error');
      assert.equal(rawToken(other).machine_binding_enabled, 0);
    }
  });

  it('rejects a non-boolean and an unknown token', async () => {
    const { other } = fixture();
    await agent.put(`/api/v1/tokens/${other}/binding`).set('X-CSRF-Token', csrf).send({ enabled: 'yes' }).expect(400);
    await agent.put('/api/v1/tokens/99999/binding').set('X-CSRF-Token', csrf).send({ enabled: true }).expect(404);
  });
});

describe('API: reset', () => {
  it('DELETE clears fingerprint + bound_at and logs machine_binding_reset (works in any mode)', async () => {
    const { userId, client } = fixture();
    tokens.bindMachineFingerprint(client, FP_A);
    setMode('global');
    const res = await agent.delete(`/api/v1/tokens/${client}/binding`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(res.body.token.machine_fingerprint, null);
    assert.equal(res.body.token.machine_bound_at, null);
    const row = rawToken(client);
    assert.equal(row.machine_fingerprint, null);
    assert.equal(row.machine_bound_at, null);
    const ev = events('machine_binding_reset');
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0].details).fingerprint, 'ab12cd34');
    assert.equal(ev[0].severity, 'warning');
    const detail = await agent.get(`/api/v1/users/${userId}`).expect(200);
    assert.equal(detail.body.tokens.find((t) => t.id === client).machine_fingerprint, null);
  });
});

describe('API: without the licence', () => {
  it('lists still carry the state (licensed:false, inactive); switch and reset answer 403', async () => {
    const { userId, client } = fixture();
    tokens.bindMachineFingerprint(client, FP_A);
    license._overrideForTest({ machine_binding: false });
    const res = await agent.get(`/api/v1/users/${userId}`).expect(200);
    assert.deepEqual(res.body.machine_binding, { licensed: false, mode: 'individual' });
    const a = res.body.tokens.find((t) => t.id === client);
    assert.equal(a.machine_binding_active, false);
    assert.equal(a.machine_fingerprint, 'ab12cd34');
    const put = await agent.put(`/api/v1/tokens/${client}/binding`).set('X-CSRF-Token', csrf).send({ enabled: false }).expect(403);
    assert.equal(put.body.feature, 'machine_binding');
    await agent.delete(`/api/v1/tokens/${client}/binding`).set('X-CSRF-Token', csrf).expect(403);
    assert.equal(rawToken(client).machine_fingerprint, FP_A);
  });
});

describe('templates', () => {
  const ROOT = path.join(__dirname, '..');
  const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/de.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8'));

  it('users.mb.* and st.mb.* exist in de and en with the same keys', () => {
    const pick = (o) => Object.keys(o).filter((k) => k.startsWith('users.mb.') || k.startsWith('st.mb.') || k.startsWith('error.tokens.binding_')).sort();
    assert.deepEqual(pick(de), pick(en));
    for (const k of ['users.mb.title', 'users.mb.bound', 'users.mb.pending', 'users.mb.inactive', 'users.mb.global', 'users.mb.reset',
      'st.mb.not_peer', 'st.mb.users_hint', 'st.mb.users_link', 'st.mb.clients', 'error.tokens.binding_toggle_failed',
      'error.tokens.binding_mode_global', 'error.tokens.binding_mode_off']) {
      assert.ok(de[k] && en[k], k);
    }
    assert.equal(de['users.mb.pending'], 'Noch nicht gebunden – wird beim nächsten Verbinden gebunden');
    assert.equal(de['users.mb.inactive'], 'Nicht aktiv');
    assert.equal(de['users.mb.global'], 'durch globale Einstellung aktiv');
    assert.equal(de['users.mb.reset'], 'Bindung zurücksetzen…');
    assert.ok(de['st.mb.clients'].includes('Android-App'));
  });

  for (const lang of ['de', 'en']) {
    it(`/users (${lang}): area hooks present, no raw keys, every island string translated`, async () => {
      const res = await agent.get(`/users?lang=${lang}`).expect(200);
      const html = res.text;
      assert.ok(html.includes('id="mb-explain"'));
      assert.ok(html.includes('id="mb-users-i18n"'));
      const visible = withoutScripts(html);
      assert.ok(!/users\.mb\.|st\.mb\./.test(visible), 'raw key in the page');
      const start = html.indexOf('id="mb-users-i18n">') + 'id="mb-users-i18n">'.length;
      const island = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
      const used = fs.readFileSync(path.join(ROOT, 'public/js/users.js'), 'utf8').match(/mbT\('([a-z_]+)'/g)
        .map((m) => m.slice(5, -1));
      for (const k of new Set(used)) {
        assert.ok(typeof island[k] === 'string' && island[k] && island[k] !== 'users.mb.' + k, `island ${k}`);
      }
    });

    it(`/settings (${lang}): Gerätebindung explains device vs. peer binding, links /users, names the clients`, async () => {
      const res = await agent.get(`/settings?lang=${lang}`).expect(200);
      const visible = withoutScripts(res.text);
      assert.ok(!/\b(st\.mb|security\.machine_binding)\.[a-z_]+/.test(visible), 'raw key in the page');
      const a = visible.indexOf('id="st-mb-facts"');
      assert.ok(a > 0, 'facts list');
      const facts = visible.slice(a, visible.indexOf('</ul>', a));
      assert.ok(facts.includes('href="/users"'), 'link to the Users page');
      assert.ok(facts.includes('Android'), 'Android client mentioned');
    });
  }
});
