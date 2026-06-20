'use strict';
const { resolveGuacTarget } = require('./guacTarget');

const SUPPORTED_PROTOCOLS = ['rdp', 'vnc', 'ssh', 'telnet'];

function applyClipboard(settings, route) {
  settings['disable-copy'] = route.browser_clipboard ? 'false' : 'true';
  settings['disable-paste'] = route.browser_clipboard ? 'false' : 'true';
}

function buildRdp(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port), security: 'any', 'ignore-cert': 'true' };
  applyClipboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  // Task 7 inserts applyAudio(settings, route); Task 8 inserts applySftp(settings, route, creds);
  return { type: 'rdp', settings };
}

function buildVnc(route, creds) {
  const t = resolveGuacTarget(route);
  const settings = { hostname: t.host, port: String(t.port) };
  applyClipboard(settings, route);
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  // Task 7 inserts applyAudio; Task 8 inserts applySftp.
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

module.exports = { buildConnectionSettings, SUPPORTED_PROTOCOLS, PHASE2A_PROTOCOLS, buildRdp, buildVnc, buildSsh, buildTelnet, applyClipboard };
