'use strict';

// gc.remote, version 6 — the core part of the plugin "Fernzugriff"
// (gatecontrol-remote; docs/plugins.md "Remote access"). A plugin process has
// no network of its own and its frames have connect-src 'none', so the core
// keeps the transport (guacd, the tunnels, the session page, the key vault,
// the L4 listeners of the gateways, wake-on-LAN) and the plugin names person
// and target — the same pattern as gc.print and gc.cameras.
//
//   sessions.js    gc.remote.session / end / sessions, the session page, the tunnel lifecycle
//   vault.js       gc.remote.vault.* — secrets stay in the core, the plugin holds handles
//   targets.js     gc.remote.probe / wake / listener(s) / gateways / hubAddress / peerAddress
//   recordings.js  gc.remote.recordings.* — asciicast of the terminal, guacd's recordings on the drive (stage 3)
//   term.js        the SSH terminal of the core (ssh2, gc-term.v1), gc.remote.tmux.list (stage 3)
//   hostKeys.js    gc.remote.hostKeys.* — pinned SSH host keys (stage 3)
//   screen.js      the screen relay gc-screen.v1 of phones and PCs (stage 5, control stage 6, desktop stage 7), tickets by gc.remote.screen
//   sshkeys.js     ed25519 pairs for gc.remote.vault.generate, fingerprints
//   facade.js      the old app API /api/v1/client/rdp* answered from the plugin (hook clientFacade)
//   candidates.js  gc.remote.candidates / scan — what „Gerät hinzufügen“ offers (version 7)

// 2: hubAddress, peerAddress, `from` in the answer of session (stage 2: the Windows switch)
// 3: engine term (SSH terminal of the core), tmux.list, hostKeys.*, vault.generate, recordings for real (stage 3)
// 4: screen (the relay gc-screen.v1: a phone shares its screen, one person watches — stage 5)
// 5: screen with mode control (the viewer operates the phone after its person said so; hook phase mode — stage 6)
// 6: the relay takes a Windows PC as sender: hello input 'desktop', mouse and keyboard input, displays (stage 7)
// 7: candidates (the targets an administrator can pick), scan (several ports at once), listener listenPort 'auto',
//    wake by a device of the network watch (target.watch) — the new „Gerät hinzufügen“ of the plugin
const VERSION = 7;

const sessions = require('./sessions');
const vault = require('./vault');
const targets = require('./targets');
const recordings = require('./recordings');
const term = require('./term');
const hostKeys = require('./hostKeys');
const screen = require('./screen');
const candidates = require('./candidates');

// error code of a service → host API code (plain codes stay generic)
const GENERIC = { invalid: 'ERR_INVALID', not_found: 'ERR_NOT_FOUND' };
function hostCode(code) {
  return GENERIC[code] || ('ERR_REMOTE_' + String(code || 'failed').toUpperCase());
}

const KNOWN = [sessions.SessionError, vault.VaultError, targets.TargetError, recordings.RecordingError, term.TermError, hostKeys.HostKeyError, screen.ScreenError];

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
    case 'vault.generate': return vault.generate(plugin.id, a);
    case 'probe': return targets.probe(plugin, a.target);
    case 'wake': return targets.wake(plugin, a.target, { user: a.user });
    case 'listener': return targets.listener(plugin, a.target);
    case 'listener.remove': return targets.removeListener(plugin, a.key);
    case 'listeners': return targets.listeners(plugin);
    case 'gateways': return targets.gateways();
    case 'hubAddress': return targets.hubAddress();
    case 'peerAddress': return targets.peerAddress(plugin, a);
    case 'recordings.available': return recordings.available();
    case 'recordings.list': return recordings.list(plugin, a);
    case 'recordings.stream': return recordings.stream(plugin, a.id, a);
    case 'tmux.list': return term.tmuxList(plugin, a.target, a);
    case 'hostKeys.pin': return hostKeys.pin(plugin.id, a);
    case 'hostKeys.list': return hostKeys.list(plugin.id);
    case 'hostKeys.remove': return hostKeys.remove(plugin.id, a.targetId);
    case 'recordings.remove': return recordings.remove(plugin, a.id);
    case 'screen': return sessions.createScreen(plugin, a);
    case 'candidates': return candidates.candidates(plugin, a);
    case 'scan': return candidates.scan(plugin, a.target, a.ports);
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
    hostKeys.forget(pluginId);
  }
}

module.exports = { VERSION, call, hostCode, isServiceError, pluginStopped, pluginRemoved };
