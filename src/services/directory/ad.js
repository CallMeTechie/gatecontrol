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
 *   • Delta (fetchDelta, sync.js "Delta"): the RootDSE of the answering
 *     domain controller gives highestCommittedUSN and dnsHostName; a full
 *     read stores both (read BEFORE the searches, so a change during the
 *     read is seen again next time). uSNChanged is local to a DC: another
 *     DC answering (a DNS name with several DCs) or a lower USN (restored
 *     DC) → FULL_SYNC_REQUIRED. Per selected group the delta asks for the
 *     member accounts with uSNChanged > the stored USN (name, mail, UPN,
 *     userAccountControl — a disabled account is seen here and disabled at
 *     once by the engine). Adding or removing members changes the GROUP
 *     (its member attribute), not the account: when the selected group or
 *     one of its nested groups changed, the complete member list of that
 *     group is read again. Deleted accounts are not visible to uSNChanged
 *     searches (they move to Deleted Objects, which needs a special
 *     control); the periodic full sync catches them.
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

/** Position for the next delta: the answering DC and its highest USN, or null. */
async function deltaPosition(client) {
  const dse = await conn.rootDse(client, ['highestCommittedUSN', 'dnsHostName', 'dsServiceName']);
  const usn = dse ? u.first(dse, 'highestCommittedUSN') : '';
  const dc = dse ? u.first(dse, 'dnsHostName').toLowerCase() : '';
  if (!/^\d{1,20}$/.test(usn) || !dc) return null;
  return { dc, service: dse ? (u.first(dse, 'dsServiceName') || null) : null, usn };
}

function usnOf(entry) {
  const v = u.first(entry, 'uSNChanged');
  return /^\d{1,20}$/.test(v) ? BigInt(v) : null;
}

function create(directory, { secret } = {}) {
  const cfg = directory.config || {};
  const run = (fn) => conn.withServiceClient(cfg, secret, fn);

  /** Every member account of the group (transitive, below the account base) into `users`. */
  async function membersOf(client, groupDn, users) {
    const { userBase } = bases(cfg);
    const filter = `(&(objectCategory=person)(objectClass=user)(memberOf:${IN_CHAIN}:=${u.escapeFilterValue(groupDn)}))`;
    const entries = await conn.searchAll(client, userBase, { filter, attributes: USER_ATTRS, explicitBufferAttributes: ['objectGUID'] });
    const members = [];
    for (const e of entries) {
      const p = userFrom(e);
      if (!p.externalId) continue;
      users.set(p.externalId, p);
      members.push(p.externalId);
    }
    return members;
  }

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

    async fetch(selected, { cursor = false } = {}) {
      const { baseDn } = bases(cfg);
      return run(async (client) => {
        // The delta position first: whatever changes during the read is seen
        // again. A RootDSE that cannot be read only means: no delta.
        let position = null;
        if (cursor) { try { position = await deltaPosition(client); } catch { position = null; } }
        const users = new Map();
        const groups = [];
        for (const sel of selected || []) {
          const entry = await findByGuid(client, baseDn, sel.externalId, '(objectClass=group)', GROUP_ATTRS);
          if (!entry) { groups.push({ externalId: sel.externalId, name: sel.name, dn: sel.dn || null, found: false, members: [] }); continue; }
          const g = groupFrom(entry);
          groups.push({ ...g, found: true, members: await membersOf(client, g.dn, users) });
        }
        const out = { groups, users: [...users.values()] };
        if (cursor) out.cursor = position;
        return out;
      });
    },

    async fetchDelta(selected, { cursor, snapshot } = {}) {
      const { baseDn, userBase } = bases(cfg);
      if (!cursor || !cursor.dc || !/^\d{1,20}$/.test(String(cursor.usn || ''))) throw u.fullSyncRequired('first');
      return run(async (client) => {
        const position = await deltaPosition(client);
        if (!position || position.dc !== cursor.dc || (cursor.service && position.service && cursor.service !== position.service)) {
          throw u.fullSyncRequired('dc_changed', `another domain controller answered (${position ? position.dc : '?'} instead of ${cursor.dc})`);
        }
        if (BigInt(position.usn) < BigInt(cursor.usn)) throw u.fullSyncRequired('usn_rollback');
        const from = BigInt(cursor.usn) + 1n;
        const changed = `(uSNChanged>=${from})`;
        const snapGroups = new Map(((snapshot && snapshot.groups) || []).map((g) => [String(g.externalId).toLowerCase(), g]));
        const users = new Map();
        const groups = [];
        for (const sel of selected || []) {
          const entry = await findByGuid(client, baseDn, sel.externalId, '(objectClass=group)', [...GROUP_ATTRS, 'uSNChanged']);
          if (!entry) { groups.push({ externalId: sel.externalId, found: false }); continue; }
          const g = groupFrom(entry);
          const snap = snapGroups.get(String(sel.externalId).toLowerCase());
          const inChain = `(memberOf:${IN_CHAIN}:=${u.escapeFilterValue(g.dn)})`;
          // Members are added / removed on the group (or a nested group), never on the account.
          let reread = !snap || !snap.found;
          if (!reread) { const usn = usnOf(entry); reread = usn == null || usn >= from; }
          if (!reread) {
            const nested = await conn.searchSome(client, baseDn, { filter: `(&(objectClass=group)${changed}${inChain})`, attributes: ['cn'] }, 1);
            reread = nested.length > 0;
          }
          if (reread) {
            groups.push({ ...g, found: true, members: await membersOf(client, g.dn, users) });
            continue;
          }
          // Same members: who of them changed. Searched in the whole domain so
          // that an account moved out of (or into) the account base is seen.
          const filter = `(&(objectCategory=person)(objectClass=user)${changed}${inChain})`;
          const entries = await conn.searchAll(client, baseDn, { filter, attributes: USER_ATTRS, explicitBufferAttributes: ['objectGUID'] });
          const have = new Set((snap.members || []).map(String));
          const add = [];
          const remove = [];
          for (const e of entries) {
            const p = userFrom(e);
            if (!p.externalId) continue;
            if (p.dn && !u.isUnder(p.dn, userBase)) { if (have.has(p.externalId)) remove.push(p.externalId); continue; }
            users.set(p.externalId, p);
            if (!have.has(p.externalId)) add.push(p.externalId);
          }
          const renamed = g.name !== snap.name || u.normDn(g.dn) !== u.normDn(snap.dn || '');
          if (add.length || remove.length || renamed) groups.push({ externalId: g.externalId, name: g.name, dn: g.dn, found: true, add, remove });
        }
        return { groups, users: [...users.values()], removedUsers: [], cursor: position };
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

module.exports = { create, userFrom, groupFrom, deltaPosition, IN_CHAIN };
