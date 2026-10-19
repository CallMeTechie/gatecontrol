'use strict';

// `callback` buttons of plugin pushes (docs/plugins.md "Callback buttons"):
//
//   hook notifyAction({ userId, notificationId, action, data })   answer ignored
//
// The app answers a press like a `done` button: POST /api/v1/client/push/ack
// { seqs, state: 'read', action: '<callback id>' }. For every notification of
// the acked deliveries that was sent by a plugin (source 'plugin:<id>') and
// carries a callback with exactly that id, the host calls that plugin's
// notifyAction hook — once per notification and action (notify_action_calls:
// a second press, another device or another recipient changes nothing).
//   userId          the person who pressed it (the delivery's person)
//   notificationId  the id gc.notify answered ({ pushed, id })
//   action          the callback id
//   data            the push's data without the fields the host interprets
//                   (route, actions, facts, conversation, sender) — the
//                   plugin's own context, cleaned like when it was sent
// The plugin must still be allowed to run (enabled, licensed, …), be running
// and declare permissions.notify; otherwise nothing is recorded and a later
// press may still reach it. Errors and timeouts of the hook are logged, never
// reported to the app (the ack itself has succeeded).

const runtime = require('./runtime');
const registry = require('./registry');
const { ID_RE } = require('./constants');
const logger = require('../../utils/logger');

const HOOK_MS = 10000;
const HOST_FIELDS = new Set(['route', 'actions', 'facts', 'conversation', 'sender']);

function evaluate(p) { return require('./index').evaluate(p); }
function db() { return require('../../db/connection').getDb(); }

/** 'plugin:<id>' → the plugin id, else null (core, administrator, test). */
function pluginOf(source) {
  const m = /^plugin:(.+)$/.exec(String(source || ''));
  return m && m[1].length >= 2 && m[1].length <= 64 && ID_RE.test(m[1]) ? m[1] : null;
}

/** A plugin that may get the hook now: may run, is running, may notify. */
function eligible(id) {
  let p;
  try { p = registry.get(id); } catch { return false; }
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.notify)
    && evaluate(p).run && runtime.info(p.id).state === 'running';
}

/** The plugin's own part of a push's data (stored JSON) → object (maybe empty). */
function contextOf(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (!HOST_FIELDS.has(k)) out[k] = v;
  return out;
}

/**
 * One notification + action: the hook of its plugin, at most once ever.
 * Resolves when the hook answered (or failed); never rejects.
 */
async function dispatchOne(notificationId, userId, action) {
  const n = db().prepare('SELECT id, source, data FROM notifications WHERE id = ?').get(notificationId);
  if (!n) return false;
  const sourceId = pluginOf(n.source);
  if (!sourceId) return false;
  // a push of a plugin that was replaced since (plugin.json `replaces`) goes to the plugin that replaced it
  let resolved = null;
  try { resolved = registry.resolve(sourceId); } catch { resolved = null; }
  const pluginId = resolved ? resolved.id : sourceId;
  let data;
  try { data = n.data ? JSON.parse(n.data) : null; } catch { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  if (!actions.some((a) => a && a.type === 'callback' && a.id === action)) return false;
  if (!eligible(pluginId)) {
    logger.info({ pluginId, notificationId, action }, 'push callback: plugin not running — not delivered');
    return false;
  }
  const r = db().prepare('INSERT OR IGNORE INTO notify_action_calls (notification_id, action, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(notificationId, action, userId, new Date().toISOString());
  if (r.changes !== 1) return false; // already delivered once
  try {
    await runtime.call(pluginId, 'notifyAction', { userId, notificationId, action, data: contextOf(data) }, HOOK_MS);
  } catch (err) {
    logger.warn({ pluginId, notificationId, action, err: err && err.message }, 'push callback: notifyAction hook failed');
  }
  return true;
}

/**
 * After an ack with state 'read' and an action: the rows store.ack changed
 * ([{ notification_id, user_id }] — deliveries of the acking device only).
 * Resolves with the number of hook calls made; never rejects (fire and
 * forget for the route, awaitable for tests).
 */
async function onAck(changed, action) {
  if (typeof action !== 'string' || !Array.isArray(changed) || !changed.length) return 0;
  const seen = new Map();
  for (const c of changed) if (c && c.user_id != null && !seen.has(c.notification_id)) seen.set(c.notification_id, c.user_id);
  let calls = 0;
  for (const [notificationId, userId] of seen) {
    try {
      if (await dispatchOne(notificationId, userId, action)) calls += 1;
    } catch (err) {
      logger.warn({ notificationId, action, err: err && err.message }, 'push callback failed');
    }
  }
  return calls;
}

module.exports = { onAck, HOOK_MS, HOST_FIELDS };
