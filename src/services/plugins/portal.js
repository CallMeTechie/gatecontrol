'use strict';

// What plugins add to the portal (docs/plugins.md "Portal"):
//
//   own tab      ui.portal.label/icon → a tab "plg-<id>" with the plugin's frame
//   sections     ui.portal.sections [{ id, tab: 'home'|'car', title, order }] →
//                a section (its own sandboxed frame) inside GateControl's
//                "Zuhause" / "Fahrzeug" tab (these tabs hold plugin sections only)
//   start tiles  hook portalTiles({ user, lang }) → small declarative tiles
//                rendered by GateControl on the Start tab (never plugin HTML)
//   search       hook portalSearch({ user, lang, q }) → declarative results
//
// Every hook is optional and asked per viewer with a timeout; a plugin that
// is slow, throws or answers garbage only loses its own part. Tiles and
// results are only taken for sections/tabs the viewer can see
// (portalVisible), and the host never sends them anything but the viewer.

const runtime = require('./runtime');
const registry = require('./registry');
const { loc } = require('./manifest');

const HOOK_MS = 1500;
const MAX_TILES = 8;
const MAX_RESULTS = 10;
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
const STATES = new Set(['on', 'off', 'good', 'warn', 'crit']);
/** GateControl tab of a section → the portal's tab id (panel-<id>). */
const TAB_IDS = Object.freeze({ home: 'zuhause', car: 'fahrzeug' });

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
 * @returns {Promise<{tabs: object[], sections: {home: object[], car: object[]}}>}
 */
async function contributions(user, lang) {
  const l = lang === 'en' ? 'en' : 'de';
  const items = [];
  for (const p of portalPlugins()) {
    const ui = p.manifest.ui.portal;
    if (ui.label) items.push({ kind: 'tab', plugin: p.id, key: 'plg-' + p.id, label: loc(ui.label, l), icon: ui.icon, section: null });
    for (const s of ui.sections || []) {
      items.push({ kind: 'section', plugin: p.id, id: s.id, key: `plg-${p.id}-${s.id}`, tab: s.tab, goto: TAB_IDS[s.tab], title: loc(s.title, l), order: s.order, section: s.id });
    }
  }
  const shown = await Promise.all(items.map(async (it) => {
    const out = await hook(it.plugin, 'portalVisible', { user, lang: l, section: it.section });
    return !(out && out.visible === false);
  }));
  const visible = items.filter((_, i) => shown[i]);
  const sections = { home: [], car: [] };
  for (const it of visible.filter((x) => x.kind === 'section')) sections[it.tab].push(it);
  for (const k of Object.keys(sections)) sections[k].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  return {
    tabs: visible.filter((x) => x.kind === 'tab').map((x) => ({ id: x.plugin, key: x.key, label: x.label, icon: x.icon })),
    sections,
  };
}

/** Where a plugin's tile/result leads: one of its visible sections, else its own tab. */
function targetOf(pluginId, sectionId, contrib) {
  const secs = [...contrib.sections.home, ...contrib.sections.car].filter((s) => s.plugin === pluginId);
  const sec = secs.find((s) => s.id === sectionId) || (sectionId == null ? null : undefined);
  if (sec) return { goto: sec.goto, anchor: 'pt-sec-' + sec.key, area: sec.tab };
  if (sec === undefined) return null; // names a section the viewer cannot see
  const tab = contrib.tabs.find((x) => x.id === pluginId);
  if (tab) return { goto: tab.key, anchor: null, area: tab.key };
  return secs.length ? { goto: secs[0].goto, anchor: 'pt-sec-' + secs[0].key, area: secs[0].tab } : null;
}

function contributors(contrib) {
  return [...new Set([...contrib.tabs.map((t) => t.id), ...contrib.sections.home.map((s) => s.plugin), ...contrib.sections.car.map((s) => s.plugin)])];
}

/**
 * Start-tab tiles: hook portalTiles({ user, lang }) → [{ section?, title,
 * value?, unit?, state?, icon? }] (≤ 8 per plugin).
 * @returns {Promise<object[]>} [{ plugin, title, value, unit, state, icon, goto, anchor, area }]
 */
async function tiles(user, lang, contrib) {
  const l = lang === 'en' ? 'en' : 'de';
  const c = contrib || await contributions(user, l);
  const lists = await Promise.all(contributors(c).map(async (id) => {
    const out = await hook(id, 'portalTiles', { user, lang: l });
    if (!Array.isArray(out)) return [];
    const res = [];
    for (const t of out.slice(0, MAX_TILES)) {
      if (!t || typeof t !== 'object') continue;
      const title = text(t.title, 60);
      const target = targetOf(id, typeof t.section === 'string' ? t.section : null, c);
      if (!title || !target) continue;
      res.push({
        plugin: id, title, value: text(t.value, 40), unit: text(t.unit, 12),
        state: typeof t.state === 'string' && STATES.has(t.state) ? t.state : null,
        icon: typeof t.icon === 'string' && ICON_RE.test(t.icon) ? t.icon : null, ...target,
      });
    }
    return res;
  }));
  return lists.flat();
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

module.exports = { contributions, tiles, search, TAB_IDS, HOOK_MS, _targetOf: targetOf };
