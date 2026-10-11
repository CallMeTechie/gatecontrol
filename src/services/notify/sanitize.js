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

/** One action → clean action or null (unknown type, bad target). */
function action(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const type = String(a.type || '');
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
 * and bad routes are dropped silently.
 */
function data(raw) {
  if (raw == null) return { ok: true, data: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, data: null };
  const out = cleanValue(raw, 0) || {};
  if ('route' in out) {
    if (typeof out.route !== 'string' || !APP_ROUTE_RE.test(out.route)) delete out.route;
  }
  if ('actions' in out) {
    const list = Array.isArray(raw.actions) ? raw.actions.slice(0, LIMITS.actions).map(action).filter(Boolean) : [];
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

module.exports = { line, text, title, body, data, action, facts, portalPath, collapseKey };
