'use strict';

// Plugins in the GateControl apps (docs/plugins.md "App"):
//
//   permissions.app   the plugin answers requests of the apps (device tokens)
//                     through its own request() — /api/v1/client/plugins/<id>/api/*
//   ui.app            { label, icon } → its own tab in the apps
//   hook appVisible(user) → boolean   optional: false hides the tab for that
//                     viewer (the plugin is still listed, its API stays usable)
//
// Only plugins that may run (enabled, compatible, signed or allowed,
// licensed), are running and declare permissions.app — the "usable" test of
// the portal and the quick actions. Asked per viewer, every plugin in
// parallel with its own timeout; an error or no answer in time hides the tab.

const runtime = require('./runtime');
const registry = require('./registry');
const { loc } = require('./manifest');
const { ID_RE } = require('./constants');

const VISIBLE_MS = 3000;

function evaluate(p) { return require('./index').evaluate(p); }

/** A plugin the apps may use: permissions.app, may run, is running. */
function usable(p) {
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.app)
    && evaluate(p).run && runtime.info(p.id).state === 'running';
}

/** The usable plugin with this id, or null (unknown, not usable, bad id). */
function pluginById(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64 || !ID_RE.test(id)) return null;
  let p;
  try { p = registry.get(id); } catch { return null; }
  return usable(p) ? p : null;
}

/** Does the plugin show its tab to this viewer? No hook → yes; error/timeout → no. */
async function tabVisible(id, user) {
  try {
    const out = await runtime.call(id, 'appVisible', user, VISIBLE_MS);
    return !!out && out.visible !== false;
  } catch { return false; }
}

/**
 * The plugins of one viewer for GET /api/v1/client/plugins.
 * @param {{id, name, role, portal: true, loggedIn: true, app: true}} user
 * @returns {Promise<object[]>} [{ id, name, version, tab: { label, icon } | null }]
 */
async function list(user, lang) {
  const l = lang === 'en' ? 'en' : 'de';
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return Promise.all(rows.filter(usable).map(async (p) => {
    const ui = p.manifest.ui && p.manifest.ui.app;
    const tab = ui && await tabVisible(p.id, user) ? { label: loc(ui.label, l), icon: ui.icon } : null;
    return { id: p.id, name: loc(p.manifest.name, l) || p.name, version: p.version, tab };
  }));
}

module.exports = { list, usable, pluginById, tabVisible, VISIBLE_MS };
