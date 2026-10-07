'use strict';

// A plugin's settings: declared in plugin.json ui.settings (shown and edited
// in Settings → Plugins → Einstellungen), stored in the plugin's own
// database (_gc_settings), so "Alles löschen" removes them with the data.
// `secret` values are encrypted with the server key and never sent to the
// browser (it only learns whether one is set).

const storage = require('./storage');
const { encrypt, decrypt } = require('../../utils/crypto');

const KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A settings key: strict pattern, never a prototype name. */
function safeKey(k) {
  return typeof k === 'string' && KEY_RE.test(k) && !FORBIDDEN_KEYS.has(k);
}
const MAX_JSON = 64 * 1024;

function defsOf(plugin) {
  return (plugin.manifest && plugin.manifest.ui && Array.isArray(plugin.manifest.ui.settings)) ? plugin.manifest.ui.settings : [];
}

async function raw(plugin) {
  const r = await storage.forPlugin(plugin.id).call('settings.all', {});
  return r.values || {};
}

function reveal(v) {
  if (v && typeof v === 'object' && typeof v.enc === 'string') {
    try { return decrypt(v.enc); } catch { return null; }
  }
  return v;
}

/** Values for the plugin process (secrets decrypted, defaults filled in). */
async function forPlugin(plugin) {
  const vals = await raw(plugin);
  const out = {};
  for (const d of defsOf(plugin)) if (d.default !== undefined) out[d.key] = d.default;
  for (const [k, v] of Object.entries(vals)) out[k] = reveal(v);
  return out;
}

/** Values for the settings form (secrets only as { set: true|false }). */
async function forUi(plugin) {
  const vals = await raw(plugin);
  const out = {};
  for (const d of defsOf(plugin)) {
    const v = vals[d.key];
    if (d.type === 'secret') out[d.key] = { set: !!(v && typeof v === 'object' && v.enc) };
    else out[d.key] = v === undefined ? (d.default === undefined ? null : d.default) : v;
  }
  return out;
}

function coerce(def, value) {
  if (value === null) return { ok: true, value: null };
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || (def.min != null && n < def.min) || (def.max != null && n > def.max)) return { ok: false };
      return { ok: true, value: n };
    }
    case 'select':
      return typeof value === 'string' && def.options.some((o) => o.value === value) ? { ok: true, value } : { ok: false };
    case 'secret':
      if (typeof value !== 'string' || value.length > 4000) return { ok: false };
      return { ok: true, value: value === '' ? null : { enc: encrypt(value) } };
    default:
      return typeof value === 'string' && value.length <= 1000 ? { ok: true, value } : { ok: false };
  }
}

/**
 * Save values. From the UI only declared keys are accepted; the plugin
 * itself may also keep undeclared keys (JSON, ≤ 64 KB each).
 * @returns {Promise<{ok:true}|{ok:false, fields:object}>}
 */
async function save(plugin, values, { fromPlugin = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, fields: { _: 'invalid' } };
  const defs = new Map(defsOf(plugin).map((d) => [d.key, d]));
  // Maps, not objects: keys come from the request (no prototype keys possible)
  const out = new Map();
  const fields = new Map();
  for (const [k, v] of Object.entries(values)) {
    if (!safeKey(k)) { fields.set(String(k).slice(0, 64), 'unknown'); continue; }
    const def = defs.get(k);
    if (def) {
      const c = coerce(def, v);
      if (!c.ok) fields.set(k, 'invalid');
      else out.set(k, c.value);
    } else if (fromPlugin) {
      let s;
      try { s = JSON.stringify(v === undefined ? null : v); } catch { s = null; }
      if (s == null || s.length > MAX_JSON) fields.set(k, 'invalid');
      else out.set(k, v === undefined ? null : v);
    } else fields.set(k, 'unknown');
  }
  if (fields.size) return { ok: false, fields: Object.fromEntries(fields) };
  await storage.forPlugin(plugin.id).call('settings.set', { values: Object.fromEntries(out) });
  return { ok: true };
}

/**
 * A secret value of the plugin's own (gc.settings.setSecret): any key the
 * plugin chooses that is not a declared non-secret setting, stored like a
 * `secret` setting ({ enc }, server key) — so backups carry it as a re-keyable
 * field — and never sent to the browser (forUi only lists declared keys).
 * @param {string|null} value  null deletes it
 */
async function saveSecret(plugin, key, value) {
  if (!safeKey(key)) return { ok: false };
  const def = defsOf(plugin).find((d) => d.key === key);
  if (def && def.type !== 'secret') return { ok: false };
  if (value !== null && (typeof value !== 'string' || value.length > 4000)) return { ok: false };
  await storage.forPlugin(plugin.id).call('settings.set', { values: { [key]: value === null ? null : { enc: encrypt(value) } } });
  return { ok: true };
}

module.exports = { forPlugin, forUi, save, saveSecret, defsOf };
