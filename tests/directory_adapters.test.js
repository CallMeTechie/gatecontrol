'use strict';

// The generic LDAP adapter (fake ldapts client: nested groupOfNames,
// memberUid, disabled attribute, escaping) and the Entra adapter (fake
// Graph: client-credentials token, paging, disabled users, missing group).

require('./helpers/test-env');
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const conn = require('../src/services/directory/ldapConn');
const entra = require('../src/services/directory/entra');

after(() => { conn._setClientFactory(null); entra._setFetch(null); });

describe('LDAP adapter (fake ldapts client)', () => {
  let calls;
  const people = [
    { dn: 'uid=anna,ou=people,dc=nas', entryUUID: 'u-anna', uid: 'anna', mail: 'anna@firma.de', displayName: 'Anna' },
    { dn: 'uid=ben,ou=people,dc=nas', entryUUID: 'u-ben', uid: 'ben', mail: 'ben@firma.de', cn: 'Ben B' },
    { dn: 'uid=carl,ou=people,dc=nas', entryUUID: 'u-carl', uid: 'carl', nsAccountLock: 'TRUE' },
  ];
  const groupsByDn = {
    'cn=team,ou=groups,dc=nas': { dn: 'cn=team,ou=groups,dc=nas', entryUUID: 'g-team', cn: 'team', member: ['uid=anna,ou=people,dc=nas', 'cn=sub,ou=groups,dc=nas'] },
    'cn=sub,ou=groups,dc=nas': { dn: 'cn=sub,ou=groups,dc=nas', entryUUID: 'g-sub', cn: 'sub', member: ['uid=ben,ou=people,dc=nas', 'uid=carl,ou=people,dc=nas', 'cn=team,ou=groups,dc=nas'] },
    'cn=posix,ou=groups,dc=nas': { dn: 'cn=posix,ou=groups,dc=nas', entryUUID: 'g-posix', cn: 'posix', memberUid: ['anna', 'ben'] },
  };
  function client() {
    return {
      async startTLS() { calls.push(['startTLS']); },
      async bind(dn, pw) { calls.push(['bind', dn, pw]); },
      async *searchPaginated(base, opts) {
        calls.push(['search', base, opts.filter, opts.scope]);
        if (opts.scope === 'base') { yield { searchEntries: groupsByDn[base] ? [groupsByDn[base]] : [] }; return; }
        if (base === 'ou=people,dc=nas') { yield { searchEntries: people }; return; }
        const m = opts.filter.match(/\(entryUUID=([^)]*)\)/);
        const hit = m && Object.values(groupsByDn).find((g) => g.entryUUID === m[1]);
        yield { searchEntries: hit ? [hit] : [] };
      },
      async unbind() {},
    };
  }
  beforeEach(() => { calls = []; conn._setClientFactory(client); });
  const base = { host: 'nas.local', security: 'starttls', baseDn: 'dc=nas', userBaseDn: 'ou=people,dc=nas', groupBaseDn: 'ou=groups,dc=nas', bindDn: 'uid=root,cn=users,dc=nas' };

  it('follows nested groups (cycle-safe) and honours the disabled attribute', async () => {
    const a = require('../src/services/directory/ldap').create({ kind: 'ldap', config: { ...base, attrs: { disabled: 'nsAccountLock' } } }, { secret: 's' });
    const data = await a.fetch([{ externalId: 'g-team', name: 'team' }, { externalId: 'g-gone', name: 'gone' }]);
    assert.deepEqual(data.groups[0].members.sort(), ['u-anna', 'u-ben', 'u-carl']);
    assert.equal(data.groups[1].found, false);
    const carl = data.users.find((x) => x.externalId === 'u-carl');
    assert.equal(carl.enabled, false);
    assert.equal(data.users.find((x) => x.externalId === 'u-ben').displayName, 'Ben B');
    assert.ok(calls.some((c) => c[0] === 'startTLS'));
  });

  it('reads memberUid groups (Synology / posixGroup)', async () => {
    const a = require('../src/services/directory/ldap').create({ kind: 'ldap', config: { ...base, attrs: { member: 'memberUid' } } }, { secret: 's' });
    const data = await a.fetch([{ externalId: 'g-posix', name: 'posix' }]);
    assert.deepEqual(data.groups[0].members.sort(), ['u-anna', 'u-ben']);
  });

  it('escapes the search text and ids in filters', async () => {
    const a = require('../src/services/directory/ldap').create({ kind: 'ldap', config: base }, { secret: 's' });
    await a.searchGroups('x*)(cn=*');
    const f = calls.find((c) => c[0] === 'search')[2];
    assert.ok(f.includes('(cn=*x\\2a\\29\\28cn=\\2a*)'), f);
    calls = [];
    await a.authenticate({ external_id: 'u-anna)(uid=*' }, 'pw');
    const f2 = calls.find((c) => c[0] === 'search')[2];
    assert.ok(f2.includes('(entryUUID=u-anna\\29\\28uid=\\2a)'), f2);
  });
});

describe('Entra adapter (fake Graph)', () => {
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const CLIENT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const G1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const U = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
  let seen;
  function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  beforeEach(() => {
    seen = [];
    entra._tokenCache.clear();
    entra._setFetch(async (url, init = {}) => {
      const s = String(url);
      seen.push({ url: s, headers: init.headers || {} });
      if (s === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
        const b = new URLSearchParams(init.body);
        if (b.get('client_secret') !== 'sec' || b.get('grant_type') !== 'client_credentials') return json({ error: 'invalid_client' }, 401);
        return json({ access_token: 'tok', expires_in: 3600 });
      }
      if (init.headers.authorization !== 'Bearer tok') return json({ error: { code: 'InvalidAuthenticationToken' } }, 401);
      if (s === `https://graph.microsoft.com/v1.0/groups/${G1}?$select=id,displayName`) return json({ id: G1, displayName: 'Vertrieb' });
      if (s.startsWith(`https://graph.microsoft.com/v1.0/groups/${G1}/transitiveMembers/microsoft.graph.user`)) {
        return json({ value: [{ id: U(1), displayName: 'Ana', mail: 'ana@firma.de', userPrincipalName: 'ana@firma.onmicrosoft.com', accountEnabled: true }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' });
      }
      if (s === 'https://graph.microsoft.com/v1.0/page2') return json({ value: [{ id: U(2), displayName: 'Bo', userPrincipalName: 'bo@firma.onmicrosoft.com', accountEnabled: false }] });
      if (s.startsWith('https://graph.microsoft.com/v1.0/groups?$search=')) return json({ value: [{ id: G1, displayName: 'Vertrieb' }] });
      return json({ error: { code: 'Request_ResourceNotFound' } }, 404);
    });
  });

  it('fetches transitive members with paging, maps disabled accounts, reports a missing group', async () => {
    const a = entra.create({ kind: 'entra', config: { tenantId: TENANT, clientId: CLIENT } }, { secret: 'sec' });
    const missing = 'aaaaaaaa-0000-4000-8000-0000000000ff';
    const data = await a.fetch([{ externalId: G1, name: 'x' }, { externalId: missing, name: 'Alt' }]);
    assert.equal(data.groups[0].name, 'Vertrieb');
    assert.deepEqual(data.groups[0].members, [U(1), U(2)]);
    assert.equal(data.groups[1].found, false);
    assert.equal(data.users.find((x) => x.externalId === U(2)).enabled, false);
    assert.equal(data.users.find((x) => x.externalId === U(1)).loginName, 'ana@firma.onmicrosoft.com');
    const memberCall = seen.find((x) => x.url.includes('transitiveMembers'));
    assert.equal(memberCall.headers.ConsistencyLevel, 'eventual');
    assert.equal(seen.filter((x) => x.url.endsWith('/token')).length, 1, 'the token is cached');
    assert.deepEqual((await a.searchGroups('Vert')).map((g) => g.name), ['Vertrieb']);
  });

  it('a refused secret or an unreachable Graph throws (the engine then changes nothing)', async () => {
    const bad = entra.create({ kind: 'entra', config: { tenantId: TENANT, clientId: CLIENT } }, { secret: 'wrong' });
    await assert.rejects(bad.fetch([{ externalId: G1, name: 'x' }]), (e) => e.code === 'AUTH_FAILED');
    entra._setFetch(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    entra._tokenCache.clear();
    const a = entra.create({ kind: 'entra', config: { tenantId: TENANT, clientId: CLIENT } }, { secret: 'sec' });
    await assert.rejects(a.test(), (e) => e.code === 'UNREACHABLE');
    assert.deepEqual(await a.authenticate({}, 'pw'), { ok: false, reason: 'oidc_only' });
  });
});
