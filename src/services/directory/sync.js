'use strict';

/**
 * Directory sync engine (docs/groups.md "Verzeichnis-Abgleich und
 * Anmeldung"). One run:
 *
 *   1. fetch   the adapter reads the selected groups with their (transitive)
 *              members. Directory unreachable / refused → the run fails and
 *              NOTHING changes.
 *   2. plan    pure diff against the database:
 *              • desired = enabled members of at least one found selected group
 *              • a desired person with a link (directory_links, stable id) is
 *                kept, updated (name, e-mail) and enabled again when the sync
 *                had disabled them
 *              • without a link: an existing account with the same e-mail →
 *                conflict "zusammenführen?" (never linked silently); else a
 *                new account (role 'user') when "Konten anlegen" is on
 *              • a linked account that is not desired (deactivated, deleted or
 *                in none of the selected groups) is disabled when "Sperren"
 *                is on
 *              • administrators are never created, disabled or enabled
 *   3. guard   more than 10 % of the linked accounts (at least 3) would be
 *              disabled, or every selected group came back empty → the run
 *              stops as 'pending' and an admin confirms (confirm(runId)) or
 *              discards it. A confirmation covers exactly the accounts it
 *              showed; a later run that would disable others stops again.
 *   4. apply   groups (via services/groups.js with owner 'directory:<id>'),
 *              accounts, memberships, then disabling: sessions end, app/API
 *              tokens are revoked, the person's VPN peers are disabled at once
 *              (remembered in directory_links.disabled_peer_ids; re-enabling
 *              restores the account and exactly those peers, not the tokens).
 *
 * Groups: every selected directory group becomes one GateControl group
 * (kind 'team', source 'directory:<id>', external_id = the directory id),
 * placed flat below the directory's optional parent group. Nested directory
 * groups are not mirrored as a tree; their members count as members of the
 * selected group (transitive resolution by the adapter). A deselected or
 * vanished group is archived (reselecting restores it). A name taken at that
 * level gets the suffix " (<directory name>)".
 *
 * API
 *   async run(directoryId, { trigger = 'manual', actor, confirmRunId }) → run
 *   confirm(directoryId, runId, { actor }) → async run with that confirmation
 *   discard(directoryId, runId, { actor }) → run
 *   listRuns(directoryId, { limit }) / getRun(directoryId, runId)
 *   async runDue(now) — scheduler tick: every enabled directory whose interval
 *       has passed (and at least every 24 h)
 *   resolveConflict(directoryId, conflictId, 'merge' | 'separate', { actor, ip })
 *   listConflicts(directoryId, { status })
 *   isRunning(directoryId)
 *   GUARD_SHARE, GUARD_MIN
 */

const { getDb } = require('../../db/connection');
const store = require('./store');
const adapters = require('./adapters');
const groups = require('../groups');
const users = require('../users');
const activity = require('../activity');
const logger = require('../../utils/logger');

const GUARD_SHARE = 0.10;
const GUARD_MIN = 3;
const FULL_SYNC_MS = 24 * 60 * 60 * 1000;
const STALE_RUN_MS = 60 * 60 * 1000;
const KEEP_RUNS = 50;
const running = new Set();

function codedError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function parseJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

function personName(p) {
  return (p && (p.displayName || p.loginName || p.upn || p.email || p.externalId)) || '?';
}

function linksOf(db, dirId) {
  return db.prepare(`SELECT l.*, u.username, u.display_name, u.email AS user_email, u.enabled, u.role,
      u.disabled_reason, u.self_service_enabled
    FROM directory_links l JOIN users u ON u.id = l.user_id WHERE l.directory_id = ?`).all(dirId);
}

// ─── plan ─────────────────────────────────────────────────────────────────

function computePlan(db, dir, data) {
  const profiles = new Map();
  for (const p of (data && data.users) || []) {
    if (p && p.externalId) profiles.set(String(p.externalId), p);
  }
  const groupList = ((data && data.groups) || []).map((g) => ({
    externalId: String(g.externalId), name: g.name, dn: g.dn || null, found: !!g.found,
    members: [...new Set((g.members || []).map(String))],
  }));
  const desired = new Set();
  let totalMembers = 0;
  for (const g of groupList) {
    if (!g.found) continue;
    for (const ext of g.members) {
      totalMembers++;
      const p = profiles.get(ext);
      if (p && p.enabled !== false) desired.add(ext);
    }
  }
  const links = linksOf(db, dir.id);
  const linkByExt = new Map(links.map((l) => [l.external_id, l]));
  const confByExt = new Map(db.prepare('SELECT * FROM directory_conflicts WHERE directory_id = ?').all(dir.id).map((c) => [c.external_id, c]));
  const byEmail = db.prepare('SELECT id, username, role FROM users WHERE email IS NOT NULL AND lower(email) = lower(?) ORDER BY id LIMIT 1');

  const plan = {
    creates: [], conflicts: [], skipped: [], updates: [], enables: [], disables: [], adminsKept: [],
    groups: groupList, desired, profiles, totalMembers,
    linkedCount: links.length,
    activeLinked: links.filter((l) => l.enabled === 1 && l.role === 'user').length,
  };

  for (const ext of desired) {
    if (linkByExt.has(ext)) continue;
    const p = profiles.get(ext);
    const conf = confByExt.get(ext);
    if (conf && conf.status === 'open') { plan.skipped.push({ profile: p, why: 'conflict_open' }); continue; }
    if (conf && conf.status === 'separate') {
      if (dir.provision === 1) plan.creates.push({ profile: p, separate: true });
      else plan.skipped.push({ profile: p, why: 'provision_off' });
      continue;
    }
    const match = p.email ? byEmail.get(String(p.email)) : null;
    if (match) { plan.conflicts.push({ profile: p, userId: match.id, username: match.username, role: match.role }); continue; }
    if (dir.provision !== 1) { plan.skipped.push({ profile: p, why: 'provision_off' }); continue; }
    plan.creates.push({ profile: p });
  }

  for (const l of links) {
    const p = profiles.get(l.external_id) || null;
    const want = desired.has(l.external_id);
    if (p) plan.updates.push({ link: l, profile: p, want });
    if (l.role !== 'user') {
      // Administrators: never disabled or enabled by the directory.
      if (!want && l.enabled === 1) plan.adminsKept.push({ link: l, why: p ? (p.enabled === false ? 'deactivated' : 'not_in_groups') : 'removed' });
      continue;
    }
    if (want) {
      if (l.enabled === 0 && l.disabled_reason === 'directory') plan.enables.push({ link: l, profile: p });
    } else if (l.enabled === 1 && dir.deprovision === 1) {
      plan.disables.push({ link: l, why: p ? (p.enabled === false ? 'deactivated' : 'not_in_groups') : 'removed' });
    }
  }
  return plan;
}

function guardReasons(db, dir, plan) {
  const reasons = [];
  const n = plan.disables.length;
  if (n >= GUARD_MIN && n > GUARD_SHARE * plan.linkedCount) reasons.push('mass_disable');
  if (dir.selectedGroups.length > 0 && plan.totalMembers === 0) {
    const source = `directory:${dir.id}`;
    const current = db.prepare(`SELECT COUNT(*) AS c FROM group_members m JOIN groups g ON g.id = m.group_id
      WHERE g.source = ? AND m.source = ? AND g.archived_at IS NULL`).get(source, source).c;
    if (current > 0 || plan.activeLinked > 0) reasons.push('all_groups_empty');
  }
  return reasons;
}

function summaryOf(plan) {
  return {
    users: plan.profiles.size,
    desired: plan.desired.size,
    groups: plan.groups.filter((g) => g.found).length,
    missingGroups: plan.groups.filter((g) => !g.found).length,
    create: plan.creates.length,
    conflicts: plan.conflicts.length,
    enable: plan.enables.length,
    disable: plan.disables.length,
    skipped: plan.skipped.length,
    linked: plan.linkedCount,
  };
}

// ─── apply ────────────────────────────────────────────────────────────────

function freeGroupName(db, parentId, name, dirName, exceptId) {
  const taken = (n) => !!db.prepare('SELECT id FROM groups WHERE COALESCE(parent_id, 0) = ? AND lower(name) = lower(?) AND id <> ?')
    .get(parentId == null ? 0 : parentId, n, exceptId || 0);
  const base = String(name || '').replace(/[\u0000-\u001f\u007f›]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Gruppe';
  if (!taken(base)) return base;
  const suffix = ` (${String(dirName || 'Verzeichnis').replace(/[›]/g, ' ').slice(0, 40)})`;
  const withDir = base.slice(0, 100 - suffix.length) + suffix;
  if (!taken(withDir)) return withDir;
  for (let i = 2; i < 1000; i++) {
    const s = `${suffix.slice(0, -1)} ${i})`;
    const cand = base.slice(0, 100 - s.length) + s;
    if (!taken(cand)) return cand;
  }
  throw codedError('NAME_TAKEN', 'no free group name');
}

function syncGroups(db, dir, plan, details) {
  const source = `directory:${dir.id}`;
  const opts = { owner: source, source: 'system' };
  const existing = db.prepare('SELECT * FROM groups WHERE source = ?').all(source);
  const byExt = new Map(existing.map((g) => [String(g.external_id).toLowerCase(), g]));
  const selected = new Set(dir.selectedGroups.map((s) => String(s.externalId).toLowerCase()));
  const parentId = dir.parent_group_id == null ? null : dir.parent_group_id;
  const gidByExt = new Map();
  for (const g of plan.groups) {
    const key = g.externalId.toLowerCase();
    const row = byExt.get(key);
    try {
      if (!g.found) {
        details.warnings.push({ code: 'group_not_found', name: g.name });
        if (row && !row.archived_at) { groups.archive(row.id, { ...opts, reason: 'directory_group_missing' }); details.groupsArchived.push(row.name); }
        continue;
      }
      if (!row) {
        const created = groups.create({ parentId, kind: 'team', name: freeGroupName(db, parentId, g.name, dir.name), source, externalId: key }, { source: 'system' });
        gidByExt.set(key, created.id);
        details.groupsCreated.push(created.path);
        continue;
      }
      if (row.archived_at) { groups.unarchive(row.id, opts); details.groupsRestored.push(row.name); }
      if ((row.parent_id == null ? null : row.parent_id) !== parentId) groups.move(row.id, parentId, opts);
      const target = freeGroupName(db, parentId, g.name, dir.name, row.id);
      if (target !== row.name) { groups.update(row.id, { name: target }, opts); details.groupsRenamed.push({ from: row.name, to: target }); }
      gidByExt.set(key, row.id);
    } catch (err) {
      details.errors.push({ code: err.code || 'GROUP_FAILED', name: g.name, message: err.message });
    }
  }
  for (const row of existing) {
    const key = String(row.external_id).toLowerCase();
    if (selected.has(key) || row.archived_at) continue;
    try { groups.archive(row.id, { ...opts, reason: 'directory_deselected' }); details.groupsArchived.push(row.name); } catch (err) {
      details.errors.push({ code: err.code || 'GROUP_FAILED', name: row.name, message: err.message });
    }
  }
  return gidByExt;
}

function freeUsername(db, wanted) {
  let base = String(wanted || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 60);
  if (!base) base = 'user';
  const taken = (n) => !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(n);
  if (!taken(base)) return base;
  for (let i = 2; i < 10000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  throw codedError('USERNAME_TAKEN', 'no free user name');
}

function wantedUsername(p) {
  if (p.loginName && !p.loginName.includes('@')) return p.loginName;
  const s = p.loginName || p.upn || p.email || p.displayName || '';
  return s.includes('@') ? s.split('@')[0] : s;
}

function insertLink(db, dirId, userId, p) {
  db.prepare(`INSERT INTO directory_links (user_id, directory_id, external_id, login_name, upn, dn, email, state, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(userId, dirId, String(p.externalId), p.loginName || null, p.upn || null,
    p.dn || null, p.email || null, new Date().toISOString());
}

/** Peers of the person (owned + bound to their app tokens, never gateways). */
function devicesOf(userId) {
  return require('../groupAccess').devicesOfUsers([userId]).map((d) => d.peerId);
}

function destroySessions(db, userId) {
  try {
    return db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? OR json_extract(data, '$.portalUserId') = ?").run(userId, userId).changes;
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'directory: sessions of a disabled account could not be ended');
    return 0;
  }
}

async function disableAccount(db, dir, entry) {
  const uid = entry.link.user_id;
  const peerIds = devicesOf(uid);
  const enabledPeers = peerIds.length
    ? db.prepare(`SELECT id FROM peers WHERE enabled = 1 AND id IN (${peerIds.map(() => '?').join(',')})`).all(...peerIds).map((r) => r.id)
    : [];
  // 1. the account (refuses administrators)
  const changed = users.setDirectoryEnabled(uid, false, { directoryId: dir.id, directoryName: dir.name, why: entry.why });
  if (!changed) return null;
  // 2. sessions (web, portal)
  const sessions = destroySessions(db, uid);
  // 3. app / API tokens of the person and tokens of their devices without owner
  const tokenIds = db.prepare(`SELECT id FROM api_tokens WHERE user_id = ?${peerIds.length ? ` OR (user_id IS NULL AND peer_id IN (${peerIds.map(() => '?').join(',')}))` : ''}`)
    .all(uid, ...peerIds).map((r) => r.id);
  const tokens = require('../tokens');
  for (const id of tokenIds) {
    try { tokens.revoke(id, null, { source: 'system' }); } catch (err) { logger.warn({ tokenId: id, err: err.message }, 'directory: token revoke failed'); }
  }
  // 4. VPN peers at once
  if (enabledPeers.length) {
    try { await require('../peers').batch('disable', enabledPeers); } catch (err) {
      logger.warn({ userId: uid, err: err.message }, 'directory: peers could not be disabled');
    }
  }
  db.prepare("UPDATE directory_links SET state = 'disabled', disabled_peer_ids = ? WHERE user_id = ?").run(JSON.stringify(enabledPeers), uid);
  return { sessions, tokens: tokenIds.length, peers: enabledPeers.length };
}

async function enableAccount(db, dir, entry) {
  const uid = entry.link.user_id;
  const changed = users.setDirectoryEnabled(uid, true, { directoryId: dir.id, directoryName: dir.name });
  if (!changed) return null;
  const remembered = parseJson(entry.link.disabled_peer_ids, []).filter((n) => Number.isSafeInteger(n) && n > 0);
  const restore = remembered.length
    ? db.prepare(`SELECT id FROM peers WHERE enabled = 0 AND id IN (${remembered.map(() => '?').join(',')})`).all(...remembered).map((r) => r.id)
    : [];
  if (restore.length) {
    try { await require('../peers').batch('enable', restore); } catch (err) {
      logger.warn({ userId: uid, err: err.message }, 'directory: peers could not be enabled again');
    }
  }
  db.prepare("UPDATE directory_links SET state = 'active', disabled_peer_ids = NULL WHERE user_id = ?").run(uid);
  return { peers: restore.length };
}

/**
 * Without company-account sign-in a new account needs a "Mein Bereich"
 * invitation (services/userInvites) — mailed when SMTP and an address exist.
 * Resolves true when a mail went out; never throws.
 */
async function inviteByMail(user) {
  try {
    if (!user.email || !require('../email').isSmtpConfigured()) return false;
    const invites = require('../userInvites');
    const { token, expiresAt } = invites.create(user.id, { actorId: null });
    let base = '';
    try { base = new URL(require('../../../config/default').app.baseUrl).origin; } catch { base = ''; }
    const { translate } = require('../../middleware/i18n');
    const lang = user.language || 'de';
    return await invites.sendMail({
      to: user.email, link: `${base}/invite/${token}`, name: user.display_name || user.username, expiresAt,
      t: (key) => translate(lang, key),
    });
  } catch (err) {
    logger.warn({ userId: user.id, err: err.message }, 'directory: invitation not sent');
    return false;
  }
}

function syncMembers(db, dir, plan, gidByExt, details) {
  const source = `directory:${dir.id}`;
  const opts = { owner: source, source, logSource: 'system' };
  const uidByExt = new Map(db.prepare('SELECT user_id, external_id FROM directory_links WHERE directory_id = ?').all(dir.id)
    .map((r) => [r.external_id, r.user_id]));
  const nameOf = db.prepare('SELECT username, display_name FROM users WHERE id = ?');
  const label = (uid) => { const r = nameOf.get(uid) || {}; return r.display_name || r.username || String(uid); };
  for (const g of plan.groups) {
    if (!g.found) continue;
    const gid = gidByExt.get(g.externalId.toLowerCase());
    if (!gid) continue;
    const want = new Set(g.members.map((ext) => uidByExt.get(ext)).filter(Boolean));
    const current = db.prepare('SELECT user_id, source FROM group_members WHERE group_id = ?').all(gid);
    const have = new Set(current.filter((m) => m.source === source).map((m) => m.user_id));
    const anyRow = new Set(current.map((m) => m.user_id));
    const added = [];
    const removed = [];
    for (const uid of want) {
      if (have.has(uid) || anyRow.has(uid)) continue; // an extra local membership stays local
      try { groups.setMember(gid, uid, 'member', opts); added.push(label(uid)); } catch (err) {
        details.errors.push({ code: err.code || 'MEMBER_FAILED', name: g.name, message: err.message });
      }
    }
    for (const uid of have) {
      if (want.has(uid)) continue;
      try { groups.removeMember(gid, uid, opts); removed.push(label(uid)); } catch (err) {
        details.errors.push({ code: err.code || 'MEMBER_FAILED', name: g.name, message: err.message });
      }
    }
    if (added.length || removed.length) details.groupChanges.push({ group: g.name, added, removed });
  }
}

async function apply(db, dir, plan) {
  const details = {
    created: [], linked: [], updated: [], enabled: [], disabled: [], conflicts: [], skipped: [],
    groupsCreated: [], groupsRenamed: [], groupsArchived: [], groupsRestored: [], groupChanges: [],
    adminsKept: [], warnings: [], errors: [],
  };
  const now = new Date().toISOString();
  const gidByExt = syncGroups(db, dir, plan, details);

  for (const c of plan.creates) {
    const p = c.profile;
    try {
      const username = freeUsername(db, wantedUsername(p));
      const user = users.createDirectoryUser({
        username, displayName: p.displayName ? String(p.displayName).slice(0, 100) : null,
        email: p.email && String(p.email).length <= 255 && !require('../../utils/validate').validateEmail(p.email) ? p.email : null,
        webLogin: dir.login_enabled === 1,
      }, { directoryId: dir.id, directoryName: dir.name });
      insertLink(db, dir.id, user.id, p);
      const invited = dir.login_enabled === 1 ? false : await inviteByMail(user);
      details.created.push({ userId: user.id, name: personName(p), username, invited });
    } catch (err) {
      details.errors.push({ code: err.code || 'CREATE_FAILED', name: personName(p), message: err.message });
    }
  }

  for (const c of plan.conflicts) {
    const p = c.profile;
    db.prepare(`INSERT OR IGNORE INTO directory_conflicts (directory_id, external_id, user_id, email, display_name, login_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(dir.id, String(p.externalId), c.userId, p.email || null, p.displayName || null, p.loginName || p.upn || null);
    details.conflicts.push({ userId: c.userId, username: c.username, email: p.email, name: personName(p) });
    activity.log('directory_conflict', `Directory "${dir.name}": ${p.email} already belongs to the account "${c.username}" — merge?`, {
      source: 'system', severity: 'warning', details: { directoryId: dir.id, userId: c.userId, externalId: String(p.externalId) },
    });
  }
  for (const s of plan.skipped) details.skipped.push({ name: personName(s.profile), why: s.why });

  const setLink = db.prepare('UPDATE directory_links SET login_name = ?, upn = ?, dn = ?, email = ?, last_seen_at = ? WHERE user_id = ?');
  for (const u of plan.updates) {
    const { link: l, profile: p } = u;
    setLink.run(p.loginName || null, p.upn || null, p.dn || null, p.email || null, now, l.user_id);
    if (l.role !== 'user') continue; // administrators keep what an admin set
    const fields = {};
    const name = p.displayName ? String(p.displayName).slice(0, 100) : null;
    if (name && name !== l.display_name) fields.display_name = name;
    const email = p.email && String(p.email).length <= 255 && !require('../../utils/validate').validateEmail(p.email) ? p.email : null;
    if (email && email !== l.user_email) fields.email = email;
    if (u.want && dir.login_enabled === 1 && l.self_service_enabled !== 1) fields.self_service_enabled = 1;
    if (u.want && l.enabled === 1 && l.state === 'disabled') {
      // An admin enabled the account again meanwhile; the link follows.
      db.prepare("UPDATE directory_links SET state = 'active', disabled_peer_ids = NULL WHERE user_id = ?").run(l.user_id);
    }
    const keys = Object.keys(fields);
    if (!keys.length) continue;
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), l.user_id);
    if (fields.display_name || fields.email) details.updated.push({ userId: l.user_id, name: personName(p) });
  }

  for (const e of plan.enables) {
    try {
      const r = await enableAccount(db, dir, e);
      if (r) details.enabled.push({ userId: e.link.user_id, name: e.link.display_name || e.link.username, peers: r.peers });
    } catch (err) {
      details.errors.push({ code: err.code || 'ENABLE_FAILED', name: e.link.username, message: err.message });
    }
  }

  syncMembers(db, dir, plan, gidByExt, details);

  for (const d of plan.disables) {
    try {
      const r = await disableAccount(db, dir, d);
      if (r) details.disabled.push({ userId: d.link.user_id, name: d.link.display_name || d.link.username, why: d.why, ...r });
    } catch (err) {
      details.errors.push({ code: err.code || 'DISABLE_FAILED', name: d.link.username, message: err.message });
    }
  }
  for (const a of plan.adminsKept) details.adminsKept.push({ userId: a.link.user_id, name: a.link.display_name || a.link.username, why: a.why });

  try { groups.flushEvents(); } catch { /* listeners log themselves */ }
  return details;
}

function countsOf(details) {
  return {
    created: details.created.length,
    updated: details.updated.length,
    enabled: details.enabled.length,
    disabled: details.disabled.length,
    conflicts: details.conflicts.length,
    skipped: details.skipped.length,
    groupChanges: details.groupChanges.length,
    groupsCreated: details.groupsCreated.length,
    groupsArchived: details.groupsArchived.length,
    errors: details.errors.length,
    warnings: details.warnings.length,
  };
}

// ─── runs ─────────────────────────────────────────────────────────────────

function shapeRun(r) {
  if (!r) return null;
  return {
    id: r.id,
    directoryId: r.directory_id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    summary: parseJson(r.summary_json, {}),
    details: parseJson(r.details_json, null),
    plan: parseJson(r.plan_json, null),
    guardReason: r.guard_reason,
    error: r.error,
  };
}

function finishRun(db, runId, fields) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE directory_runs SET ${cols.map((c) => `${c} = ?`).join(', ')}, finished_at = ? WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), new Date().toISOString(), runId);
}

function pruneRuns(db, dirId) {
  db.prepare(`DELETE FROM directory_runs WHERE directory_id = ? AND status NOT IN ('pending', 'running') AND id NOT IN
    (SELECT id FROM directory_runs WHERE directory_id = ? ORDER BY id DESC LIMIT ?)`).run(dirId, dirId, KEEP_RUNS);
}

function isRunning(id) { return running.has(Number(id)); }

/**
 * One sync run of a directory. Never throws for directory problems (the
 * run is stored with status 'error'); throws NOT_FOUND / RUNNING / DISABLED.
 */
async function run(directoryId, { trigger = 'manual', actor = null, confirmRunId = null } = {}) {
  const db = getDb();
  const dir = store.load(directoryId);
  if (!dir) throw codedError('NOT_FOUND', 'directory not found');
  if (dir.enabled !== 1 && trigger === 'schedule') throw codedError('DISABLED', 'directory sync is switched off');
  if (running.has(dir.id)) throw codedError('RUNNING', 'a sync of this directory is running');
  running.add(dir.id);
  const startedAt = new Date().toISOString();
  const runId = Number(db.prepare("INSERT INTO directory_runs (directory_id, trigger, status, started_at, actor_id) VALUES (?, ?, 'running', ?, ?)")
    .run(dir.id, trigger, startedAt, actor).lastInsertRowid);
  try {
    let confirmed = null;
    if (confirmRunId) {
      const c = db.prepare("SELECT * FROM directory_runs WHERE id = ? AND directory_id = ? AND status = 'pending'").get(confirmRunId, dir.id);
      if (!c) throw codedError('RUN_NOT_PENDING', 'this run is not waiting for a confirmation');
      confirmed = { id: c.id, plan: parseJson(c.plan_json, {}) };
    }

    // 1. fetch — any failure: nothing changes.
    let data;
    try {
      const adapter = adapters.adapterFor(dir);
      data = await adapter.fetch(dir.selectedGroups);
    } catch (err) {
      const message = String(err && err.message ? err.message : err).slice(0, 500);
      finishRun(db, runId, { status: 'error', error: message, summary_json: JSON.stringify({}) });
      db.prepare("UPDATE directories SET last_status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message, dir.id);
      activity.log('directory_sync_failed', `Directory "${dir.name}" could not be read — nothing was changed (${message})`, {
        source: 'system', severity: 'warning', details: { directoryId: dir.id, runId },
      });
      logger.warn({ directoryId: dir.id, err: message }, 'directory sync: directory unreachable, nothing changed');
      return shapeRun(db.prepare('SELECT * FROM directory_runs WHERE id = ?').get(runId));
    }

    // 2. plan, 3. guard
    const plan = computePlan(db, dir, data);
    const summary = summaryOf(plan);
    const reasons = guardReasons(db, dir, plan);
    if (reasons.length) {
      const okIds = new Set(((confirmed && confirmed.plan.disable) || []).map(Number));
      const okReasons = new Set((confirmed && confirmed.plan.reasons) || []);
      const covered = !!confirmed && plan.disables.every((d) => okIds.has(d.link.user_id))
        && reasons.every((r) => r === 'mass_disable' || okReasons.has(r));
      if (!covered) {
        const planJson = {
          reasons,
          disable: plan.disables.map((d) => d.link.user_id),
          disableNames: plan.disables.map((d) => ({ userId: d.link.user_id, name: d.link.display_name || d.link.username, why: d.why })),
        };
        finishRun(db, runId, { status: 'pending', summary_json: JSON.stringify(summary), plan_json: JSON.stringify(planJson), guard_reason: reasons.join(',') });
        // Only the newest pending run counts.
        db.prepare("UPDATE directory_runs SET status = 'superseded' WHERE directory_id = ? AND status = 'pending' AND id <> ?").run(dir.id, runId);
        db.prepare("UPDATE directories SET last_status = 'pending', last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(dir.id);
        activity.log('directory_sync_pending', `Directory "${dir.name}": the sync stopped — it would disable ${plan.disables.length} of ${plan.linkedCount} accounts${reasons.includes('all_groups_empty') ? ' and every selected group is empty' : ''}. An admin must confirm it.`, {
          source: 'system', severity: 'warning', details: { directoryId: dir.id, runId, reasons, disable: plan.disables.length },
        });
        return shapeRun(db.prepare('SELECT * FROM directory_runs WHERE id = ?').get(runId));
      }
    }

    // 4. apply
    const details = await apply(db, dir, plan);
    const counts = { ...summary, ...countsOf(details) };
    finishRun(db, runId, { status: 'ok', summary_json: JSON.stringify(counts), details_json: JSON.stringify(details) });
    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE directories SET last_status = ?, last_error = NULL, last_sync_at = ?, last_full_sync_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(details.errors.length ? 'warning' : 'ok', nowIso, nowIso, dir.id);
    if (confirmed) db.prepare("UPDATE directory_runs SET status = 'confirmed' WHERE id = ?").run(confirmed.id);
    db.prepare("UPDATE directory_runs SET status = 'superseded' WHERE directory_id = ? AND status = 'pending'").run(dir.id);
    if (counts.created || counts.disabled || counts.enabled || counts.conflicts || counts.groupChanges) {
      activity.log('directory_sync', `Directory "${dir.name}" synchronised: ${counts.created} new, ${counts.disabled} disabled, ${counts.enabled} enabled, ${counts.groupChanges} group changes, ${counts.conflicts} conflicts`, {
        source: 'system', severity: 'info', details: { directoryId: dir.id, runId, counts },
      });
    }
    pruneRuns(db, dir.id);
    return shapeRun(db.prepare('SELECT * FROM directory_runs WHERE id = ?').get(runId));
  } catch (err) {
    const message = String(err && err.message ? err.message : err).slice(0, 500);
    finishRun(db, runId, { status: 'error', error: message });
    if (err && err.code === 'RUN_NOT_PENDING') throw err;
    db.prepare("UPDATE directories SET last_status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message, dir.id);
    logger.error({ directoryId: dir.id, err: message }, 'directory sync failed');
    return shapeRun(db.prepare('SELECT * FROM directory_runs WHERE id = ?').get(runId));
  } finally {
    running.delete(dir.id);
  }
}

function confirm(directoryId, runId, { actor = null, ip = null } = {}) {
  const db = getDb();
  const r = db.prepare("SELECT * FROM directory_runs WHERE id = ? AND directory_id = ?").get(Number(runId), Number(directoryId));
  if (!r) throw codedError('RUN_NOT_FOUND', 'run not found');
  if (r.status !== 'pending') throw codedError('RUN_NOT_PENDING', 'this run is not waiting for a confirmation');
  const dir = store.load(directoryId);
  activity.log('directory_sync_confirmed', `Directory "${dir ? dir.name : directoryId}": mass change confirmed by an admin`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { directoryId: Number(directoryId), runId: r.id, actorId: actor },
  });
  return run(directoryId, { trigger: 'confirm', actor, confirmRunId: r.id });
}

function discard(directoryId, runId, { actor = null, ip = null } = {}) {
  const db = getDb();
  const r = db.prepare("SELECT * FROM directory_runs WHERE id = ? AND directory_id = ?").get(Number(runId), Number(directoryId));
  if (!r) throw codedError('RUN_NOT_FOUND', 'run not found');
  if (r.status !== 'pending') throw codedError('RUN_NOT_PENDING', 'this run is not waiting for a confirmation');
  db.prepare("UPDATE directory_runs SET status = 'discarded' WHERE id = ?").run(r.id);
  db.prepare("UPDATE directories SET last_status = NULL, updated_at = datetime('now') WHERE id = ? AND last_status = 'pending'").run(Number(directoryId));
  activity.log('directory_sync_discarded', `Directory: pending mass change discarded by an admin`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { directoryId: Number(directoryId), runId: r.id, actorId: actor },
  });
  return shapeRun(db.prepare('SELECT * FROM directory_runs WHERE id = ?').get(r.id));
}

function listRuns(directoryId, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 20, KEEP_RUNS));
  return getDb().prepare('SELECT * FROM directory_runs WHERE directory_id = ? ORDER BY id DESC LIMIT ?').all(Number(directoryId), n)
    .map((r) => { const s = shapeRun(r); delete s.details; return s; });
}

function getRun(directoryId, runId) {
  return shapeRun(getDb().prepare('SELECT * FROM directory_runs WHERE id = ? AND directory_id = ?').get(Number(runId), Number(directoryId)));
}

/** Scheduler tick (server.js, every minute). */
let ticking = false;
async function runDue(now = Date.now()) {
  if (ticking) return 0; // the previous tick is still syncing
  ticking = true;
  try { return await runDueInner(now); } finally { ticking = false; }
}

async function runDueInner(now) {
  const db = getDb();
  // A run that never finished (process restart) is closed.
  db.prepare("UPDATE directory_runs SET status = 'error', error = 'interrupted', finished_at = ? WHERE status = 'running' AND started_at < ?")
    .run(new Date(now).toISOString(), new Date(now - STALE_RUN_MS).toISOString());
  // Without a stored secret (restored from a backup of a server with another
  // key) every run would fail: the schedule waits until an admin enters it.
  const rows = db.prepare("SELECT id, interval_min, last_sync_at, last_full_sync_at, last_status FROM directories WHERE enabled = 1 AND secret_enc IS NOT NULL AND secret_enc <> ''").all();
  let started = 0;
  for (const r of rows) {
    if (running.has(r.id)) continue;
    // The last attempt (ok, error or pending) counts for the interval.
    const last = db.prepare('SELECT started_at FROM directory_runs WHERE directory_id = ? ORDER BY id DESC LIMIT 1').get(r.id);
    const lastAt = last ? Date.parse(last.started_at) : 0;
    // Every run is a full sync and the interval is at most 1440 minutes, so
    // a full sync happens at least every 24 h. While a mass change waits for
    // an admin, the schedule pauses (no repeated warnings; "Jetzt abgleichen"
    // still works).
    if (r.last_status === 'pending') continue;
    const intervalMs = Math.max(5, Math.min(1440, r.interval_min || 15)) * 60000;
    if (lastAt && now - lastAt < intervalMs) continue;
    started++;
    try { await run(r.id, { trigger: 'schedule' }); } catch (err) {
      if (err.code !== 'RUNNING' && err.code !== 'DISABLED') logger.warn({ directoryId: r.id, err: err.message }, 'scheduled directory sync failed');
    }
  }
  return started;
}

// ─── conflicts ────────────────────────────────────────────────────────────

function listConflicts(directoryId, { status = 'open' } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT c.*, u.username, u.display_name AS user_display_name, u.role AS user_role, u.email AS user_email
    FROM directory_conflicts c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.directory_id = ?${status ? ' AND c.status = ?' : ''} ORDER BY c.id DESC`).all(...(status ? [Number(directoryId), status] : [Number(directoryId)]));
  return rows.map((c) => ({
    id: c.id,
    externalId: c.external_id,
    email: c.email,
    displayName: c.display_name,
    loginName: c.login_name,
    status: c.status,
    createdAt: c.created_at,
    resolvedAt: c.resolved_at,
    user: c.user_id ? { id: c.user_id, username: c.username, displayName: c.user_display_name, role: c.user_role, email: c.user_email } : null,
    canMerge: !!c.user_id && c.user_role === 'user',
  }));
}

/**
 * merge: link the existing account to the directory person (only members —
 * an administrator stays local; only an account not linked elsewhere).
 * separate: leave the existing account alone; the directory person gets an
 * own account at the next run (when "Konten anlegen" is on).
 */
function resolveConflict(directoryId, conflictId, action, { actor = null, ip = null } = {}) {
  const db = getDb();
  const dir = store.load(directoryId);
  if (!dir) throw codedError('NOT_FOUND', 'directory not found');
  const c = db.prepare('SELECT * FROM directory_conflicts WHERE id = ? AND directory_id = ?').get(Number(conflictId), dir.id);
  if (!c) throw codedError('CONFLICT_NOT_FOUND', 'conflict not found');
  if (c.status !== 'open') throw codedError('CONFLICT_RESOLVED', 'this conflict was already decided');
  if (action === 'merge') {
    const u = c.user_id && db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(c.user_id);
    if (!u) throw codedError('USER_NOT_FOUND', 'the account no longer exists');
    if (u.role !== 'user') throw codedError('ADMIN_NOT_MERGEABLE', 'administrators always stay local accounts');
    if (db.prepare('SELECT 1 FROM directory_links WHERE user_id = ?').get(u.id)) throw codedError('ALREADY_LINKED', 'this account already belongs to a directory');
    if (db.prepare('SELECT 1 FROM directory_links WHERE directory_id = ? AND external_id = ?').get(dir.id, c.external_id)) {
      throw codedError('ALREADY_LINKED', 'this directory person is already linked');
    }
    db.transaction(() => {
      insertLink(db, dir.id, u.id, { externalId: c.external_id, loginName: c.login_name, email: c.email });
      db.prepare("UPDATE directory_conflicts SET status = 'merged', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").run(actor, c.id);
    })();
    activity.log('directory_user_linked', `Account "${u.username}" merged with the directory person ${c.email || c.login_name} (${dir.name})`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { directoryId: dir.id, userId: u.id, actorId: actor, externalId: c.external_id },
    });
  } else if (action === 'separate') {
    db.prepare("UPDATE directory_conflicts SET status = 'separate', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").run(actor, c.id);
    activity.log('directory_conflict_separate', `Directory "${dir.name}": ${c.email || c.login_name} stays separate from the existing account`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { directoryId: dir.id, userId: c.user_id, actorId: actor },
    });
  } else {
    throw codedError('INVALID', 'action must be merge or separate');
  }
  return listConflicts(dir.id, { status: null }).find((x) => x.id === c.id);
}

module.exports = {
  run, confirm, discard, listRuns, getRun, runDue, isRunning, listConflicts, resolveConflict,
  computePlan, guardReasons, freeUsername, freeGroupName,
  GUARD_SHARE, GUARD_MIN, FULL_SYNC_MS,
};
