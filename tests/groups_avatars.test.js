'use strict';

// Profile pictures and favourite colours on the group pages (docs/groups.md,
// docs/feature-avatars.md): the admin API (members, default successor), the
// people list of the admin picker (/api/v1/principals), the portal tab
// "Gruppen" (leaders, members) and the invitation page show the same look as
// the users page. The plugin API keeps its documented member fields.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
const ROOT = path.join(__dirname, '..');
let app, agent, csrf, groups, team;
const U = {};
const AVATAR_ID = 'AbCdEfGhIjKlMnOpQrStUvWx';

function portalAgent(ip) {
  const a = supertest.agent(app);
  const wrap = (m) => (p) => a[m](p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip);
  return { get: wrap('get'), post: wrap('post') };
}
async function signedIn(userId) {
  const dev = H.makeDevice(userId, { name: 'ga-phone' });
  const r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`).send({}).expect(200);
  const p = portalAgent(dev.ip);
  await p.get('/auto?t=' + new URL(r.body.url).searchParams.get('t')).expect(302);
  return p;
}

before(async () => {
  ({ app, agent, csrfToken: csrf } = await setup());
  groups = require('../src/services/groups');
  for (const n of ['lea', 'max', 'nina']) U[n] = H.makeUser('ga-' + n);
  // lea: a picture; max: a favourite colour; nina: neither (colour from the id)
  H.db().prepare("INSERT INTO user_avatars (user_id, avatar_id, mime, data) VALUES (?, ?, 'image/png', ?)").run(U.lea, AVATAR_ID, Buffer.from('x'));
  H.db().prepare("UPDATE users SET avatar_color = 'teal' WHERE id = ?").run(U.max);
  team = groups.create({ kind: 'team', name: 'GA Team' });
  groups.setMember(team.id, U.lea, 'lead');
  groups.setMember(team.id, U.max, 'admin');
  groups.setMember(team.id, U.nina, 'member');
});
after(() => teardown());

const byId = (list) => new Map(list.map((m) => [m.userId != null ? m.userId : m.id, m]));

describe('admin API', () => {
  it('members carry avatarUrl, color and colorHex', async () => {
    const r = await agent.get(`/api/v1/groups/${team.id}`).expect(200);
    const m = byId(r.body.members);
    assert.equal(m.get(U.lea).avatarUrl, `/avatars/${AVATAR_ID}.png`);
    assert.ok(m.get(U.lea).color);
    assert.equal(m.get(U.max).avatarUrl, null);
    assert.equal(m.get(U.max).color, 'teal');
    assert.equal(m.get(U.max).colorHex, '#14B8A6');
    assert.ok(m.get(U.nina).color, 'a colour derived from the id is never null');
  });

  it('the default successor and the people of the picker carry the look', async () => {
    const u = await agent.get(`/api/v1/groups/${team.id}/usage`).expect(200);
    assert.equal(u.body.defaultSuccessor.userId, U.lea);
    assert.equal(u.body.defaultSuccessor.avatarUrl, `/avatars/${AVATAR_ID}.png`);
    const p = await agent.get('/api/v1/principals').expect(200);
    const users = byId(p.body.users);
    assert.equal(users.get(U.lea).avatarUrl, `/avatars/${AVATAR_ID}.png`);
    assert.equal(users.get(U.max).color, 'teal');
  });

  it('the plugin API keeps its documented member fields', () => {
    const memberView = require('../src/services/plugins/groups');
    const plugin = { id: 'ga', manifest: { permissions: { groups: 'read' } } };
    const list = memberView.call(plugin, 'members', { id: team.id });
    const done = (ms) => {
      for (const m of ms) {
        assert.equal('avatarUrl' in m, false);
        assert.equal('email' in m, false);
      }
    };
    return Promise.resolve(list).then(done);
  });

  it('the page loads GCAvatar and paints people with it', async () => {
    const page = await agent.get('/groups').expect(200);
    assert.ok(page.text.indexOf('/js/avatar-edit.js') >= 0 && page.text.indexOf('/js/avatar-edit.js') < page.text.indexOf('/js/groups.js'));
    assert.match(page.text, /id="grp-member-user" role="radiogroup"/);
    assert.match(page.text, /id="grp-del-successor-av"/);
    const js = fs.readFileSync(path.join(ROOT, 'public/js/groups.js'), 'utf8');
    assert.match(js, /GCAvatar\.paint\(n, \{ avatarUrl: p\.avatarUrl, color: p\.color/);
    assert.doesNotMatch(js, /us-avatar us-tone-member grp-avatar' \+ \(m\.enabled/, 'no initials-only member avatar left');
    assert.doesNotMatch(js, /\.innerHTML\s*=/);
  });
});

describe('portal tab "Gruppen"', () => {
  it('leaders and members carry the look', async () => {
    const p = await signedIn(U.max);
    const r = await p.get(`/api/v1/portal/groups/${team.id}`).expect(200);
    const lead = r.body.leaders.find((l) => l.userId === U.lea);
    assert.equal(lead.avatarUrl, `/avatars/${AVATAR_ID}.png`);
    const m = byId(r.body.members);
    assert.equal(m.get(U.max).color, 'teal');
    assert.equal(m.get(U.lea).avatarUrl, `/avatars/${AVATAR_ID}.png`);
    const list = await p.get('/api/v1/portal/groups').expect(200);
    assert.equal(list.body.groups.find((g) => g.id === team.id).leaders[0].avatarUrl, `/avatars/${AVATAR_ID}.png`);
    const js = fs.readFileSync(path.join(ROOT, 'public/js/portal.js'), 'utf8');
    assert.match(js, /function grpAvatar\(p\)/);
    assert.doesNotMatch(js, /pt-grp-av', 'aria-hidden': 'true' \}, initials\(m\.name\)/);
  });

  it('the invitation page shows who joins and who leads — only when signed in', async () => {
    const inv = groups.createInvite(team.id, { role: 'member', expiresInDays: 1, maxUses: 5 });
    const anon = await supertest(app).get(`/portal/groups/join/${inv.token}`).expect(200);
    assert.doesNotMatch(anon.text, /grp-join-person/);
    const outsider = H.makeUser('ga-olga');
    const p = await signedIn(outsider);
    const page = await p.get(`/portal/groups/join/${inv.token}`).expect(200);
    assert.match(page.text, /class="grp-join-person"/);
    assert.ok(page.text.includes(`<img class="av-img" src="/avatars/${AVATAR_ID}.png" alt="">`), 'the lead with the picture');
    assert.match(page.text, /ga-olga/);
  });
});
