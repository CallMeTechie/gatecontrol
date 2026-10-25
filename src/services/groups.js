'use strict';

/**
 * Person groups ("Gruppenverwaltung", docs/groups.md) — the single source of
 * truth for teams, departments, projects, sites and the family. Access
 * (routes, RDP, portal tiles, push), the plugin API (gc.groups) and the admin
 * and portal pages all go through this module. Admin rights NEVER come from
 * a group; groups exist in every edition (no licence gate).
 *
 * Rules
 *   • Nested at most MAX_DEPTH (3) levels, no cycles, name unique per parent
 *     (case-insensitive). Family groups stay at the top level without
 *     subgroups.
 *   • A member of a subgroup counts as an (inherited) member of every
 *     ancestor, with role 'member' there.
 *   • Roles: member | lead | deputy | admin; family groups: parent | child.
 *     'admin' = group admin (maintains members and invitations, no
 *     leadership rights in plugins). In a family 'parent' leads.
 *   • Leadership walks up: a group without lead/deputy is led by the nearest
 *     ancestor's lead/deputy.
 *   • Projects may carry endsAt ('YYYY-MM-DD'); the day after, the group is
 *     archived (archiveExpired, hourly from server.js): access ends, data
 *     stays. Archived groups (and their subgroups) are ignored by
 *     effectiveUserIds / isMember / leadersOf / groupsOfUser.
 *   • Disabled accounts keep their memberships, which rest: they are skipped
 *     by effectiveUserIds / isMember / leadersOf. Deleting an account drops
 *     its memberships (FK cascade + member_removed events).
 *   • Sources: 'local' | 'directory:<id>' | 'plugin:<pluginId>'. A non-local
 *     group is read-only for name, structure and its own members (members
 *     whose source equals the group's source) unless the caller passes the
 *     group's own source as opts.owner (directory sync, gc.groups for the
 *     plugin's groups). Admins may still give roles lead/deputy/admin to
 *     members of DIRECTORY groups and add extra LOCAL members there; plugin
 *     groups are fully read-only for admins (only color may change).
 *
 * API (all synchronous unless marked async; errors are Error objects with
 * err.code — see ERROR CODES below)
 *
 *   KINDS, ROLES, FAMILY_ROLES, MAX_DEPTH
 *   list({ tree = false, kind, includeArchived = false })
 *       → flat: [group] sorted by path; tree: [group & { children: [...] }]
 *   get(id) → group | null where group = { id, name, description, color,
 *       kind, parentId, childIds, path ('Verwaltung › Buchhaltung'), pathIds,
 *       depth (1-based), source, externalId, endsAt, archived, archivedAt,
 *       readOnly, memberCount (direct), totalMemberCount (distinct incl.
 *       subgroups), createdAt, updatedAt }
 *   create({ parentId, kind, name, description, color, endsAt, source = 'local',
 *       externalId }, { actor, ip } = {}) → group
 *   update(id, patch, { actor, ip, owner } = {}) → group
 *       patch: name, description, color, kind, endsAt, parentId (→ move)
 *   move(id, newParentId, { actor, ip, owner } = {}) → group
 *   archive(id, { actor, ip, reason, owner } = {}) → group   (incl. subgroups)
 *   unarchive(id, { actor, ip, owner } = {}) → group         (clears a past endsAt)
 *   remove(id, { confirmName, actor, ip, owner } = {}) → true
 *       confirmName must equal the name; groups with subgroups are refused.
 *
 *   setMember(groupId, userId, role = 'member', { source = 'local', actor, ip,
 *       owner } = {}) → { groupId, userId, role, source, created, changed }
 *   removeMember(groupId, userId, { actor, ip, owner } = {}) → boolean
 *   members(groupId, { nested = false, roles } = {})
 *       → [{ userId, name, email, username, role, direct, source, groupId,
 *            enabled }]  (inherited entries: role 'member', direct false,
 *            groupId = the subgroup they come from)
 *   groupsOfUser(userId, { includeInherited = false, includeArchived = false } = {})
 *       → [{ id, name, path, kind, role, direct, source (group's source),
 *            memberSource, archived }]
 *   isMember(userId, groupId, { nested = false } = {}) → boolean
 *   leadersOf(userId, { groupId } = {}) → [{ userId, role, groupId }]
 *       lead (family: parent) before deputy; the person themself is never
 *       their own leader; walks up while a level has nobody.
 *   effectiveUserIds(groupIds) → Set<userId>  (incl. subgroup members, only
 *       enabled accounts, archived groups skipped)
 *
 *   createInvite(groupId, { role = 'member', expiresInDays = 7, maxUses = 1,
 *       actor, ip } = {}) → { token, id, groupId, role, expiresAt, maxUses }
 *   lookupInvite(token) → { id, groupId, name, path, kind, role, expiresAt } | null
 *   acceptInvite(token, userId, { ip } = {}) → { groupId, role, already }
 *   listInvites(groupId) → [{ id, role, createdAt, expiresAt, maxUses, uses,
 *       createdBy, active }]
 *   revokeInvite(groupId, inviteId, { actor, ip } = {}) → boolean
 *
 *   importCsv(text, { actor, ip } = {}) → { created: [path], added, updated,
 *       unchanged, errors: [{ line, code, message }] }
 *       lines 'pfad;email;rolle[;art]', path segments split by '›' or '/'.
 *
 *   async usage(groupId) → [{ kind, label, onDelete, core?, id? }]
 *       core kinds 'route' (route_group_acl) and 'rdp' (rdp_routes.group_ids)
 *       plus whatever the registered providers return.
 *   registerUsageProvider(fn) → unregister()   fn(groupId) → Promise<[{ kind,
 *       label, onDelete }]>, 5 s timeout, errors ignored.
 *
 *   events  EventEmitter: 'change' with a batched array of { type, groupId,
 *       userId?, role?, reason? } — type member_added | member_removed |
 *       role_changed | group_created | group_renamed | group_moved |
 *       group_archived | group_deleted (+ group_unarchived). Batched within
 *       BATCH_MS (1 s). flushEvents() emits the pending batch synchronously.
 *   userDeleted(userId, memberships) / userEnabledChanged(userId, enabled)
 *       hooks for services/users.js (events with reason 'user_deleted' /
 *       'user_disabled' / 'user_enabled').
 *   membershipsOfUser(userId) → raw [{ group_id, role }] (direct)
 *   archiveExpired(now = new Date()) → number of archived projects
 *
 * ERROR CODES: NOT_FOUND, USER_NOT_FOUND, USER_DISABLED, INVALID_NAME,
 *   INVALID_KIND, INVALID_ROLE, INVALID_COLOR, INVALID_DATE, INVALID_SOURCE,
 *   INVALID_PARENT, INVALID (other fields), NAME_TAKEN, DEPTH_EXCEEDED, CYCLE,
 *   FAMILY_NESTING, READ_ONLY, HAS_CHILDREN, CONFIRM_MISMATCH, ARCHIVED,
 *   INVITE_INVALID.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');

const KINDS = Object.freeze(['department', 'team', 'project', 'site', 'family']);
const ROLES = Object.freeze(['member', 'lead', 'deputy', 'admin']);
const FAMILY_ROLES = Object.freeze(['parent', 'child']);
const MAX_DEPTH = 3;
const SEP = ' › ';
const BATCH_MS = 1000;
const NAME_MAX = 100;
const DESC_MAX = 500;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SOURCE_RE = /^(?:local|directory:[A-Za-z0-9_.-]{1,64}|plugin:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function codedError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function toId(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function rolesFor(kind) { return kind === 'family' ? FAMILY_ROLES : ROLES; }
function isLocal(source) { return !source || source === 'local'; }
function isDirectory(source) { return typeof source === 'string' && source.startsWith('directory:'); }
function actorId(opts) { return opts && toId(opts.actor) ? toId(opts.actor) : null; }

// ─── change events ────────────────────────────────────────────────────────

const events = new EventEmitter();
events.setMaxListeners(50);
let pending = [];
let timer = null;

function flushEvents() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending.length) return [];
  const batch = pending;
  pending = [];
  try { events.emit('change', batch); } catch (err) {
    logger.warn({ err: err.message }, 'groups: a change listener failed');
  }
  return batch;
}

function queue(change) {
  const c = { type: change.type, groupId: change.groupId };
  if (change.userId != null) c.userId = change.userId;
  if (change.role != null) c.role = change.role;
  if (change.reason != null) c.reason = change.reason;
  pending.push(c);
  if (!timer) {
    timer = setTimeout(flushEvents, BATCH_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

// ─── loading ──────────────────────────────────────────────────────────────

/** Every group row, keyed by id (the table is small; one query). */
function loadAll(db) {
  const rows = db.prepare('SELECT * FROM groups').all();
  const byId = new Map();
  const children = new Map();
  for (const r of rows) {
    byId.set(r.id, r);
    if (!children.has(r.id)) children.set(r.id, []);
  }
  for (const r of rows) {
    if (r.parent_id != null) {
      if (!children.has(r.parent_id)) children.set(r.parent_id, []);
      children.get(r.parent_id).push(r.id);
    }
  }
  return { byId, children };
}

function ancestorsOf(all, id) {
  const out = [];
  const seen = new Set([id]);
  let cur = all.byId.get(id);
  while (cur && cur.parent_id != null && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    cur = all.byId.get(cur.parent_id);
    if (cur) out.push(cur.id);
  }
  return out; // nearest first
}

function descendantsOf(all, id) {
  const out = [];
  const stack = [...(all.children.get(id) || [])];
  const seen = new Set([id]);
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...(all.children.get(c) || []));
  }
  return out;
}

/** Levels below a group (0 = no subgroups). */
function heightOf(all, id) {
  const kids = all.children.get(id) || [];
  let h = 0;
  for (const k of kids) h = Math.max(h, 1 + heightOf(all, k));
  return h;
}

function pathIdsOf(all, id) { return [...ancestorsOf(all, id)].reverse().concat(id); }
function pathOf(all, id) { return pathIdsOf(all, id).map((g) => (all.byId.get(g) || {}).name).join(SEP); }

function memberCounts(db, all) {
  const rows = db.prepare('SELECT group_id, user_id FROM group_members').all();
  const direct = new Map();
  for (const r of rows) {
    if (!direct.has(r.group_id)) direct.set(r.group_id, new Set());
    direct.get(r.group_id).add(r.user_id);
  }
  const total = new Map();
  const totalOf = (id) => {
    if (total.has(id)) return total.get(id);
    const s = new Set(direct.get(id) || []);
    for (const k of all.children.get(id) || []) for (const u of totalOf(k)) s.add(u);
    total.set(id, s);
    return s;
  };
  return { direct: (id) => (direct.get(id) || new Set()).size, total: (id) => totalOf(id).size };
}

function shape(all, row, counts) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    color: row.color || null,
    kind: row.kind,
    parentId: row.parent_id == null ? null : row.parent_id,
    childIds: [...(all.children.get(row.id) || [])].sort((a, b) => {
      const x = all.byId.get(a); const y = all.byId.get(b);
      return String(x.name).localeCompare(String(y.name));
    }),
    path: pathOf(all, row.id),
    pathIds: pathIdsOf(all, row.id),
    depth: ancestorsOf(all, row.id).length + 1,
    source: row.source || 'local',
    externalId: row.external_id || null,
    endsAt: row.ends_at || null,
    archived: !!row.archived_at,
    archivedAt: row.archived_at || null,
    readOnly: !isLocal(row.source),
    memberCount: counts ? counts.direct(row.id) : 0,
    totalMemberCount: counts ? counts.total(row.id) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowOrThrow(db, id) {
  const gid = toId(id);
  const row = gid && db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
  if (!row) throw codedError('NOT_FOUND', 'Group not found');
  return row;
}

// ─── reading ──────────────────────────────────────────────────────────────

function list({ tree = false, kind, includeArchived = false } = {}) {
  const db = getDb();
  const all = loadAll(db);
  const counts = memberCounts(db, all);
  const shaped = new Map();
  for (const row of all.byId.values()) shaped.set(row.id, shape(all, row, counts));
  const visible = (g) => (includeArchived || !g.archived);
  if (!tree) {
    return [...shaped.values()]
      .filter((g) => visible(g) && (!kind || g.kind === kind))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  // Tree: a kind filter keeps the matching groups with their ancestors.
  const keep = new Set();
  for (const g of shaped.values()) {
    if (!visible(g) || (kind && g.kind !== kind)) continue;
    keep.add(g.id);
    for (const a of ancestorsOf(all, g.id)) keep.add(a);
  }
  const build = (id) => {
    const g = shaped.get(id);
    return { ...g, children: g.childIds.filter((c) => keep.has(c)).map(build) };
  };
  return [...shaped.values()]
    .filter((g) => g.parentId == null && keep.has(g.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => build(g.id));
}

function get(id) {
  const gid = toId(id);
  if (!gid) return null;
  const db = getDb();
  const all = loadAll(db);
  const row = all.byId.get(gid);
  return row ? shape(all, row, memberCounts(db, all)) : null;
}

// ─── validation ───────────────────────────────────────────────────────────

function cleanName(name) {
  if (typeof name !== 'string') throw codedError('INVALID_NAME', 'name is required');
  const n = name.replace(/\s+/g, ' ').trim();
  // Control characters and the path separator › are not allowed in a name.
  // eslint-disable-next-line no-control-regex
  if (!n || n.length > NAME_MAX || /[\u0000-\u001f\u007f›]/.test(n)) {
    throw codedError('INVALID_NAME', `name must be 1–${NAME_MAX} characters without control characters or "›"`);
  }
  return n;
}

function cleanDescription(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > DESC_MAX) throw codedError('INVALID', `description must be at most ${DESC_MAX} characters`);
  return v.trim() || null;
}

function cleanColor(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw codedError('INVALID_COLOR', 'color must be #rrggbb');
  return v.toLowerCase();
}

function cleanDate(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw codedError('INVALID_DATE', 'endsAt must be YYYY-MM-DD');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw codedError('INVALID_DATE', 'endsAt is not a date');
  return v;
}

function cleanKind(v) {
  if (!KINDS.includes(v)) throw codedError('INVALID_KIND', `kind must be one of ${KINDS.join(', ')}`);
  return v;
}

function nameTaken(db, parentId, name, exceptId) {
  const row = db.prepare('SELECT id FROM groups WHERE COALESCE(parent_id, 0) = ? AND lower(name) = lower(?) AND id <> ?')
    .get(parentId == null ? 0 : parentId, name, exceptId || 0);
  return !!row;
}

/** Local date 'YYYY-MM-DD' of the server. */
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function assertWritable(row, opts, what) {
  if (isLocal(row.source)) return;
  if (opts && opts.owner && opts.owner === row.source) return;
  throw codedError('READ_ONLY', `${what || 'This group'} is managed by ${row.source}`);
}

function checkPlacement(all, { id, parentId, kind }) {
  if (parentId == null) return;
  const parent = all.byId.get(parentId);
  if (!parent) throw codedError('INVALID_PARENT', 'parent group not found');
  if (id != null && (parentId === id || descendantsOf(all, id).includes(parentId))) {
    throw codedError('CYCLE', 'a group cannot be placed below itself');
  }
  if (kind === 'family' || parent.kind === 'family') {
    throw codedError('FAMILY_NESTING', 'family groups stay at the top level without subgroups');
  }
  const parentDepth = ancestorsOf(all, parentId).length + 1;
  const height = id != null ? heightOf(all, id) : 0;
  if (parentDepth + 1 + height > MAX_DEPTH) {
    throw codedError('DEPTH_EXCEEDED', `groups nest at most ${MAX_DEPTH} levels`);
  }
}

// ─── writing groups ───────────────────────────────────────────────────────

function create(input = {}, opts = {}) {
  const db = getDb();
  const kind = cleanKind(input.kind);
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const color = cleanColor(input.color);
  const endsAt = cleanDate(input.endsAt);
  if (endsAt && kind !== 'project') throw codedError('INVALID_DATE', 'only projects have an end date');
  const source = input.source == null || input.source === '' ? 'local' : String(input.source);
  if (!SOURCE_RE.test(source)) throw codedError('INVALID_SOURCE', 'source must be local, directory:<id> or plugin:<id>');
  let externalId = null;
  if (input.externalId != null && input.externalId !== '') {
    if (typeof input.externalId !== 'string' || input.externalId.length > 200) throw codedError('INVALID', 'externalId must be a string of at most 200 characters');
    externalId = input.externalId;
  }
  const parentId = input.parentId == null || input.parentId === '' ? null : toId(input.parentId);
  if (input.parentId != null && input.parentId !== '' && !parentId) throw codedError('INVALID_PARENT', 'parentId must be a group id');

  const all = loadAll(db);
  checkPlacement(all, { id: null, parentId, kind });
  if (parentId != null) {
    const parent = all.byId.get(parentId);
    // A local group below a directory / plugin group would change its structure.
    if (!isLocal(parent.source) && parent.source !== source) throw codedError('READ_ONLY', 'the parent group is managed elsewhere');
    if (parent.archived_at) throw codedError('ARCHIVED', 'the parent group is archived');
  }
  if (nameTaken(db, parentId, name)) throw codedError('NAME_TAKEN', 'a group with this name already exists here');

  let info;
  try {
    info = db.prepare(`INSERT INTO groups (parent_id, kind, name, description, color, source, external_id, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(parentId, kind, name, description, color, source, externalId, endsAt);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw codedError('NAME_TAKEN', 'a group with this name or external id already exists');
    throw err;
  }
  const id = Number(info.lastInsertRowid);
  const group = get(id);
  activity.log('group_created', `Group "${group.path}" created`, {
    source: opts.source || (isLocal(source) ? 'admin' : 'system'), ipAddress: opts.ip, severity: 'info',
    details: { groupId: id, kind, actorId: actorId(opts), groupSource: source },
  });
  queue({ type: 'group_created', groupId: id });
  return group;
}

function update(id, patch = {}, opts = {}) {
  const db = getDb();
  const row = rowOrThrow(db, id);
  const p = patch || {};
  const onlyColor = Object.keys(p).filter((k) => p[k] !== undefined).every((k) => k === 'color');
  if (!onlyColor) assertWritable(row, opts);

  const sets = [];
  const vals = [];
  let renamed = null;
  if (p.name !== undefined) {
    const name = cleanName(p.name);
    if (name !== row.name) {
      if (nameTaken(db, row.parent_id, name, row.id)) throw codedError('NAME_TAKEN', 'a group with this name already exists here');
      sets.push('name = ?'); vals.push(name);
      renamed = { from: row.name, to: name };
    }
  }
  if (p.description !== undefined) { sets.push('description = ?'); vals.push(cleanDescription(p.description)); }
  if (p.color !== undefined) { sets.push('color = ?'); vals.push(cleanColor(p.color)); }
  let kind = row.kind;
  if (p.kind !== undefined && p.kind !== row.kind) {
    kind = cleanKind(p.kind);
    const all = loadAll(db);
    if (kind === 'family' || row.kind === 'family') {
      const hasMembers = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? LIMIT 1').get(row.id);
      if (hasMembers) throw codedError('INVALID_KIND', 'a group with members cannot change to or from family');
      if (kind === 'family' && (row.parent_id != null || (all.children.get(row.id) || []).length)) {
        throw codedError('FAMILY_NESTING', 'family groups stay at the top level without subgroups');
      }
    }
    sets.push('kind = ?'); vals.push(kind);
  }
  if (p.endsAt !== undefined) {
    const endsAt = cleanDate(p.endsAt);
    if (endsAt && kind !== 'project') throw codedError('INVALID_DATE', 'only projects have an end date');
    sets.push('ends_at = ?'); vals.push(endsAt);
  } else if (kind !== 'project' && row.ends_at) {
    sets.push('ends_at = NULL');
  }

  // One transaction: a refused move (depth, cycle, name) leaves the other fields unchanged.
  db.transaction(() => {
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      try {
        db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw codedError('NAME_TAKEN', 'a group with this name already exists here');
        throw err;
      }
    }
    if (p.parentId !== undefined) {
      const np = p.parentId == null || p.parentId === '' ? null : toId(p.parentId);
      if (np !== (row.parent_id == null ? null : row.parent_id)) move(row.id, p.parentId, opts);
    }
  })();
  if (renamed) {
    activity.log('group_renamed', `Group "${renamed.from}" renamed to "${renamed.to}"`, {
      source: opts.source || 'admin', ipAddress: opts.ip, severity: 'info',
      details: { groupId: row.id, actorId: actorId(opts), from: renamed.from, to: renamed.to },
    });
    queue({ type: 'group_renamed', groupId: row.id });
  } else if (sets.length) {
    activity.log('group_updated', `Group "${row.name}" updated`, {
      source: opts.source || 'admin', ipAddress: opts.ip, severity: 'info', details: { groupId: row.id, actorId: actorId(opts) },
    });
  }
  return get(row.id);
}

function move(id, newParentId, opts = {}) {
  const db = getDb();
  const row = rowOrThrow(db, id);
  assertWritable(row, opts);
  const parentId = newParentId == null || newParentId === '' ? null : toId(newParentId);
  if (newParentId != null && newParentId !== '' && !parentId) throw codedError('INVALID_PARENT', 'parentId must be a group id');
  if (parentId === (row.parent_id == null ? null : row.parent_id)) return get(row.id);
  const all = loadAll(db);
  checkPlacement(all, { id: row.id, parentId, kind: row.kind });
  if (parentId != null) {
    const parent = all.byId.get(parentId);
    if (!isLocal(parent.source) && parent.source !== row.source) throw codedError('READ_ONLY', 'the new parent group is managed elsewhere');
  }
  if (nameTaken(db, parentId, row.name, row.id)) throw codedError('NAME_TAKEN', 'a group with this name already exists there');
  db.prepare("UPDATE groups SET parent_id = ?, updated_at = datetime('now') WHERE id = ?").run(parentId, row.id);
  const group = get(row.id);
  activity.log('group_moved', `Group "${row.name}" moved to "${group.path}"`, {
    source: opts.source || 'admin', ipAddress: opts.ip, severity: 'info',
    details: { groupId: row.id, actorId: actorId(opts), from: row.parent_id, to: parentId },
  });
  queue({ type: 'group_moved', groupId: row.id });
  return group;
}

function archive(id, opts = {}) {
  const db = getDb();
  const row = rowOrThrow(db, id);
  if (opts.reason !== 'ended') assertWritable(row, opts);
  const all = loadAll(db);
  const ids = [row.id, ...descendantsOf(all, row.id)].filter((g) => !all.byId.get(g).archived_at);
  if (!ids.length) return get(row.id);
  const now = new Date().toISOString();
  const upd = db.prepare("UPDATE groups SET archived_at = ?, updated_at = datetime('now') WHERE id = ?");
  db.transaction(() => { for (const g of ids) upd.run(now, g); })();
  activity.log('group_archived', `Group "${pathOf(all, row.id)}" archived${opts.reason === 'ended' ? ' (end date passed)' : ''}`, {
    source: opts.source || (opts.reason === 'ended' ? 'system' : 'admin'), ipAddress: opts.ip, severity: 'info',
    details: { groupId: row.id, actorId: actorId(opts), groups: ids.length, reason: opts.reason || 'admin' },
  });
  for (const g of ids) queue({ type: 'group_archived', groupId: g });
  return get(row.id);
}

function unarchive(id, opts = {}) {
  const db = getDb();
  const row = rowOrThrow(db, id);
  assertWritable(row, opts);
  if (!row.archived_at) return get(row.id);
  const all = loadAll(db);
  const parent = row.parent_id != null ? all.byId.get(row.parent_id) : null;
  if (parent && parent.archived_at) throw codedError('ARCHIVED', 'the parent group is archived');
  const ids = [row.id, ...descendantsOf(all, row.id)].filter((g) => all.byId.get(g).archived_at);
  const t = today();
  db.transaction(() => {
    for (const g of ids) {
      const r = all.byId.get(g);
      // An end date that already passed would archive the group again at once.
      const clearEnd = r.ends_at && r.ends_at < t;
      db.prepare(`UPDATE groups SET archived_at = NULL${clearEnd ? ', ends_at = NULL' : ''}, updated_at = datetime('now') WHERE id = ?`).run(g);
    }
  })();
  activity.log('group_unarchived', `Group "${pathOf(all, row.id)}" restored from the archive`, {
    source: opts.source || 'admin', ipAddress: opts.ip, severity: 'info', details: { groupId: row.id, actorId: actorId(opts) },
  });
  for (const g of ids) queue({ type: 'group_unarchived', groupId: g });
  return get(row.id);
}

function parseIdList(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : null;
  } catch { return null; }
}

function remove(id, opts = {}) {
  const db = getDb();
  const row = rowOrThrow(db, id);
  assertWritable(row, opts);
  const typed = typeof opts.confirmName === 'string' ? opts.confirmName.trim() : '';
  if (typed !== row.name) throw codedError('CONFIRM_MISMATCH', 'type the group name to confirm');
  const kids = db.prepare('SELECT COUNT(*) AS c FROM groups WHERE parent_id = ?').get(row.id).c;
  if (kids) throw codedError('HAS_CHILDREN', 'delete or move the subgroups first');
  const all = loadAll(db);
  const path = pathOf(all, row.id);
  const memberRows = db.prepare('SELECT user_id, role FROM group_members WHERE group_id = ?').all(row.id);
  db.transaction(() => {
    // rdp_routes.group_ids: drop the id. A list that only named this group
    // keeps it when the entry names no person either — emptying both would
    // make the entry visible for everyone (same rule as for deleted users).
    const rdp = db.prepare("SELECT id, user_ids, group_ids FROM rdp_routes WHERE group_ids IS NOT NULL AND group_ids <> ''").all();
    const upd = db.prepare('UPDATE rdp_routes SET group_ids = ? WHERE id = ?');
    for (const r of rdp) {
      const ids = parseIdList(r.group_ids);
      if (!ids || !ids.includes(row.id)) continue;
      const rest = ids.filter((x) => x !== row.id);
      const users = parseIdList(r.user_ids);
      if (!rest.length && !(users && users.length)) continue;
      upd.run(rest.length ? JSON.stringify(rest) : null, r.id);
    }
    // route_group_acl goes with the group (FK cascade). An HTTP route that
    // was released for this group only (no other group, no person) gets the
    // NOBODY marker [0] in user_ids and stays closed instead of opening up
    // (services/groupAccess.js).
    const solo = db.prepare(`SELECT r.id, r.user_ids FROM routes r JOIN route_group_acl a ON a.route_id = r.id
      WHERE a.group_id = ? AND NOT EXISTS (SELECT 1 FROM route_group_acl b WHERE b.route_id = r.id AND b.group_id <> ?)`).all(row.id, row.id);
    for (const r of solo) {
      let persons = [];
      try { persons = JSON.parse(r.user_ids || '[]'); } catch { persons = []; }
      if (Array.isArray(persons) && persons.length) continue;
      db.prepare("UPDATE routes SET user_ids = '[0]' WHERE id = ?").run(r.id);
    }
    db.prepare('DELETE FROM groups WHERE id = ?').run(row.id); // members, invites, route ACL cascade
  })();
  activity.log('group_deleted', `Group "${path}" deleted`, {
    source: opts.source || 'admin', ipAddress: opts.ip, severity: 'warning',
    details: { groupId: row.id, actorId: actorId(opts), members: memberRows.length },
  });
  for (const m of memberRows) queue({ type: 'member_removed', groupId: row.id, userId: m.user_id, role: m.role, reason: 'group_deleted' });
  queue({ type: 'group_deleted', groupId: row.id });
  return true;
}

// ─── members ──────────────────────────────────────────────────────────────

function userRow(db, userId) {
  const uid = toId(userId);
  const u = uid && db.prepare('SELECT id, username, display_name, email, enabled FROM users WHERE id = ?').get(uid);
  if (!u) throw codedError('USER_NOT_FOUND', 'User not found');
  return u;
}

function setMember(groupId, userId, role = 'member', opts = {}) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  const u = userRow(db, userId);
  const r = role == null || role === '' ? (g.kind === 'family' ? 'child' : 'member') : role;
  if (!rolesFor(g.kind).includes(r)) throw codedError('INVALID_ROLE', `role must be one of ${rolesFor(g.kind).join(', ')}`);
  const isOwner = !!(opts.owner && opts.owner === g.source);
  let source = opts.source == null || opts.source === '' ? 'local' : String(opts.source);
  if (source !== 'local' && source !== g.source) throw codedError('INVALID_SOURCE', 'member source must be local or the group\'s source');
  if (source !== 'local' && !isOwner) throw codedError('READ_ONLY', 'only the managing source adds its own members');
  const existing = db.prepare('SELECT role, source FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, u.id);

  if (!isLocal(g.source) && !isOwner) {
    // Plugin groups: read-only. Directory groups: extra local members and
    // GateControl roles (lead / deputy / admin) are allowed.
    if (!isDirectory(g.source)) throw codedError('READ_ONLY', `This group is managed by ${g.source}`);
  }
  if (g.archived_at && !existing) throw codedError('ARCHIVED', 'the group is archived');

  if (existing) {
    if (existing.role === r) return { groupId: g.id, userId: u.id, role: r, source: existing.source, created: false, changed: false };
    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(r, g.id, u.id);
    activity.log('group_member_role_changed', `Role of "${u.display_name || u.username}" in group "${g.name}" changed to ${r}`, {
      source: opts.logSource || 'admin', ipAddress: opts.ip, severity: 'info',
      details: { groupId: g.id, userId: u.id, actorId: actorId(opts), from: existing.role, to: r },
    });
    queue({ type: 'role_changed', groupId: g.id, userId: u.id, role: r });
    return { groupId: g.id, userId: u.id, role: r, source: existing.source, created: false, changed: true };
  }
  if (!isLocal(g.source) && !isOwner) source = 'local';
  db.prepare('INSERT INTO group_members (group_id, user_id, role, source, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(g.id, u.id, r, source, actorId(opts));
  activity.log('group_member_added', `"${u.display_name || u.username}" added to group "${g.name}" as ${r}`, {
    source: opts.logSource || 'admin', ipAddress: opts.ip, severity: 'info',
    details: { groupId: g.id, userId: u.id, actorId: actorId(opts), role: r, memberSource: source },
  });
  queue({ type: 'member_added', groupId: g.id, userId: u.id, role: r });
  return { groupId: g.id, userId: u.id, role: r, source, created: true, changed: true };
}

function removeMember(groupId, userId, opts = {}) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  const uid = toId(userId);
  const m = uid && db.prepare('SELECT role, source FROM group_members WHERE group_id = ? AND user_id = ?').get(g.id, uid);
  if (!m) return false;
  const isOwner = !!(opts.owner && opts.owner === g.source);
  if (!isOwner && !isLocal(g.source)) {
    if (!isDirectory(g.source)) throw codedError('READ_ONLY', `This group is managed by ${g.source}`);
    if (m.source !== 'local') throw codedError('READ_ONLY', 'members from the directory are changed there');
  }
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, uid);
  const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(uid) || {};
  activity.log('group_member_removed', `"${u.display_name || u.username || uid}" removed from group "${g.name}"`, {
    source: opts.logSource || 'admin', ipAddress: opts.ip, severity: 'info',
    details: { groupId: g.id, userId: uid, actorId: actorId(opts), role: m.role },
  });
  queue({ type: 'member_removed', groupId: g.id, userId: uid, role: m.role });
  return true;
}

function members(groupId, { nested = false, roles } = {}) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  const all = loadAll(db);
  const q = db.prepare(`SELECT m.group_id, m.user_id, m.role, m.source, u.username, u.display_name, u.email, u.enabled
    FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?`);
  const out = new Map();
  for (const r of q.all(g.id)) {
    out.set(r.user_id, {
      userId: r.user_id, name: r.display_name || r.username, username: r.username, email: r.email || null,
      role: r.role, direct: true, source: r.source, groupId: g.id, enabled: r.enabled === 1,
    });
  }
  if (nested) {
    // Breadth-first: the nearest subgroup names where an inherited member comes from.
    const queue2 = [...(all.children.get(g.id) || [])];
    const seen = new Set([g.id]);
    while (queue2.length) {
      const cid = queue2.shift();
      if (seen.has(cid)) continue;
      seen.add(cid);
      const child = all.byId.get(cid);
      if (!child || child.archived_at) continue;
      for (const r of q.all(cid)) {
        if (out.has(r.user_id)) continue;
        out.set(r.user_id, {
          userId: r.user_id, name: r.display_name || r.username, username: r.username, email: r.email || null,
          role: 'member', direct: false, source: r.source, groupId: cid, enabled: r.enabled === 1,
        });
      }
      queue2.push(...(all.children.get(cid) || []));
    }
  }
  let res = [...out.values()];
  if (Array.isArray(roles) && roles.length) res = res.filter((m) => roles.includes(m.role));
  const rank = { lead: 0, parent: 0, deputy: 1, admin: 2, member: 3, child: 3 };
  return res.sort((a, b) => (Number(b.direct) - Number(a.direct)) || (rank[a.role] - rank[b.role]) || a.name.localeCompare(b.name));
}

function membershipsOfUser(userId) {
  const uid = toId(userId);
  if (!uid) return [];
  return getDb().prepare('SELECT group_id, role, source FROM group_members WHERE user_id = ?').all(uid);
}

function groupsOfUser(userId, { includeInherited = false, includeArchived = false } = {}) {
  const uid = toId(userId);
  if (!uid) return [];
  const db = getDb();
  const all = loadAll(db);
  const out = new Map();
  for (const m of membershipsOfUser(uid)) {
    const g = all.byId.get(m.group_id);
    if (!g || (!includeArchived && g.archived_at)) continue;
    out.set(g.id, {
      id: g.id, name: g.name, path: pathOf(all, g.id), kind: g.kind, role: m.role, direct: true,
      source: g.source, memberSource: m.source, archived: !!g.archived_at,
    });
  }
  if (includeInherited) {
    for (const m of [...out.values()]) {
      for (const aid of ancestorsOf(all, m.id)) {
        if (out.has(aid)) continue;
        const a = all.byId.get(aid);
        if (!includeArchived && a.archived_at) continue;
        out.set(aid, {
          id: a.id, name: a.name, path: pathOf(all, a.id), kind: a.kind, role: 'member', direct: false,
          source: a.source, memberSource: null, archived: !!a.archived_at,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function userEnabled(db, uid) {
  const r = db.prepare('SELECT enabled FROM users WHERE id = ?').get(uid);
  return !!(r && r.enabled === 1);
}

function isMember(userId, groupId, { nested = false } = {}) {
  const uid = toId(userId);
  const gid = toId(groupId);
  if (!uid || !gid) return false;
  const db = getDb();
  if (!userEnabled(db, uid)) return false;
  const all = loadAll(db);
  const g = all.byId.get(gid);
  if (!g || g.archived_at) return false;
  const ids = nested ? [gid, ...descendantsOf(all, gid).filter((d) => !all.byId.get(d).archived_at)] : [gid];
  const ph = ids.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${ph}) LIMIT 1`).get(uid, ...ids);
}

/** Leaders of one group level for `uid`: lead/parent (rank 1), then deputy (rank 2). */
function leadersAt(db, all, gid, uid) {
  const g = all.byId.get(gid);
  if (!g || g.archived_at) return [];
  const leadRole = g.kind === 'family' ? 'parent' : 'lead';
  const rows = db.prepare(`SELECT m.user_id, m.role FROM group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? AND m.role IN (?, 'deputy') AND u.enabled = 1 AND m.user_id <> ?
    ORDER BY CASE m.role WHEN ? THEN 0 ELSE 1 END, m.added_at, m.user_id`).all(gid, leadRole, uid, leadRole);
  return rows.map((r) => ({ userId: r.user_id, role: r.role, groupId: gid }));
}

function leadersOf(userId, { groupId } = {}) {
  const uid = toId(userId) || 0;
  const db = getDb();
  const all = loadAll(db);
  const walk = (gid) => {
    for (const id of [gid, ...ancestorsOf(all, gid)]) {
      const found = leadersAt(db, all, id, uid);
      if (found.length) return found;
    }
    return [];
  };
  if (groupId != null) {
    const gid = toId(groupId);
    if (!gid || !all.byId.has(gid)) throw codedError('NOT_FOUND', 'Group not found');
    return walk(gid);
  }
  const out = [];
  const seen = new Set();
  for (const m of membershipsOfUser(uid)) {
    const g = all.byId.get(m.group_id);
    if (!g || g.archived_at) continue;
    for (const l of walk(g.id)) {
      if (seen.has(l.userId)) continue;
      seen.add(l.userId);
      out.push(l);
    }
  }
  const rank = (r) => (r === 'deputy' ? 1 : 0);
  return out.sort((a, b) => rank(a.role) - rank(b.role));
}

function effectiveUserIds(groupIds) {
  const ids = [].concat(groupIds == null ? [] : groupIds).map(toId).filter(Boolean);
  const result = new Set();
  if (!ids.length) return result;
  const db = getDb();
  const all = loadAll(db);
  const groupSet = new Set();
  for (const gid of ids) {
    const g = all.byId.get(gid);
    if (!g || g.archived_at) continue;
    groupSet.add(gid);
    for (const d of descendantsOf(all, gid)) if (!all.byId.get(d).archived_at) groupSet.add(d);
  }
  if (!groupSet.size) return result;
  const list2 = [...groupSet];
  const ph = list2.map(() => '?').join(',');
  const rows = db.prepare(`SELECT DISTINCT m.user_id FROM group_members m JOIN users u ON u.id = m.user_id
    WHERE u.enabled = 1 AND m.group_id IN (${ph})`).all(...list2);
  for (const r of rows) result.add(r.user_id);
  return result;
}

// ─── account hooks (services/users.js) ────────────────────────────────────

/** After an account was deleted (memberships went with the FK cascade). */
function userDeleted(userId, memberships) {
  for (const m of memberships || []) queue({ type: 'member_removed', groupId: m.group_id, userId, role: m.role, reason: 'user_deleted' });
}

/** An account was disabled / enabled: its memberships rest / count again. */
function userEnabledChanged(userId, enabled) {
  for (const m of membershipsOfUser(userId)) {
    queue({
      type: enabled ? 'member_added' : 'member_removed', groupId: m.group_id, userId: toId(userId), role: m.role,
      reason: enabled ? 'user_enabled' : 'user_disabled',
    });
  }
}

// ─── invitations ──────────────────────────────────────────────────────────

function hashToken(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
function inviteId(hash) { return hash.slice(0, 16); }

function createInvite(groupId, { role = 'member', expiresInDays = 7, maxUses = 1, actor, ip } = {}) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  if (!isLocal(g.source) && !isDirectory(g.source)) throw codedError('READ_ONLY', `This group is managed by ${g.source}`);
  if (g.archived_at) throw codedError('ARCHIVED', 'the group is archived');
  const r = role || 'member';
  if (!rolesFor(g.kind).includes(r)) throw codedError('INVALID_ROLE', `role must be one of ${rolesFor(g.kind).join(', ')}`);
  const days = Number(expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw codedError('INVALID', 'expiresInDays must be 1–30');
  const uses = maxUses == null ? 1 : Number(maxUses);
  if (!Number.isInteger(uses) || uses < 1 || uses > 500) throw codedError('INVALID', 'maxUses must be 1–500');
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(`INSERT INTO group_invites (token_hash, group_id, role, created_by, created_at, expires_at, max_uses, uses)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(hash, g.id, r, toId(actor), createdAt, expiresAt, uses);
  activity.log('group_invite_created', `Invitation link for group "${g.name}" created (${r}, ${uses}×, ${days} d)`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { groupId: g.id, actorId: toId(actor), role: r, maxUses: uses, expiresAt },
  });
  return { token, id: inviteId(hash), groupId: g.id, role: r, expiresAt, maxUses: uses };
}

function inviteRow(db, raw) {
  if (typeof raw !== 'string' || !INVITE_TOKEN_RE.test(raw)) return null;
  const row = db.prepare('SELECT * FROM group_invites WHERE token_hash = ?').get(hashToken(raw));
  if (!row) return null;
  if (!(Date.parse(row.expires_at) > Date.now())) return null;
  if (row.max_uses != null && row.uses >= row.max_uses) return null;
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(row.group_id);
  if (!g || g.archived_at) return null;
  if (!isLocal(g.source) && !isDirectory(g.source)) return null;
  return { row, group: g };
}

function lookupInvite(raw) {
  const db = getDb();
  const hit = inviteRow(db, raw);
  if (!hit) return null;
  const all = loadAll(db);
  return {
    id: inviteId(hit.row.token_hash), groupId: hit.group.id, name: hit.group.name, path: pathOf(all, hit.group.id),
    kind: hit.group.kind, role: hit.row.role, expiresAt: hit.row.expires_at,
  };
}

function acceptInvite(raw, userId, { ip } = {}) {
  const db = getDb();
  const u = userRow(db, userId);
  if (u.enabled !== 1) throw codedError('USER_DISABLED', 'User is disabled');
  return db.transaction(() => {
    const hit = inviteRow(db, raw);
    if (!hit) throw codedError('INVITE_INVALID', 'Invitation invalid or expired');
    const { row, group } = hit;
    const existing = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, u.id);
    // Already a member: nothing changes (an invitation never lowers a role) and no use is counted.
    if (existing) return { groupId: group.id, role: existing.role, already: true };
    const used = db.prepare('UPDATE group_invites SET uses = uses + 1 WHERE token_hash = ? AND (max_uses IS NULL OR uses < max_uses)').run(row.token_hash);
    if (!used.changes) throw codedError('INVITE_INVALID', 'Invitation invalid or expired');
    db.prepare("INSERT INTO group_members (group_id, user_id, role, source, added_by) VALUES (?, ?, ?, 'local', ?)")
      .run(group.id, u.id, row.role, row.created_by || null);
    activity.log('group_invite_accepted', `"${u.display_name || u.username}" joined group "${group.name}" with an invitation link`, {
      source: 'user', ipAddress: ip, severity: 'info', details: { groupId: group.id, userId: u.id, role: row.role },
    });
    queue({ type: 'member_added', groupId: group.id, userId: u.id, role: row.role });
    return { groupId: group.id, role: row.role, already: false };
  })();
}

function listInvites(groupId) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  const now = Date.now();
  return db.prepare('SELECT * FROM group_invites WHERE group_id = ? ORDER BY created_at DESC').all(g.id).map((r) => ({
    id: inviteId(r.token_hash), role: r.role, createdAt: r.created_at, expiresAt: r.expires_at,
    maxUses: r.max_uses, uses: r.uses, createdBy: r.created_by,
    active: Date.parse(r.expires_at) > now && (r.max_uses == null || r.uses < r.max_uses),
  }));
}

function revokeInvite(groupId, id, { actor, ip } = {}) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return false;
  const info = db.prepare('DELETE FROM group_invites WHERE group_id = ? AND substr(token_hash, 1, 16) = ?').run(g.id, id);
  if (info.changes) {
    activity.log('group_invite_revoked', `Invitation link for group "${g.name}" revoked`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { groupId: g.id, actorId: toId(actor) },
    });
  }
  return info.changes > 0;
}

/** Remove invitations that ended more than 30 days ago (hourly job). */
function purgeInvites(now = Date.now()) {
  const cutoff = new Date(now - 30 * 86400000).toISOString();
  return getDb().prepare('DELETE FROM group_invites WHERE expires_at < ?').run(cutoff).changes;
}

// ─── CSV import ───────────────────────────────────────────────────────────

const ROLE_ALIASES = {
  member: 'member', mitglied: 'member',
  lead: 'lead', leitung: 'lead', leader: 'lead',
  deputy: 'deputy', vertretung: 'deputy', stellvertretung: 'deputy',
  admin: 'admin', 'gruppen-admin': 'admin', gruppenadmin: 'admin', 'group-admin': 'admin', 'group admin': 'admin',
  parent: 'parent', eltern: 'parent', elternteil: 'parent',
  child: 'child', kind: 'child',
};
const KIND_ALIASES = {
  department: 'department', abteilung: 'department',
  team: 'team',
  project: 'project', projekt: 'project',
  site: 'site', standort: 'site',
};

function splitCsvLine(line) {
  // Semicolon-separated; a field may be quoted with "…" ("" = a quote).
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"' && cur.trim() === '') { q = true; cur = ''; } else if (c === ';') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function splitPath(p) {
  const parts = p.includes('›') ? p.split('›') : p.split('/');
  return parts.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function importCsv(text, { actor, ip } = {}) {
  if (typeof text !== 'string') throw codedError('INVALID', 'CSV text is required');
  if (text.length > 1024 * 1024) throw codedError('INVALID', 'CSV is larger than 1 MB');
  const db = getDb();
  const result = { created: [], added: 0, updated: 0, unchanged: 0, errors: [] };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.length > 10000) throw codedError('INVALID', 'CSV has more than 10000 lines');
  const findUser = db.prepare(`SELECT id FROM users WHERE lower(email) = lower(?) ORDER BY id LIMIT 1`);
  const findUserByName = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1');
  const findChild = db.prepare('SELECT * FROM groups WHERE COALESCE(parent_id, 0) = ? AND lower(name) = lower(?)');
  const opts = { actor, ip, logSource: 'admin' };
  let first = true;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cols = splitCsvLine(line);
    if (first) {
      first = false;
      const h = (cols[0] || '').toLowerCase();
      if (h === 'pfad' || h === 'path' || h === 'gruppe' || h === 'group') return; // header line
    }
    const fail = (code, message) => result.errors.push({ line: lineNo, code, message });
    const [pathText, email, roleText, kindText] = cols;
    const segs = splitPath(pathText || '');
    if (!segs.length) return fail('INVALID_NAME', 'path is empty');
    if (segs.length > MAX_DEPTH) return fail('DEPTH_EXCEEDED', `groups nest at most ${MAX_DEPTH} levels`);
    let kindForNew = null;
    if (kindText) {
      kindForNew = KIND_ALIASES[kindText.toLowerCase()];
      if (!kindForNew) return fail('INVALID_KIND', `unknown kind "${kindText}"`);
    }
    try {
      // Walk / create the path.
      let parentId = null;
      let group = null;
      for (let s = 0; s < segs.length; s++) {
        const name = cleanName(segs[s]);
        const found = findChild.get(parentId == null ? 0 : parentId, name);
        if (found) { group = found; parentId = found.id; continue; }
        const kind = s === segs.length - 1 && kindForNew ? kindForNew : (s === 0 ? 'department' : 'team');
        const created = create({ parentId, kind, name }, { actor, ip });
        result.created.push(created.path);
        group = db.prepare('SELECT * FROM groups WHERE id = ?').get(created.id);
        parentId = created.id;
      }
      if (!email) return undefined; // a line without a person only creates the groups
      const u = findUser.get(email) || findUserByName.get(email);
      if (!u) return fail('USER_NOT_FOUND', `no account with the e-mail address "${email}"`);
      let role = group.kind === 'family' ? 'child' : 'member';
      if (roleText) {
        role = ROLE_ALIASES[roleText.toLowerCase()];
        if (!role) return fail('INVALID_ROLE', `unknown role "${roleText}"`);
      }
      const res = setMember(group.id, u.id, role, opts);
      if (res.created) result.added++; else if (res.changed) result.updated++; else result.unchanged++;
    } catch (err) {
      if (!err.code) throw err;
      fail(err.code, err.message);
    }
    return undefined;
  });
  activity.log('group_import', `Groups imported from CSV: ${result.created.length} created, ${result.added} members added, ${result.updated} roles changed, ${result.errors.length} errors`, {
    source: 'admin', ipAddress: ip, severity: result.errors.length ? 'warning' : 'info',
    details: { actorId: toId(actor), created: result.created.length, added: result.added, updated: result.updated, errors: result.errors.length },
  });
  return result;
}

// ─── usage ────────────────────────────────────────────────────────────────

const providers = new Set();
const PROVIDER_TIMEOUT_MS = 5000;

function registerUsageProvider(fn) {
  if (typeof fn !== 'function') throw new TypeError('usage provider must be a function');
  providers.add(fn);
  return () => providers.delete(fn);
}

function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : (v == null ? null : String(v).slice(0, n)); }

function coreUsage(db, gid) {
  const out = [];
  for (const r of db.prepare(`SELECT r.id, COALESCE(NULLIF(r.label, ''), r.domain) AS name FROM route_group_acl a
      JOIN routes r ON r.id = a.route_id WHERE a.group_id = ? ORDER BY name`).all(gid)) {
    out.push({ kind: 'route', label: r.name || `#${r.id}`, onDelete: null, core: true, id: r.id });
  }
  let rdp = [];
  try { rdp = db.prepare("SELECT id, name, group_ids FROM rdp_routes WHERE group_ids IS NOT NULL AND group_ids <> ''").all(); } catch { rdp = []; }
  for (const r of rdp) {
    const ids = parseIdList(r.group_ids);
    if (ids && ids.includes(gid)) out.push({ kind: 'rdp', label: r.name, onDelete: null, core: true, id: r.id });
  }
  return out;
}

async function usage(groupId) {
  const db = getDb();
  const g = rowOrThrow(db, groupId);
  const out = coreUsage(db, g.id);
  const calls = [...providers].map((fn) => new Promise((resolve) => {
    const t = setTimeout(() => resolve([]), PROVIDER_TIMEOUT_MS);
    if (typeof t.unref === 'function') t.unref();
    Promise.resolve().then(() => fn(g.id)).then((v) => { clearTimeout(t); resolve(v); }, (err) => {
      clearTimeout(t);
      logger.warn({ err: err && err.message }, 'groups: a usage provider failed');
      resolve([]);
    });
  }));
  for (const entries of await Promise.all(calls)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries.slice(0, 100)) {
      if (!e || typeof e !== 'object' || !e.label) continue;
      out.push({ kind: clip(e.kind, 60) || 'Plugin', label: clip(e.label, 200), onDelete: clip(e.onDelete, 300) || null });
    }
  }
  return out;
}

// ─── jobs ─────────────────────────────────────────────────────────────────

/** Archive projects whose end date has passed (hourly from server.js). */
function archiveExpired(now = new Date()) {
  const db = getDb();
  const t = today(now);
  const due = db.prepare("SELECT id FROM groups WHERE ends_at IS NOT NULL AND archived_at IS NULL AND ends_at < ? ORDER BY id").all(t);
  let n = 0;
  for (const r of due) {
    try { archive(r.id, { reason: 'ended', source: 'system' }); n++; } catch (err) {
      logger.warn({ err: err.message, groupId: r.id }, 'groups: archiving an ended project failed');
    }
  }
  try { purgeInvites(); } catch (err) { logger.debug({ err: err.message }, 'groups: invite clean-up skipped'); }
  return n;
}

module.exports = {
  KINDS, ROLES, FAMILY_ROLES, MAX_DEPTH, SEP, BATCH_MS,
  rolesFor,
  list, get, create, update, move, archive, unarchive, remove,
  setMember, removeMember, members, groupsOfUser, isMember, leadersOf, effectiveUserIds, membershipsOfUser,
  createInvite, lookupInvite, acceptInvite, listInvites, revokeInvite, purgeInvites,
  importCsv,
  usage, registerUsageProvider,
  events, flushEvents,
  userDeleted, userEnabledChanged,
  archiveExpired,
};
