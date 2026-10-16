'use strict';

// Quick actions of the GateControl apps (docs/plugins.md "Quick actions"):
// Android home-screen shortcuts, Quick Settings tiles and the widget.
//
//   hook quickActions({ user, lang })          → [{ id, title, subtitle?, icon?,
//                                                  kind: 'button'|'toggle', state?, confirm?,
//                                                  confirmWhen?, look?, device?, widget? }]
//   hook runQuickAction({ user, lang, id, via, automation, control?, value? })
//                                              → { ok?, message?, state?, widget? }
//     via: 'app' (shortcut, tile, widget, app screen) | 'notification' (the
//     action button of a push) | '<plugin id>' (gc.actions.run of that
//     plugin); automation: true only for gc.actions.run (another plugin ran
//     it for the user), false for everything a person started.
//     control / value: only when the app moved a control of the action's
//     widget (the control's id and the validated value — a number for a
//     stepper / slider, an option id for a choice); absent otherwise.
//
// A device groups the actions of one thing (a car, a lamp, a lock) in the
// apps: device: { id, title, subtitle?, icon? } (invalid → null, the action
// stays). Toggles may say how each state looks — look: { on?: { icon?, tone? },
// off?: { icon?, tone? } }, tone 'good'|'warn'|'crit'|'neutral' — and in which
// state the app asks first: confirmWhen: 'on'|'off'.
//
// A widget is a quick action with extra information and controls, shown by
// the apps as a card instead of a button:
//   widget: { label?, value?: string|number, unit?, status?, state?: 'on'|'off'|'good'|'warn'|'crit',
//             readings?: [{ id, label, value?, unit?, icon?, state? }],   (≤ 4, invalid ones dropped)
//             controls?: [{ id, kind: 'stepper'|'slider', label?, value, min, max, step, unit? },
//                         { id, kind: 'choice', label?, value, options: [{ id, label }] }],
//             power?: boolean }                                        (default true)
// Anything invalid in it (but a reading) makes the whole widget null; the action stays.
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
const WIDGET_STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
const CONTROL_KINDS = new Set(['stepper', 'slider', 'choice']);
const CONTROL_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_CONTROLS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const DEVICE_ID_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const TONES = new Set(['good', 'warn', 'crit', 'neutral']);
const MAX_READINGS = 4;

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
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function icon(v) { return typeof v === 'string' && ICON_RE.test(v) ? v : null; }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** device: { id, title, subtitle?, icon? } → { id, title, subtitle, icon }, or null (invalid / none). */
function sanitizeDevice(d) {
  if (!isObj(d)) return null;
  if (typeof d.id !== 'string' || !DEVICE_ID_RE.test(d.id)) return null;
  const title = text(d.title, 40);
  if (!title) return null;
  return { id: d.id, title, subtitle: text(d.subtitle, 60), icon: icon(d.icon) };
}

/** One part (on / off) of a toggle's look → { icon, tone }, or null without a valid icon or tone. */
function lookPart(p) {
  if (!isObj(p)) return null;
  const i = icon(p.icon);
  const tone = typeof p.tone === 'string' && TONES.has(p.tone) ? p.tone : null;
  return i || tone ? { icon: i, tone } : null;
}

/** look of a toggle → { on: {icon, tone}|null, off: {icon, tone}|null }, or null when neither part is valid. */
function sanitizeLook(l) {
  if (!isObj(l)) return null;
  const on = lookPart(l.on);
  const off = lookPart(l.off);
  return on || off ? { on, off } : null;
}

/**
 * The shared part of a widget reading and a Start tile item (the apps'
 * value rows) → { label, value, unit, icon, state }, or null: label ≤ 20
 * (required), value a string ≤ 16 or a finite number, unit ≤ 8, icon an SVG
 * path, state from the widget states; a value or an icon is required.
 */
function sanitizeValueRow(r) {
  if (!isObj(r)) return null;
  const label = text(r.label, 20);
  if (!label) return null;
  let value = null;
  if (typeof r.value === 'string') value = text(r.value, 16);
  else value = num(r.value);
  const i = icon(r.icon);
  if (value === null && i === null) return null;
  return {
    label, value, unit: text(r.unit, 8), icon: i,
    state: typeof r.state === 'string' && WIDGET_STATES.has(r.state) ? r.state : null,
  };
}

/** One reading of a widget → { id, label, value, unit, icon, state }, or null (dropped). */
function sanitizeReading(r) {
  if (!isObj(r) || typeof r.id !== 'string' || !CONTROL_ID_RE.test(r.id)) return null;
  const row = sanitizeValueRow(r);
  return row && { id: r.id, ...row };
}

/** readings of a widget → at most 4 valid ones with unique ids (invalid ones dropped, never the widget). */
function sanitizeReadings(list) {
  if (!Array.isArray(list)) return [];
  const res = [];
  const seen = new Set();
  for (const raw of list.slice(0, MAX_READINGS * 4)) {
    const r = sanitizeReading(raw);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    res.push(r);
    if (res.length >= MAX_READINGS) break;
  }
  return res;
}

/** One control of a widget → the sanitised control, or null (invalid). */
function sanitizeControl(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (typeof c.id !== 'string' || !CONTROL_ID_RE.test(c.id)) return null;
  if (typeof c.kind !== 'string' || !CONTROL_KINDS.has(c.kind)) return null;
  const label = text(c.label, 20);
  if (c.kind === 'choice') {
    if (!Array.isArray(c.options) || c.options.length < MIN_OPTIONS || c.options.length > MAX_OPTIONS) return null;
    const options = [];
    const seen = new Set();
    for (const o of c.options) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      if (typeof o.id !== 'string' || !CONTROL_ID_RE.test(o.id) || seen.has(o.id)) return null;
      const l = text(o.label, 20);
      if (!l) return null;
      seen.add(o.id);
      options.push({ id: o.id, label: l });
    }
    const value = typeof c.value === 'string' && seen.has(c.value) ? c.value : options[0].id;
    return { id: c.id, kind: 'choice', label, value, options };
  }
  const min = num(c.min);
  const max = num(c.max);
  const step = num(c.step);
  const value = num(c.value);
  if (min === null || max === null || step === null || value === null || !(min < max) || !(step > 0)) return null;
  return { id: c.id, kind: c.kind, label, value: Math.min(max, Math.max(min, value)), min, max, step, unit: text(c.unit, 8) };
}

/**
 * The `widget` of a quick action (listed or in a run's answer) → the sanitised
 * widget, or null when there is none or anything in it is invalid.
 * Readings are dropped one by one, they never make the widget null.
 * @returns {null | { label: string|null, value: string|number|null, unit: string|null,
 *   status: string|null, state: string|null, readings: object[], controls: object[], power: boolean }}
 */
function sanitizeWidget(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  let value = null;
  if (typeof w.value === 'string') value = text(w.value, 24);
  else if (typeof w.value === 'number' && Number.isFinite(w.value)) value = w.value;
  const controls = [];
  if (w.controls != null) {
    if (!Array.isArray(w.controls) || w.controls.length > MAX_CONTROLS) return null;
    const seen = new Set();
    for (const raw of w.controls) {
      const c = sanitizeControl(raw);
      if (!c || seen.has(c.id)) return null;
      seen.add(c.id);
      controls.push(c);
    }
  }
  return {
    label: text(w.label, 24),
    value,
    unit: text(w.unit, 8),
    status: text(w.status, 60),
    state: typeof w.state === 'string' && WIDGET_STATES.has(w.state) ? w.state : null,
    readings: sanitizeReadings(w.readings),
    controls,
    power: w.power !== false,
  };
}

/** One entry of quickActions → the sanitised action, or null (dropped). */
function sanitize(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) return null;
  const title = text(a.title, 40);
  if (!title) return null;
  const kind = a.kind == null ? 'button' : a.kind;
  if (!KINDS.has(kind)) return null;
  const toggle = kind === 'toggle';
  return {
    id: a.id,
    title,
    subtitle: text(a.subtitle, 60),
    icon: icon(a.icon),
    kind,
    state: toggle ? state(a.state) : null,
    confirm: a.confirm === true,
    confirmWhen: toggle ? state(a.confirmWhen) : null,
    look: toggle ? sanitizeLook(a.look) : null,
    device: sanitizeDevice(a.device),
    widget: sanitizeWidget(a.widget),
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
 * @returns {Promise<object[]>} [{ plugin, pluginName, id, title, subtitle, icon, kind, state, confirm,
 *   confirmWhen, look, device, widget }]
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

const VIA_PERSON = new Set(['app', 'notification']);

/**
 * The value the app sent for one control of the listed widget → the validated
 * value (a number for a stepper / slider, an option id for a choice), or
 * undefined when it is not acceptable.
 */
function controlValue(c, v) {
  if (c.kind === 'choice') return typeof v === 'string' && c.options.some((o) => o.id === v) ? v : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= c.min && v <= c.max ? v : undefined;
}

/**
 * Run one action for one viewer — only an id the plugin currently lists for
 * that viewer.
 * @param {{via?: string, control?: string, value?: number|string}} [opts]
 *   via: 'app' (default) | 'notification' for a run a person started; a
 *   viewer with `automation: true` (gc.actions.run) always runs with via =
 *   its `via` (the calling plugin's id). control: the id of a control of the
 *   listed action's widget the app moved, value its new value — both reach
 *   the hook validated; without `control` the hook gets neither.
 * @returns {Promise<{status: number, body: object}>}
 *   200 { ok, message, state, widget } · 400 invalid_control | invalid_value ·
 *   404 not_found · 502 plugin_error · 504 timeout
 */
async function run(pluginId, actionId, user, lang, opts = {}) {
  const l = lang2(lang);
  const automation = !!(user && user.automation === true);
  let via;
  if (automation) via = String(user.via || '');
  else via = opts && typeof opts.via === 'string' && VIA_PERSON.has(opts.via) ? opts.via : 'app';
  const controlRun = !!opts && opts.control !== undefined && opts.control !== null;
  const notFound = { status: 404, body: { ok: false, error: 'not_found' } };
  const p = pluginById(pluginId);
  if (!p || typeof actionId !== 'string' || !ACTION_ID_RE.test(actionId)) return notFound;
  const fail = (e) => (e && e.code === 'ERR_TIMEOUT'
    ? { status: 504, body: { ok: false, error: 'timeout' } }
    : { status: 502, body: { ok: false, error: 'plugin_error' } });
  let listed;
  try { listed = sanitizeList(await runtime.call(p.id, 'quickActions', { user, lang: l }, HOOK_MS)); } catch (e) { return fail(e); }
  const action = listed.find((a) => a.id === actionId);
  if (!action) return notFound;
  const payload = { user, lang: l, id: actionId, via, automation };
  if (controlRun) {
    const c = typeof opts.control === 'string' && action.widget
      ? action.widget.controls.find((x) => x.id === opts.control) : undefined;
    if (!c) return { status: 400, body: { ok: false, error: 'invalid_control' } };
    const value = controlValue(c, opts.value);
    if (value === undefined) return { status: 400, body: { ok: false, error: 'invalid_value' } };
    payload.control = c.id;
    payload.value = value;
  }
  let out;
  try { out = await runtime.call(p.id, 'runQuickAction', payload, runMs); } catch (e) { return fail(e); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) return { status: 502, body: { ok: false, error: 'plugin_error' } };
  return { status: 200, body: { ok: out.ok !== false, message: text(out.message, 120), state: state(out.state), widget: sanitizeWidget(out.widget) } };
}

function _setRunTimeoutForTest(ms) {
  if (process.env.NODE_ENV === 'test') runMs = Number.isInteger(ms) && ms > 0 ? ms : RUN_MS;
}

module.exports = {
  list, run, sanitize, sanitizeWidget, sanitizeDevice, sanitizeLook, sanitizeReading, sanitizeReadings, sanitizeValueRow,
  HOOK_MS, MAX_READINGS, TONES, RUN_MS, MAX_ACTIONS, MAX_CONTROLS, ACTION_ID_RE, CONTROL_ID_RE, DEVICE_ID_RE, VIA_PERSON, _setRunTimeoutForTest,
};
