'use strict';

// Notifications in chats (docs/plugins.md "Notifications in chats"): per
// topic a person chooses where a notification appears — the GateControl inbox
// ('inbox', default), the household's family chat ('family', set by an
// administrator or a family parent for everyone) or an own chat per source
// ('own'). Chats belong to a sink plugin (plugin.json permissions.notifySink,
// in practice the messenger); without an active sink everything goes to the
// inbox exactly as before.
//
//   split(notif, targets)     after router.resolve: which devices stay in the
//                             inbox, which people go to the sink
//   dispatch(notif, divert, fallback)
//                             the sink's deliverNotice hook (async, ≤ 10 s);
//                             everyone it did not cover — error, timeout,
//                             not listed in `covered` — gets the normal inbox
//                             delivery afterwards (fallback). Never lost,
//                             never doubled.
//   view / setRoute           GET / PUT …/notify/routes (web and app); 1.192.0: choosing 'own'
//                             asks the sink to create (or find) that source's chat at once
//                             (ensureNoticeChat, ≤ 5 s) instead of with the first notification
//
// Locked topics (security, admin_notice) and chat topics (kind 'message')
// never leave the inbox path.

const { getDb } = require('../../db/connection');
const store = require('./store');
const text = require('./text');
const { CORE_TOPICS, ROUTE_LOCKED_TOPICS } = require('./constants');
const logger = require('../../utils/logger');

const DESTS = ['inbox', 'own', 'family'];
const HOOK_MS = 10000;   // deliverNotice
const ASK_MS = 3000;     // mayRouteToFamily
const ENSURE_MS = 5000;  // ensureNoticeChat
const inflight = new Set();

function db() { return getDb(); }
function runtime() { return require('../plugins/runtime'); }

// ─── The sink ───────────────────────────────────────────────────────────

/**
 * The active sink: the first installed plugin (registry order) declaring
 * permissions.notifySink that may run (enabled, licensed, compatible). Null
 * when there is none.
 */
function activeSink() {
  let list = [];
  try { list = require('../plugins/registry').list(); } catch { return null; }
  for (const p of list) {
    const perms = p.manifest && p.manifest.permissions;
    if (!perms || perms.notifySink !== true || !p.enabled) continue;
    let ok = false;
    try { ok = require('../plugins').evaluate(p).run === true; } catch { ok = false; }
    if (ok) return p;
  }
  return null;
}

/** The active sink when its process runs now (else null: inbox as before). */
function runningSink() {
  const p = activeSink();
  if (!p) return null;
  try { return runtime().info(p.id).state === 'running' ? p : null; } catch { return null; }
}

// ─── Stored routes ──────────────────────────────────────────────────────

function familyRoute(topic) {
  return db().prepare('SELECT topic, set_by, set_at FROM notify_family_routes WHERE topic = ?').get(topic) || null;
}

function ownUsers(topic) {
  return new Set(db().prepare("SELECT user_id FROM notify_routes WHERE topic = ? AND dest = 'own'").all(topic).map((r) => r.user_id));
}

function isChatTopic(topic) {
  if (!String(topic).startsWith('plugin:')) return false;
  const pt = require('./rules').pluginTopic(topic);
  return !!(pt && pt.chat);
}

/** May this notification leave the inbox path at all? */
function routable(notif) {
  if (!notif || notif.kind === 'message') return false;
  if (ROUTE_LOCKED_TOPICS.has(notif.topic)) return false;
  return CORE_TOPICS.includes(notif.topic) || String(notif.topic).startsWith('plugin:');
}

/**
 * targets ([{ tokenId, userId, silent }] of router.resolve) →
 * { inbox: targets that stay, divert: { sinkId, family, own, users, targets } | null }.
 * Without a running sink, a route or a person to divert: inbox = targets
 * (the very same array), divert = null.
 */
function split(notif, targets) {
  const none = { inbox: targets, divert: null };
  if (!Array.isArray(targets) || !targets.length || !routable(notif)) return none;
  const fam = familyRoute(notif.topic);
  const own = fam ? null : ownUsers(notif.topic);
  if (!fam && !own.size) return none;
  if (isChatTopic(notif.topic)) return none;
  const people = [...new Set(targets.map((t) => t.userId).filter((u) => u != null))];
  const family = fam ? people : [];
  const mine = fam ? [] : people.filter((u) => own.has(u));
  if (!family.length && !mine.length) return none;
  const sink = runningSink();
  if (!sink) return none;
  const users = new Set([...family, ...mine]);
  return {
    inbox: targets.filter((t) => t.userId == null || !users.has(t.userId)),
    divert: { sinkId: sink.id, family, own: mine, users: [...users], targets: targets.filter((t) => t.userId != null && users.has(t.userId)) },
  };
}

// ─── Labels ─────────────────────────────────────────────────────────────

/** { source, sourceLabel, topicLabel } of a topic in `lang`. */
function labelsOf(topic, lang) {
  if (CORE_TOPICS.includes(topic)) return { source: 'core', sourceLabel: 'GateControl', topicLabel: text.topicLabel(topic, lang) };
  const pt = require('./rules').pluginTopic(topic);
  const m = /^plugin:([a-z0-9]+(?:-[a-z0-9]+)*):/.exec(String(topic));
  const pluginId = pt ? pt.plugin_id : (m ? m[1] : null);
  if (!pt) return { source: pluginId ? `plugin:${pluginId}` : 'core', sourceLabel: pluginId || 'GateControl', topicLabel: topic };
  const name = text.loc(pt.plugin_name, lang) || pluginId;
  return { source: `plugin:${pluginId}`, sourceLabel: name, topicLabel: pt.id === 'default' ? name : (text.loc(pt.label, lang) || pt.id) };
}

// ─── Delivery to the sink ───────────────────────────────────────────────

/**
 * The deliverNotice payload: the notification as stored (title, body and
 * data were sanitised on the way in, like the inbox payload), labels in the
 * server language — the language notifications are stored in.
 */
function noticePayload(notif, divert) {
  const lang = text.serverLang();
  const meta = store.parseJson(notif.meta, {}) || {};
  const labels = labelsOf(notif.topic, lang);
  const imageUrl = store.imageUrlOf(notif);
  return {
    id: notif.id,
    topic: notif.topic,
    source: labels.source,
    sourceLabel: labels.sourceLabel,
    topicLabel: labels.topicLabel,
    title: notif.title,
    body: notif.body || '',
    priority: notif.priority,
    createdAt: store.wire(notif.created_at),
    data: store.parseJson(notif.data, null),
    ...(imageUrl ? { imageUrl } : {}),
    ...(meta.card && typeof meta.card === 'object' ? { card: meta.card } : {}),
    family: divert.family,
    own: divert.own,
    lang,
  };
}

/** `covered` of a hook answer → the ids among `users` (anything else ignored). */
function coveredOf(out, users) {
  const list = out && Array.isArray(out.covered) ? out.covered : [];
  const allowed = new Set(users);
  return new Set(list.filter((u) => Number.isSafeInteger(u) && allowed.has(u)));
}

/**
 * Hand the diverted people to the sink. `fallback(targets)` gets the devices
 * of everyone not covered — called once, after the hook answered, failed or
 * timed out. Returns a promise that never rejects (tests may await it).
 */
function dispatch(notif, divert, fallback) {
  const job = (async () => {
    let covered = new Set();
    let error = null;
    try {
      const out = await runtime().call(divert.sinkId, 'deliverNotice', noticePayload(notif, divert), module.exports._hookMs || HOOK_MS);
      covered = coveredOf(out, divert.users);
    } catch (err) {
      error = (err && (err.code || err.message)) || 'failed';
      logger.warn({ sink: divert.sinkId, id: notif.id, err: err && err.message }, 'notify: sink deliverNotice failed — inbox instead');
    }
    const missing = divert.targets.filter((t) => !covered.has(t.userId));
    try {
      const cur = store.getNotification(notif.id);
      if (cur) {
        const meta = store.parseJson(cur.meta, {}) || {};
        meta.chat = { sink: divert.sinkId, family: divert.family, own: divert.own, covered: [...covered], ...(error ? { error: String(error).slice(0, 120) } : {}), at: store.iso() };
        store.updateNotification(notif.id, { meta });
      }
    } catch { /* bookkeeping only */ }
    if (missing.length) {
      try { fallback(missing); } catch (err) {
        logger.warn({ id: notif.id, err: err && err.message }, 'notify: inbox fallback after the sink failed');
      }
    }
    return { covered: [...covered], fallback: [...new Set(missing.map((t) => t.userId))] };
  })().catch(() => ({ covered: [], fallback: [] }));
  inflight.add(job);
  job.finally(() => inflight.delete(job));
  return job;
}

/** Resolves when every sink call started so far has finished (tests). */
async function settled() {
  while (inflight.size) await Promise.all([...inflight]);
}

// ─── Who may set the family chat ────────────────────────────────────────

function userOf(userId) {
  return db().prepare('SELECT id, username, display_name, role, enabled FROM users WHERE id = ?').get(userId) || null;
}

/**
 * May this person set (or lift) a household family route? Administrators
 * always (with a sink); anyone else when the sink's hook
 * mayRouteToFamily({ user }) answers true within 3 s. No sink → false.
 */
async function mayRouteToFamily(userId, sink = activeSink()) {
  if (!sink) return false;
  const u = userOf(userId);
  if (!u || u.enabled !== 1) return false;
  if (u.role === 'admin') return true;
  try {
    const out = await runtime().call(sink.id, 'mayRouteToFamily', { user: { id: u.id, name: u.display_name || u.username, role: u.role } }, module.exports._askMs || ASK_MS);
    return !!out && out.allowed === true;
  } catch { return false; }
}

// ─── API (GET / PUT …/notify/routes) ────────────────────────────────────

/** Topics a person can route: [{ id, label, source, sourceLabel }] (no chat topics). */
function routeTopics(userId, lang) {
  const hub = require('./hub');
  const out = [];
  for (const t of hub.topicsForUser(userId, lang)) {
    if (isChatTopic(t.id)) continue;
    const l = labelsOf(t.id, lang);
    out.push({ id: t.id, label: l.topicLabel, source: l.source, sourceLabel: l.sourceLabel });
  }
  return out;
}

const CONV_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * 1.192.0: the sink's chat for `topic`'s source, created now when missing (hook ensureNoticeChat,
 * ≤ 5 s) → { source, label, conversationId, created } or null (no hook, an error, no answer —
 * the chat then appears with the first notification, as before).
 */
async function ensureChat(userId, topic, sink, lang) {
  const u = userOf(userId);
  if (!sink || !u) return null;
  const l = labelsOf(topic, lang);
  try {
    const out = await runtime().call(sink.id, 'ensureNoticeChat', {
      user: { id: u.id, name: u.display_name || u.username, role: u.role }, source: l.source, sourceLabel: l.sourceLabel, lang,
    }, module.exports._ensureMs || ENSURE_MS);
    const c = out && out.chat;
    if (!c || typeof c !== 'object' || c.conversationId == null || !CONV_ID_RE.test(String(c.conversationId))) return null;
    return { source: l.source, label: l.sourceLabel, conversationId: String(c.conversationId), created: c.created === true };
  } catch (err) {
    logger.warn({ err: err.message, sink: sink.id }, 'ensureNoticeChat failed');
    return null;
  }
}

function nameOf(userId) {
  if (userId == null) return null;
  const u = userOf(userId);
  return u ? (u.display_name || u.username) : null;
}

/** GET answer: { ok, sink, canFamily, groups: [{ source, label, topics: [{ id, label, dest, locked, familySetBy }] }] } */
async function view(userId, lang) {
  const sink = activeSink();
  const canFamily = sink ? await mayRouteToFamily(userId, sink) : false;
  const fam = new Map(db().prepare('SELECT topic, set_by FROM notify_family_routes').all().map((r) => [r.topic, r]));
  const mine = new Map(db().prepare('SELECT topic, dest FROM notify_routes WHERE user_id = ?').all(userId).map((r) => [r.topic, r.dest]));
  const groups = [];
  const bySource = new Map();
  for (const t of routeTopics(userId, lang)) {
    let g = bySource.get(t.source);
    if (!g) { g = { source: t.source, label: t.sourceLabel, topics: [] }; bySource.set(t.source, g); groups.push(g); }
    const locked = ROUTE_LOCKED_TOPICS.has(t.id);
    let dest = 'inbox';
    let familySetBy = null;
    if (!locked && sink) {
      if (fam.has(t.id)) { dest = 'family'; familySetBy = nameOf(fam.get(t.id).set_by); }
      else if (mine.get(t.id) === 'own') dest = 'own';
    }
    g.topics.push({ id: t.id, label: t.label, dest, locked, familySetBy });
  }
  return { ok: true, sink: !!sink, canFamily, groups };
}

/**
 * PUT { topic, dest } → { status: 200 } or { status, error }:
 *   400 invalid_dest / invalid_topic, 404 unknown_topic (not one of this
 *   person's routable topics), 409 locked, 409 no_sink ('own' / 'family'
 *   without a sink), 403 family_not_allowed ('family' — or lifting the
 *   household's family route with 'inbox' / 'own' — without permission).
 */
async function setRoute(userId, topic, dest) {
  if (!DESTS.includes(dest)) return { status: 400, error: 'invalid_dest' };
  if (typeof topic !== 'string' || !topic || topic.length > 120) return { status: 400, error: 'invalid_topic' };
  const lang = text.userLang(userId);
  if (!routeTopics(userId, lang).some((t) => t.id === topic)) return { status: 404, error: 'unknown_topic' };
  if (ROUTE_LOCKED_TOPICS.has(topic)) return { status: 409, error: 'locked' };
  const sink = activeSink();
  if (!sink && dest !== 'inbox') return { status: 409, error: 'no_sink' };
  const t = store.iso();
  const d = db();
  if (dest === 'family') {
    if (!(await mayRouteToFamily(userId, sink))) return { status: 403, error: 'family_not_allowed' };
    d.prepare(`INSERT INTO notify_family_routes (topic, set_by, set_at) VALUES (?, ?, ?)
      ON CONFLICT(topic) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at`).run(topic, userId, t);
    return { status: 200 };
  }
  // 'inbox' / 'own' on a topic the household sends to the family chat lifts
  // that route — only for a person who may set it (without a sink the family
  // route is dormant and stays as it is)
  const lift = !!sink && !!familyRoute(topic);
  if (lift && !(await mayRouteToFamily(userId, sink))) return { status: 403, error: 'family_not_allowed' };
  d.transaction(() => {
    if (lift) d.prepare('DELETE FROM notify_family_routes WHERE topic = ?').run(topic);
    if (dest === 'own') {
      d.prepare(`INSERT INTO notify_routes (user_id, topic, dest, updated_at) VALUES (?, ?, 'own', ?)
        ON CONFLICT(user_id, topic) DO UPDATE SET dest = excluded.dest, updated_at = excluded.updated_at`).run(userId, topic, t);
    } else {
      d.prepare('DELETE FROM notify_routes WHERE user_id = ? AND topic = ?').run(userId, topic);
    }
  })();
  // 1.192.0: the own chat exists right away (an existing one of that source is used)
  if (dest === 'own') return { status: 200, chat: await ensureChat(userId, topic, sink, lang) };
  return { status: 200 };
}

module.exports = {
  DESTS, HOOK_MS, ASK_MS, ENSURE_MS,
  activeSink, runningSink, split, dispatch, settled, noticePayload, labelsOf, routable,
  mayRouteToFamily, view, setRoute, routeTopics,
  _hookMs: null, _askMs: null, _ensureMs: null, // tests only
};
