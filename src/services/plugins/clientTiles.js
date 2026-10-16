'use strict';

// Start tiles in the GateControl apps (docs/plugins.md "Portal" → "Start
// tiles"): the start card of the Android app slides through the same tiles the
// portal's Start tab shows.
//
//   hook portalTiles({ user, lang })  → [{ section?, title, value?, unit?, state?, icon?, items? }]
//
// `items` (apps only, the portal ignores them): ≤ 4 value rows
// [{ label, icon?, value?, unit?, state? }] with the rules of a quick-action
// widget's readings (src/services/plugins/quickActions.js) without an id —
// label ≤ 20 required, a value (string ≤ 16 or finite number) or an icon
// required; an invalid item is dropped, never the tile. Always a list.
//
// Asked exactly like for the portal (src/services/plugins/portal.js): only
// plugins that may run, are running and have `permissions.portal` and a
// `ui.portal` entry; portalVisible decides per tab/section like in the portal
// and a tile naming a section the viewer cannot see is dropped; every plugin
// in parallel with its own timeout (1.5 s), a slow / failing /
// garbage-answering plugin only loses its own tiles; ≤ 8 tiles per plugin,
// texts capped, control characters removed. The viewer is the owner of the
// app's device token like for the quick actions (src/services/plugins/
// quickActions.js). Icons may be up to 2000 path characters (like the quick
// actions), the portal keeps its 600.
//
// Every tile gets a stable `key` — "<plugin id>/<section or ''>/<title>" in
// URL-safe characters — so the app can remember which tiles the person picked
// and in which order.

const crypto = require('node:crypto');
const registry = require('./registry');
const { loc } = require('./manifest');
const portal = require('./portal');
const { sanitizeValueRow } = require('./quickActions');

// SVG path data like ui.nav.icon / the quick actions
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,2000}$/;
const KEY_PART_MAX = 48;
const HASH_LEN = 10;
// plugin id (≤ 64) + 2 × (48 + '~' + 10) + 2 separators
const KEY_MAX = 64 + 2 * (KEY_PART_MAX + 1 + HASH_LEN) + 2;
const KEY_SAFE_RE = /^[A-Za-z0-9._~-]*$/;
const MAX_ITEMS = 4;

function lang2(lang) { return lang === 'en' ? 'en' : 'de'; }

/** A tile's `items` → at most 4 valid { label, value, unit, icon, state } (invalid ones dropped; [] without). */
function sanitizeItems(list) {
  if (!Array.isArray(list)) return [];
  const res = [];
  for (const raw of list.slice(0, MAX_ITEMS * 4)) {
    const it = sanitizeValueRow(raw);
    if (!it) continue;
    res.push(it);
    if (res.length >= MAX_ITEMS) break;
  }
  return res;
}

/**
 * One part of a key: the text itself when it is short and URL-safe
 * ([A-Za-z0-9._~-], no leading/trailing '-'), else a URL-safe form of it
 * (accents dropped, other characters → '-', ≤ 48) plus '~' and the first 10
 * hex digits of its SHA-256 — deterministic, and two texts only share a key
 * part when they are equal.
 */
function keyPart(s) {
  if (typeof s !== 'string' || !s) return '';
  if (s.length <= KEY_PART_MAX && KEY_SAFE_RE.test(s) && !/^-|-$/.test(s) && !s.includes('~')) return s;
  const plain = s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, KEY_PART_MAX);
  return plain + '~' + crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, HASH_LEN);
}

/** "<plugin id>/<section or ''>/<title>" in URL-safe characters (≤ KEY_MAX). */
function tileKey(pluginId, section, title) {
  return `${pluginId}/${keyPart(section)}/${keyPart(title)}`.slice(0, KEY_MAX);
}

function pluginNames(l) {
  const names = new Map();
  let rows;
  try { rows = registry.list(); } catch { return names; }
  for (const p of rows) {
    if (p && p.manifest) names.set(p.id, loc(p.manifest.name, l) || p.name);
  }
  return names;
}

/**
 * Start tiles of every plugin the viewer sees in the portal, for the apps.
 * @param {{id, name, role, portal: true, loggedIn: true, app: true}} user
 * @param {string} lang
 * @returns {Promise<object[]>} [{ key, plugin, pluginName, section, title, value, unit, state, icon, items }]
 */
async function list(user, lang) {
  const l = lang2(lang);
  const lists = await portal.collectTiles(user, l, null, { iconRe: ICON_RE, extend: (t) => ({ items: sanitizeItems(t.items) }) });
  const names = pluginNames(l);
  const out = [];
  for (const tiles of lists) {
    const seen = new Set();
    for (const t of tiles) {
      const key = tileKey(t.plugin, t.section, t.title);
      if (seen.has(key)) continue; // the same section + title twice: the first one wins
      seen.add(key);
      out.push({
        key, plugin: t.plugin, pluginName: names.get(t.plugin) || t.plugin, section: t.section,
        title: t.title, value: t.value, unit: t.unit, state: t.state, icon: t.icon, items: t.items,
      });
    }
  }
  return out;
}

module.exports = { list, tileKey, keyPart, sanitizeItems, KEY_MAX, MAX_ITEMS, ICON_RE };
