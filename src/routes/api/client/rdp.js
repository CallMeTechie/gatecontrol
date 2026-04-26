'use strict';

const { Router } = require('express');
const peers = require('../../../services/peers');
const routes = require('../../../services/routes');
const tokens = require('../../../services/tokens');
const logger = require('../../../utils/logger');
const { hasFeature } = require('../../../services/license');
const { getDb } = require('../../../db/connection');
const rdpService = require('../../../services/rdp');
const rdpMonitor = require('../../../services/rdpMonitor');
const rdpSessions = require('../../../services/rdpSessions');
const { requirePeerOwnership, verifyMachineBinding } = require('./helpers');

const router = Router();

router.get('/rdp', (req, res) => {
  try {
    if (!hasFeature('remote_desktop')) {
      return res.status(403).json({ ok: false, error: 'Remote Desktop feature not available' });
    }

    const scopes = req.tokenScopes || [];
    const hasRdpScope = scopes.includes('full-access') || scopes.includes('client:rdp');
    if (!hasRdpScope) {
      return res.status(403).json({ ok: false, error: 'Token does not have client:rdp permission' });
    }

    const tokenId = req.tokenId;
    const userId = req.tokenUserId || null;
    const routes = rdpService.getForToken(tokenId, userId);

    // Self-exclusion: you can't RDP into the host you're running on.
    // Drop any route whose target host matches the requesting peer's
    // own VPN IP. Only applies to token-bound requests — admin UI
    // session-auth calls keep seeing the full list so operators can
    // edit routes for any host.
    let selfIp = null;
    if (req.tokenAuth && req.tokenPeerId != null) {
      const selfPeer = peers.getById(req.tokenPeerId);
      if (selfPeer && selfPeer.allowed_ips) {
        selfIp = String(selfPeer.allowed_ips).split(',')[0].split('/')[0].trim();
      }
    }
    const visibleRoutes = selfIp ? routes.filter(r => r.host !== selfIp) : routes;

    // Attach online status
    const statuses = rdpMonitor.getAllStatus();
    const enriched = visibleRoutes.map(r => ({
      ...r,
      status: statuses[r.id] || { online: false, lastCheck: null },
    }));

    res.json({ ok: true, routes: enriched });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list client RDP routes');
    res.status(500).json({ ok: false, error: 'Failed to list RDP services' });
  }
});

/**
 * GET /api/v1/client/rdp/:id/status
 * Server-side TCP reachability check for an RDP route.
 * Android VPN apps cannot connect to VPN addresses from within
 * their own process, so the server performs the check on behalf
 * of the client.
 */
router.get('/rdp/:id/status', async (req, res) => {
  try {
    if (!hasFeature('remote_desktop')) {
      return res.status(403).json({ ok: false, error: 'Remote Desktop feature not available' });
    }
    const id = parseInt(req.params.id, 10);
    const route = rdpService.getById(id);
    if (!route) return res.status(404).json({ ok: false, error: 'RDP route not found' });
    if (!rdpService.canAccessRoute(route, req.tokenId, req.tokenUserId)) {
      return res.status(403).json({ ok: false, error: 'Not authorized for this RDP route' });
    }
    const result = await rdpMonitor.checkRouteById(id);
    res.json({ ok: true, status: { online: result.online, responseTime: result.responseTime, lastCheck: result.lastCheck } });
  } catch (err) {
    logger.error({ error: err.message }, 'Client RDP status check failed');
    res.status(500).json({ ok: false, error: 'Status check failed' });
  }
});

/**
 * GET /api/v1/client/rdp/:id/connect
 * Get connection data + credentials (E2EE) for an RDP route
 * Query: ?publicKey=<base64-encoded-client-public-key>
 */
router.get('/rdp/:id/connect', (req, res) => {
  try {
    if (!hasFeature('remote_desktop')) {
      return res.status(403).json({ ok: false, error: 'Remote Desktop feature not available' });
    }

    const id = parseInt(req.params.id, 10);
    const route = rdpService.getById(id, true);
    if (!route) return res.status(404).json({ ok: false, error: 'RDP route not found' });

    // Disabled routes must not hand out credentials, even if the id is guessed.
    if (!route.enabled) {
      return res.status(403).json({ ok: false, error: 'RDP route is disabled' });
    }

    // Self-guard: a peer cannot RDP into itself. Mirrors the list
    // filter in GET /rdp — covers stale client caches that still
    // remember a self-route id from before the server-side filter.
    if (req.tokenAuth && req.tokenPeerId != null) {
      const selfPeer = peers.getById(req.tokenPeerId);
      const selfIp = selfPeer && selfPeer.allowed_ips
        ? String(selfPeer.allowed_ips).split(',')[0].split('/')[0].trim()
        : null;
      if (selfIp && selfIp === route.host) {
        return res.status(400).json({ ok: false, error: 'Cannot RDP to the host you are running on' });
      }
    }

    // Centralized ACL: user_ids takes priority over token_ids (same order
    // as list endpoint). Must stay aligned — otherwise a user sees no
    // route in the list but can guess the id and get credentials.
    if (!rdpService.canAccessRoute(route, req.tokenId, req.tokenUserId)) {
      return res.status(403).json({ ok: false, error: 'Not authorized for this RDP route' });
    }

    // Maintenance window check
    if (route.maintenance_enabled && rdpService.isInMaintenanceWindow(id)) {
      return res.status(503).json({
        ok: false,
        error: 'Route is in maintenance window',
        maintenance: true,
        maintenance_schedule: route.maintenance_schedule,
      });
    }

    // If the target host is a VPN IP and a peer with that IP has a
    // registered hostname (feature: internal_dns), include the FQDN so
    // the Pro client can use it as the RDP "full address" — this lets
    // CredSSP validate the server cert against its own hostname instead
    // of the IP, avoiding the "The credentials that were used to
    // connect … did not work" dialog on hosts whose cert CN differs
    // from the IP.
    let peer_hostname = null;
    let peer_fqdn = null;
    try {
      const { hasFeature: _hasFeature } = require("../../../services/license");
      if (_hasFeature('internal_dns')) {
        const configDef = require("../../../../config/default");
        const peerRow = getDb().prepare(
          "SELECT hostname FROM peers WHERE hostname IS NOT NULL AND allowed_ips LIKE ?"
        ).get(`${route.host}/%`);
        if (peerRow && peerRow.hostname) {
          peer_hostname = peerRow.hostname;
          peer_fqdn = `${peerRow.hostname}.${configDef.dns.domain}`;
        }
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'peer hostname lookup failed');
    }

    // Build connection info
    const connection = {
      id: route.id,
      name: route.name,
      host: route.host,
      port: route.port,
      peer_hostname,
      peer_fqdn,
      external_hostname: route.external_hostname,
      external_port: route.external_port,
      access_mode: route.access_mode,
      gateway_host: route.gateway_host,
      gateway_port: route.gateway_port,
      credential_mode: route.credential_mode,
      domain: route.domain,
      resolution_mode: route.resolution_mode,
      resolution_width: route.resolution_width,
      resolution_height: route.resolution_height,
      multi_monitor: route.multi_monitor,
      color_depth: route.color_depth,
      redirect_clipboard: route.redirect_clipboard,
      redirect_printers: route.redirect_printers,
      redirect_drives: route.redirect_drives,
      redirect_usb: route.redirect_usb,
      redirect_smartcard: route.redirect_smartcard,
      audio_mode: route.audio_mode,
      network_profile: route.network_profile,
      nla_enabled: route.nla_enabled,
      disable_wallpaper: route.disable_wallpaper,
      disable_themes: route.disable_themes,
      disable_animations: route.disable_animations,
      bandwidth_limit: route.bandwidth_limit,
      session_timeout: route.session_timeout,
      admin_session: route.admin_session,
      remote_app: route.remote_app,
      start_program: route.start_program,
      wol_enabled: route.wol_enabled,
      maintenance_enabled: route.maintenance_enabled,
      maintenance_schedule: route.maintenance_schedule,
    };

    // Include credentials if applicable
    if (route.credential_mode !== 'none') {
      // getById(id, true) returned decrypted values or null — but the
      // service also reports whether decrypt itself failed, so the
      // client sees a clear 409 instead of a confusingly empty
      // credentials payload after a key rotation.
      if (route.decrypt_failed) {
        return res.status(409).json({ ok: false, error: 'credentials_invalid' });
      }
      const ecdhPubKey = req.query.ecdhPublicKey;
      const rsaPubKey = req.query.publicKey;

      if (ecdhPubKey) {
        // ECDH E2EE (preferred) — encrypt all credentials as single JSON blob
        const { ecdhEncrypt } = require("../../../utils/crypto");
        try {
          const credentialsJson = JSON.stringify({
            username: route.username || null,
            password: route.credential_mode === 'full' ? (route.password || null) : null,
            domain: route.domain || null,
          });
          connection.credentials_e2ee = ecdhEncrypt(credentialsJson, ecdhPubKey);
        } catch (err) {
          logger.warn({ error: err.message }, 'ECDH E2EE encryption failed');
        }
      } else if (rsaPubKey) {
        // RSA-OAEP E2EE (legacy fallback)
        const { publicKeyEncrypt } = require("../../../utils/crypto");
        try {
          const pubKeyPem = Buffer.from(rsaPubKey, 'base64').toString('utf8');
          if (route.username) {
            connection.username_encrypted = publicKeyEncrypt(route.username, pubKeyPem);
          }
          if (route.credential_mode === 'full' && route.password) {
            connection.password_encrypted = publicKeyEncrypt(route.password, pubKeyPem);
          }
        } catch (err) {
          logger.warn({ error: err.message }, 'RSA E2EE encryption failed');
        }
      } else {
        // No client public key -- send plain (only over HTTPS)
        connection.username = route.username || null;
        if (route.credential_mode === 'full') {
          connection.password = route.password || null;
        }
      }
    }

    const status = rdpMonitor.getStatus(id);
    connection.online = status.online;

    res.json({ ok: true, connection });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get RDP connection info');
    res.status(500).json({ ok: false, error: 'Failed to get connection info' });
  }
});

/**
 * POST /api/v1/client/rdp/:id/session -- Start RDP session (audit)
 */
router.post('/rdp/:id/session', (req, res) => {
  try {
    if (!hasFeature('remote_desktop')) {
      return res.status(403).json({ ok: false, error: 'Remote Desktop feature not available' });
    }

    const id = parseInt(req.params.id, 10);
    const route = rdpService.getById(id);
    if (!route) return res.status(404).json({ ok: false, error: 'RDP route not found' });
    if (!rdpService.canAccessRoute(route, req.tokenId, req.tokenUserId)) {
      return res.status(403).json({ ok: false, error: 'Not authorized for this RDP route' });
    }
    const token = req.tokenAuth ? tokens.getById(req.tokenId) : null;

    const session = rdpSessions.startSession(id, {
      tokenId: req.tokenId || null,
      tokenName: token?.name || null,
      peerId: req.tokenPeerId || null,
      clientIp: req.ip,
    });

    res.status(201).json({ ok: true, session });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to start RDP session');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: 'RDP route not found' });
    }
    res.status(500).json({ ok: false, error: 'Failed to start session' });
  }
});

/**
 * PATCH /api/v1/client/rdp/:id/session -- Session heartbeat
 * Body: { sessionId }
 */
router.patch('/rdp/:id/session', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    rdpSessions.heartbeatSession(parseInt(sessionId, 10), {
      tokenId: req.tokenId || null,
      peerId: req.tokenPeerId || null,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Session not owned by caller') {
      return res.status(403).json({ ok: false, error: 'Not your session' });
    }
    if (err.message === 'Session not found' || err.message === 'Session is not active') {
      return res.status(404).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: 'Heartbeat failed' });
  }
});

/**
 * DELETE /api/v1/client/rdp/:id/session -- End RDP session
 * Body: { sessionId, endReason }
 */
router.delete('/rdp/:id/session', (req, res) => {
  try {
    const { sessionId, endReason } = req.body || {};
    const routeId = parseInt(req.params.id, 10);
    const ownerCheck = {
      tokenId: req.tokenId || null,
      peerId: req.tokenPeerId || null,
    };
    let resolvedSessionId = sessionId ? parseInt(sessionId, 10) : null;

    // Fallback: find the most recent active session owned by THIS caller.
    // Without the owner filter any client with rdp scope could terminate
    // another user's active session by calling DELETE without a body.
    if (!resolvedSessionId) {
      const activeSession = rdpSessions.findActiveSession(routeId, ownerCheck);
      if (activeSession) resolvedSessionId = activeSession.id;
    }

    if (!resolvedSessionId) return res.status(400).json({ ok: false, error: 'No active session found' });

    const result = rdpSessions.endSession(resolvedSessionId, endReason || 'normal', ownerCheck);
    res.json({ ok: true, session: result });
  } catch (err) {
    if (err.message === 'Session not owned by caller') {
      return res.status(403).json({ ok: false, error: 'Not your session' });
    }
    if (err.message === 'Session not found') {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }
    res.status(500).json({ ok: false, error: 'Failed to end session' });
  }
});

module.exports = router;
