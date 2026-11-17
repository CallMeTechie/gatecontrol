'use strict';

// Device codes for the Linux agent, issued by a plugin (gc.remote version 9, docs/plugins.md "Remote access"):
// „Linux-Gerät mit Agent“ of the plugin "Fernzugriff" shows the command with a code and follows it live.
//
//   enrollment.create({ actorId, userId, name }) → { ticket, code, expiresAt, url }
//   enrollment.status(ticket)                    → { state: waiting | redeemed | expired | revoked, peerId, peerName, vpnIp,
//                                                    handshakeAt, tokenDeviceId, platform, expiresAt }
//   enrollment.revoke(ticket)                    → { revoked, state }
//
// The code is a normal device code of services/clientEnrollment.js (10 minutes, once, the scopes of the app, the
// peer created on redeem for `userId`), redeemed by `gatecontrol-agent enroll <url> <code>` (POST /api/v1/client/enroll).
// Only an enabled administrator whose request to the plugin is in flight may have one made (like requireAdminSession
// for POST /api/v1/enrollment) — for himself or for another person. The plugin keeps the ticket, never the code.

const crypto = require('node:crypto');

class EnrollmentError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const TICKET_RE = /^ce_[0-9a-f]{32}$/;
const PER_PLUGIN_OPEN_MAX = 50;

function db() { return require('../../db/connection').getDb(); }

function idOf(v, what) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new EnrollmentError('invalid', `${what}: a user id`);
  return n;
}

/** The address the agent enrolls at: the origin of GC_BASE_URL. */
function serverUrl() {
  const config = require('../../../config/default');
  try { return new URL(config.app.baseUrl).origin; } catch { return null; }
}

function ticketOf(v) {
  if (typeof v !== 'string' || !TICKET_RE.test(v)) throw new EnrollmentError('invalid', 'ticket: ce_<32 hex>');
  return v;
}

function rowOf(pluginId, ticket) {
  const r = db().prepare('SELECT * FROM client_enrollment_codes WHERE ticket = ? AND ticket_plugin = ?').get(ticketOf(ticket), pluginId);
  if (!r) throw new EnrollmentError('not_found', 'no such ticket of this plugin');
  return r;
}

function stateOf(r, now = Date.now()) {
  if (r.revoked_at != null) return 'revoked';
  if (r.consumed_at != null && r.token_id != null) return 'redeemed';
  if (Number(r.expires_at) <= now) return 'expired';
  return 'waiting';
}

const CODE_ERRORS = {
  user_not_found: 'not_found', user_disabled: 'user_disabled', no_valid_scopes: 'no_client_access', name_too_long: 'invalid',
};

/** gc.remote.enrollment.create({ actorId, userId, name? }) → { ticket, code, expiresAt, url } */
function create(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  const actorId = idOf(o.actorId, 'actorId');
  const userId = o.userId == null ? actorId : idOf(o.userId, 'userId');
  if (o.name != null && (typeof o.name !== 'string' || o.name.length > 100)) throw new EnrollmentError('invalid', 'name: at most 100 characters');
  const actor = db().prepare('SELECT role, enabled FROM users WHERE id = ?').get(actorId);
  if (!actor || actor.enabled !== 1 || actor.role !== 'admin' || !require('../plugins/personContext').has(plugin.id, actorId)) {
    throw new EnrollmentError('forbidden', 'only an administrator, in a request of his to this plugin');
  }
  const ce = require('../clientEnrollment');
  ce.purgeExpired(db());
  const open = db().prepare('SELECT COUNT(*) AS c FROM client_enrollment_codes WHERE ticket_plugin = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
    .get(plugin.id, Date.now()).c;
  if (open >= PER_PLUGIN_OPEN_MAX) throw new EnrollmentError('limit', `at most ${PER_PLUGIN_OPEN_MAX} open codes per plugin`);
  const ticket = 'ce_' + crypto.randomBytes(16).toString('hex');
  let r;
  try {
    r = ce.createCode({ userId, name: o.name && o.name.trim() ? o.name.trim() : null, ticket: { id: ticket, pluginId: plugin.id }, logSource: 'plugin:' + plugin.id });
  } catch (e) {
    const code = e && CODE_ERRORS[e.code];
    if (code) throw new EnrollmentError(code, e.code);
    throw e;
  }
  return { ticket, code: r.code, expiresAt: new Date(r.expiresAt).toISOString(), url: serverUrl() };
}

/** gc.remote.enrollment.status(ticket) → { state, peerId, peerName, vpnIp, handshakeAt, tokenDeviceId, platform, expiresAt } */
function status(plugin, ticket) {
  const r = rowOf(plugin.id, ticket);
  const state = stateOf(r);
  const out = { state, peerId: null, peerName: null, vpnIp: null, handshakeAt: null, tokenDeviceId: null, platform: null, expiresAt: new Date(Number(r.expires_at)).toISOString() };
  if (state !== 'redeemed') return out;
  out.platform = r.redeemed_platform || null;
  // a revoked token is deleted (tokens.revoke)
  const tok = db().prepare('SELECT id FROM api_tokens WHERE id = ?').get(r.token_id);
  out.tokenDeviceId = tok ? tok.id : null;
  if (r.redeemed_peer_id != null) {
    const p = db().prepare('SELECT id, name, allowed_ips, latest_handshake FROM peers WHERE id = ?').get(r.redeemed_peer_id);
    if (p) {
      out.peerId = p.id;
      out.peerName = p.name;
      const ip = String(p.allowed_ips || '').split(',')[0].split('/')[0].trim();
      out.vpnIp = require('node:net').isIP(ip) ? ip : null;
      const hs = Number(p.latest_handshake);
      // only a handshake after the redeem says the agent's tunnel is up
      out.handshakeAt = Number.isFinite(hs) && hs > 0 && hs * 1000 >= Number(r.consumed_at) - 5000 ? new Date(hs * 1000).toISOString() : null;
    }
  }
  return out;
}

/** gc.remote.enrollment.revoke(ticket) → { revoked, state } — a waiting code dies; a redeemed one stays as it is. */
function revoke(plugin, ticket) {
  const r = rowOf(plugin.id, ticket);
  const state = stateOf(r);
  if (state !== 'waiting') return { revoked: false, state };
  const now = Date.now();
  const u = db().prepare('UPDATE client_enrollment_codes SET revoked_at = ?, expires_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL')
    .run(now, now, r.code_hash);
  if (!u.changes) return { revoked: false, state: stateOf(db().prepare('SELECT * FROM client_enrollment_codes WHERE code_hash = ?').get(r.code_hash)) };
  try {
    require('../activity').log('client_enrollment_revoked', `Setup code withdrawn by plugin "${plugin.id}"`, {
      source: 'plugin:' + plugin.id, severity: 'info', details: { plugin: plugin.id, userId: r.user_id },
    });
  } catch { /* best-effort */ }
  return { revoked: true, state: 'revoked' };
}

module.exports = { create, status, revoke, EnrollmentError, TICKET_RE };
