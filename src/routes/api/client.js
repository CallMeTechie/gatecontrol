'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const config = require('../../../config/default');
const peers = require('../../services/peers');
const routes = require('../../services/routes');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');
const activity = require('../../services/activity');
const { validatePeerName } = require('../../utils/validate');
const { requireLimit, requireFeature } = require('../../middleware/license');
const { hostnameReportLimiter } = require('../../middleware/rateLimit');
const { getDb } = require('../../db/connection');
const settings = require('../../services/settings');
const { hasFeature } = require('../../services/license');
const rdpService = require('../../services/rdp');
const rdpMonitor = require('../../services/rdpMonitor');
const rdpSessions = require('../../services/rdpSessions');

function clientLabel(platform) {
  switch ((platform || '').toLowerCase()) {
    case 'android': return 'Android Client';
    case 'win32':
    case 'windows': return 'Desktop Client';
    default: return 'Client';
  }
}

/**
 * Verify the requesting token owns the given peerId.
 * Returns the validated peerId or sends an error response.
 */
function requirePeerOwnership(req, res) {
  const peerId = req.query.peerId || req.headers['x-peer-id'] || req.body?.peerId;
  if (!peerId) {
    res.status(400).json({ ok: false, error: 'Peer ID is required' });
    return null;
  }

  // Session-based auth (admin UI) can access any peer
  if (!req.tokenAuth) return Number(peerId);

  const boundPeerId = req.tokenPeerId;
  if (boundPeerId == null) {
    res.status(403).json({ ok: false, error: 'Token is not bound to a peer. Register first.' });
    return null;
  }

  if (boundPeerId !== Number(peerId)) {
    logger.warn({ tokenId: req.tokenId, requestedPeerId: peerId, boundPeerId }, 'Peer ownership mismatch');
    res.status(403).json({ ok: false, error: 'Token is not authorized for this peer' });
    return null;
  }

  return Number(peerId);
}

const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

/**
 * Check if machine binding is active for a token.
 */
function isBindingActive(req) {
  if (!req.tokenAuth) return false;
  if (!hasFeature('machine_binding')) return false;

  const mode = settings.get('machine_binding.mode', 'off');
  if (mode === 'off') return false;
  if (mode === 'global') return true;
  if (mode === 'individual') {
    const token = tokens.getById(req.tokenId);
    return token && token.machine_binding_enabled;
  }
  return false;
}

/**
 * Verify machine fingerprint for bound tokens.
 * Returns true if OK to proceed, false if response was sent (error).
 */
function verifyMachineBinding(req, res) {
  if (!isBindingActive(req)) return true;

  const fingerprint = req.headers['x-machine-fingerprint'];
  const token = tokens.getById(req.tokenId);
  const stored = token?.machine_fingerprint;

  if (!stored) {
    // First request with binding active — bind the fingerprint now
    if (fingerprint && FINGERPRINT_RE.test(fingerprint)) {
      tokens.bindMachineFingerprint(req.tokenId, fingerprint);
      return true;
    }
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_required') : 'Machine fingerprint required' });
    return false;
  }

  if (!fingerprint) {
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_required') : 'Machine fingerprint required' });
    return false;
  }

  if (!FINGERPRINT_RE.test(fingerprint)) {
    res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Invalid machine fingerprint format' });
    return false;
  }

  if (fingerprint !== stored) {
    logger.warn({ tokenId: req.tokenId, stored: stored.substring(0, 8), received: fingerprint.substring(0, 8) }, 'Machine fingerprint mismatch');
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.binding_mismatch') : 'Token is bound to a different machine' });
    return false;
  }

  return true;
}

const router = Router();

// Update peer description with current client version on every authenticated request.
// Runs at most once per 5 minutes per peer to avoid DB churn.
const _descriptionUpdated = new Map(); // peerId → timestamp
router.use((req, res, next) => {
  if (req.tokenAuth && req.tokenPeerId) {
    const now = Date.now();
    const lastUpdate = _descriptionUpdated.get(req.tokenPeerId) || 0;
    if (now - lastUpdate > 5 * 60 * 1000) {
      const platform = req.headers['x-client-platform'] || '';
      const version = req.headers['x-client-version'] || '';
      if (version) {
        try {
          const db = getDb();
          db.prepare('UPDATE peers SET description = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(`${clientLabel(platform)} (${platform || 'unknown'}, v${version})`, req.tokenPeerId);
          _descriptionUpdated.set(req.tokenPeerId, now);
        } catch {}
      }
    }
  }
  next();
});

const peerCountFn = () => getDb().prepare('SELECT COUNT(*) as count FROM peers').get().count;

/**
 * Hash a WireGuard config string for change detection
 */
function hashConfig(config) {
  return crypto.createHash('sha256').update(config).digest('hex');
}

/**
 * GET /api/v1/client/ping
 * Health check for desktop clients — confirms auth works
 */
router.get('/ping', (req, res) => {
  const { version } = require('../../../package.json');
  res.json({ ok: true, version, timestamp: new Date().toISOString() });
});

/**
 * GET /api/v1/client/permissions
 * Returns the scopes/permissions of the current token
 */
router.get('/permissions', (req, res) => {
  const scopes = req.tokenScopes || [];
  const hasScope = (s) => scopes.includes('full-access') || scopes.includes(s);

  res.json({
    ok: true,
    permissions: {
      services: hasScope('client:services'),
      traffic: hasScope('client:traffic'),
      dns: hasScope('client:dns'),
      rdp: hasScope('client:rdp') && hasFeature('remote_desktop'),
    },
    scopes,
  });
});

/**
 * POST /api/v1/client/register
 * Register a desktop client as a new peer
 * Body: { hostname, platform, clientVersion }
 * Returns: { ok, peerId, config, hash }
 */
router.post('/register', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
  try {
    const { hostname, platform, clientVersion, peerId: existingPeerId } = req.body;

    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.hostname_required') : 'Hostname is required' });
    }

    // If token is already bound to a peer, only allow re-registration for that peer
    if (req.tokenAuth && req.tokenPeerId != null) {
      const boundPeer = peers.getById(req.tokenPeerId);
      if (!boundPeer) {
        return res.status(404).json({ ok: false, error: 'Bound peer no longer exists' });
      }

      // Bind machine fingerprint on re-registration if not yet bound
      if (isBindingActive(req)) {
        const token = tokens.getById(req.tokenId);
        if (!token.machine_fingerprint) {
          const fp = req.headers['x-machine-fingerprint'];
          if (!fp || !FINGERPRINT_RE.test(fp)) {
            return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Valid machine fingerprint required for binding' });
          }
          tokens.bindMachineFingerprint(req.tokenId, fp);
        } else {
          if (!verifyMachineBinding(req, res)) return;
        }
      }

      // Update description with latest client version
      const db = getDb();
      try {
        db.prepare('UPDATE peers SET description = ? WHERE id = ?')
          .run(`${clientLabel(platform)} (${platform || 'unknown'}, v${clientVersion || '?'})`, boundPeer.id);
      } catch {}

      const peerConfig = await peers.getClientConfig(boundPeer.id);
      const hash = hashConfig(peerConfig);
      return res.json({ ok: true, peerId: boundPeer.id, peerName: boundPeer.name, config: peerConfig, hash });
    }

    const db = getDb();
    let peer = null;
    let isNew = false;

    // 1. Check if client already has a registered peerId
    if (existingPeerId) {
      peer = peers.getById(Number(existingPeerId));
      if (peer) {
        logger.info({ peerId: peer.id, hostname }, 'Client reconnected with existing peer');
      }
    }

    // 2. Check if a peer with same hostname already exists
    if (!peer) {
      const baseName = hostname.replace(/[^\w.\-]/g, '_').substring(0, 50);
      const existing = db.prepare('SELECT * FROM peers WHERE name = ?').get(baseName);
      if (existing) {
        peer = existing;
        logger.info({ peerId: peer.id, hostname }, 'Client matched existing peer by hostname');
      }
    }

    // 3. Create new peer only if none found
    if (!peer) {
      const baseName = hostname.replace(/[^\w.\-]/g, '_').substring(0, 50);
      const nameErr = validatePeerName(baseName);
      if (nameErr) {
        return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.invalid_hostname') : 'Invalid hostname for peer name' });
      }

      peer = await peers.create({
        name: baseName,
        description: `${clientLabel(platform)} (${platform || 'unknown'}, v${clientVersion || '?'})`,
        tags: platform === 'android' ? 'mobile-client' : 'desktop-client',
      });
      isNew = true;

      activity.log('client_registered', `${clientLabel(platform)} "${baseName}" registered`, {
        source: 'api',
        severity: 'info',
        details: { peerId: peer.id, hostname, platform, clientVersion },
      });

      logger.info({ peerId: peer.id, hostname, platform }, 'New desktop client registered');
    }

    // Bind token to peer (one-time)
    if (req.tokenAuth) {
      const bound = tokens.bindPeer(req.tokenId, peer.id);
      if (!bound) {
        return res.status(403).json({ ok: false, error: 'Token is already bound to a different peer' });
      }
      logger.info({ tokenId: req.tokenId, peerId: peer.id }, 'Token bound to peer on registration');

      // Bind machine fingerprint if binding is active
      if (isBindingActive(req)) {
        const fingerprint = req.headers['x-machine-fingerprint'];
        if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
          return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Valid machine fingerprint required for binding' });
        }
        tokens.bindMachineFingerprint(req.tokenId, fingerprint);
      }
    }

    // Update description with latest client version
    if (!isNew) {
      try {
        db.prepare('UPDATE peers SET description = ? WHERE id = ?')
          .run(`${clientLabel(platform)} (${platform || 'unknown'}, v${clientVersion || '?'})`, peer.id);
      } catch {}
    }

    // Generate client config
    const peerConfig = await peers.getClientConfig(peer.id);
    const hash = hashConfig(peerConfig);

    res.status(isNew ? 201 : 200).json({
      ok: true,
      peerId: peer.id,
      peerName: peer.name,
      config: peerConfig,
      hash,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Client registration failed');

    if (err.message.includes('No available')) {
      return res.status(409).json({ ok: false, error: req.t ? req.t('error.peers.no_ips') : 'No available IP addresses' });
    }
    if (err.message.includes('limit')) {
      return res.status(403).json({ ok: false, error: req.t ? req.t('error.license.limit_reached') : 'Peer limit reached' });
    }

    res.status(500).json({ ok: false, error: req.t ? req.t('error.client.register_failed') : 'Registration failed' });
  }
});

/**
 * GET /api/v1/client/config
 * Fetch WireGuard config for a registered peer
 * Query: ?peerId=123
 */
router.get('/config', async (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: req.t ? req.t('error.peers.not_found') : 'Peer not found' });
    }

    const config = await peers.getClientConfig(peer.id);
    const hash = hashConfig(config);

    res.json({ ok: true, config, hash, peerName: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to fetch client config');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.peers.config') : 'Failed to get config' });
  }
});

/**
 * GET /api/v1/client/config/check
 * Check if config has changed (hash-based)
 * Query: ?peerId=123&hash=abc123
 */
router.get('/config/check', async (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: req.t ? req.t('error.peers.not_found') : 'Peer not found' });
    }

    const config = await peers.getClientConfig(peer.id);
    const currentHash = hashConfig(config);
    const clientHash = req.query.hash;

    if (clientHash && clientHash === currentHash) {
      return res.json({ ok: true, updated: false });
    }

    res.json({ ok: true, updated: true, config, hash: currentHash });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to check client config');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.peers.config') : 'Failed to check config' });
  }
});

/**
 * POST /api/v1/client/heartbeat
 * Receive heartbeat from desktop client
 * Body: { peerId, connected, rxBytes, txBytes, uptime, hostname }
 */
/**
 * POST /api/v1/client/peer/hostname
 * Agent reports its OS hostname for internal DNS resolution. Token-bound:
 * the target peer is taken from req.tokenPeerId (ignores any body-level
 * peerId to prevent hostname-hijacking across peers). License-gated and
 * rate-limited (3/min/token). Respects sticky admin source.
 */
router.post('/peer/hostname', hostnameReportLimiter, requireFeature('internal_dns'), (req, res) => {
  try {
    if (!req.tokenAuth) {
      return res.status(401).json({ ok: false, error: 'API token required' });
    }
    if (req.tokenPeerId == null) {
      return res.status(403).json({ ok: false, error: 'Token is not bound to a peer. Register first.' });
    }
    if (!verifyMachineBinding(req, res)) return;

    const raw = req.body && req.body.hostname;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.dns.hostname_required') : 'hostname is required' });
    }

    const result = peers.setHostname(req.tokenPeerId, raw, 'agent');
    res.json({ ok: true, assigned: result.assigned, changed: result.changed });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('reserved')) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.dns.hostname_reserved') : 'hostname is reserved' });
    }
    if (msg.includes('invalid characters') || msg.includes('empty') || msg.includes('too long') || msg.includes('disallowed byte')) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.dns.hostname_invalid') : 'hostname is invalid' });
    }
    logger.error({ error: err.message, peerId: req.tokenPeerId }, 'Agent hostname report failed');
    res.status(500).json({ ok: false, error: 'Hostname report failed' });
  }
});

router.post('/heartbeat', (req, res) => {
  try {
    const validatedPeerId = requirePeerOwnership(req, res);
    if (validatedPeerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const { connected, rxBytes, txBytes, uptime, hostname } = req.body;

    const peer = peers.getById(validatedPeerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    // Update last seen timestamp
    const db = getDb();
    db.prepare(`UPDATE peers SET updated_at = datetime('now') WHERE id = ?`).run(peer.id);

    logger.debug({ peerId: validatedPeerId, connected, rxBytes, txBytes }, 'Client heartbeat received');

    res.json({
      ok: true,
      peerEnabled: peer.enabled === 1,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Heartbeat failed');
    res.status(500).json({ ok: false, error: 'Heartbeat processing failed' });
  }
});

/**
 * POST /api/v1/client/status
 * Receive status update from desktop client
 * Body: { peerId, status, timestamp, ... }
 */
router.post('/status', (req, res) => {
  try {
    const validatedPeerId = requirePeerOwnership(req, res);
    if (validatedPeerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const { status, timestamp } = req.body;

    const peer = peers.getById(validatedPeerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    activity.log('client_status', `Client "${peer.name}" reported: ${status}`, {
      source: 'api',
      severity: 'info',
      details: { peerId: validatedPeerId, status, timestamp },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Status report failed');
    res.status(500).json({ ok: false, error: 'Status processing failed' });
  }
});

// ── Peer-Info ───────────────────────────────────────────────

/**
 * GET /api/v1/client/peer-info
 * Returns peer details including expiry date
 * Query: ?peerId=123
 */
router.get('/peer-info', (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    res.json({
      ok: true,
      peer: {
        id: peer.id,
        name: peer.name,
        enabled: peer.enabled === 1,
        expiresAt: peer.expires_at || null,
        createdAt: peer.created_at,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer info');
    res.status(500).json({ ok: false, error: 'Failed to get peer info' });
  }
});

// ── Traffic-Verbrauch ───────────────────────────────────────

/**
 * GET /api/v1/client/traffic
 * Returns traffic stats for a peer (total, 30d, 7d, 24h)
 * Query: ?peerId=123
 */
router.get('/traffic', (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    const db = getDb();

    // Total from peers table
    const totalRx = peer.total_rx || 0;
    const totalTx = peer.total_tx || 0;

    // Aggregated from snapshots for time periods
    const periods = [
      { key: 'last24h', interval: '-24 hours' },
      { key: 'last7d', interval: '-7 days' },
      { key: 'last30d', interval: '-30 days' },
    ];

    const traffic = {
      total: { rx: totalRx, tx: totalTx },
    };

    for (const { key, interval } of periods) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(download_bytes), 0) as rx, COALESCE(SUM(upload_bytes), 0) as tx
        FROM peer_traffic_snapshots
        WHERE peer_id = ? AND recorded_at >= datetime('now', ?)
      `).get(Number(peerId), interval);
      traffic[key] = { rx: row.rx, tx: row.tx };
    }

    res.json({ ok: true, traffic });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get traffic stats');
    res.status(500).json({ ok: false, error: 'Failed to get traffic stats' });
  }
});

// ── Erreichbare Dienste ─────────────────────────────────────

/**
 * GET /api/v1/client/services
 * Returns list of configured HTTP routes (services) the client can access
 */
router.get('/services', (req, res) => {
  try {
    const userId = req.tokenUserId || null;
    const filtered = routes.getForUser(userId);

    const services = filtered.map(r => ({
      id: r.id,
      name: r.name || r.domain,
      domain: r.domain,
      url: `https://${r.domain}`,
      hasAuth: r.route_auth_enabled === 1,
      tls: r.tls_mode || 'auto',
    }));

    res.json({ ok: true, services });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list services');
    res.status(500).json({ ok: false, error: 'Failed to list services' });
  }
});

/**
 * GET /api/v1/client/dns-check
 * Returns VPN DNS config so the client can verify DNS goes through VPN
 */
router.get('/dns-check', (req, res) => {
  const settings = require('../../services/settings');
  const customDns = settings.get('custom_dns');
  const vpnDns = customDns || config.wireguard.dns.join(',');

  res.json({
    ok: true,
    vpnSubnet: config.wireguard.subnet,
    vpnDns,
    gatewayIp: config.wireguard.gatewayIp,
  });
});

// -- RDP (Remote Desktop) ---------------------------------------

/**
 * GET /api/v1/client/rdp
 * Returns RDP routes available for the current token
 */
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

    // Attach online status
    const statuses = rdpMonitor.getAllStatus();
    const enriched = routes.map(r => ({
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
    const result = await rdpMonitor.checkRouteById(id);
    res.json({ ok: true, status: { online: result.online, responseTime: result.responseTime, lastCheck: result.lastCheck } });
  } catch (err) {
    logger.error({ error: err.message }, 'Client RDP status check failed');
    res.status(500).json({ ok: false, error: err.message });
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

    // Check token access
    if (route.token_ids) {
      try {
        const allowed = JSON.parse(route.token_ids);
        if (Array.isArray(allowed) && !allowed.includes(req.tokenId)) {
          return res.status(403).json({ ok: false, error: 'Not authorized for this RDP route' });
        }
      } catch {}
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

    // Build connection info
    const connection = {
      id: route.id,
      name: route.name,
      host: route.host,
      port: route.port,
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
      const ecdhPubKey = req.query.ecdhPublicKey;
      const rsaPubKey = req.query.publicKey;

      if (ecdhPubKey) {
        // ECDH E2EE (preferred) — encrypt all credentials as single JSON blob
        const { ecdhEncrypt } = require('../../utils/crypto');
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
        const { publicKeyEncrypt } = require('../../utils/crypto');
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

    rdpSessions.heartbeatSession(parseInt(sessionId, 10));
    res.json({ ok: true });
  } catch (err) {
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
    let resolvedSessionId = sessionId ? parseInt(sessionId, 10) : null;

    // Fallback: find active session by routeId + tokenId if no sessionId provided
    if (!resolvedSessionId) {
      const tokenId = req.tokenRecord?.id;
      const activeSession = rdpSessions.findActiveSession(routeId, tokenId);
      if (activeSession) resolvedSessionId = activeSession.id;
    }

    if (!resolvedSessionId) return res.status(400).json({ ok: false, error: 'No active session found' });

    const result = rdpSessions.endSession(resolvedSessionId, endReason || 'normal');
    res.json({ ok: true, session: result });
  } catch (err) {
    if (err.message === 'Session not found') {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }
    res.status(500).json({ ok: false, error: 'Failed to end session' });
  }
});

// ── Auto-Update ──────────────────────────────────────────────

const https = require('node:https');
const http = require('node:http');

// Pro-rata Cache pro Client-Typ: { [clientType]: { data, fetchedAt } }
const releaseCache = {};
const CACHE_TTL = 120000; // 2 minutes

const CLIENT_GITHUB_TOKEN = process.env.GC_CLIENT_GITHUB_TOKEN || '';

const CLIENT_REPOS = {
  community: process.env.GC_CLIENT_REPO_COMMUNITY || 'CallMeTechie/GateControl-Community-Client',
  pro:       process.env.GC_CLIENT_REPO_PRO       || 'CallMeTechie/GateControl-Pro-Client',
  android:   process.env.GC_CLIENT_REPO_ANDROID   || 'CallMeTechie/GateControl-Android-Client',
};

/**
 * Client-Typ aus Query/Header ermitteln
 * Prüft mehrere Quellen für robuste Erkennung (auch ältere Clients ohne client-Param)
 */
function resolveClientType(req) {
  // 1. Expliziter Parameter (neue Clients)
  const param = (req.query.client || req.headers['x-client-type'] || '').toLowerCase().trim();
  if (param === 'android' || param === 'gatecontrol-android') return 'android';
  if (param === 'pro' || param === 'gatecontrol-pro') return 'pro';
  if (param === 'community' || param === 'gatecontrol-community') return 'community';

  // 2. Platform header / query (Android client sends X-Client-Platform: android)
  const platform = (req.query.platform || req.headers['x-client-platform'] || '').toLowerCase();
  if (platform === 'android') return 'android';

  // 3. App-Name Header (ab Core v1.2.4+)
  const clientName = (req.headers['x-client-name'] || '').toLowerCase();
  if (clientName.includes('pro')) return 'pro';

  // 4. API-Token basiert: Pro-Client Versionen sind 1.x.x (< 2.0), Community ist 1.1x.x (>= 1.10)
  const clientVersion = req.query.version || '';
  const parts = clientVersion.split('.').map(Number);
  if (parts.length >= 2 && parts[0] === 1 && parts[1] < 10) {
    // Version 1.0.x - 1.9.x → Pro Client (Community ist bei 1.10+)
    return 'pro';
  }

  return 'community';
}

/**
 * Fetch latest release from GitHub API (cached 2min per client type, follows redirects)
 */
async function fetchLatestRelease(clientType = 'community') {
  const cached = releaseCache[clientType];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.data;
  }

  const repo = CLIENT_REPOS[clientType] || CLIENT_REPOS.community;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = {
    'User-Agent': 'GateControl-Server',
    'Accept': 'application/vnd.github+json',
  };
  if (CLIENT_GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CLIENT_GITHUB_TOKEN}`;
  }

  const fetchUrl = (targetUrl, redirectCount = 0) => new Promise((resolve) => {
    if (redirectCount > 3) return resolve(null);
    https.get(targetUrl, { headers }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, redirectCount + 1));
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          logger.warn({ statusCode: res.statusCode, repo }, 'GitHub release API error');
          return resolve(null);
        }
        try {
          const data = JSON.parse(body);
          releaseCache[clientType] = { data, fetchedAt: Date.now() };
          resolve(data);
        } catch {
          resolve(null);
        }
      });
    }).on('error', (err) => {
      logger.warn({ error: err.message }, 'GitHub release fetch failed');
      resolve(null);
    });
  });

  return fetchUrl(url);
}

// ─── Public update routes (mounted WITHOUT auth in routes/index.js) ───
const updateRouter = Router();

/**
 * GET /api/v1/client/update/check
 * Query: ?version=1.2.1&platform=windows&client=pro|community
 * Returns: { ok, available, version?, downloadUrl?, releaseNotes? }
 */
updateRouter.get('/check', async (req, res) => {
  try {
    const clientVersion = req.query.version;
    if (!clientVersion) {
      return res.status(400).json({ ok: false, error: 'Version parameter required' });
    }

    const clientType = resolveClientType(req);
    const release = await fetchLatestRelease(clientType);
    if (!release || !release.tag_name) {
      return res.json({ ok: true, available: false });
    }

    const latestVersion = release.tag_name.replace(/^v/, '');

    // Compare versions
    if (!isNewerVersion(latestVersion, clientVersion)) {
      return res.json({ ok: true, available: false });
    }

    // Find installer asset based on client type
    let installerAsset;
    if (clientType === 'android') {
      installerAsset = (release.assets || []).find(a =>
        a.name.endsWith('.apk') && !a.name.includes('debug')
      );
    } else {
      installerAsset = (release.assets || []).find(a =>
        a.name.endsWith('.exe') && a.name.includes('Setup')
      );
    }

    // For public repos, link directly to GitHub; for private, proxy through server
    let downloadUrl = null;
    if (installerAsset) {
      downloadUrl = CLIENT_GITHUB_TOKEN
        ? `${config.app.baseUrl}/api/v1/client/update/download?client=${clientType}`
        : installerAsset.browser_download_url;
    }

    const defaultFileName = clientType === 'android'
      ? `GateControl-Android-${latestVersion}.apk`
      : `GateControl-Setup-${latestVersion}.exe`;

    res.json({
      ok: true,
      available: true,
      version: latestVersion,
      downloadUrl,
      fileName: installerAsset?.name || defaultFileName,
      fileSize: installerAsset?.size || null,
      releaseNotes: release.body || '',
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Update check failed');
    res.status(500).json({ ok: false, error: 'Update check failed' });
  }
});

/**
 * GET /api/v1/client/update/download?client=pro|community
 * Proxies the installer download from GitHub (needed for private repos)
 */
updateRouter.get('/download', async (req, res) => {
  try {
    const clientType = resolveClientType(req);
    const release = await fetchLatestRelease(clientType);
    if (!release) {
      return res.status(404).json({ ok: false, error: 'No release found' });
    }

    let asset;
    if (clientType === 'android') {
      asset = (release.assets || []).find(a =>
        a.name.endsWith('.apk') && !a.name.includes('debug')
      );
    } else {
      asset = (release.assets || []).find(a =>
        a.name.endsWith('.exe') && a.name.includes('Setup')
      );
    }
    if (!asset) {
      return res.status(404).json({ ok: false, error: 'No installer asset found' });
    }

    // Redirect to browser_download_url for public repos
    if (!CLIENT_GITHUB_TOKEN) {
      return res.redirect(asset.browser_download_url);
    }

    // For private repos, proxy through GitHub API
    const headers = {
      'User-Agent': 'GateControl-Server',
      'Accept': 'application/octet-stream',
      'Authorization': `Bearer ${CLIENT_GITHUB_TOKEN}`,
    };

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
    if (asset.size) res.setHeader('Content-Length', asset.size);

    const proxyUrl = asset.url; // api.github.com URL (requires auth)

    https.get(proxyUrl, { headers }, (ghRes) => {
      // GitHub returns 302 redirect to S3
      if (ghRes.statusCode === 302 && ghRes.headers.location) {
        const redirectUrl = new URL(ghRes.headers.location);
        const transport = redirectUrl.protocol === 'https:' ? https : http;
        transport.get(ghRes.headers.location, (dlRes) => {
          dlRes.pipe(res);
        }).on('error', () => res.status(502).end());
      } else if (ghRes.statusCode === 200) {
        ghRes.pipe(res);
      } else {
        res.status(502).json({ ok: false, error: 'Download failed' });
      }
    }).on('error', () => res.status(502).end());
  } catch (err) {
    logger.error({ error: err.message }, 'Update download failed');
    res.status(500).json({ ok: false, error: 'Download failed' });
  }
});

/**
 * Compare semver: returns true if latest > current
 */
function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

/**
 * GET /api/v1/client/split-tunnel
 * Returns the effective split-tunnel preset for this token.
 * Resolution: token override > global preset > empty.
 */
router.get('/split-tunnel', (req, res) => {
  try {
    let preset = null;
    let source = 'none';

    // 1. Check token-specific override
    if (req.tokenAuth && req.tokenId) {
      const token = tokens.getById(req.tokenId);
      if (token && token.split_tunnel_override) {
        try {
          preset = JSON.parse(token.split_tunnel_override);
          source = 'token';
        } catch {}
      }
    }

    // 2. Fall back to global preset
    if (!preset) {
      const raw = settings.get('split_tunnel_preset', '');
      if (raw) {
        try {
          preset = JSON.parse(raw);
          source = 'global';
        } catch {}
      }
    }

    // 3. No preset
    if (!preset || preset.mode === 'off') {
      return res.json({ ok: true, mode: 'off', networks: [], locked: false, source: 'none' });
    }

    res.json({
      ok: true,
      mode: preset.mode || 'exclude',
      networks: preset.networks || [],
      locked: !!preset.locked,
      source,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get split-tunnel config');
    res.status(500).json({ ok: false, error: 'Failed to load split-tunnel config' });
  }
});

module.exports = router;
module.exports.updateRouter = updateRouter;
