'use strict';
const { resolveGuacTarget } = require('./guacTarget');

const PHASE2A_PROTOCOLS = ['rdp', 'vnc'];

// Build a guacamole-lite connection object for rdp/vnc. Security defaults from
// the Phase-1 columns gate clipboard/SFTP (untrusted-device threat model).
function buildConnectionSettings(route, creds = {}) {
  const protocol = route.protocol || 'rdp';
  if (!PHASE2A_PROTOCOLS.includes(protocol)) {
    throw new Error(`protocol_not_supported_in_phase2a: ${protocol}`);
  }
  const target = resolveGuacTarget(route);
  const settings = {
    hostname: target.host,
    port: String(target.port),
    'disable-copy': route.browser_clipboard ? 'false' : 'true',
    'disable-paste': route.browser_clipboard ? 'false' : 'true',
  };
  if (creds.username) settings.username = creds.username;
  if (creds.password) settings.password = creds.password;
  if (protocol === 'rdp') {
    settings.security = 'any';
    settings['ignore-cert'] = 'true';
  }
  // SFTP/Audio wiring is Phase 2b; clipboard handled above.
  return { type: protocol, settings };
}

module.exports = { buildConnectionSettings, PHASE2A_PROTOCOLS };
