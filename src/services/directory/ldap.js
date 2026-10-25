'use strict';

/**
 * Generic LDAP adapter: OpenLDAP, Synology Directory Server, FreeIPA, …
 * (LDAPS or StartTLS, ldapts). Everything that differs between servers is
 * configurable:
 *
 * config: { host, port, security, tlsServerName, caCert, baseDn,
 *   userBaseDn?, groupBaseDn?, bindDn,
 *   userFilter   default '(|(objectClass=inetOrgPerson)(objectClass=posixAccount))'
 *   groupFilter  default '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))'
 *   attrs: {
 *     id        stable user id            default 'entryUUID'  (FreeIPA: ipaUniqueID)
 *     login     login name                default 'uid'
 *     email                               default 'mail'
 *     name      display name              default 'displayName' (fallback cn)
 *     groupId   stable group id           default 'entryUUID'
 *     groupName                           default 'cn'
 *     member    membership attribute of the group: 'member' / 'uniqueMember'
 *               (DNs, nested groups are followed) or 'memberUid' (login
 *               names, posixGroup)        default 'member'
 *     disabled  optional attribute that marks a disabled account, e.g.
 *               'nsAccountLock' (FreeIPA, 389 DS) or 'pwdAccountLockedTime'
 *               (OpenLDAP ppolicy); present and not FALSE/0 = disabled
 *   } }
 *
 * Membership: the selected group's member values; DN members that are
 * groups themselves are resolved recursively (cycle-safe, depth ≤ 10).
 * Password check: service bind, look the person up by the id attribute,
 * then bind as that DN.
 */

const conn = require('./ldapConn');
const u = require('./ldapUtil');

const DEFAULTS = Object.freeze({
  userFilter: '(|(objectClass=inetOrgPerson)(objectClass=posixAccount))',
  groupFilter: '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))',
  attrs: Object.freeze({
    id: 'entryUUID', login: 'uid', email: 'mail', name: 'displayName',
    groupId: 'entryUUID', groupName: 'cn', member: 'member', disabled: '',
  }),
});
const ATTR_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const MAX_NESTING = 10;

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/** A filter typed by the admin: must be one parenthesised expression. */
function cleanFilter(f, fallback) {
  const s = String(f == null ? '' : f).trim();
  if (!s) return fallback;
  if (s.length > 500 || !s.startsWith('(') || !s.endsWith(')')) throw codedError('INVALID_FILTER', 'filters must be a parenthesised LDAP filter');
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0 && i !== s.length - 1) throw codedError('INVALID_FILTER', 'unbalanced filter'); }
    if (depth < 0) throw codedError('INVALID_FILTER', 'unbalanced filter');
  }
  if (depth !== 0) throw codedError('INVALID_FILTER', 'unbalanced filter');
  return s;
}

function attrsOf(cfg) {
  const a = { ...DEFAULTS.attrs, ...((cfg && cfg.attrs) || {}) };
  for (const k of Object.keys(DEFAULTS.attrs)) {
    const v = String(a[k] == null ? '' : a[k]).trim();
    if (k === 'disabled' && !v) { a[k] = ''; continue; }
    if (!ATTR_RE.test(v)) throw codedError('INVALID_ATTRIBUTE', `attribute "${k}" is not a valid attribute name`);
    a[k] = v;
  }
  if (!['member', 'uniquemember', 'memberuid'].includes(a.member.toLowerCase())) {
    throw codedError('INVALID_ATTRIBUTE', 'member must be member, uniqueMember or memberUid');
  }
  return a;
}

function settings(cfg) {
  const baseDn = String(cfg.baseDn || '').trim();
  if (!baseDn) throw codedError('INVALID_BASE_DN', 'base DN is required');
  return {
    baseDn,
    userBase: String(cfg.userBaseDn || '').trim() || baseDn,
    groupBase: String(cfg.groupBaseDn || '').trim() || baseDn,
    userFilter: cleanFilter(cfg.userFilter, DEFAULTS.userFilter),
    groupFilter: cleanFilter(cfg.groupFilter, DEFAULTS.groupFilter),
    attrs: attrsOf(cfg),
  };
}

/** A stable id value as a string (objectGUID-style binary ids too). */
function idOf(entry, attr) {
  const raw = u.rawFirst(entry, attr);
  if (raw == null) return '';
  if (Buffer.isBuffer(raw)) return raw.length === 16 && attr.toLowerCase() === 'objectguid' ? u.guidToString(raw) : raw.toString('utf8');
  return String(raw);
}

function isDisabled(entry, attr) {
  if (!attr) return false;
  const vals = u.all(entry, attr);
  if (!vals.length) return false;
  return vals.some((v) => !['false', '0', ''].includes(String(v).trim().toLowerCase()));
}

function userFrom(entry, s) {
  const a = s.attrs;
  return {
    externalId: idOf(entry, a.id),
    loginName: u.first(entry, a.login) || null,
    upn: null,
    dn: entry.dn || null,
    email: u.first(entry, a.email) || null,
    displayName: u.first(entry, a.name) || u.first(entry, 'cn') || null,
    enabled: !isDisabled(entry, a.disabled),
  };
}

function userAttrs(s) {
  const a = s.attrs;
  return [...new Set([a.id, a.login, a.email, a.name, 'cn', a.disabled].filter(Boolean))];
}

function binaryAttrs(s) {
  return [s.attrs.id, s.attrs.groupId].filter((x) => x.toLowerCase() === 'objectguid');
}

function idFilter(attr, value) {
  if (attr.toLowerCase() === 'objectguid') {
    if (!u.isGuid(value)) return null;
    return `(objectGUID=${u.escapeBinary(u.guidToBuffer(value))})`;
  }
  return `(${attr}=${u.escapeFilterValue(value)})`;
}

function create(directory, { secret } = {}) {
  const cfg = directory.config || {};
  const run = (fn) => conn.withServiceClient(cfg, secret, fn);

  return {
    kind: 'ldap',

    async test() {
      const s = settings(cfg);
      return run(async (client) => {
        const users = await conn.searchSome(client, s.userBase, { filter: s.userFilter, attributes: [s.attrs.login] }, 5);
        const groups = await conn.searchSome(client, s.groupBase, { filter: s.groupFilter, attributes: [s.attrs.groupName] }, 5);
        return { ok: true, details: { server: conn.urlFor(cfg), baseDn: s.baseDn, sampleUsers: users.length, sampleGroups: groups.length } };
      });
    },

    async searchGroups(query, { limit = 50 } = {}) {
      const s = settings(cfg);
      const q = String(query || '').trim().slice(0, 100);
      const filter = q ? `(&${s.groupFilter}(${s.attrs.groupName}=*${u.escapeFilterValue(q)}*))` : s.groupFilter;
      return run(async (client) => {
        const entries = await conn.searchSome(client, s.groupBase, {
          filter, attributes: [s.attrs.groupId, s.attrs.groupName, 'description'], explicitBufferAttributes: binaryAttrs(s),
        }, limit);
        return entries.map((e) => ({
          externalId: idOf(e, s.attrs.groupId), name: u.first(e, s.attrs.groupName), dn: e.dn, description: u.first(e, 'description') || null,
        })).filter((g) => g.externalId && g.name).sort((a, b) => a.name.localeCompare(b.name));
      });
    },

    async fetch(selected) {
      const s = settings(cfg);
      const a = s.attrs;
      const memberAttr = a.member;
      return run(async (client) => {
        // Every person of the user base once (the member lists name DNs or
        // login names; one search is cheaper than one per member).
        const userEntries = await conn.searchAll(client, s.userBase, { filter: s.userFilter, attributes: userAttrs(s), explicitBufferAttributes: binaryAttrs(s) });
        const byDn = new Map();
        const byLogin = new Map();
        for (const e of userEntries) {
          const p = userFrom(e, s);
          if (!p.externalId) continue;
          if (p.dn) byDn.set(u.normDn(p.dn), p);
          if (p.loginName) byLogin.set(p.loginName.toLowerCase(), p);
        }
        const groupAttrList = [a.groupId, a.groupName, memberAttr];
        const groupCache = new Map();
        async function groupByDn(dn) {
          const key = u.normDn(dn);
          if (groupCache.has(key)) return groupCache.get(key);
          let entry = null;
          try {
            const res = await conn.searchSome(client, dn, { scope: 'base', filter: s.groupFilter, attributes: groupAttrList, explicitBufferAttributes: binaryAttrs(s) }, 1);
            entry = res[0] || null;
          } catch { entry = null; }
          groupCache.set(key, entry);
          return entry;
        }
        async function collect(entry, out, seen, depth) {
          for (const v of u.all(entry, memberAttr)) {
            if (memberAttr.toLowerCase() === 'memberuid') {
              const p = byLogin.get(String(v).toLowerCase());
              if (p) out.set(p.externalId, p);
              continue;
            }
            const p = byDn.get(u.normDn(v));
            if (p) { out.set(p.externalId, p); continue; }
            if (depth >= MAX_NESTING || seen.has(u.normDn(v))) continue;
            seen.add(u.normDn(v));
            const sub = await groupByDn(v);
            if (sub) await collect(sub, out, seen, depth + 1);
          }
        }
        const users = new Map();
        const groups = [];
        for (const sel of selected || []) {
          const f = idFilter(a.groupId, sel.externalId);
          const res = f ? await conn.searchSome(client, s.groupBase, {
            filter: `(&${s.groupFilter}${f})`, attributes: groupAttrList, explicitBufferAttributes: binaryAttrs(s),
          }, 1) : [];
          const entry = res[0];
          if (!entry) { groups.push({ externalId: sel.externalId, name: sel.name, dn: sel.dn || null, found: false, members: [] }); continue; }
          const out = new Map();
          await collect(entry, out, new Set([u.normDn(entry.dn)]), 0);
          for (const p of out.values()) users.set(p.externalId, p);
          groups.push({ externalId: idOf(entry, a.groupId), name: u.first(entry, a.groupName), dn: entry.dn, found: true, members: [...out.keys()] });
        }
        return { groups, users: [...users.values()] };
      });
    },

    async authenticate(link, password) {
      if (typeof password !== 'string' || password.length === 0) return { ok: false, reason: 'invalid' };
      const s = settings(cfg);
      const f = idFilter(s.attrs.id, link.external_id);
      if (!f) return { ok: false, reason: 'not_found' };
      const client = await conn.open(cfg);
      try {
        await client.bind(String(cfg.bindDn || ''), secret || '');
        const res = await conn.searchSome(client, s.userBase, { filter: `(&${s.userFilter}${f})`, attributes: userAttrs(s), explicitBufferAttributes: binaryAttrs(s) }, 1);
        if (!res[0]) return { ok: false, reason: 'not_found' };
        const p = userFrom(res[0], s);
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

module.exports = { create, settings, cleanFilter, attrsOf, DEFAULTS };
