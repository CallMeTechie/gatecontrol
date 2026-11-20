'use strict';

// "Im VPN öffnen": the status page of a gateway over HTTPS from the VPN
// (gateway docs/setup-page.md „Aus dem VPN per HTTPS“, gatecontrol-gateway
// 1.42.0, capability `setup-page-vpn`). The gateway has no accounts of its
// own — the login is the admin session on this server:
//
//   1. a random one-time ticket (32 bytes, base64url) is made here,
//   2. only its SHA-256 goes to the gateway over the management API (tunnel,
//      gateway token): POST /api/status-page/ticket { ticket_sha256, ttl_s },
//   3. the admin's browser goes to https://<host>:<port>/login?t=<ticket>; the
//      gateway takes the ticket once and sets its own session cookie.
//
// The ticket never reaches the log or the activity entry. It is handed out
// only while the switch is on, the device wildcard is passed on to this
// gateway and the gateway answers under the name this server expects
// (vpn_cert.host — <hostname>.<device area>).

const crypto = require('node:crypto');
const logger = require('../utils/logger');

const TICKET_TTL_S = 60;
const PORT_RE = /^\d{1,5}$/;

class StatusVpnError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function features() { return require('./gatewayFeatures'); }

/**
 * Ticket for the gateway's status page from the VPN.
 * → { url, host, port, expiresInS }; throws StatusVpnError:
 *   not_found, unavailable (switched off / gateway too old / no wildcard or name),
 *   gateway_unreachable, gateway_refused (the gateway's reason in `reason`), gateway_error
 */
async function open(peerId, { ip = null, user = null, mgmtCall } = {}) {
  const f = features();
  const g = f.needGateway(peerId);
  const part = f.overview(g.id).setupPageVpn;
  if (!part.enabled) throw new StatusVpnError('unavailable', 'the status page over the VPN is switched off');
  if (!part.supported) throw new StatusVpnError('unavailable', `the gateway does not know the status page over the VPN yet (gatecontrol-gateway ${part.minGateway} or newer)`);
  if (!part.shared || !part.host) throw new StatusVpnError('unavailable', 'the device certificate is not passed on to this gateway, or the gateway has no name in the device area');

  const ticket = crypto.randomBytes(32).toString('base64url');
  const sha = crypto.createHash('sha256').update(ticket).digest('hex');
  const call = mgmtCall || require('./gateways').mgmtCall;
  const r = await call(g.id, '/api/status-page/ticket', { ticket_sha256: sha, ttl_s: TICKET_TTL_S }, 7000);
  if (!r) throw new StatusVpnError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 409 || r.status === 404) {
    const reason = r.body && typeof r.body.error === 'string' && /^[a-z_]{1,32}$/.test(r.body.error) ? r.body.error : 'unknown';
    throw Object.assign(new StatusVpnError('gateway_refused', `the gateway does not offer the page: ${reason}`), { reason });
  }
  const b = r.body || {};
  // the gateway must answer under the name this server knows for it — never a URL from the gateway as it is
  const host = typeof b.host === 'string' ? b.host.toLowerCase() : '';
  const port = Number(b.port);
  if (r.status !== 200 || b.ok !== true || host !== part.host || !PORT_RE.test(String(b.port)) || port < 1 || port > 65535) {
    logger.warn({ peerId: g.id, status: r.status }, 'status page over the VPN: unexpected answer of the gateway');
    throw new StatusVpnError('gateway_error', 'unexpected answer of the gateway');
  }
  const url = new URL(`https://${part.host}`);
  url.port = port === 443 ? '' : String(port);
  url.pathname = '/login';
  url.searchParams.set('t', ticket);
  try {
    require('./activity').log('gateway_status_page_vpn_opened', `Status page of gateway "${g.name}" opened over the VPN`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, host: part.host, ...(user ? { user } : {}) },
    });
  } catch (e) { logger.debug({ err: e.message }, 'status page activity not written'); }
  return { url: url.toString(), host: part.host, port, expiresInS: Number.isInteger(b.expires_in_s) ? b.expires_in_s : TICKET_TTL_S };
}

module.exports = { open, StatusVpnError, TICKET_TTL_S };
