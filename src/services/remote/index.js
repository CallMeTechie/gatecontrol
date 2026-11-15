'use strict';

// gc.remote, version 1 — the core part of the plugin "Fernzugriff"
// (gatecontrol-remote; docs/plugins.md "Remote access"). A plugin process has
// no network of its own and its frames have connect-src 'none', so the core
// keeps the transport (guacd, the tunnels, the session page, the key vault,
// the L4 listeners of the gateways, wake-on-LAN) and the plugin names person
// and target — the same pattern as gc.print and gc.cameras.
//
//   sessions.js    gc.remote.session / end / sessions, the session page, the tunnel lifecycle
//   vault.js       gc.remote.vault.* — secrets stay in the core, the plugin holds handles
//   targets.js     gc.remote.probe / wake / listener(s) / gateways
//   recordings.js  gc.remote.recordings.* (the frame; recording comes with stage 3)
//   facade.js      the old app API /api/v1/client/rdp* answered from the plugin (hook clientFacade)

const VERSION = 1;

const sessions = require('./sessions');
const vault = require('./vault');
const targets = require('./targets');
const recordings = require('./recordings');

// error code of a service → host API code (plain codes stay generic)
const GENERIC = { invalid: 'ERR_INVALID', not_found: 'ERR_NOT_FOUND' };
function hostCode(code) {
  return GENERIC[code] || ('ERR_REMOTE_' + String(code || 'failed').toUpperCase());
}

const KNOWN = [sessions.SessionError, vault.VaultError, targets.TargetError, recordings.RecordingError];

/**
 * One gc.remote call (hostApi.js remoteCall — the permission is checked there).
 * Throws service errors; hostApi turns them into HostApiError(hostCode(e.code)).
 */
async function call(plugin, op, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (op) {
    case 'session': return sessions.create(plugin, a);
    case 'end': return sessions.endFor(plugin, a);
    case 'sessions': return sessions.list(plugin, a);
    case 'vault.put': return vault.put(plugin.id, a.entry);
    case 'vault.remove': return vault.remove(plugin.id, a.handle);
    case 'vault.info': return vault.info(plugin.id, a.handle);
    case 'vault.list': return vault.list(plugin.id);
    case 'probe': return targets.probe(plugin, a.target);
    case 'wake': return targets.wake(plugin, a.target);
    case 'listener': return targets.listener(plugin, a.target);
    case 'listener.remove': return targets.removeListener(plugin, a.key);
    case 'listeners': return targets.listeners(plugin);
    case 'gateways': return targets.gateways();
    case 'recordings.available': return recordings.available();
    case 'recordings.list': return recordings.list(plugin, a);
    case 'recordings.stream': return recordings.stream(plugin, a.id);
    case 'recordings.remove': return recordings.remove(plugin, a.id);
    default: {
      const e = new Error('unknown host API');
      e.code = 'unknown_api';
      throw e;
    }
  }
}

function isServiceError(e) { return KNOWN.some((C) => e instanceof C); }

/** The plugin stopped: its sessions end (no new tokens without a running plugin anyway). */
function pluginStopped(pluginId) {
  try { sessions.endAllFor(pluginId, 'plugin_stopped'); } catch { /* db closed */ }
}

/** The plugin is uninstalled: sessions and its own listeners go; with "Alles löschen" also vault and recordings. */
async function pluginRemoved(pluginId, mode) {
  pluginStopped(pluginId);
  try { await targets.removeAllListeners(pluginId); } catch { /* best-effort */ }
  if (mode === 'wipe') {
    vault.forget(pluginId);
    recordings.forget(pluginId);
  }
}

module.exports = { VERSION, call, hostCode, isServiceError, pluginStopped, pluginRemoved };
