'use strict';

// plugin.json — validation and normalisation (schema: docs/plugins.md).
// validate() never throws: it returns { ok, manifest, errors[] }; error
// strings are stable codes ("field: problem") the UI shows as they are.

const semver = require('./semver');
const netPolicy = require('./netPolicy');
const { ID_RE } = require('./constants');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
const SETTING_TYPES = new Set(['text', 'number', 'boolean', 'select', 'secret']);

/** "x" or { de, en } → { de, en } (both filled); null when invalid. */
function locText(v, max) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s && s.length <= max ? { de: s, en: s } : null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const de = typeof v.de === 'string' ? v.de.trim() : '';
  const en = typeof v.en === 'string' ? v.en.trim() : '';
  if ((!de && !en) || de.length > max || en.length > max) return null;
  return { de: de || en, en: en || de };
}

/** Pick the language of a { de, en } text. */
function loc(text, lang) {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return (lang === 'en' ? text.en : text.de) || text.en || text.de || '';
}

function rangeStr([a, b]) { return a === b ? String(a) : `${a}-${b}`; }

const TARGET_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * permissions.network: an array (= internet hosts) or
 *   { internet: [...], homeTargets: [{ id, label, protocols, multiple }], localDiscovery: { udp: [ports] } }
 * protocols: "http", "tcp:<ports>", "udp:<ports>".
 */
function validateNetwork(n, err) {
  const out = { internet: [], homeTargets: [], localDiscovery: null };
  if (n == null) return out;
  const obj = Array.isArray(n) ? { internet: n } : n;
  if (!obj || typeof obj !== 'object') { err('permissions.network: invalid'); return null; }
  for (const k of Object.keys(obj)) if (!['internet', 'homeTargets', 'localDiscovery'].includes(k)) { err('permissions.network: unknown key ' + k); return null; }
  try {
    const entries = netPolicy.parseList(obj.internet);
    if (entries.some((e) => e.type === 'cidr' && netPolicy.classify(e.net[0].toString()) !== 'public')) throw new Error('private');
    out.internet = (obj.internet || []).map((s) => String(s).trim());
  } catch { err('permissions.network.internet: invalid'); }
  if (obj.homeTargets != null) {
    if (!Array.isArray(obj.homeTargets) || obj.homeTargets.length > 16) err('permissions.network.homeTargets: invalid');
    else {
      for (const t of obj.homeTargets) {
        const label = locText(t && t.label, 60);
        if (!t || typeof t.id !== 'string' || !TARGET_ID_RE.test(t.id) || !label || !Array.isArray(t.protocols) || !t.protocols.length || t.protocols.length > 4) {
          err('permissions.network.homeTargets: invalid'); break;
        }
        if (out.homeTargets.some((x) => x.id === t.id)) { err('permissions.network.homeTargets: duplicate'); break; }
        const proto = { http: false, tcp: [], udp: [] };
        let bad = false;
        for (const pr of t.protocols) {
          const m = /^(http|tcp|udp)(?::([0-9,\- ]+))?$/.exec(String(pr));
          if (!m || (m[1] === 'http' && m[2]) || (m[1] !== 'http' && !m[2])) { bad = true; break; }
          if (m[1] === 'http') proto.http = true;
          else { try { proto[m[1]] = netPolicy.parsePorts(m[2]).map(rangeStr); } catch { bad = true; break; } }
        }
        if (bad) { err('permissions.network.homeTargets: invalid protocol'); break; }
        if (t.multiple != null && typeof t.multiple !== 'boolean') { err('permissions.network.homeTargets: invalid'); break; }
        out.homeTargets.push({ id: t.id, label, protocols: t.protocols.map(String), proto, multiple: !!t.multiple });
      }
    }
  }
  if (obj.localDiscovery != null) {
    try {
      const ld = obj.localDiscovery;
      if (!ld || typeof ld !== 'object' || Object.keys(ld).some((k) => k !== 'udp')) throw new Error('x');
      out.localDiscovery = { udp: netPolicy.parsePorts(ld.udp).map(rangeStr) };
    } catch { err('permissions.network.localDiscovery: invalid'); }
  }
  return out;
}

function isFile(p) {
  return typeof p === 'string' && p.length <= 200 && FILE_RE.test(p) && !p.split('/').some((s) => s === '..' || s === '.');
}

function validate(raw, opts = {}) {
  const errors = [];
  const err = (e) => { errors.push(e); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['plugin.json: not an object'] };

  const m = {};
  if (typeof raw.id !== 'string' || raw.id.length < 2 || raw.id.length > 64 || !ID_RE.test(raw.id)) err('id: invalid');
  else m.id = raw.id;

  m.name = locText(raw.name, 60);
  if (!m.name) err('name: invalid');
  if (typeof raw.version !== 'string' || !semver.valid(raw.version)) err('version: invalid');
  else m.version = raw.version.trim();
  if (typeof raw.publisher !== 'string' || !raw.publisher.trim() || raw.publisher.length > 80) err('publisher: invalid');
  else m.publisher = raw.publisher.trim();
  m.description = raw.description == null ? { de: '', en: '' } : locText(raw.description, 600);
  if (!m.description) err('description: invalid');
  if (typeof raw.gatecontrol !== 'string' || !semver.validRange(raw.gatecontrol)) err('gatecontrol: invalid');
  else m.gatecontrol = raw.gatecontrol.trim();
  if (!isFile(raw.entry) || !/\.(c?js)$/.test(raw.entry)) err('entry: invalid');
  else m.entry = raw.entry;
  if (opts.files && m.entry && !opts.files.has(m.entry)) err('entry: missing');

  // permissions
  const p = raw.permissions == null ? {} : raw.permissions;
  if (!p || typeof p !== 'object' || Array.isArray(p)) err('permissions: invalid');
  const perms = { network: { internet: [], homeTargets: [], localDiscovery: null }, storage: false, portal: false, users: false, notify: false, background: null };
  if (p && typeof p === 'object') {
    if (p.lan != null) err('permissions.lan: replaced by permissions.network.homeTargets / localDiscovery');
    const net = validateNetwork(p.network, err);
    if (net) perms.network = net;
    for (const k of ['storage', 'portal', 'users', 'notify']) {
      if (p[k] == null) continue;
      if (typeof p[k] !== 'boolean') err(`permissions.${k}: invalid`);
      else perms[k] = p[k];
    }
    if (p.background != null) {
      const iv = p.background && Number(p.background.intervalSeconds);
      if (!Number.isInteger(iv) || iv < 10 || iv > 86400) err('permissions.background.intervalSeconds: invalid');
      else perms.background = { intervalSeconds: iv };
    }
  }
  m.permissions = perms;

  // ui
  const u = raw.ui == null ? {} : raw.ui;
  const ui = { nav: null, pages: [], settings: [], portal: null };
  if (!u || typeof u !== 'object' || Array.isArray(u)) err('ui: invalid');
  else {
    if (u.nav != null) {
      const label = locText(u.nav && u.nav.label, 40);
      const icon = u.nav && u.nav.icon != null ? String(u.nav.icon) : 'M4 4h16v16H4z';
      if (!label || !ICON_RE.test(icon)) err('ui.nav: invalid');
      else ui.nav = { label, icon };
    }
    if (u.pages != null) {
      if (!Array.isArray(u.pages) || u.pages.length > 10) err('ui.pages: invalid');
      else {
        for (const pg of u.pages) {
          const title = locText(pg && pg.title, 60);
          if (!pg || typeof pg.id !== 'string' || !SLUG_RE.test(pg.id) || pg.id.length > 40 || !title) { err('ui.pages: invalid'); break; }
          if (ui.pages.some((x) => x.id === pg.id) || pg.id === 'frame') { err('ui.pages: duplicate'); break; }
          ui.pages.push({ id: pg.id, title });
        }
      }
    }
    if (ui.nav && !ui.pages.length) err('ui.nav: needs ui.pages');
    if (u.settings != null) {
      if (!Array.isArray(u.settings) || u.settings.length > 50) err('ui.settings: invalid');
      else {
        for (const s of u.settings) {
          const label = locText(s && s.label, 80);
          if (!s || typeof s.key !== 'string' || !KEY_RE.test(s.key) || !SETTING_TYPES.has(s.type) || !label) { err('ui.settings: invalid'); break; }
          if (ui.settings.some((x) => x.key === s.key)) { err('ui.settings: duplicate'); break; }
          const def = { key: s.key, type: s.type, label, help: s.help == null ? null : locText(s.help, 300) };
          if (s.type === 'select') {
            if (!Array.isArray(s.options) || !s.options.length || s.options.length > 50) { err('ui.settings: invalid'); break; }
            def.options = [];
            for (const o of s.options) {
              const ol = locText(o && o.label, 80);
              if (!o || typeof o.value !== 'string' || o.value.length > 100 || !ol) { def.options = null; break; }
              def.options.push({ value: o.value, label: ol });
            }
            if (!def.options) { err('ui.settings: invalid'); break; }
          }
          if (s.type === 'number') {
            def.min = Number.isFinite(s.min) ? s.min : null;
            def.max = Number.isFinite(s.max) ? s.max : null;
          }
          if (s.default !== undefined && s.type !== 'secret') {
            const okDefault = (s.type === 'boolean' && typeof s.default === 'boolean')
              || (s.type === 'number' && Number.isFinite(s.default))
              || ((s.type === 'text' || s.type === 'select') && typeof s.default === 'string' && s.default.length <= 1000);
            if (!okDefault) { err('ui.settings: invalid'); break; }
            def.default = s.default;
          }
          ui.settings.push(def);
        }
      }
    }
    if (u.portal != null) {
      const label = locText(u.portal && u.portal.label, 40);
      const icon = u.portal && u.portal.icon != null ? String(u.portal.icon) : 'M4 4h16v16H4z';
      if (!label || !ICON_RE.test(icon)) err('ui.portal: invalid');
      else if (!perms.portal) err('ui.portal: needs permissions.portal');
      else ui.portal = { label, icon };
    }
  }
  m.ui = ui;

  // license
  const l = raw.license == null ? { required: false } : raw.license;
  if (!l || typeof l !== 'object' || typeof (l.required ?? false) !== 'boolean') err('license: invalid');
  else {
    m.license = { required: !!l.required, server: null };
    if (l.server != null) {
      let ok = false;
      try { const su = new URL(String(l.server)); ok = su.protocol === 'https:' && !su.username && !su.password && String(l.server).length <= 300; } catch { ok = false; }
      if (!ok) err('license.server: must be an https URL');
      else m.license.server = String(l.server);
    }
  }

  // migrations
  if (raw.migrations != null && !isFile(raw.migrations)) err('migrations: invalid');
  else m.migrations = raw.migrations || 'migrations';

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m, errors: [] };
}

/**
 * Migration files of a package: <migrations>/<number>_<name>.sql, ordered.
 * @param {Map<string,Buffer>} files
 */
function migrationsOf(manifest, files) {
  const dir = manifest.migrations.replace(/\/+$/, '') + '/';
  const out = [];
  for (const [p, buf] of files) {
    if (!p.startsWith(dir)) continue;
    const name = p.slice(dir.length);
    const mm = /^(\d{1,6})_([A-Za-z0-9_-]{1,80})\.sql$/.exec(name);
    if (!mm) continue;
    out.push({ version: Number(mm[1]), name: mm[2], file: p, sql: buf.toString('utf8') });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) if (out[i].version === out[i - 1].version) throw new Error('duplicate migration version ' + out[i].version);
  return out;
}

module.exports = { validate, loc, locText, migrationsOf, isFile };
