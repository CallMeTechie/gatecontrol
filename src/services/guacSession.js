// src/services/guacSession.js
'use strict';

const { hasFeature } = require('../services/license');
const rdpService = require('../services/rdp');
const { admitSession } = require('../services/guacSessions');
const { buildConnectionSettings, SUPPORTED_PROTOCOLS } = require('../services/guacSettings');
const guacToken = require('../services/guacToken');

/**
 * Compute the set of credential fields that MUST decrypt successfully for a
 * given route. Branches on whether a field is CONFIGURED (decrypted value
 * present OR decrypt failed), not on the decrypted value itself — otherwise a
 * corrupt required key would be mis-classified to the password path and the
 * 409 would be skipped (v2.1 #1).
 *
 * Pure move from src/routes/api/client/rdp.js:26.
 */
function requiredCredFields(route, failed) {
  const p = route.protocol || 'rdp';
  const has = (k) => !!route[k] || failed.has(k); // configured = decrypted-present OR decrypt-failed
  const f = [];
  if (p === 'rdp' || p === 'vnc') { if (route.credential_mode !== 'none') f.push('username', 'password'); }
  else if (p === 'ssh') {
    f.push('username');
    if (has('ssh_private_key')) { f.push('ssh_private_key'); if (has('ssh_passphrase')) f.push('ssh_passphrase'); }
    else f.push('password');
  } // telnet → none required
  if (route.browser_enable_sftp && (p === 'rdp' || p === 'vnc')) {
    f.push(has('sftp_private_key') ? 'sftp_private_key' : 'sftp_password');
    if (has('sftp_private_key') && has('sftp_passphrase')) f.push('sftp_passphrase');
  }
  return f;
}

/**
 * Mint a guacamole-lite token for the given route with the given actor.
 *
 * Guard order (spec §5): license → cred-fail → browser_enabled → ACL (client only)
 *                        → maintenance → protocol → concurrency → mint.
 *
 * @param {object} route  - Route row from rdp.getById(id, true) — must include decrypted creds.
 * @param {object} opts
 * @param {object} opts.actor
 *   - { kind:'admin', userId }           — ACL skipped; tokenName = 'admin:'+userId
 *   - { kind:'client', tokenId, userId, peerId, tokenName }
 *                                        — ACL enforced; tokenName = actor.tokenName ?? null
 *
 * @returns {{ ok:true, token:string, ttlMs:number }}
 *        | {{ ok:false, status:number, code:string }}
 */
function mintForRoute(route, { actor }) {
  // 1. Licence gate
  if (!hasFeature('browser_sessions')) {
    return { ok: false, status: 403, code: 'license_required' };
  }

  // 2. Required-cred fatality (spec §5: decrypt position, v2.1 #1).
  // Branch on CONFIGURED-ness, not on the decrypted value: a field is
  // configured when it was stored (decrypted value present) OR when its
  // decrypt failed (null + recorded in decrypt_failed_fields). Testing
  // the decrypted value would mis-branch a corrupt required key to the
  // password path and silently skip the 409.
  const failed = route.decrypt_failed_fields || new Set();
  const required = requiredCredFields(route, failed);
  if (route.decrypt_failed || required.some((x) => failed.has(x))) {
    return { ok: false, status: 409, code: 'mint_failed' };
  }

  // 3. Browser access gate
  if (!route.browser_enabled) {
    return { ok: false, status: 403, code: 'not_enabled' };
  }

  // 4. ACL gate — runs ONLY for client actor; admin bypasses.
  if (actor.kind === 'client' && !rdpService.canAccessRoute(route, actor.tokenId, actor.userId)) {
    return { ok: false, status: 403, code: 'not_authorized' };
  }

  // 5. Maintenance window gate
  if (route.maintenance_enabled && rdpService.isInMaintenanceWindow(route.id)) {
    return { ok: false, status: 503, code: 'maintenance_active' };
  }

  // 6. Protocol gate
  const protocol = route.protocol || 'rdp';
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    return { ok: false, status: 400, code: 'protocol_unsupported' };
  }

  // 7. Soft concurrency pre-check at mint time (WS connect is authoritative).
  const admit = admitSession({
    routeId: route.id,
    tokenId: actor.tokenId ?? null,
    peerId: actor.peerId ?? null,
    isStale: () => false,
  });
  if (!admit.ok) {
    return { ok: false, status: 429, code: 'limit_reached' };
  }

  // 8. Build credentials + connection settings (pure move from rdp.js:343-348).
  const creds = {
    username: route.username, password: route.password,
    ssh_private_key: route.ssh_private_key, ssh_passphrase: route.ssh_passphrase,
    sftp_password: route.sftp_password, sftp_private_key: route.sftp_private_key, sftp_passphrase: route.sftp_passphrase,
  };
  const conn = buildConnectionSettings(route, creds);

  // DA-C byte-identity (Chain3-C3): client actor keeps tokenName=null so the embedded
  // token and rdp_sessions.token_name stay byte-identical to the pre-refactor behaviour
  // (rdp.js:353 never embedded tokenName). Admin actor gets an audit marker.
  const tokenName = actor.kind === 'admin' ? 'admin:' + actor.userId : (actor.tokenName ?? null);

  // Spike requirement: embed routeId/tokenId/peerId so Task 9's evaluateConnection
  // can perform authoritative admitSession at WS-upgrade time (Task 8 ↔ Task 9).
  const { token, ttlMs } = guacToken.mint({
    ...conn,
    rdpRouteId: route.id,
    tokenId: actor.tokenId ?? null,
    peerId: actor.peerId ?? null,
    tokenName,
  });

  return { ok: true, token, ttlMs };
}

module.exports = { mintForRoute, requiredCredFields };
