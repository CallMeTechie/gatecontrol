'use strict';

// What plugins add to the portal (docs/plugins.md "Portal"):
//
//   own tab      ui.portal.label/icon → a tab "plg-<id>" with the plugin's frame
//   sections     ui.portal.sections [{ id, tab: 'home'|'car', title, order }] →
//                a section (its own sandboxed frame) inside GateControl's
//                "Zuhause" / "Fahrzeug" tab (these tabs hold plugin sections only)
//   profile      (since 1.188.0) ui.portal.profileSections [{ id, title, order }]
//                (tab 'profile') → a section on the viewer's own profile
//                ("Meine Geräte", below picture and colour) — only for a
//                signed-in person, never a kiosk device or device trust
//   start tiles  hook portalTiles({ user, lang }) → small declarative tiles
//                rendered by GateControl on the Start tab (never plugin HTML);
//                since 1.197.0 a tile may carry a QR code (`qr`, drawn by
//                GateControl as a PNG), a hidden line (`secret`, shown on a
//                tap) and an end (`until`, a countdown; gone after it) —
//                Start tab only, never the apps' start card
//   search       hook portalSearch({ user, lang, q }) → declarative results
//
// Every hook is optional and asked per viewer with a timeout; a plugin that
// is slow, throws or answers garbage only loses its own part. Tiles and
// results are only taken for sections/tabs the viewer can see
// (portalVisible), and the host never sends them anything but the viewer.

const runtime = require('./runtime');
const registry = require('./registry');
const { loc } = require('./manifest');
const frame = require('./frame');
const qrcode = require('../qrcode');

const HOOK_MS = 1500;
const MAX_TILES = 8;
const MAX_RESULTS = 10;
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
const STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
// Start-tab extras of a tile (since 1.197.0, portal only)
const QR_MAX = 512;
const SECRET_LABEL_MAX = 30;
const SECRET_MAX = 128;
const UNTIL_MAX_MS = 400 * 24 * 3600 * 1000;
const CONTROL_RE = /[\0-\x1f\x7f]/;
/** GateControl tab of a section → the portal's tab id (panel-<id>). */
const TAB_IDS = Object.freeze({ home: 'zuhause', car: 'fahrzeug', profile: 'geraete' });

/** May this viewer see profile sections? A signed-in person, not a kiosk device. */
function profileViewer(user) { return !!(user && user.loggedIn === true && user.kiosk !== true); }

function evaluate(p) { return require('./index').evaluate(p); }

/** Running plugins with the portal permission and a ui.portal entry. */
function portalPlugins() {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter((p) => p.manifest && p.manifest.permissions && p.manifest.permissions.portal && p.manifest.ui && p.manifest.ui.portal)
    .filter((p) => evaluate(p).run && runtime.info(p.id).state === 'running');
}

/** A hook call with a timeout; undefined on any failure. */
async function hook(id, name, payload) {
  try { return await runtime.call(id, name, payload, HOOK_MS); } catch { return undefined; }
}

function text(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Tabs and sections of the running plugins for one viewer (portalVisible
 * asked per tab/section; no hook, an error or a timeout → shown).
 * @param {{id, name, role, portal: true}} user
 * @returns {Promise<{tabs: object[], sections: {home: object[], car: object[], profile: object[]}}>}
 */
async function contributions(user, lang) {
  const l = lang === 'en' ? 'en' : 'de';
  const items = [];
  for (const p of portalPlugins()) {
    const ui = p.manifest.ui.portal;
    const maps = !!p.manifest.ui.maps; // the frame's sandbox gets allow-popups (frame.js "Maps")
    // media: the frame's <iframe> gets allow="microphone *" (voice recording); events: the
    // parent page may hold the plugin's event stream; geolocation: allow="geolocation *";
    // camera: allow="camera *"; inbox: the frame may ask for the viewer's inbox summary
    // (GC.inbox); scanQr: GC.scanQr, the page's QR dialog names the plugin (name)
    // — keys only when set; allow: the iframe's allow attribute ('' = none)
    const extra = { ...(p.manifest.media ? { media: true } : {}), ...(p.manifest.permissions.events ? { events: true } : {}),
      ...(p.manifest.ui.geolocation ? { geolocation: true } : {}), ...(p.manifest.ui.camera ? { camera: true } : {}),
      ...(p.manifest.ui.inbox ? { inbox: true } : {}),
      ...(frame.scanQrOf(p.manifest) ? { scanQr: true, name: loc(p.manifest.name, l) } : {}),
      allow: frame.allowAttr({ media: !!p.manifest.media, geolocation: !!p.manifest.ui.geolocation, camera: !!p.manifest.ui.camera }) };
    if (ui.label) items.push({ kind: 'tab', plugin: p.id, key: 'plg-' + p.id, label: loc(ui.label, l), icon: ui.icon, section: null, maps, ...extra });
    for (const s of ui.sections || []) {
      if (s.tab === 'profile' && !profileViewer(user)) continue;
      items.push({ kind: 'section', plugin: p.id, id: s.id, key: `plg-${p.id}-${s.id}`, tab: s.tab, goto: TAB_IDS[s.tab], title: loc(s.title, l), order: s.order, section: s.id, maps, ...extra });
    }
  }
  const shown = await Promise.all(items.map(async (it) => {
    const out = await hook(it.plugin, 'portalVisible', { user, lang: l, section: it.section });
    return !(out && out.visible === false);
  }));
  const visible = items.filter((_, i) => shown[i]);
  const sections = { home: [], car: [], profile: [] };
  for (const it of visible.filter((x) => x.kind === 'section')) sections[it.tab].push(it);
  for (const k of Object.keys(sections)) sections[k].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  return {
    tabs: visible.filter((x) => x.kind === 'tab').map((x) => ({ id: x.plugin, key: x.key, label: x.label, icon: x.icon, maps: x.maps,
      ...(x.media ? { media: true } : {}), ...(x.events ? { events: true } : {}),
      ...(x.geolocation ? { geolocation: true } : {}), ...(x.camera ? { camera: true } : {}), ...(x.inbox ? { inbox: true } : {}),
      ...(x.scanQr ? { scanQr: true, name: x.name } : {}), allow: x.allow })),
    sections,
  };
}

/** Where a plugin's tile/result leads: one of its visible sections, else its own tab. */
function targetOf(pluginId, sectionId, contrib) {
  const secs = [...contrib.sections.home, ...contrib.sections.car, ...(contrib.sections.profile || [])].filter((s) => s.plugin === pluginId);
  const sec = secs.find((s) => s.id === sectionId) || (sectionId == null ? null : undefined);
  if (sec) return { goto: sec.goto, anchor: 'pt-sec-' + sec.key, area: sec.tab };
  if (sec === undefined) return null; // names a section the viewer cannot see
  const tab = contrib.tabs.find((x) => x.id === pluginId);
  if (tab) return { goto: tab.key, anchor: null, area: tab.key };
  return secs.length ? { goto: secs[0].goto, anchor: 'pt-sec-' + secs[0].key, area: secs[0].tab } : null;
}

function contributors(contrib) {
  return [...new Set([...contrib.tabs.map((t) => t.id), ...contrib.sections.home.map((s) => s.plugin), ...contrib.sections.car.map((s) => s.plugin),
    ...(contrib.sections.profile || []).map((s) => s.plugin)])];
}

/**
 * One plugin's portalTiles answer → its sanitised tiles (≤ 8) with the
 * section the tile names (null when none) and its target in the portal.
 * @param {RegExp} iconRe  the portal's ICON_RE (≤ 600) or a longer one (apps)
 * @param {Function} [extend]  raw tile → extra sanitised fields (the apps' `items`); none for the portal
 */
function sanitizeTiles(id, out, c, iconRe, extend) {
  if (!Array.isArray(out)) return [];
  const res = [];
  for (const t of out.slice(0, MAX_TILES)) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const title = text(t.title, 60);
    const section = typeof t.section === 'string' ? t.section : null;
    const target = targetOf(id, section, c);
    if (!title || !target) continue;
    res.push({
      plugin: id, section, title, value: text(t.value, 40), unit: text(t.unit, 12),
      state: typeof t.state === 'string' && STATES.has(t.state) ? t.state : null,
      icon: typeof t.icon === 'string' && iconRe.test(t.icon) ? t.icon : null, ...target,
      ...(extend ? extend(t) : {}),
    });
  }
  return res;
}

/**
 * Start tiles of every plugin the viewer sees (portalVisible as for the
 * portal), one list per plugin in the portal's order. Shared by the portal's
 * Start tab and the apps' start card (src/services/plugins/clientTiles.js).
 * @param {{iconRe?: RegExp, extend?: Function}} [opts]  extend: raw tile → extra sanitised fields
 * @returns {Promise<object[][]>} [[{ plugin, section, title, value, unit, state, icon, goto, anchor, area }]]
 */
async function collectTiles(user, lang, contrib, opts = {}) {
  const l = lang === 'en' ? 'en' : 'de';
  const iconRe = opts && opts.iconRe instanceof RegExp ? opts.iconRe : ICON_RE;
  const extend = opts && typeof opts.extend === 'function' ? opts.extend : null;
  const c = contrib || await contributions(user, l);
  return Promise.all(contributors(c).map(async (id) => sanitizeTiles(id, await hook(id, 'portalTiles', { user, lang: l }), c, iconRe, extend)));
}

/**
 * The Start-tab extras of a raw tile (since 1.197.0; the apps never get them):
 *   qr      text 1–512 characters without control characters → drawn here as a QR code
 *   secret  { label ≤ 30, value 1–128 characters } → a line the portal hides until tapped
 *   until   ISO time → the portal counts down and drops the tile then; a time in
 *           the past drops the tile now, one more than 400 days ahead is ignored
 * Keys only when valid; an invalid extra is dropped, never the tile (but a past `until`).
 */
function startExtras(t, now = Date.now()) {
  const out = {};
  if (typeof t.qr === 'string' && t.qr.length >= 1 && t.qr.length <= QR_MAX && !CONTROL_RE.test(t.qr)) out.qr = t.qr;
  const sec = t.secret;
  if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
    const label = text(sec.label, SECRET_LABEL_MAX);
    const value = typeof sec.value === 'string' && sec.value.length >= 1 && sec.value.length <= SECRET_MAX && !CONTROL_RE.test(sec.value) ? sec.value : null;
    if (label && value) out.secret = { label, value };
  }
  if (typeof t.until === 'string' && t.until.length <= 40) {
    const ms = Date.parse(t.until);
    if (Number.isFinite(ms) && ms <= now) out.expired = true;
    else if (Number.isFinite(ms) && ms - now <= UNTIL_MAX_MS) out.until = new Date(ms).toISOString();
  }
  return out;
}

/**
 * Start-tab tiles: hook portalTiles({ user, lang }) → [{ section?, title,
 * value?, unit?, state?, icon?, qr?, secret?, until? }] (≤ 8 per plugin).
 * A `qr` becomes `qrImage` (a PNG data URL); the text itself is not sent on.
 * @returns {Promise<object[]>} [{ plugin, title, value, unit, state, icon, goto, anchor, area, qrImage?, secret?, until? }]
 */
async function tiles(user, lang, contrib) {
  const now = Date.now();
  const list = (await collectTiles(user, lang, contrib, { extend: (t) => startExtras(t, now) })).flat();
  const out = [];
  for (const { section: _section, expired, qr, ...t } of list) { // the portal's answer has no `section` key
    if (expired) continue;
    if (qr) {
      try { t.qrImage = await qrcode.toDataUrl(qr); } catch { /* too long for a QR code: the tile without it */ }
    }
    out.push(t);
  }
  return out;
}

/**
 * Portal search: hook portalSearch({ user, lang, q }) → [{ title, subtitle?, section? }]
 * (≤ 10 per plugin). q: 2–100 characters.
 */
async function search(user, lang, q, contrib) {
  const l = lang === 'en' ? 'en' : 'de';
  const query = typeof q === 'string' ? q.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 100) : '';
  if (query.length < 2) return [];
  const c = contrib || await contributions(user, l);
  const lists = await Promise.all(contributors(c).map(async (id) => {
    const out = await hook(id, 'portalSearch', { user, lang: l, q: query });
    if (!Array.isArray(out)) return [];
    const res = [];
    for (const r of out.slice(0, MAX_RESULTS)) {
      if (!r || typeof r !== 'object') continue;
      const title = text(r.title, 80);
      const target = targetOf(id, typeof r.section === 'string' ? r.section : null, c);
      if (!title || !target) continue;
      res.push({ plugin: id, title, subtitle: text(r.subtitle, 80), ...target });
    }
    return res;
  }));
  return lists.flat();
}

module.exports = { contributions, tiles, collectTiles, search, text, startExtras, TAB_IDS, profileViewer, HOOK_MS, MAX_TILES, QR_MAX, _targetOf: targetOf };
