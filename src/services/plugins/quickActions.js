'use strict';

// Quick actions of the GateControl apps (docs/plugins.md "Quick actions"):
// Android home-screen shortcuts, Quick Settings tiles and the widget.
//
//   hook quickActions({ user, lang })          → [{ id, title, subtitle?, icon?,
//                                                  kind: 'button'|'toggle', state?, confirm? }]
//   hook runQuickAction({ user, lang, id })    → { ok?, message?, state? }
//
// Asked like the portal hooks (src/services/plugins/portal.js): only plugins
// that may run, are running and have `permissions.portal` (the actions run as
// the identified viewer — the owner of the app's device token); every plugin
// in parallel with its own timeout, a slow / failing / garbage-answering
// plugin only loses its own part. Everything a plugin answers is validated
// and capped here; the apps render it declaratively.

const runtime = require('./runtime');
const registry = require('./registry');
const { loc } = require('./manifest');
const { ID_RE } = require('./constants');
const { text, HOOK_MS } = require('./portal');

const RUN_MS = 10000;
let runMs = RUN_MS;
const MAX_ACTIONS = 16;
const ACTION_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
// SVG path data like ui.nav.icon / the Start tiles, longer for detailed glyphs
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
const KINDS = new Set(['button', 'toggle']);
const TOGGLE_STATES = new Set(['on', 'off']);

function evaluate(p) { return require('./index').evaluate(p); }

/** A plugin that may answer quick actions: may run, is running, has the portal permission. */
function eligible(p) {
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.portal)
    && evaluate(p).run && runtime.info(p.id).state === 'running';
}

function actionPlugins() {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter(eligible);
}

function pluginById(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64 || !ID_RE.test(id)) return null;
  let p;
  try { p = registry.get(id); } catch { return null; }
  return p && eligible(p) ? p : null;
}

function state(v) { return typeof v === 'string' && TOGGLE_STATES.has(v) ? v : null; }

/** One entry of quickActions → the sanitised action, or null (dropped). */
function sanitize(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) return null;
  const title = text(a.title, 40);
  if (!title) return null;
  const kind = a.kind == null ? 'button' : a.kind;
  if (!KINDS.has(kind)) return null;
  return {
    id: a.id,
    title,
    subtitle: text(a.subtitle, 60),
    icon: typeof a.icon === 'string' && ICON_RE.test(a.icon) ? a.icon : null,
    kind,
    state: kind === 'toggle' ? state(a.state) : null,
    confirm: a.confirm === true,
  };
}

/** A plugin's answer → at most 16 valid actions with unique ids. */
function sanitizeList(out) {
  if (!Array.isArray(out)) return [];
  const res = [];
  const seen = new Set();
  for (const raw of out.slice(0, MAX_ACTIONS * 4)) {
    const a = sanitize(raw);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    res.push(a);
    if (res.length >= MAX_ACTIONS) break;
  }
  return res;
}

function lang2(lang) { return lang === 'en' ? 'en' : 'de'; }

/**
 * Quick actions of every eligible plugin for one viewer.
 * @param {{id, name, role, portal: true, loggedIn: true, app: true}} user
 * @param {string} lang
 * @param {{exclude?: string}} [opts]  exclude: a plugin id that is not asked (gc.actions.list leaves out the caller)
 * @returns {Promise<object[]>} [{ plugin, pluginName, id, title, subtitle, icon, kind, state, confirm }]
 */
async function list(user, lang, opts = {}) {
  const l = lang2(lang);
  const exclude = opts && typeof opts.exclude === 'string' ? opts.exclude : null;
  const lists = await Promise.all(actionPlugins().filter((p) => p.id !== exclude).map(async (p) => {
    let out;
    try { out = await runtime.call(p.id, 'quickActions', { user, lang: l }, HOOK_MS); } catch { return []; }
    const pluginName = loc(p.manifest.name, l) || p.name;
    return sanitizeList(out).map((a) => ({ plugin: p.id, pluginName, ...a }));
  }));
  return lists.flat();
}

/**
 * Run one action for one viewer — only an id the plugin currently lists for
 * that viewer.
 * @returns {Promise<{status: number, body: object}>}
 *   200 { ok, message, state } · 404 not_found · 502 plugin_error · 504 timeout
 */
async function run(pluginId, actionId, user, lang) {
  const l = lang2(lang);
  const notFound = { status: 404, body: { ok: false, error: 'not_found' } };
  const p = pluginById(pluginId);
  if (!p || typeof actionId !== 'string' || !ACTION_ID_RE.test(actionId)) return notFound;
  const fail = (e) => (e && e.code === 'ERR_TIMEOUT'
    ? { status: 504, body: { ok: false, error: 'timeout' } }
    : { status: 502, body: { ok: false, error: 'plugin_error' } });
  let listed;
  try { listed = sanitizeList(await runtime.call(p.id, 'quickActions', { user, lang: l }, HOOK_MS)); } catch (e) { return fail(e); }
  if (!listed.some((a) => a.id === actionId)) return notFound;
  let out;
  try { out = await runtime.call(p.id, 'runQuickAction', { user, lang: l, id: actionId }, runMs); } catch (e) { return fail(e); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) return { status: 502, body: { ok: false, error: 'plugin_error' } };
  return { status: 200, body: { ok: out.ok !== false, message: text(out.message, 120), state: state(out.state) } };
}

function _setRunTimeoutForTest(ms) {
  if (process.env.NODE_ENV === 'test') runMs = Number.isInteger(ms) && ms > 0 ? ms : RUN_MS;
}

module.exports = { list, run, sanitize, HOOK_MS, RUN_MS, MAX_ACTIONS, ACTION_ID_RE, _setRunTimeoutForTest };
