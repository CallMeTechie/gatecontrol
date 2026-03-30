'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const config = require('../../../config/default');
const peers = require('../../services/peers');
const routes = require('../../services/routes');
const logger = require('../../utils/logger');
const activity = require('../../services/activity');
const { validatePeerName } = require('../../utils/validate');
const { requireLimit } = require('../../middleware/license');
const { getDb } = require('../../db/connection');

const router = Router();

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
 * POST /api/v1/client/register
 * Register a desktop client as a new peer
 * Body: { hostname, platform, clientVersion }
 * Returns: { ok, peerId, config, hash }
 */
router.post('/register', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
  try {
    const { hostname, platform, clientVersion } = req.body;

    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.hostname_required') : 'Hostname is required' });
    }

    // Generate a unique peer name from hostname
    const baseName = hostname.replace(/[^\w.\-]/g, '_').substring(0, 50);
    let peerName = baseName;
    const db = getDb();
    let attempt = 0;

    // Ensure unique name
    while (db.prepare('SELECT id FROM peers WHERE name = ?').get(peerName)) {
      attempt++;
      peerName = `${baseName}-${attempt}`;
    }

    const nameErr = validatePeerName(peerName);
    if (nameErr) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.invalid_hostname') : 'Invalid hostname for peer name' });
    }

    // Create the peer
    const peer = await peers.create({
      name: peerName,
      description: `Desktop Client (${platform || 'unknown'}, v${clientVersion || '?'})`,
      tags: 'desktop-client',
    });

    // Generate client config
    const config = await peers.getClientConfig(peer.id);
    const hash = hashConfig(config);

    activity.log('client_registered', `Desktop client "${peerName}" registered`, {
      source: 'api',
      severity: 'info',
      details: { peerId: peer.id, hostname, platform, clientVersion },
    });

    logger.info({ peerId: peer.id, hostname, platform }, 'Desktop client registered');

    res.status(201).json({
      ok: true,
      peerId: peer.id,
      peerName,
      config,
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
    const peerId = req.query.peerId || req.headers['x-peer-id'];
    if (!peerId) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.peer_id_required') : 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
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
    const peerId = req.query.peerId || req.headers['x-peer-id'];
    if (!peerId) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.peer_id_required') : 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
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
router.post('/heartbeat', (req, res) => {
  try {
    const { peerId, connected, rxBytes, txBytes, uptime, hostname } = req.body;

    if (!peerId) {
      return res.status(400).json({ ok: false, error: 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    // Update last seen timestamp
    const db = getDb();
    db.prepare(`UPDATE peers SET updated_at = datetime('now') WHERE id = ?`).run(peer.id);

    logger.debug({ peerId, connected, rxBytes, txBytes }, 'Client heartbeat received');

    res.json({ ok: true });
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
    const { peerId, status, timestamp } = req.body;

    if (!peerId) {
      return res.status(400).json({ ok: false, error: 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    activity.log('client_status', `Client "${peer.name}" reported: ${status}`, {
      source: 'api',
      severity: 'info',
      details: { peerId, status, timestamp },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Status report failed');
    res.status(500).json({ ok: false, error: 'Status processing failed' });
  }
});

// ── Erreichbare Dienste ─────────────────────────────────────

/**
 * GET /api/v1/client/services
 * Returns list of configured HTTP routes (services) the client can access
 */
router.get('/services', (req, res) => {
  try {
    const allRoutes = routes.getAll({ type: 'http' });

    const services = allRoutes
      .filter(r => r.enabled !== 0)
      .map(r => ({
        id: r.id,
        name: r.name || r.domain,
        domain: r.domain,
        url: `https://${r.domain}`,
        target: r.target_host && r.target_port ? `${r.target_host}:${r.target_port}` : null,
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
 * Returns the server's public IP so the client can verify DNS goes through VPN
 */
router.get('/dns-check', (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress;
  res.json({
    ok: true,
    serverIp: clientIp,
    vpnSubnet: config.wireguard.subnet,
  });
});

// ── Auto-Update ──────────────────────────────────────────────

const https = require('node:https');
const http = require('node:http');

// Cache: { data, fetchedAt }
let releaseCache = null;
const CACHE_TTL = 3600000; // 1 hour

const CLIENT_REPO = process.env.GC_CLIENT_REPO || 'CallMeTechie/GateControl-Windows-Client';
const CLIENT_GITHUB_TOKEN = process.env.GC_CLIENT_GITHUB_TOKEN || '';

/**
 * Fetch latest release from GitHub API (cached 1h)
 */
async function fetchLatestRelease() {
  if (releaseCache && (Date.now() - releaseCache.fetchedAt) < CACHE_TTL) {
    return releaseCache.data;
  }

  const url = `https://api.github.com/repos/${CLIENT_REPO}/releases/latest`;
  const headers = {
    'User-Agent': 'GateControl-Server',
    'Accept': 'application/vnd.github+json',
  };
  if (CLIENT_GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CLIENT_GITHUB_TOKEN}`;
  }

  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          logger.warn({ statusCode: res.statusCode }, 'GitHub release API error');
          return resolve(null);
        }
        try {
          const data = JSON.parse(body);
          releaseCache = { data, fetchedAt: Date.now() };
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
}

/**
 * GET /api/v1/client/update/check
 * Query: ?version=1.2.1&platform=windows
 * Returns: { ok, available, version?, downloadUrl?, releaseNotes? }
 */
router.get('/update/check', async (req, res) => {
  try {
    const clientVersion = req.query.version;
    if (!clientVersion) {
      return res.status(400).json({ ok: false, error: 'Version parameter required' });
    }

    const release = await fetchLatestRelease();
    if (!release || !release.tag_name) {
      return res.json({ ok: true, available: false });
    }

    const latestVersion = release.tag_name.replace(/^v/, '');

    // Compare versions
    if (!isNewerVersion(latestVersion, clientVersion)) {
      return res.json({ ok: true, available: false });
    }

    // Find installer asset (.exe with "Setup" in name)
    const installerAsset = (release.assets || []).find(a =>
      a.name.endsWith('.exe') && a.name.includes('Setup')
    );

    // For private repos, proxy the download through the server
    let downloadUrl = null;
    if (installerAsset) {
      downloadUrl = `${config.app.baseUrl}/api/v1/client/update/download`;
    }

    res.json({
      ok: true,
      available: true,
      version: latestVersion,
      downloadUrl,
      fileName: installerAsset?.name || `GateControl-Setup-${latestVersion}.exe`,
      releaseNotes: release.body || '',
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Update check failed');
    res.status(500).json({ ok: false, error: 'Update check failed' });
  }
});

/**
 * GET /api/v1/client/update/download
 * Proxies the installer download from GitHub (needed for private repos)
 */
router.get('/update/download', async (req, res) => {
  try {
    const release = await fetchLatestRelease();
    if (!release) {
      return res.status(404).json({ ok: false, error: 'No release found' });
    }

    const asset = (release.assets || []).find(a =>
      a.name.endsWith('.exe') && a.name.includes('Setup')
    );
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

module.exports = router;
