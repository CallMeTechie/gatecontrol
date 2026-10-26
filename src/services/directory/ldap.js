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
 *
 * Delta (fetchDelta, sync.js "Delta"): where the server keeps the
 * operational attribute modifyTimestamp and accepts `>=` on it (OpenLDAP,
 * Synology Directory Server, 389 DS / FreeIPA). A full read checks that
 * (no modifyTimestamp or the filter refused → cursor null: every run stays
 * full) and stores a watermark — the newest modifyTimestamp it saw, at most
 * the start of the read minus 10 minutes (clock differences, replicas), so
 * nothing is lost and a change may come twice (harmless). It also remembers
 * the DNs of the nested groups and the member values it could not resolve
 * (memberUid of an account created later). A delta run reads the accounts
 * and groups with modifyTimestamp >= watermark: changed member accounts are
 * taken over (name, mail, the disabled attribute); a changed selected or
 * nested group, a member renamed or moved (DN / login name) or a new account
 * that matches an unresolved member value → that selected group is resolved
 * again (known accounts from the snapshot, others are looked up one by
 * one). Deleted accounts are not visible (no modifyTimestamp left); the
 * periodic full sync catches them.
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
const WATERMARK_MARGIN_MS = 10 * 60000;
const MAX_TRACKED = 1000;
const GENTIME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:[.,]\d+)?(Z|[+-]\d{4})?$/;

/** LDAP GeneralizedTime → ms (NaN when unreadable). */
function parseGenTime(v) {
  const m = GENTIME_RE.exec(String(v || '').trim());
  if (!m) return NaN;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7] && m[7] !== 'Z') {
    const sign = m[7][0] === '-' ? -1 : 1;
    t -= sign * ((+m[7].slice(1, 3)) * 60 + (+m[7].slice(3, 5))) * 60000;
  }
  return t;
}

/** ms → GeneralizedTime 'YYYYMMDDHHMMSSZ'. */
function genTime(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z');
}

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

/**
 * Member resolution of selected groups, shared by the full and the delta
 * read. lookup.dn(dn) / lookup.byUid(value) → the account or null (a DN
 * that is no account may be a nested group).
 */
function resolver(client, s, lookup, seen) {
  const a = s.attrs;
  const memberAttr = a.member;
  const groupAttrList = [a.groupId, a.groupName, memberAttr, ...(seen ? ['modifyTimestamp'] : [])];
  const groupCache = new Map();
  async function groupByDn(dn) {
    const key = u.normDn(dn);
    if (groupCache.has(key)) return groupCache.get(key);
    let entry = null;
    try {
      const res = await conn.searchSome(client, dn, { scope: 'base', filter: s.groupFilter, attributes: groupAttrList, explicitBufferAttributes: binaryAttrs(s) }, 1);
      entry = res[0] || null;
    } catch { entry = null; }
    if (entry && seen) seen(entry);
    groupCache.set(key, entry);
    return entry;
  }
  async function collect(entry, out, visited, depth, nested, unresolved) {
    for (const v of u.all(entry, memberAttr)) {
      if (memberAttr.toLowerCase() === 'memberuid') {
        const p = await lookup.byUid(v);
        if (p) out.set(p.externalId, p); else unresolved.push(String(v).toLowerCase());
        continue;
      }
      const p = await lookup.dn(v);
      if (p) { out.set(p.externalId, p); continue; }
      if (depth >= MAX_NESTING || visited.has(u.normDn(v))) continue;
      visited.add(u.normDn(v));
      const sub = await groupByDn(v);
      if (sub) { nested.push(u.normDn(v)); await collect(sub, out, visited, depth + 1, nested, unresolved); } else unresolved.push(u.normDn(v));
    }
  }
  return {
    /** One selected group → { externalId, name, dn, found, members }; members' profiles into `users`. */
    async group(sel, users, tracked) {
      const key = String(sel.externalId).toLowerCase();
      const f = idFilter(a.groupId, sel.externalId);
      const res = f ? await conn.searchSome(client, s.groupBase, {
        filter: `(&${s.groupFilter}${f})`, attributes: groupAttrList, explicitBufferAttributes: binaryAttrs(s),
      }, 1) : [];
      const entry = res[0];
      if (!entry) {
        delete tracked.nested[key];
        delete tracked.unresolved[key];
        return { externalId: sel.externalId, name: sel.name, dn: sel.dn || null, found: false, members: [] };
      }
      if (seen) seen(entry);
      const out = new Map();
      const nested = [];
      const unresolved = [];
      await collect(entry, out, new Set([u.normDn(entry.dn)]), 0, nested, unresolved);
      for (const p of out.values()) users.set(p.externalId, p);
      tracked.nested[key] = [...new Set(nested)].slice(0, MAX_TRACKED);
      tracked.unresolved[key] = [...new Set(unresolved)].slice(0, MAX_TRACKED);
      return { externalId: idOf(entry, a.groupId), name: u.first(entry, a.groupName), dn: entry.dn, found: true, members: [...out.keys()] };
    },
  };
}

/**
 * The delta position after a read: the watermark (newest modifyTimestamp
 * seen, at most the start minus the margin) — or null when the server gives
 * no modifyTimestamp or refuses the filter (every run stays full).
 */
async function position(client, s, startedAt, newest, tracked) {
  if (!Number.isFinite(newest)) return null;
  const watermark = genTime(Math.min(startedAt - WATERMARK_MARGIN_MS, newest));
  try {
    await conn.searchSome(client, s.userBase, { filter: `(&${s.userFilter}(modifyTimestamp>=${watermark}))`, attributes: ['modifyTimestamp'] }, 1);
  } catch {
    return null;
  }
  return { watermark, nested: tracked.nested, unresolved: tracked.unresolved };
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

    async fetch(selected, { cursor = false } = {}) {
      const s = settings(cfg);
      return run(async (client) => {
        const startedAt = Date.now();
        // Every person of the user base once (the member lists name DNs or
        // login names; one search is cheaper than one per member).
        const userEntries = await conn.searchAll(client, s.userBase, {
          filter: s.userFilter, attributes: cursor ? [...userAttrs(s), 'modifyTimestamp'] : userAttrs(s), explicitBufferAttributes: binaryAttrs(s),
        });
        let newest = NaN;
        const seen = (e) => { const t = parseGenTime(u.first(e, 'modifyTimestamp')); if (Number.isFinite(t) && (!Number.isFinite(newest) || t > newest)) newest = t; };
        const byDn = new Map();
        const byLogin = new Map();
        for (const e of userEntries) {
          if (cursor) seen(e);
          const p = userFrom(e, s);
          if (!p.externalId) continue;
          if (p.dn) byDn.set(u.normDn(p.dn), p);
          if (p.loginName) byLogin.set(p.loginName.toLowerCase(), p);
        }
        const lookup = { dn: async (dn) => byDn.get(u.normDn(dn)) || null, byUid: async (v) => byLogin.get(String(v).toLowerCase()) || null };
        const r = resolver(client, s, lookup, cursor ? seen : null);
        const users = new Map();
        const groups = [];
        const tracked = { nested: {}, unresolved: {} };
        for (const sel of selected || []) {
          const g = await r.group(sel, users, tracked);
          groups.push(g);
        }
        const out = { groups, users: [...users.values()] };
        if (cursor) out.cursor = await position(client, s, startedAt, newest, tracked);
        return out;
      });
    },

    async fetchDelta(selected, { cursor, snapshot } = {}) {
      if (!cursor || !Number.isFinite(parseGenTime(cursor.watermark))) throw u.fullSyncRequired('first');
      const s = settings(cfg);
      const a = s.attrs;
      return run(async (client) => {
        const startedAt = Date.now();
        // Everything up to the watermark was seen by the last read (it is at
        // most its start minus the margin): ask from the next second on.
        const since = `(modifyTimestamp>=${genTime(parseGenTime(cursor.watermark) + 1000)})`;
        let newest = parseGenTime(cursor.watermark);
        const seen = (e) => { const t = parseGenTime(u.first(e, 'modifyTimestamp')); if (Number.isFinite(t) && t > newest) newest = t; };
        const changedUsers = await conn.searchAll(client, s.userBase, {
          filter: `(&${s.userFilter}${since})`, attributes: [...userAttrs(s), 'modifyTimestamp'], explicitBufferAttributes: binaryAttrs(s),
        });
        const changedGroups = await conn.searchAll(client, s.baseDn, {
          filter: `(&${s.groupFilter}${since})`, attributes: [a.groupId, 'modifyTimestamp'], explicitBufferAttributes: binaryAttrs(s),
        });
        // The accounts as the last run knew them, with the changes on top.
        const known = new Map();
        for (const p of (snapshot && snapshot.users) || []) known.set(String(p.externalId), p);
        const byDn = new Map();
        const byLogin = new Map();
        const index = (p) => {
          if (p.dn) byDn.set(u.normDn(p.dn), p);
          if (p.loginName) byLogin.set(String(p.loginName).toLowerCase(), p);
        };
        for (const p of known.values()) index(p);
        const changed = new Map();
        const moved = new Set(); // DN or login name changed: member values point elsewhere
        for (const e of changedUsers) {
          seen(e);
          const p = userFrom(e, s);
          if (!p.externalId) continue;
          const before = known.get(p.externalId);
          if (before && (u.normDn(before.dn || '') !== u.normDn(p.dn || '') || String(before.loginName || '').toLowerCase() !== String(p.loginName || '').toLowerCase())) {
            moved.add(p.externalId);
            if (before.dn) byDn.delete(u.normDn(before.dn));
            if (before.loginName) byLogin.delete(String(before.loginName).toLowerCase());
          }
          changed.set(p.externalId, p);
          index(p);
        }
        const changedGroupDns = new Set();
        const changedGroupIds = new Set();
        for (const e of changedGroups) {
          seen(e);
          changedGroupDns.add(u.normDn(e.dn));
          const id = idOf(e, a.groupId);
          if (id) changedGroupIds.add(id.toLowerCase());
        }
        // Accounts nobody knew yet are looked up one by one (below the account base only, like a full read).
        const asked = new Map();
        const lookup = {
          async dn(dn) {
            const key = u.normDn(dn);
            if (byDn.has(key)) return byDn.get(key);
            if (!u.isUnder(dn, s.userBase)) return null;
            if (!asked.has(key)) {
              let p = null;
              try {
                const res = await conn.searchSome(client, dn, { scope: 'base', filter: s.userFilter, attributes: userAttrs(s), explicitBufferAttributes: binaryAttrs(s) }, 1);
                p = res[0] ? userFrom(res[0], s) : null;
              } catch { p = null; }
              asked.set(key, p && p.externalId ? p : null);
            }
            return asked.get(key);
          },
          async byUid(v) {
            const key = 'login:' + String(v).toLowerCase();
            if (byLogin.has(String(v).toLowerCase())) return byLogin.get(String(v).toLowerCase());
            if (!asked.has(key)) {
              const res = await conn.searchSome(client, s.userBase, {
                filter: `(&${s.userFilter}(${a.login}=${u.escapeFilterValue(v)}))`, attributes: userAttrs(s), explicitBufferAttributes: binaryAttrs(s),
              }, 1);
              const p = res[0] ? userFrom(res[0], s) : null;
              asked.set(key, p && p.externalId ? p : null);
            }
            return asked.get(key);
          },
        };
        const r = resolver(client, s, lookup, seen);
        const snapGroups = new Map(((snapshot && snapshot.groups) || []).map((g) => [String(g.externalId).toLowerCase(), g]));
        const tracked = { nested: { ...(cursor.nested || {}) }, unresolved: { ...(cursor.unresolved || {}) } };
        const users = new Map();
        const groups = [];
        for (const sel of selected || []) {
          const key = String(sel.externalId).toLowerCase();
          const snap = snapGroups.get(key);
          const members = new Set(((snap && snap.members) || []).map(String));
          const nestedDns = (tracked.nested[key] || []).map((x) => u.normDn(x));
          const pending = new Set((tracked.unresolved[key] || []).map((x) => String(x).toLowerCase()));
          const hitsPending = (p) => pending.size && ((p.dn && pending.has(u.normDn(p.dn))) || (p.loginName && pending.has(String(p.loginName).toLowerCase())));
          const again = !snap || !snap.found || changedGroupIds.has(key)
            || (snap.dn && changedGroupDns.has(u.normDn(snap.dn))) || nestedDns.some((dn) => changedGroupDns.has(dn))
            || [...moved].some((id) => members.has(id))
            || [...changed.values()].some((p) => !members.has(p.externalId) && hitsPending(p));
          if (again) {
            groups.push(await r.group(sel, users, tracked));
            continue;
          }
          for (const p of changed.values()) if (members.has(p.externalId)) users.set(p.externalId, p);
        }
        return { groups, users: [...users.values()], removedUsers: [], cursor: await position(client, s, startedAt, newest, tracked) };
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

module.exports = { create, settings, cleanFilter, attrsOf, parseGenTime, genTime, DEFAULTS };
