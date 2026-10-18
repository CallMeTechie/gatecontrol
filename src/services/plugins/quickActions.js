'use strict';

// Quick actions of the GateControl apps (docs/plugins.md "Quick actions"):
// Android home-screen shortcuts, Quick Settings tiles and the widget.
//
//   hook quickActions({ user, lang })          → [{ id, title, subtitle?, icon?,
//                                                  kind: 'button'|'toggle', state?, confirm?,
//                                                  confirmWhen?, look?, verbs?, targets?,
//                                                  device?, widget? }]
//   hook runQuickAction({ user, lang, id, via, automation, control?, value?, target? })
//                                              → { ok?, message?, state?, widget? }
//     via: 'app' (shortcut, tile, widget, app screen) | 'notification' (the
//     action button of a push) | '<plugin id>' (gc.actions.run of that
//     plugin); automation: true only for gc.actions.run (another plugin ran
//     it for the user), false for everything a person started — also for
//     gc.actions.run with interactive: true (a person pressed the button in
//     that plugin; the viewer then has interactive: true).
//     control / value: only when the app moved a control of the action's
//     widget (the control's id and the validated value — a number for a
//     stepper / slider, an option id for a choice); absent otherwise.
//     target: 'on'|'off' only for a toggle that declares `targets: true`
//     when the run asks for a state — the plugin sets that state (never
//     flips); absent otherwise.
//
// A device groups the actions of one thing (a car, a lamp, a lock) in the
// apps: device: { id, title, subtitle?, icon? } (invalid → null, the action
// stays). Toggles may say how each state looks — look: { on?: { icon?, tone? },
// off?: { icon?, tone? } }, tone 'good'|'warn'|'crit'|'neutral' — and in which
// state the app asks first: confirmWhen: 'on'|'off'.
//
// Target states (toggles only): verbs: { on, off } names the command that
// sets each state ("Verriegeln" / "Entriegeln"); targets: true says the plugin
// honours `target` in runQuickAction. A run with `state` ('on'|'off', the
// client API and gc.actions.run) reaches a `targets` toggle as `target`; for
// any other toggle the host only runs it when the listed state is the other
// one (a flip reaches the target), answers `unchanged: true` without asking
// the plugin when it is already there, and 409 state_unknown when the plugin
// lists no state.
//
// A widget is a quick action with extra information and controls, shown by
// the apps as a card instead of a button:
//   widget: { label?, value?: string|number, unit?, status?, state?: 'on'|'off'|'good'|'warn'|'crit',
//             readings?: [{ id, label, value?, unit?, icon?, state? }],   (≤ 4, invalid ones dropped)
//             controls?: [{ id, kind: 'stepper'|'slider', label?, value, min, max, step, unit? },
//                         { id, kind: 'choice', label?, value, options: [{ id, label, icon? }] }],
//             power?: boolean,                                         (default true)
//             badge?: { icon, value?, unit?, state?: 'good'|'warn'|'crit', label? } }
// Anything invalid in it (but a reading or the badge) makes the whole widget null;
// the action stays. An invalid badge becomes null (badge: one small value in the
// card's head, right of the device name, e.g. a car's battery).
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
const MAX_VERB = 20;
const BADGE_STATES = new Set(['good', 'warn', 'crit']);
const MAX_BADGE_VALUE = 8;
const MAX_BADGE_UNIT = 4;
const MAX_BADGE_LABEL = 20;
const CTRL_RE = /[\0-\x1f\x7f]/;

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

/** One verb of a toggle: a string, trimmed 1–20 characters without control characters, else null. */
function verb(v) { return shortText(v, MAX_VERB); }

/**
 * A short text of a badge: a string, trimmed 1–max characters without
 * control characters, else null (too long → null, never cut).
 */
function shortText(v, max) {
  if (typeof v !== 'string' || CTRL_RE.test(v)) return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

/**
 * badge of a widget (one small value in the card's head, right of the device
 * name) → { icon, value, unit, state, label }, or null: icon an SVG path
 * (required — without a valid one the badge is null), value a string ≤ 8 or
 * a finite number, unit ≤ 4 (only with a value), state 'good'|'warn'|'crit',
 * label ≤ 20 (the accessible name); an invalid field becomes null, a string
 * that is too long or has control characters as well.
 */
function sanitizeBadge(b) {
  if (!isObj(b)) return null;
  const i = icon(b.icon);
  if (!i) return null;
  const value = typeof b.value === 'number' ? num(b.value) : shortText(b.value, MAX_BADGE_VALUE);
  return {
    icon: i,
    value,
    unit: value === null ? null : shortText(b.unit, MAX_BADGE_UNIT),
    state: typeof b.state === 'string' && BADGE_STATES.has(b.state) ? b.state : null,
    label: shortText(b.label, MAX_BADGE_LABEL),
  };
}

/** verbs of a toggle: { on, off } → { on, off } (both valid), or null. */
function sanitizeVerbs(v) {
  if (!isObj(v)) return null;
  const on = verb(v.on);
  const off = verb(v.off);
  return on && off ? { on, off } : null;
}

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
      options.push({ id: o.id, label: l, icon: icon(o.icon) }); // invalid icon → null, the option stays
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
 * Readings are dropped one by one and an invalid badge becomes null — they
 * never make the widget null. A widget without a value (value: null) is valid.
 * @returns {null | { label: string|null, value: string|number|null, unit: string|null,
 *   status: string|null, state: string|null, readings: object[], controls: object[], power: boolean,
 *   badge: { icon: string, value: string|number|null, unit: string|null, state: string|null,
 *   label: string|null } | null }}
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
    badge: sanitizeBadge(w.badge),
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
    verbs: toggle ? sanitizeVerbs(a.verbs) : null,
    targets: toggle && a.targets === true,
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
 *   confirmWhen, look, verbs, targets, device, widget }]
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
 * Quick actions of ONE plugin for one viewer (gc.actions.get): only that
 * plugin's hook is asked; [] when it is not eligible, fails or answers garbage.
 * @returns {Promise<object[]>} the same entries as list()
 */
async function listOf(pluginId, user, lang) {
  const p = pluginById(pluginId);
  if (!p) return [];
  const l = lang2(lang);
  let out;
  try { out = await runtime.call(p.id, 'quickActions', { user, lang: l }, HOOK_MS); } catch { return []; }
  const pluginName = loc(p.manifest.name, l) || p.name;
  return sanitizeList(out).map((a) => ({ plugin: p.id, pluginName, ...a }));
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
 * @param {{via?: string, control?: string, value?: number|string, state?: string}} [opts]
 *   via: 'app' (default) | 'notification' for a run a person started; a
 *   viewer with `automation: true` or `interactive: true` (gc.actions.run)
 *   always runs with via = its `via` (the calling plugin's id). control: the id of a control of the
 *   listed action's widget the app moved, value its new value — both reach
 *   the hook validated; without `control` the hook gets neither. state:
 *   'on'|'off', the state a toggle should end in (never with `control`) —
 *   `target` in the payload of a `targets` toggle, else the host's fallback
 *   (no run when already there, a flip when in the other state).
 * @returns {Promise<{status: number, body: object}>}
 *   200 { ok, message, state, widget, unchanged } · 400 invalid_state |
 *   invalid_control | invalid_value · 404 not_found · 409 state_unknown ·
 *   502 plugin_error · 504 timeout
 */
async function run(pluginId, actionId, user, lang, opts = {}) {
  const l = lang2(lang);
  const automation = !!(user && user.automation === true);
  // gc.actions.run: an automation run, or an interactive one (a person
  // pressed the button in the calling plugin) — via is the caller's id
  const byPlugin = automation || !!(user && user.interactive === true);
  let via;
  if (byPlugin) via = String(user.via || '');
  else via = opts && typeof opts.via === 'string' && VIA_PERSON.has(opts.via) ? opts.via : 'app';
  const controlRun = !!opts && opts.control !== undefined && opts.control !== null;
  const stateRun = !!opts && opts.state !== undefined && opts.state !== null;
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
  if (stateRun) {
    const want = state(opts.state);
    if (!want || controlRun || action.kind !== 'toggle') return { status: 400, body: { ok: false, error: 'invalid_state' } };
    if (action.targets) payload.target = want;
    else if (action.state === want) {
      // already there: the plugin is not asked (a run would flip it away)
      return { status: 200, body: { ok: true, message: null, state: want, widget: action.widget, unchanged: true } };
    } else if (action.state === null) return { status: 409, body: { ok: false, error: 'state_unknown' } };
    // else: in the other state — the plain run flips it into the target
  }
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
  return { status: 200, body: { ok: out.ok !== false, message: text(out.message, 120), state: state(out.state), widget: sanitizeWidget(out.widget), unchanged: false } };
}

function _setRunTimeoutForTest(ms) {
  if (process.env.NODE_ENV === 'test') runMs = Number.isInteger(ms) && ms > 0 ? ms : RUN_MS;
}

module.exports = {
  list, listOf, run, sanitize, sanitizeWidget, sanitizeDevice, sanitizeLook, sanitizeVerbs, sanitizeReading, sanitizeReadings, sanitizeValueRow, sanitizeBadge,
  HOOK_MS, MAX_READINGS, TONES, RUN_MS, MAX_ACTIONS, MAX_CONTROLS, ACTION_ID_RE, CONTROL_ID_RE, DEVICE_ID_RE, VIA_PERSON, TOGGLE_STATES, MAX_VERB, BADGE_STATES, _setRunTimeoutForTest,
};
