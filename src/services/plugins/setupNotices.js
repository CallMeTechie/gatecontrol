'use strict';

// Einrichtungshinweise ("Handeln nötig") of plugins — plugin.json
// `setupNotices` (since 1.241.0, docs/plugins.md "Setup notices",
// validated in manifest.js). A notice is a step an administrator has to do by
// hand after an install or an update to a version ≥ `since` (a new compose
// file for the gateway, a setting of a camera …). It is shown as a banner on
// Einstellungen › Plugins › <plugin> (every tab), as a dot in the plugin list
// and as "Plugins brauchen deine Hilfe" on the dashboard until it is done:
//
//   manual          only "Erledigt" of an administrator
//   gatewayService  done as soon as one gateway has the feature `feature` on
//                   and its compose service `service` runs (telemetry); open
//                   while a gateway has the feature on but the service is
//                   missing — with that gateway's name and the download of
//                   its docker-compose.yml
//   gatewayVersion  { min } done when every gateway (with `feature`, when
//                   given) runs at least that gateway version
//   hostVersion     { min } done when this GateControl is at least that version
//
// "Erledigt" is stored per plugin + notice id (migration 137,
// plugin_notice_acks: who, when, for which plugin version) and written to the
// activity log; it ends a notice whatever its check says.

const { getDb } = require('../../db/connection');
const semver = require('./semver');
const { loc } = require('./manifest');
const logger = require('../../utils/logger');

const SNAPSHOT_MS = 10 * 1000;

class NoticeError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function serverVersion() { return require('../../../package.json').version; }

function atLeast(v, min) {
  if (typeof v !== 'string' || !semver.valid(v)) return false;
  try { return semver.compare(v, min) >= 0; } catch { return false; }
}

// ─── Gateways (telemetry of the last heartbeat) ──────────────────────

// Features with a compose service of their own: whether the gateway should run it (what the
// admin switched on — the same rule as the "docker-compose.yml herunterladen" of its row) and
// whether it runs (telemetry, as the rows "Kameras", "Lokale KI", "Funk" read it).
const FEATURES = {
  cameras: {
    on: (g) => require('../homeCameras').composeWantsCameras(g.id),
    running: (tel) => { const t = require('../homeCameras').telemetryCameras(tel); return !!t && t.service === 'managed'; },
  },
  ai: {
    on: (g) => require('../ai/local').composeWantsAi(g.id),
    running: (tel) => { const t = require('../ai/local').telemetryAi(tel); return !!t && t.service === 'managed'; },
  },
  radio: {
    on: (g) => require('../homeRadio').composeWantsZigbee(g.id),
    running: (tel) => { const t = require('../homeRadio').telemetryRadio(tel); return !!t && (t.zigbee.service === 'managed' || t.zigbee.service === 'image'); },
  },
};
FEATURES.zigbee = FEATURES.radio;

/** A feature this host does not know by name: the gateway's stored switch or its telemetry. */
function genericOn(g, feature) {
  try {
    const s = require('../gatewayFeatures').get(g.id)[feature];
    if (isObj(s) && typeof s.enabled === 'boolean') return s.enabled;
  } catch { /* unknown feature */ }
  const t = isObj(g.tel.features) ? g.tel.features[feature] : null;
  return isObj(t) && (t.enabled === true || t.want === true);
}

function genericRunning(tel, feature) {
  const t = isObj(tel.features) ? tel.features[feature] : null;
  return isObj(t) && t.service === 'managed';
}

function featureOn(g, feature) {
  const f = FEATURES[feature];
  try { return f ? !!f.on(g) : genericOn(g, feature); } catch { return false; }
}

function serviceRunning(g, feature) {
  const f = FEATURES[feature];
  try { return f ? !!f.running(g.tel) : genericRunning(g.tel, feature); } catch { return false; }
}

let _snap = { at: 0, list: null };

/** The enabled gateways with name, version, platform and telemetry (cached SNAPSHOT_MS). */
function gateways(now = Date.now()) {
  if (_snap.list && now - _snap.at < SNAPSHOT_MS) return _snap.list;
  let rows = [];
  try {
    rows = db().prepare(`SELECT p.id, p.name, gm.last_health FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
      WHERE p.peer_type = 'gateway' AND p.enabled = 1 ORDER BY p.name COLLATE NOCASE, p.id`).all();
  } catch (e) {
    logger.warn({ err: e.message }, 'setup notices: gateways unavailable');
    rows = [];
  }
  const list = rows.map((r) => {
    const h = json(r.last_health) || {};
    const tel = isObj(h.telemetry) ? h.telemetry : {};
    let platform = null;
    try { platform = require('../homeRadio').platformOf(r.id, tel); } catch { platform = null; }
    return { id: r.id, name: r.name, tel, platform, version: typeof tel.gateway_version === 'string' ? tel.gateway_version : null };
  });
  _snap = { at: now, list };
  return list;
}

function resetCache() { _snap = { at: 0, list: null }; }

function gwView(g, extra) {
  return { id: g.id, name: g.name, version: g.version, platform: g.platform, ...(extra || {}) };
}

// ─── Evaluation ────────────────────────────────────────

/**
 * The check of one notice → { met, gateways } (met: the step is visibly done).
 * gateways: those that still need it (gatewayService: compose true when a new compose file helps).
 */
function evaluateCheck(check, gws) {
  const c = check || { type: 'manual' };
  if (c.type === 'gatewayService') {
    const on = gws.filter((g) => featureOn(g, c.feature));
    const missing = on.filter((g) => !serviceRunning(g, c.feature));
    if (missing.length) return { met: false, gateways: missing.map((g) => gwView(g, { compose: g.platform !== 'rpi' })) };
    return { met: on.length > 0, gateways: [] };
  }
  if (c.type === 'gatewayVersion') {
    const relevant = c.feature ? gws.filter((g) => featureOn(g, c.feature)) : gws;
    const old = relevant.filter((g) => !atLeast(g.version, c.min));
    return { met: old.length === 0, gateways: old.map((g) => gwView(g)) };
  }
  if (c.type === 'hostVersion') return { met: atLeast(serverVersion(), c.min), gateways: [] };
  return { met: false, gateways: [] };
}

function acksOf(pluginId) {
  try {
    return new Map(db().prepare('SELECT notice_id, plugin_version, acked_by, acked_at FROM plugin_notice_acks WHERE plugin_id = ?').all(pluginId)
      .map((r) => [r.notice_id, r]));
  } catch { return new Map(); }
}

function anchorOf(p, n, lang) {
  const h = p.manifest && p.manifest.handbook;
  if (!h || !n.handbook) return null;
  if (typeof n.handbook === 'string') return n.handbook;
  return n.handbook[require('./handbook').pickLang(h, lang)] || null;
}

/** The notices of the installed version (≥ since). */
function declared(p) {
  const list = p && p.manifest && Array.isArray(p.manifest.setupNotices) ? p.manifest.setupNotices : [];
  return list.filter((n) => n && typeof n.since === 'string' && atLeast(p.version, n.since));
}

/**
 * Every notice of a plugin's installed version with its state:
 * 'open' (shown), 'done' (the check is met) or 'acked' ("Erledigt").
 */
function all(p, lang, { gws } = {}) {
  const list = declared(p);
  if (!list.length) return [];
  const acks = acksOf(p.id);
  const needsGateways = list.some((n) => n.check && (n.check.type === 'gatewayService' || n.check.type === 'gatewayVersion'));
  const g = gws || (needsGateways ? gateways() : []);
  return list.map((n) => {
    const ack = acks.get(n.id) || null;
    const ev = evaluateCheck(n.check, g);
    const state = ack ? 'acked' : (ev.met ? 'done' : 'open');
    return {
      id: n.id, since: n.since, title: loc(n.title, lang), text: loc(n.text, lang),
      // the anchor in the language the tab shows (handbook.pickLang); a stored string: both
      handbook: anchorOf(p, n, lang),
      check: { ...n.check },
      state,
      gateways: state === 'open' ? ev.gateways : [],
      ack: ack ? { by: ack.acked_by || null, at: ack.acked_at, version: ack.plugin_version || null } : null,
    };
  });
}

/** The open notices of a plugin (the banner). */
function open(p, lang, opts) {
  try { return all(p, lang, opts).filter((n) => n.state === 'open'); } catch (e) {
    logger.warn({ plugin: p && p.id, err: e.message }, 'setup notices not evaluated');
    return [];
  }
}

/** Dashboard "Plugins brauchen deine Hilfe": enabled plugins with open notices → [{ id, name, count, titles }]. */
function summary(lang) {
  let rows;
  try { rows = require('./registry').list(); } catch { return []; }
  const out = [];
  for (const p of rows) {
    if (!p.enabled || !declared(p).length) continue;
    const list = open(p, lang);
    if (list.length) out.push({ id: p.id, name: loc(p.manifest.name, lang) || p.name, count: list.length, titles: list.map((n) => n.title) });
  }
  return out;
}

/**
 * "Erledigt" of an administrator.
 * @param {object} p        the installed plugin (registry row)
 * @param {string} noticeId
 * @param {{ user?: {id, name}, ip?: string }} opts
 */
function ack(p, noticeId, { user, ip } = {}) {
  const n = declared(p).find((x) => x.id === noticeId);
  if (!n) throw new NoticeError('notice_not_found', 'no such notice');
  const now = Date.now();
  db().prepare(`INSERT INTO plugin_notice_acks (plugin_id, notice_id, plugin_version, acked_by, acked_by_id, acked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id, notice_id) DO UPDATE SET plugin_version = excluded.plugin_version, acked_by = excluded.acked_by,
      acked_by_id = excluded.acked_by_id, acked_at = excluded.acked_at`)
    .run(p.id, n.id, p.version, user ? String(user.name || '').slice(0, 120) || null : null, user && Number.isSafeInteger(user.id) ? user.id : null, now);
  const name = loc(p.manifest.name, 'de') || p.name;
  try { require('./registry').addLog(p.id, 'info', `setup notice "${n.id}" marked as done${user && user.name ? ' by ' + user.name : ''}`); } catch { /* log only */ }
  try {
    require('../activity').log('plugin_notice_done', `Plugin "${name}": setup step "${loc(n.title, 'de')}" marked as done`, {
      source: 'admin', ipAddress: ip, severity: 'info',
      details: { plugin: p.id, notice: n.id, version: p.version, check: n.check.type, user: user ? user.name || null : null },
    });
  } catch (e) { logger.warn({ plugin: p.id, err: e.message }, 'setup notice: activity not logged'); }
  return { at: now };
}

/** "Alles löschen" of a plugin: its confirmations go with it. */
function forget(pluginId) {
  try { db().prepare('DELETE FROM plugin_notice_acks WHERE plugin_id = ?').run(pluginId); } catch { /* table missing on an old schema */ }
}

module.exports = { NoticeError, all, open, summary, ack, forget, evaluateCheck, gateways, resetCache, featureOn, serviceRunning, declared };
