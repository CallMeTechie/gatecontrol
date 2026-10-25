'use strict';

// Person groups for plugins (docs/plugins.md "Groups", services/groups.js).
//
// plugin.json `permissions.groups`:
//   "read"    gc.groups.list / get / members / isMember / leadersOf, the hooks
//             groupsChanged / groupUsage / groupDeleting, gc.notify({ groups }),
//             GC.pickPrincipals in the plugin's frames;
//   "manage"  the same, plus gc.groups.ensure / remove of the plugin's OWN
//             groups — source 'plugin:<id>', external_id = the plugin's key.
//             Every write goes through services/groups.js with
//             owner 'plugin:<id>', so a plugin never changes a group it does
//             not own (ERR_READ_ONLY), and admins cannot change its groups.
//
// Answers are plain JSON: ids, names, path, kind, role, direct, source,
// archived — never e-mail addresses or user names (gc.users does not hand
// them out either).
//
// Hooks (best-effort, like the other hooks): groups.events 'change' batches
// go to every running plugin with the permission (groupsChanged, 10 s); ONE
// usage provider asks them all for groupUsage (≤ 4.5 s each, errors and
// garbage ignored); ONE pre-remove hook asks them all for groupDeleting
// before a group is deleted (groups.removeWithHooks: 30 s in total, the
// plugin that deletes its own group is not asked).

const registry = require('./registry');
const runtime = require('./runtime');
const { loc } = require('./manifest');
const logger = require('../../utils/logger');

function groups() { return require('../groups'); }
function db() { return require('../../db/connection').getDb(); }

const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_ENSURE_MEMBERS = 2000;
const MAX_NOTIFY_GROUPS = 50;
const MAX_NOTIFY_RECIPIENTS = 1000;
const CHANGED_MS = 10000;
const USAGE_MS = 4500;
const DELETING_MS = 30000;
const ALL_ROLES = ['member', 'lead', 'deputy', 'admin', 'parent', 'child'];

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  throw e;
}
function need(cond, code, message) { if (!cond) fail(code, message); }

/** 'read' | 'manage' | null — the plugin's permissions.groups. */
function levelOf(manifest) {
  const g = manifest && manifest.permissions && manifest.permissions.groups;
  return g === 'read' || g === 'manage' ? g : null;
}
function ownerOf(plugin) { return `plugin:${plugin.id}`; }

function needRead(plugin) {
  need(levelOf(plugin.manifest), 'ERR_GROUPS_DENIED', 'this plugin has no groups permission (permissions.groups)');
}
function needManage(plugin) {
  need(levelOf(plugin.manifest) === 'manage', 'ERR_GROUPS_DENIED', 'gc.groups.ensure / remove need permissions.groups "manage"');
}

/** services/groups.js error → host API error code. */
function mapError(err) {
  if (!err || !err.code || String(err.code).startsWith('ERR_')) return err;
  const code = err.code === 'NOT_FOUND' ? 'ERR_NOT_FOUND' : (err.code === 'READ_ONLY' ? 'ERR_READ_ONLY' : 'ERR_INVALID');
  const e = new Error(code === 'ERR_INVALID' ? `${err.code}: ${err.message}` : err.message);
  e.code = code;
  return e;
}

function idOf(v, what) {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  need(Number.isSafeInteger(n) && n > 0, 'ERR_INVALID', `invalid ${what}`);
  return n;
}
function bool(v, what) {
  need(v == null || typeof v === 'boolean', 'ERR_INVALID', `${what} must be a boolean`);
  return v === true;
}

/** A group as plugins see it. `key`: the plugin's own key of one of its groups. */
function groupView(plugin, g) {
  if (!g) return null;
  const own = g.source === ownerOf(plugin);
  return {
    id: g.id, name: g.name, path: g.path, kind: g.kind, parentId: g.parentId, childIds: g.childIds, depth: g.depth,
    source: g.source, own, key: own ? g.externalId : null, endsAt: g.endsAt, archived: g.archived,
    memberCount: g.memberCount, totalMemberCount: g.totalMemberCount,
  };
}

function memberView(m) {
  return { userId: m.userId, name: m.name, role: m.role, direct: m.direct, source: m.source, groupId: m.groupId, enabled: m.enabled };
}

function userExists(id) { return !!db().prepare('SELECT 1 FROM users WHERE id = ?').get(id); }

function groupOrNotFound(id) {
  const g = groups().get(id);
  need(g, 'ERR_NOT_FOUND', 'group not found');
  return g;
}

// ─── reading ──────────────────────────────────────────────────────────────

function list(plugin, args) {
  const o = args || {};
  need(o.kind == null || groups().KINDS.includes(o.kind), 'ERR_INVALID', 'invalid kind');
  const includeInherited = bool(o.includeInherited, 'includeInherited');
  const includeArchived = bool(o.includeArchived, 'includeArchived');
  if (o.userId != null) {
    const uid = idOf(o.userId, 'userId');
    return groups().groupsOfUser(uid, { includeInherited, includeArchived })
      .filter((g) => !o.kind || g.kind === o.kind)
      .map((g) => ({ id: g.id, name: g.name, path: g.path, kind: g.kind, role: g.role, direct: g.direct, source: g.source, archived: g.archived }));
  }
  return groups().list({ kind: o.kind || undefined, includeArchived }).map((g) => groupView(plugin, g));
}

function get(plugin, args) {
  return groupView(plugin, groups().get(idOf(args && args.id, 'group id')));
}

function members(plugin, args) {
  const o = args || {};
  const gid = idOf(o.id, 'group id');
  const nested = bool(o.nested, 'nested');
  let roles;
  if (o.roles != null) {
    need(Array.isArray(o.roles) && o.roles.length <= ALL_ROLES.length && o.roles.every((r) => ALL_ROLES.includes(r)), 'ERR_INVALID', 'invalid roles');
    roles = o.roles;
  }
  groupOrNotFound(gid);
  return groups().members(gid, { nested, roles }).map(memberView);
}

function isMember(plugin, args) {
  const o = args || {};
  const uid = idOf(o.userId, 'userId');
  const gid = idOf(o.groupId, 'group id');
  const nested = bool(o.nested, 'nested');
  groupOrNotFound(gid);
  return groups().isMember(uid, gid, { nested });
}

function leadersOf(plugin, args) {
  const o = args || {};
  const uid = idOf(o.userId, 'userId');
  let groupId;
  if (o.groupId != null) groupId = groupOrNotFound(idOf(o.groupId, 'group id')).id;
  const names = new Map(db().prepare('SELECT id, username, display_name FROM users').all().map((u) => [u.id, u.display_name || u.username]));
  return groups().leadersOf(uid, groupId == null ? {} : { groupId })
    .map((l) => ({ userId: l.userId, name: names.get(l.userId) || null, role: l.role, groupId: l.groupId }));
}

// ─── managing the plugin's own groups ────────────────────────────────────

function ownRow(plugin, key) {
  return db().prepare('SELECT * FROM groups WHERE source = ? AND external_id = ?').get(ownerOf(plugin), key) || null;
}

function cleanKey(v, what) {
  need(typeof v === 'string' && KEY_RE.test(v), 'ERR_INVALID', `${what} must be 1–100 characters A-Z a-z 0-9 _ . : -`);
  return v;
}

/**
 * gc.groups.ensure({ key, name, kind, parentKey?, members: [{ userId, role }] })
 * → the group (groupView) + { created, added, removed, changed }: creates or
 * updates the plugin's group with that key and sets its members exactly.
 */
function ensure(plugin, args) {
  needManage(plugin);
  const o = args || {};
  const G = groups();
  const key = cleanKey(o.key, 'key');
  need(G.KINDS.includes(o.kind), 'ERR_INVALID', 'invalid kind');
  need(typeof o.name === 'string' && o.name.trim(), 'ERR_INVALID', 'name required');
  let parentId = null;
  if (o.parentKey != null) {
    const pk = cleanKey(o.parentKey, 'parentKey');
    need(pk !== key, 'ERR_INVALID', 'a group cannot be its own parent');
    const parent = ownRow(plugin, pk);
    need(parent, 'ERR_NOT_FOUND', 'no group of this plugin with that parentKey');
    parentId = parent.id;
  }
  need(Array.isArray(o.members) && o.members.length <= MAX_ENSURE_MEMBERS, 'ERR_INVALID', `members must be a list of at most ${MAX_ENSURE_MEMBERS}`);
  const roles = G.rolesFor(o.kind);
  const want = new Map();
  for (const m of o.members) {
    need(m && typeof m === 'object' && !Array.isArray(m), 'ERR_INVALID', 'invalid member');
    const uid = idOf(m.userId, 'member userId');
    need(!want.has(uid), 'ERR_INVALID', 'a person is listed twice');
    const role = m.role == null ? (o.kind === 'family' ? 'child' : 'member') : m.role;
    need(roles.includes(role), 'ERR_INVALID', `role must be one of ${roles.join(', ')}`);
    need(userExists(uid), 'ERR_INVALID', `unknown user ${uid}`);
    want.set(uid, role);
  }
  const owner = ownerOf(plugin);
  const opts = { owner, source: 'plugin', logSource: 'plugin' };
  const result = { created: false, added: 0, removed: 0, changed: 0 };
  try {
    let row = ownRow(plugin, key);
    if (!row) {
      const g = G.create({ parentId, kind: o.kind, name: o.name, source: owner, externalId: key }, opts);
      row = { id: g.id, kind: g.kind };
      result.created = true;
    } else {
      if (row.archived_at) G.unarchive(row.id, opts);
      const patch = {};
      const name = o.name.replace(/\s+/g, ' ').trim();
      if (name !== row.name) patch.name = o.name;
      if (o.kind !== row.kind) {
        // a group with members never changes to or from family: the members go first, the wanted ones come back below
        if (o.kind === 'family' || row.kind === 'family') {
          for (const m of G.members(row.id)) if (G.removeMember(row.id, m.userId, opts)) result.removed++;
        }
        patch.kind = o.kind;
      }
      if ((row.parent_id == null ? null : row.parent_id) !== parentId) patch.parentId = parentId;
      if (Object.keys(patch).length) G.update(row.id, patch, opts);
    }
    for (const m of G.members(row.id)) {
      if (!want.has(m.userId) && G.removeMember(row.id, m.userId, opts)) result.removed++;
    }
    for (const [uid, role] of want) {
      const r = G.setMember(row.id, uid, role, { ...opts, source: owner });
      if (r.created) result.added++; else if (r.changed) result.changed++;
    }
    return { ...groupView(plugin, G.get(row.id)), ...result };
  } catch (err) { throw mapError(err); }
}

/**
 * gc.groups.remove(key) → true | false (no such group of the plugin). A
 * group id instead of a key must name one of the plugin's own groups
 * (else ERR_READ_ONLY). Groups with subgroups are refused (ERR_INVALID).
 */
async function remove(plugin, args) {
  needManage(plugin);
  const k = args && args.key;
  let row;
  if (typeof k === 'number') {
    row = db().prepare('SELECT * FROM groups WHERE id = ?').get(idOf(k, 'group id'));
    need(row, 'ERR_NOT_FOUND', 'group not found');
    need(row.source === ownerOf(plugin), 'ERR_READ_ONLY', `this group is managed by ${row.source}`);
  } else {
    row = ownRow(plugin, cleanKey(k, 'key'));
    if (!row) return false;
  }
  try {
    await groups().removeWithHooks(row.id, { confirmName: row.name, owner: ownerOf(plugin), source: 'plugin' });
  } catch (err) { throw mapError(err); }
  return true;
}

/** Host API entry (hostApi.js): op = list | get | members | isMember | leadersOf | ensure | remove. */
async function call(plugin, op, args) {
  needRead(plugin);
  try {
    switch (op) {
      case 'list': return list(plugin, args);
      case 'get': return get(plugin, args);
      case 'members': return members(plugin, args);
      case 'isMember': return isMember(plugin, args);
      case 'leadersOf': return leadersOf(plugin, args);
      case 'ensure': return ensure(plugin, args);
      case 'remove': return await remove(plugin, args);
      default: return fail('ERR_UNKNOWN_API', 'unknown host API');
    }
  } catch (err) { throw mapError(err); }
}

// ─── gc.notify({ groups }) ────────────────────────────────────────────────

/**
 * Recipients of gc.notify({ …, groups: [id], users? }): the enabled members
 * of the groups and their subgroups (effectiveUserIds, at send time), merged
 * with `users`. Needs permissions.groups (ERR_GROUPS_DENIED); 1…50 groups,
 * every one must exist (ERR_INVALID); at most 1000 people in total.
 * @returns {number[]}
 */
function recipients(plugin, groupIds, users) {
  need(levelOf(plugin.manifest), 'ERR_GROUPS_DENIED', 'groups as recipients need permissions.groups');
  need(Array.isArray(groupIds) && groupIds.length >= 1 && groupIds.length <= MAX_NOTIFY_GROUPS
    && groupIds.every((g) => Number.isSafeInteger(g) && g > 0), 'ERR_INVALID', `groups must be 1…${MAX_NOTIFY_GROUPS} group ids`);
  const ids = [...new Set(groupIds)];
  const known = new Set(db().prepare(`SELECT id FROM groups WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id));
  need(ids.every((g) => known.has(g)), 'ERR_INVALID', 'unknown group');
  const out = new Set(users || []);
  for (const u of groups().effectiveUserIds(ids)) out.add(u);
  need(out.size <= MAX_NOTIFY_RECIPIENTS, 'ERR_INVALID', `too many recipients (at most ${MAX_NOTIFY_RECIPIENTS})`);
  return [...out];
}

// ─── hooks ────────────────────────────────────────────────────────────────

function evaluate(p) { return require('./index').evaluate(p); }

/** Installed, runnable, running plugins with permissions.groups (`except`: a plugin id to leave out). */
function groupPlugins(except) {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter((p) => p.id !== except && levelOf(p.manifest))
    .filter((p) => { try { return evaluate(p).run && runtime.info(p.id).state === 'running'; } catch { return false; } });
}

function pluginLog(id, level, message) {
  try { registry.addLog(id, level, message); } catch { /* db closed */ }
}

/** groups.events 'change': the batch to every plugin's groupsChanged (never awaited). */
function onChange(batch) {
  if (!Array.isArray(batch) || !batch.length) return;
  const changes = batch.map((c) => ({ ...c }));
  for (const p of groupPlugins()) {
    runtime.call(p.id, 'groupsChanged', { changes }, module.exports._changedMs || CHANGED_MS).catch((e) => {
      pluginLog(p.id, 'warn', 'groupsChanged failed: ' + String((e && e.message) || e).slice(0, 200));
    });
  }
}

function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** The usage provider (groups.usage): what the plugins keep for a group. */
async function usage(groupId) {
  const lists = await Promise.all(groupPlugins().map(async (p) => {
    let out;
    try { out = await runtime.call(p.id, 'groupUsage', { groupId }, module.exports._usageMs || USAGE_MS); } catch { return []; }
    if (!Array.isArray(out)) return [];
    const name = loc(p.manifest.name, 'de') || p.name || p.id;
    return out.slice(0, 50).filter((e) => e && typeof e === 'object' && text(e.label, 200))
      .map((e) => ({ kind: text(e.kind, 60) || name, label: text(e.label, 200), onDelete: text(e.onDelete, 300) }));
  }));
  return lists.flat();
}

/** The pre-remove hook (groups.removeWithHooks): every plugin's groupDeleting, in parallel. */
async function deleting(info) {
  const except = info && typeof info.owner === 'string' && info.owner.startsWith('plugin:') ? info.owner.slice(7) : null;
  const payload = { groupId: info.groupId, successorUserId: info.successorUserId == null ? null : info.successorUserId };
  await Promise.all(groupPlugins(except).map((p) => runtime.call(p.id, 'groupDeleting', payload, module.exports._deletingMs || DELETING_MS)
    .catch((e) => {
      pluginLog(p.id, 'warn', 'groupDeleting failed: ' + String((e && e.message) || e).slice(0, 200));
      logger.warn({ plugin: p.id, groupId: info.groupId, err: e && e.message }, 'plugin groupDeleting failed');
    })));
}

let wired = null;

/** Wire the hooks once (plugins/index.js start()). */
function init() {
  if (wired) return;
  const G = groups();
  G.events.on('change', onChange);
  wired = { offUsage: G.registerUsageProvider(usage), offRemove: G.registerRemoveHook(deleting) };
}

function shutdown() {
  if (!wired) return;
  const G = groups();
  G.events.off('change', onChange);
  wired.offUsage();
  wired.offRemove();
  wired = null;
}

module.exports = {
  levelOf, call, recipients, init, shutdown, groupPlugins, usage, deleting, onChange,
  MAX_NOTIFY_GROUPS, MAX_NOTIFY_RECIPIENTS, KEY_RE,
  _changedMs: null, _usageMs: null, _deletingMs: null,
};
