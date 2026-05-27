'use strict';

const { getDb } = require('../db/connection');
const accessRules = require('./accessRules');
const activity = require('./activity');
const logger = require('../utils/logger');

// Module state: the set of currently-denied targets, keyed "type:id".
// A transition is any target that moved into or out of this set between
// ticks. On the very first run lastDenied is empty, so the ENTIRE initial
// deny-set is treated as transitions — boot-time denies (peer disconnects,
// L4 route omissions) are therefore enforced and logged, never silent.
let lastDenied = new Set();
let _timer = null;

function _key(type, id) { return `${type}:${id}`; }

/**
 * One reconciliation pass.
 *  1. Orphan sweep — drop rules whose target row no longer exists.
 *  2. Compute the current deny-set (peers gated on enabled=1).
 *  3. Diff vs lastDenied; for newly-denied peers, live-disconnect via
 *     wireguard.removePeer (DIRECTLY, never via the coalesced sync, so a
 *     deny can't be dropped). Log every transition both directions.
 *  4. If any route changed, request a coalesced Caddy sync; if any peer
 *     changed, rewrite the WG config (serialized via peers._wgRewriteChain).
 *  5. Persist the new deny-set as lastDenied.
 *
 * Deps that tests stub (wireguard, caddySync, peers) are require()'d inline
 * so the stubbed exports are observed.
 */
async function reconcile(now = new Date()) {
  const db = getDb();

  // 1. Orphan sweep — two explicit statements.
  db.prepare("DELETE FROM access_rules WHERE target_type='route' AND target_id NOT IN (SELECT id FROM routes)").run();
  db.prepare("DELETE FROM access_rules WHERE target_type='peer' AND target_id NOT IN (SELECT id FROM peers)").run();

  // 2. Current deny-set.
  const targets = db.prepare('SELECT DISTINCT target_type, target_id FROM access_rules').all();
  const current = new Set();
  for (const { target_type, target_id } of targets) {
    if (!accessRules.isDenied(target_type, target_id, now)) continue;
    if (target_type === 'peer') {
      // Only enabled peers belong in the deny-set: a license/admin-disabled
      // peer is already absent from the WG file, so denying it would emit a
      // spurious removePeer + transition log.
      const row = db.prepare('SELECT enabled FROM peers WHERE id=?').get(target_id);
      if (!row || !row.enabled) continue;
    }
    current.add(_key(target_type, target_id));
  }

  // 3. Diff and act on transitions.
  let routesChanged = false;
  let peersChanged = false;

  // Newly denied (in current, not in lastDenied).
  for (const { target_type, target_id } of targets) {
    const key = _key(target_type, target_id);
    if (!current.has(key) || lastDenied.has(key)) continue;
    // became denied
    if (target_type === 'peer') {
      peersChanged = true;
      const row = db.prepare('SELECT public_key FROM peers WHERE id=?').get(target_id);
      if (row && row.public_key) {
        try {
          await require('./wireguard').removePeer(row.public_key);
        } catch (err) {
          logger.warn({ err: err.message, target_id }, 'access reconcile removePeer failed');
        }
      }
    } else {
      routesChanged = true;
    }
    _logTransition('access_window_denied', target_type, target_id, now, 'warning');
  }

  // Newly allowed (in lastDenied, not in current).
  for (const key of lastDenied) {
    if (current.has(key)) continue;
    const [target_type, idStr] = key.split(':');
    const target_id = Number(idStr);
    if (target_type === 'peer') peersChanged = true;
    else routesChanged = true;
    _logTransition('access_window_allowed', target_type, target_id, now, 'info');
  }

  // 4. Push config changes. removePeer already ran directly above; the WG
  //    rewrite re-adds any peer that became allowed.
  if (routesChanged) {
    await require('./caddySync').requestCaddySync();
  }
  if (peersChanged) {
    await require('./peers').rewriteWgConfig();
  }

  // 5. Persist.
  lastDenied = current;
}

function _logTransition(type, target_type, target_id, now, severity) {
  let schedule = null;
  try {
    const ev = accessRules.evaluate(target_type, target_id, now);
    schedule = ev && ev.reason && ev.reason.rule ? ev.reason.rule.schedule : null;
  } catch { /* best-effort */ }
  const verb = type === 'access_window_denied' ? 'denied' : 'allowed';
  activity.log(
    type,
    `Access ${verb} for ${target_type} #${target_id} by schedule`,
    { source: 'system', severity, details: { target_type, target_id, schedule } }
  );
}

async function reconcileNow() {
  return reconcile();
}

async function start() {
  await reconcile();
  _timer = setInterval(() => { reconcile().catch(() => {}); }, 60000);
  _timer.unref();
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { reconcile, reconcileNow, start, stop };
