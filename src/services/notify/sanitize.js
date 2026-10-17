'use strict';

// Payload limits of a notification (docs "Sicherheit und Datenschutz"):
// title ≤ 120, body ≤ 1000 characters, data ≤ 4 KB JSON, control characters
// removed, actions only from the fixed list. The apps show plain text only.

const { ACTION_TYPES, APP_ROUTE_RE, LIMITS } = require('./constants');

// C0/C1 control characters and the Unicode bidi overrides. A newline inside
// a body is kept (as \n); everything else becomes a space.
const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** One line: no control characters at all, trimmed, cut to `max`. */
function line(value, max) {
  return String(value == null ? '' : value).replace(/\r?\n|\r|\t/g, ' ').replace(CTRL_RE, ' ')
    .replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** Multi-line text: newlines kept (at most two in a row), cut to `max`. */
function text(value, max) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CTRL_RE, ' ')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

const title = (v) => line(v, LIMITS.title);
const body = (v) => text(v, LIMITS.body);

/** A path inside the portal ('/…', never '//host' or a scheme). */
function portalPath(v) {
  const s = String(v == null ? '' : v);
  return /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]{0,300}$/.test(s) && !s.includes('\\') ? s : null;
}

// quick_action: the id is a quick action id of the plugin (quickActions.js ACTION_ID_RE)
const QUICK_ACTION_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;

/**
 * A quick_action of a plugin push → { id, label, type, plugin, confirm,
 * auth? } or null. Only from that plugin itself (`opts.plugin`), never in a
 * core or administrator message.
 */
function quickAction(a, opts) {
  const pluginId = opts && typeof opts.plugin === 'string' ? opts.plugin : null;
  if (!pluginId || a.plugin !== pluginId) return null;
  if (typeof a.id !== 'string' || !QUICK_ACTION_ID_RE.test(a.id)) return null;
  const label = line(a.label, LIMITS.quickActionLabel);
  if (!label) return null;
  const out = { id: a.id, label, type: 'quick_action', plugin: pluginId, confirm: a.confirm === true };
  if (a.auth === 'device') out.auth = 'device';
  return out;
}

// reply / mark_read: a path of the sending plugin's own client API
// (POST /api/v1/client/plugins/<plugin>/api/<path>), relative, no '..'
const PLUGIN_PATH_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,300}$/;
const CHAT_ACTIONS = new Set(['reply', 'mark_read']);
const CHAT_BODY_BYTES = 1024;

/** A relative plugin API path ('conversations/12/messages') or null. */
function pluginPath(v) {
  const s = typeof v === 'string' ? v.replace(/^\/+/, '') : '';
  return PLUGIN_PATH_RE.test(s) && !s.split('/').some((x) => x === '..' || x === '.') ? s : null;
}

/**
 * reply / mark_read of a chat notification (docs/plugins.md "Chat
 * notifications") → { id, label, type, path, body? } or null. Only in a
 * plugin push on a chat topic (`opts.chat`). `body`: a JSON object ≤ 1 KB
 * the app sends along (reply: merged with { clientId, kind, text }).
 */
function chatAction(a, opts) {
  if (!opts || opts.chat !== true || typeof opts.plugin !== 'string') return null;
  const path = pluginPath(a.path);
  if (!path) return null;
  const id = line(a.id || a.type, 40);
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(id)) return null;
  const label = line(a.label, LIMITS.quickActionLabel);
  if (!label) return null;
  const out = { id, label, type: a.type, path };
  if (a.body != null) {
    if (typeof a.body !== 'object' || Array.isArray(a.body)) return null;
    const body = cleanValue(a.body, 1);
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > CHAT_BODY_BYTES) return null;
    out.body = body;
  }
  return out;
}

/**
 * One action → clean action or null (unknown type, bad target). opts.plugin:
 * the id of the plugin sending the message (allows its own quick_action);
 * opts.chat: a chat topic of that plugin (allows reply / mark_read).
 */
function action(a, opts = null) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const type = String(a.type || '');
  if (type === 'quick_action') return quickAction(a, opts);
  if (CHAT_ACTIONS.has(type)) return chatAction(a, opts);
  if (!ACTION_TYPES.has(type)) return null;
  const id = line(a.id || type, 40);
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(id)) return null;
  const out = { id, label: line(a.label || id, 40), type };
  if (type === 'open_app_route') {
    const target = String(a.target || '');
    if (!APP_ROUTE_RE.test(target)) return null;
    out.target = target;
  } else if (type === 'open_portal') {
    const target = portalPath(a.target);
    if (!target) return null;
    out.target = target;
  }
  return out;
}

/** Deep-clean plain JSON values: strings lose control characters. */
function cleanValue(v, depth) {
  if (depth > 6) return null;
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.replace(CTRL_RE, ' ').slice(0, 1000);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cleanValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 50)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[String(k).slice(0, 60)] = cleanValue(x, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * `data.facts`: up to LIMITS.facts { label, value } pairs the apps show
 * under the text ("Zuletzt gesehen: 21:40"). One line each, label ≤ 60 and
 * value ≤ 120 characters, numbers become text; empty or malformed entries
 * are dropped. → array or null (nothing usable).
 */
function facts(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const f of raw.slice(0, 20)) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const ok = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    if (!ok(f.label) || !ok(f.value)) continue;
    const label = line(f.label, LIMITS.factLabel);
    const value = line(f.value, LIMITS.factValue);
    if (!label || !value) continue;
    out.push({ label, value });
    if (out.length >= LIMITS.facts) break;
  }
  return out.length ? out : null;
}

/**
 * `data` of a notification: { route?, actions?, facts?, ...context }. Returns
 * { ok, data } — ok=false when it does not fit into 4 KB (callers from a
 * plugin get ERR_INVALID; core events never get there). Unknown action types
 * and bad routes are dropped silently. opts.plugin: the sending plugin
 * (quick_action entries of that plugin are kept).
 */
function data(raw, opts = null) {
  if (raw == null) return { ok: true, data: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null };
  const out = cleanValue(raw, 0) || {};
  if ('route' in out) {
    if (typeof out.route !== 'string' || !APP_ROUTE_RE.test(out.route)) delete out.route;
  }
  if ('actions' in out) {
    const list = Array.isArray(raw.actions) ? raw.actions.slice(0, LIMITS.actions).map((a) => action(a, opts)).filter(Boolean) : [];
    if (list.length) out.actions = list; else delete out.actions;
  }
  if ('facts' in out) {
    const list = facts(raw.facts);
    if (list) out.facts = list; else delete out.facts;
  }
  if (!Object.keys(out).length) return { ok: true, data: null };
  const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (size > LIMITS.dataBytes) return { ok: false, data: null };
  return { ok: true, data: out };
}

function collapseKey(v) {
  if (v == null || v === '') return null;
  const s = line(v, LIMITS.collapseKey);
  return /^[A-Za-z0-9_.:@/-]{1,120}$/.test(s) ? s : null;
}

module.exports = { line, text, title, body, data, action, facts, portalPath, pluginPath, collapseKey, CHAT_ACTIONS, CHAT_BODY_BYTES };
