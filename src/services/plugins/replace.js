'use strict';

// Plugin replacement (plugin.json `replaces`, since 1.185.0): a first-party
// plugin under a new id takes over an installed plugin it replaces — the same
// plugin with a new name, e.g. gatecontrol-raumklima for gatecontrol-midea.
//
// On install of the new plugin (signature `trusted`, its id not installed
// yet, a replaced id installed) the host:
//   1. stops the old plugin and closes its storage, streams and sockets;
//   2. moves its folders: plugin-data/<old> (database with the settings and
//      secrets, files/) and plugin-media/<old> → <new>. The database keeps its
//      _gc_migrations, so the new plugin continues the old one's numbering
//      (the same migration versions are not run again);
//   3. after the new code is in place and its migrations ran, moves the
//      records keyed by the old id: home targets and the discovery grant,
//      the licence key (third-party), kiosk users, the built-in import
//      record, media rows, notification rules, subscriptions and muted
//      topics (plugin:<old>:… → plugin:<new>:…), the media quota and the
//      apps' stored layouts (tiles, widgets, shortcuts naming the old id);
//   4. removes the old plugin's code, registry row and log.
// A failure before step 3 moves the folders back and leaves the old plugin
// as it was. Ids stored elsewhere (quick action ids in other plugins' rules,
// services, callback buttons of earlier pushes) resolve through
// registry.resolve(); first-party licence entitlements of the old slug count
// for the new plugin (licensing.js).

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./registry');
const { dataDir, pluginsRoot } = require('./constants');

function db() { return require('../../db/connection').getDb(); }

/** The installed plugin a package replaces, or null (not first-party, already installed under its id, nothing to replace). */
function candidate(manifest, sigStatus) {
  if (!manifest || sigStatus !== 'trusted' || !Array.isArray(manifest.replaces) || !manifest.replaces.length) return null;
  if (registry.get(manifest.id)) return null;
  for (const id of manifest.replaces) {
    const p = registry.get(id);
    if (p) return p;
  }
  return null;
}

function mediaDirOf(id) { return path.join(require('./media').mediaRoot(), id); }

function emptyDir(p) {
  try { return fs.readdirSync(p).length === 0; } catch { return true; }
}

/** Stop the old plugin and let go of everything it holds open. */
async function detach(oldId) {
  await require('./runtime').ensureStopped(oldId);
  await require('./storage').close(oldId);
  require('./events').closeStreams(oldId);
  require('./hostApi').closeSockets(oldId);
}

/**
 * Move the old plugin's folders to the new id. A folder already there for the
 * new id must be empty (else the replacement stops). Returns the undo.
 */
function moveFolders(oldId, newId) {
  const moves = [[dataDir(oldId), dataDir(newId)], [mediaDirOf(oldId), mediaDirOf(newId)]];
  for (const [, to] of moves) {
    if (fs.existsSync(to) && !emptyDir(to)) {
      throw Object.assign(new Error(`data of ${path.basename(to)} exists already`), { code: 'replace_conflict' });
    }
  }
  const done = [];
  try {
    for (const [from, to] of moves) {
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) fs.rmdirSync(to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      done.push([from, to]);
    }
  } catch (e) {
    for (const [from, to] of done.reverse()) { try { fs.renameSync(to, from); } catch { /* best effort */ } }
    throw e;
  }
  return () => {
    for (const [from, to] of done.reverse()) { try { fs.renameSync(to, from); } catch { /* best effort */ } }
  };
}

/** `old` as a whole token (not part of a longer id) → `new`, in any text. */
function swapToken(text, oldId, newId) {
  const esc = oldId.replace(/[-]/g, '\\-');
  return String(text).replace(new RegExp(`(?<![a-z0-9-])${esc}(?![a-z0-9-])`, 'g'), newId);
}

/** Move every record keyed by the old id to the new one (one transaction). */
function moveRecords(oldId, newId) {
  const d = db();
  const tx = d.transaction(() => {
    for (const table of ['plugin_targets', 'plugin_licenses', 'plugin_kiosk_users', 'plugin_legacy_imports']) {
      d.prepare(`DELETE FROM ${table} WHERE plugin_id = ?`).run(newId);
      d.prepare(`UPDATE ${table} SET plugin_id = ? WHERE plugin_id = ?`).run(newId, oldId);
    }
    d.prepare('UPDATE plugin_media SET plugin = ? WHERE plugin = ?').run(newId, oldId);
    const oldPrefix = `plugin:${oldId}:`;
    const newPrefix = `plugin:${newId}:`;
    const like = oldPrefix.replace(/[%_\\]/g, '\\$&') + '%';
    d.prepare(`UPDATE OR REPLACE notify_rules SET event_id = ? || substr(event_id, ?) WHERE event_id LIKE ? ESCAPE '\\'`).run(newPrefix, oldPrefix.length + 1, like);
    d.prepare(`UPDATE OR REPLACE notify_subscriptions SET topic = ? || substr(topic, ?) WHERE topic LIKE ? ESCAPE '\\'`).run(newPrefix, oldPrefix.length + 1, like);
    for (const r of d.prepare("SELECT token_id, topics FROM notify_device_prefs WHERE topics LIKE '%' || ? || '%'").all(oldPrefix)) {
      let topics;
      try { topics = JSON.parse(r.topics); } catch { continue; }
      if (!Array.isArray(topics)) continue;
      const next = [...new Set(topics.map((x) => (typeof x === 'string' && x.startsWith(oldPrefix) ? newPrefix + x.slice(oldPrefix.length) : x)))];
      d.prepare('UPDATE notify_device_prefs SET topics = ? WHERE token_id = ?').run(JSON.stringify(next), r.token_id);
    }
    for (const r of d.prepare("SELECT key, layout FROM client_layouts WHERE layout LIKE '%' || ? || '%'").all(oldId)) {
      d.prepare('UPDATE client_layouts SET layout = ? WHERE key = ?').run(swapToken(r.layout, oldId, newId), r.key);
    }
    const quota = d.prepare('SELECT value FROM settings WHERE key = ?').get(`plugins.media_quota.${oldId}`);
    if (quota) {
      d.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(`plugins.media_quota.${newId}`, quota.value);
      d.prepare('DELETE FROM settings WHERE key = ?').run(`plugins.media_quota.${oldId}`);
    }
  });
  tx();
}

/** Remove what is left of the old plugin (code, registry row, log). */
function removeOld(oldId) {
  fs.rmSync(path.join(pluginsRoot(), oldId), { recursive: true, force: true });
  registry.remove(oldId);
  try { require('./updates').forgetApproval(oldId); } catch { /* nothing waiting */ }
  try { require('../kiosk').invalidate(); } catch { /* not loaded */ }
}

module.exports = { candidate, detach, moveFolders, moveRecords, removeOld, swapToken };
