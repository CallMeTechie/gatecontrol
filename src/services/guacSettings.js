'use strict';
const { resolveGuacTarget } = require('./guacTarget');

const SUPPORTED_PROTOCOLS = ['rdp', 'vnc', 'ssh', 'telnet'];

function applyClipboard(settings, route) {
  settings['disable-copy'] = route.browser_clipboard ? 'false' : 'true';
  settings['disable-paste'] = route.browser_clipboard ? 'false' : 'true';
}

function applyAudio(settings, route) {
  if (route.protocol === 'rdp') {
    if (route.rdp_disable_audio === 1) settings['disable-audio'] = 'true';   // NULL/0 → nothing (2a default)
    return;
  }
  if (route.protocol === 'vnc') {
    const internal = !route.access_mode || route.access_mode === 'internal' || route.access_mode === 'both';
    if (route.browser_enable_audio && internal && route.audio_servername) {  // DA-2: non-gateway only
      settings['enable-audio'] = 'true';
      settings['audio-servername'] = route.audio_servername;
    }
  }
}

function applySftp(settings, route, creds) {
  if (!route.browser_enable_sftp) return;
  const internal = !route.access_mode || route.access_mode === 'internal' || route.access_mode === 'both';
  if (!internal) return;   // DA-2: gateway/external secondary target unreachable from guacd
  settings['enable-sftp'] = 'true';
  settings['sftp-hostname'] = route.sftp_host || route.host;
  settings['sftp-port'] = String(route.sftp_port || 22);
  if (route.sftp_username) settings['sftp-username'] = route.sftp_username;
  if (creds.sftp_password) settings['sftp-password'] = creds.sftp_password;
  if (creds.sftp_private_key) { settings['sftp-private-key'] = creds.sftp_private_key; if (creds.sftp_passphrase) settings['sftp-passphrase'] = creds.sftp_passphrase; }
  if (route.sftp_disable_download) settings['sftp-disable-download'] = 'true';
  if (route.sftp_disable_upload) settings['sftp-disable-upload'] = 'true';
}

function applySecurity(settings, route) {
  settings.security = route.nla_enabled ? 'any' : 'rdp';
  if (route.domain && typeof route.domain === 'string' && route.domain.length > 0) {
    settings.domain = route.domain;
  }
}

function applyExperience(settings, route) {
  if (route.protocol !== 'rdp') return;
  const profile = route.network_profile || 'auto';
  const isLanOrAuto = profile === 'lan' || profile === 'auto';
  const isBroadband = profile === 'broadband';
  settings['enable-font-smoothing'] = (isLanOrAuto || isBroadband) ? 'true' : 'false';
  settings['enable-full-window-drag'] = isLanOrAuto ? 'true' : 'false';
  settings['enable-desktop-composition'] = isLanOrAuto ? 'true' : 'false';
}

function applyRedirects(settings, route) {
  // Only redirect_printers is mappable to guacd's enable-printing.
  // redirect_drives, redirect_usb, redirect_smartcard, multi_monitor, and
  // bandwidth_limit are native-client-only: guacd RDP has no/limited support
  // for drive/USB/smartcard redirection, and mapping a guacd-side drive share
  // requires a writable container path — both are out of scope for browser sessions.
  if (route.redirect_printers) settings['enable-printing'] = 'true';
}

function applyDisplay(settings, route) {
  settings['color-depth'] = String(route.color_depth || 32);
  if (route.protocol === 'rdp') {
    settings['enable-wallpaper'] = route.disable_wallpaper ? 'false' : 'true';
    settings['enable-theming'] = route.disable_themes ? 'false' : 'true';
    settings['enable-menu-animations'] = route.disable_animations ? 'false' : 'true';
    if (route.resolution_mode === 'dynamic') settings['resize-method'] = 'display-update';
  }
}

function buildRdp(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port), 'ignore-cert': 'true' };
  applySecurity(settings, route);
  applyClipboard(settings, route);
  applyDisplay(settings, route);
  applyExperience(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  applyAudio(settings, route);
  applyRedirects(settings, route);
  applySftp(settings, route, creds);
  return { type: 'rdp', settings };
}

function buildVnc(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port) };
  applyClipboard(settings, route);
  applyDisplay(settings, route);   // emits color-depth only (wallpaper/theming are rdp-guarded inside applyDisplay)
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  applyAudio(settings, route);
  applySftp(settings, route, creds);
  return { type: 'vnc', settings };
}

function buildSsh(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = {
    hostname: t.host, port: String(t.port || 22),
    'font-name': 'monospace', 'font-size': '12', 'color-scheme': 'gray-black',
  };
  applyClipboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  if (creds.ssh_private_key) {
    settings['private-key'] = creds.ssh_private_key;
    if (creds.ssh_passphrase) settings.passphrase = creds.ssh_passphrase;
  }
  // NOTE: host-key pinning is DEFERRED (guacd upstream bug GUACAMOLE-1930 — verification
  // rejects even correct keys; see _phase2b-spike-findings.md). ssh ships accept-any.
  // Native SFTP for ssh: uses the ssh connection itself.
  if (route.browser_enable_sftp) {
    settings['enable-sftp'] = 'true';
    if (route.sftp_disable_download) settings['sftp-disable-download'] = 'true';
    if (route.sftp_disable_upload) settings['sftp-disable-upload'] = 'true';
  }
  return { type: 'ssh', settings };
}   // Task 5
function buildTelnet(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port || 23),
    'font-name': 'monospace', 'font-size': '12', 'color-scheme': 'gray-black' };
  applyClipboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  return { type: 'telnet', settings };
} // Task 6

function buildConnectionSettings(route, creds = {}) {
  const protocol = route.protocol || 'rdp';
  switch (protocol) {
    case 'rdp': return buildRdp(route, creds);
    case 'vnc': return buildVnc(route, creds);
    case 'ssh': return buildSsh(route, creds);
    case 'telnet': return buildTelnet(route, creds);
    default: throw new Error(`protocol_not_supported: ${protocol}`);
  }
}

// Keep PHASE2A_PROTOCOLS exported as an ALIAS so the existing route import
// (`src/routes/api/client/rdp.js` imports { PHASE2A_PROTOCOLS }) keeps working
// until Task 10 swaps it — otherwise mint throws `undefined.includes` (500) on
// every request between the Task-4 and Task-10 commits (review-chain C3).
const PHASE2A_PROTOCOLS = SUPPORTED_PROTOCOLS;

module.exports = { buildConnectionSettings, SUPPORTED_PROTOCOLS, PHASE2A_PROTOCOLS, buildRdp, buildVnc, buildSsh, buildTelnet, applyClipboard, applyDisplay, applyExperience, applySecurity, applyRedirects };
