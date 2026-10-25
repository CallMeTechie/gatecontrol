'use strict';

/**
 * Active Directory adapter (LDAPS or StartTLS, ldapts).
 *
 * config: { host, port, security: 'ldaps' | 'starttls', tlsServerName,
 *   caCert, baseDn, userBaseDn?, groupBaseDn?, bindDn } + the service
 *   account password (secret).
 *
 *   • Stable ids: objectGUID (users and groups) as a GUID string.
 *   • Membership is resolved transitively by the domain controller
 *     (LDAP_MATCHING_RULE_IN_CHAIN, memberOf:1.2.840.113556.1.4.1941:=<dn>):
 *     members of nested groups count as members of the selected group.
 *   • Disabled: userAccountControl bit ACCOUNTDISABLE (0x2).
 *   • Login names: sAMAccountName and userPrincipalName; e-mail: mail
 *     (fallback userPrincipalName for matching only when mail is empty).
 *   • Password check (authenticate): service bind, look the person up by
 *     objectGUID (so a moved / renamed account still works), refuse a
 *     disabled account, then bind as the person's DN. The password is only
 *     passed through, never stored.
 */

const conn = require('./ldapConn');
const u = require('./ldapUtil');

const USER_ATTRS = ['objectGUID', 'sAMAccountName', 'userPrincipalName', 'mail', 'displayName', 'givenName', 'sn', 'cn', 'userAccountControl', 'distinguishedName'];
const GROUP_ATTRS = ['objectGUID', 'cn', 'name', 'description', 'distinguishedName'];
const IN_CHAIN = '1.2.840.113556.1.4.1941';

function bases(cfg) {
  const baseDn = String(cfg.baseDn || '').trim();
  if (!baseDn) {
    const err = new Error('base DN is required');
    err.code = 'INVALID_BASE_DN';
    throw err;
  }
  return {
    baseDn,
    userBase: String(cfg.userBaseDn || '').trim() || baseDn,
    groupBase: String(cfg.groupBaseDn || '').trim() || baseDn,
  };
}

function guidOf(entry) {
  const raw = u.rawFirst(entry, 'objectGUID');
  if (Buffer.isBuffer(raw)) return u.guidToString(raw);
  return '';
}

function userFrom(entry) {
  const uac = Number.parseInt(u.first(entry, 'userAccountControl'), 10) || 0;
  const given = u.first(entry, 'givenName');
  const sn = u.first(entry, 'sn');
  return {
    externalId: guidOf(entry),
    loginName: u.first(entry, 'sAMAccountName') || null,
    upn: u.first(entry, 'userPrincipalName') || null,
    dn: entry.dn || u.first(entry, 'distinguishedName') || null,
    email: u.first(entry, 'mail') || null,
    displayName: u.first(entry, 'displayName') || [given, sn].filter(Boolean).join(' ') || u.first(entry, 'cn') || null,
    enabled: (uac & 0x2) === 0,
  };
}

function groupFrom(entry) {
  return {
    externalId: guidOf(entry),
    name: u.first(entry, 'cn') || u.first(entry, 'name'),
    dn: entry.dn || u.first(entry, 'distinguishedName') || null,
    description: u.first(entry, 'description') || null,
  };
}

function create(directory, { secret } = {}) {
  const cfg = directory.config || {};
  const run = (fn) => conn.withServiceClient(cfg, secret, fn);

  async function findByGuid(client, base, guid, filterClass, attributes) {
    if (!u.isGuid(guid)) return null;
    const filter = `(&${filterClass}(objectGUID=${u.escapeBinary(u.guidToBuffer(guid))}))`;
    const res = await conn.searchSome(client, base, { filter, attributes, explicitBufferAttributes: ['objectGUID'] }, 1);
    return res[0] || null;
  }

  return {
    kind: 'ad',

    async test() {
      const { baseDn, groupBase } = bases(cfg);
      return run(async (client) => {
        const groups = await conn.searchSome(client, groupBase, { filter: '(objectClass=group)', attributes: ['cn'] }, 5);
        return { ok: true, details: { server: conn.urlFor(cfg), baseDn, sampleGroups: groups.length } };
      });
    },

    async searchGroups(query, { limit = 50 } = {}) {
      const { groupBase } = bases(cfg);
      const q = String(query || '').trim().slice(0, 100);
      const filter = q
        ? `(&(objectClass=group)(|(cn=*${u.escapeFilterValue(q)}*)(description=*${u.escapeFilterValue(q)}*)))`
        : '(objectClass=group)';
      return run(async (client) => {
        const entries = await conn.searchSome(client, groupBase, { filter, attributes: GROUP_ATTRS, explicitBufferAttributes: ['objectGUID'] }, limit);
        return entries.map(groupFrom).filter((g) => g.externalId).sort((a, b) => a.name.localeCompare(b.name));
      });
    },

    async fetch(selected) {
      const { baseDn, userBase } = bases(cfg);
      return run(async (client) => {
        const users = new Map();
        const groups = [];
        for (const sel of selected || []) {
          const entry = await findByGuid(client, baseDn, sel.externalId, '(objectClass=group)', GROUP_ATTRS);
          if (!entry) { groups.push({ externalId: sel.externalId, name: sel.name, dn: sel.dn || null, found: false, members: [] }); continue; }
          const g = groupFrom(entry);
          const filter = `(&(objectCategory=person)(objectClass=user)(memberOf:${IN_CHAIN}:=${u.escapeFilterValue(g.dn)}))`;
          const entries = await conn.searchAll(client, userBase, { filter, attributes: USER_ATTRS, explicitBufferAttributes: ['objectGUID'] });
          const members = [];
          for (const e of entries) {
            const p = userFrom(e);
            if (!p.externalId) continue;
            users.set(p.externalId, p);
            members.push(p.externalId);
          }
          groups.push({ ...g, found: true, members });
        }
        return { groups, users: [...users.values()] };
      });
    },

    async authenticate(link, password) {
      if (typeof password !== 'string' || password.length === 0) return { ok: false, reason: 'invalid' };
      const { baseDn } = bases(cfg);
      const client = await conn.open(cfg);
      try {
        await client.bind(String(cfg.bindDn || ''), secret || '');
        const entry = await findByGuid(client, baseDn, link.external_id, '(objectClass=user)', USER_ATTRS);
        if (!entry) return { ok: false, reason: 'not_found' };
        const p = userFrom(entry);
        if (!p.enabled) return { ok: false, reason: 'disabled' };
        try {
          await client.bind(p.dn, password);
        } catch (err) {
          if (conn.isInvalidCredentials(err)) return { ok: false, reason: 'invalid' };
          throw err;
        }
        return { ok: true, profile: p };
      } finally {
        try { await client.unbind(); } catch { /* closed */ }
      }
    },
  };
}

module.exports = { create, userFrom, groupFrom, IN_CHAIN };
