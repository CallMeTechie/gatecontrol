'use strict';

const { Router } = require('express');
const https = require('node:https');
const http = require('node:http');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');
const clientUpdates = require('../../../services/clientUpdates');
const { extractToken } = require('../../../middleware/auth');

// Per client type + channel release cache (2 min TTL). Used by both /check
// and /download.
const releaseCache = {};
const CACHE_TTL = 120000;

// Read per request so tests (and a restarted env) see the current value.
const githubToken = () => process.env.GC_CLIENT_GITHUB_TOKEN || '';

// Signed update manifests (Windows clients): the release workflow of the
// Pro/Community client uploads update-manifest.json plus a detached Ed25519
// signature. The server hands both through byte for byte; only the client
// verifies them (the signing key never leaves GitHub Actions).
const MANIFEST_ASSET = 'update-manifest.json';
const SIGNATURE_ASSET = 'update-manifest.json.sig';
const MAX_MANIFEST_BYTES = 16 * 1024;
const signedCache = {};

const CLIENT_REPOS = {
  community: process.env.GC_CLIENT_REPO_COMMUNITY || 'CallMeTechie/GateControl-Community-Client',
  pro:       process.env.GC_CLIENT_REPO_PRO       || 'CallMeTechie/GateControl-Pro-Client',
  android:   process.env.GC_CLIENT_REPO_ANDROID   || 'CallMeTechie/GateControl-Android-Client',
};

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
 * Newest release of a /releases listing for the beta channel: drafts are
 * skipped, pre-releases count; the highest x.y.z tag wins (GitHub orders by
 * creation date, not by version). null when nothing usable is listed.
 */
function pickBetaRelease(list) {
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const rel of list) {
    if (!rel || rel.draft || typeof rel.tag_name !== 'string') continue;
    if (!clientUpdates.parseVersion(rel.tag_name)) continue;
    if (!best || clientUpdates.compareVersions(rel.tag_name, best.tag_name) === 1) best = rel;
  }
  return best;
}

/**
 * Fetch the newest release of a channel from the GitHub API (cached 2 min per
 * client type and channel, follows redirects).
 *   stable: /releases/latest (GitHub never returns pre-releases or drafts)
 *   beta:   /releases listing incl. pre-releases, highest version
 */
async function fetchLatestRelease(clientType = 'community', channel = 'stable') {
  const cacheKey = `${clientType}:${channel}`;
  const cached = releaseCache[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.data;
  }

  const repo = CLIENT_REPOS[clientType] || CLIENT_REPOS.community;
  const beta = channel === 'beta';
  const url = beta
    ? `https://api.github.com/repos/${repo}/releases?per_page=30`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = {
    'User-Agent': 'GateControl-Server',
    'Accept': 'application/vnd.github+json',
  };
  if (githubToken()) {
    headers['Authorization'] = `Bearer ${githubToken()}`;
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
          const parsed = JSON.parse(body);
          const data = beta ? pickBetaRelease(parsed) : parsed;
          releaseCache[cacheKey] = { data, fetchedAt: Date.now() };
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

/**
 * Download a small release asset (manifest/signature). Public repos use the
 * browser_download_url, private repos the API URL with the token. Redirects
 * are followed (https only); the Authorization header is dropped as soon as
 * the host changes (GitHub redirects to a pre-signed storage URL). Resolves
 * to the exact bytes as a utf8 string, or null on any error / >maxBytes.
 */
function fetchSmallAsset(asset, maxBytes = MAX_MANIFEST_BYTES) {
  const token = githubToken();
  const startUrl = token ? asset.url : asset.browser_download_url;
  if (!startUrl) return Promise.resolve(null);
  const baseHeaders = { 'User-Agent': 'GateControl-Server', 'Accept': 'application/octet-stream' };
  const startHost = (() => { try { return new URL(startUrl).host; } catch { return null; } })();

  const get = (targetUrl, redirectCount) => new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return resolve(null); }
    if (parsed.protocol !== 'https:' || redirectCount > 5) return resolve(null);
    const headers = { ...baseHeaders };
    if (token && parsed.host === startHost) headers['Authorization'] = `Bearer ${token}`;

    const req = https.get(targetUrl, { headers, timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, targetUrl).toString(); } catch { return resolve(null); }
        return resolve(get(next, redirectCount + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        logger.warn({ statusCode: res.statusCode, asset: asset.name }, 'Update manifest asset download failed');
        return resolve(null);
      }
      const chunks = [];
      let size = 0;
      let aborted = false;
      res.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBytes) {
          aborted = true;
          logger.warn({ asset: asset.name }, 'Update manifest asset too large');
          res.destroy();
          return resolve(null);
        }
        chunks.push(chunk);
      });
      res.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      logger.warn({ error: err.message, asset: asset.name }, 'Update manifest asset fetch failed');
      resolve(null);
    });
  });

  return get(startUrl, 0);
}

/**
 * Manifest + signature of a Windows client release, cached per client type
 * and release (same TTL as the release itself). null when the release has no
 * signed manifest (old releases) or the download failed.
 */
async function fetchSignedManifest(clientType, release, channel = 'stable') {
  if (clientType === 'android' || !release) return null;
  const assets = release.assets || [];
  const manifestAsset = assets.find(a => a.name === MANIFEST_ASSET);
  const signatureAsset = assets.find(a => a.name === SIGNATURE_ASSET);
  if (!manifestAsset || !signatureAsset) return null;

  const cacheKey = `${clientType}:${channel}`;
  const key = `${release.id || ''}:${release.tag_name || ''}:${manifestAsset.id || ''}:${signatureAsset.id || ''}`;
  const cached = signedCache[cacheKey];
  if (cached && cached.key === key && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.value;
  }

  const [manifest, signature] = await Promise.all([
    fetchSmallAsset(manifestAsset),
    fetchSmallAsset(signatureAsset),
  ]);
  const value = manifest && signature ? { manifest, signature } : null;
  signedCache[cacheKey] = { key, value, fetchedAt: Date.now() };
  return value;
}

/**
 * Installer asset of a release. For Windows clients with a signed manifest
 * the asset named in the manifest wins; otherwise (old releases, Android) the
 * previous heuristic applies.
 */
function pickInstallerAsset(clientType, release, signed) {
  const assets = release.assets || [];
  if (clientType === 'android') {
    return assets.find(a => a.name.endsWith('.apk') && !a.name.includes('debug'));
  }
  if (signed) {
    let fileName = null;
    try { fileName = JSON.parse(signed.manifest).fileName; } catch { /* client rejects it */ }
    const named = typeof fileName === 'string' && assets.find(a => a.name === fileName);
    if (named) return named;
  }
  return assets.find(a => a.name.endsWith('.exe') && a.name.includes('Setup'));
}

/**
 * The peer behind an optional API token on the (public) update routes. The
 * Windows clients send X-API-Token with every check, Android its token too.
 * A missing, unknown, expired or out-of-scope token is not an error here —
 * the request simply counts as anonymous (global default channel, nothing
 * recorded). Never throws.
 */
function resolveRequester(req) {
  try {
    const raw = extractToken(req);
    if (!raw) return null;
    return clientUpdates.resolveTokenPeer(raw, '/api/v1/client/update/check');
  } catch (err) {
    logger.debug({ err: err.message }, 'Update check: token lookup failed, treating as anonymous');
    return null;
  }
}

/**
 * Channel + minimum version for this request. The channel comes from the
 * server only (peer override, else global default) — a client cannot ask for
 * beta via query or header.
 */
function resolveUpdatePolicy(req, clientType) {
  const policy = clientUpdates.getPolicy();
  const requester = resolveRequester(req);
  const peer = requester && requester.peer;
  return {
    peer,
    channel: peer ? clientUpdates.effectiveChannel(peer, policy) : policy.defaultChannel,
    minVersion: clientUpdates.minVersionFor(clientType, policy),
  };
}

// ─── Public update routes (mounted WITHOUT auth in routes/index.js) ───
const updateRouter = Router();

/**
 * GET /api/v1/client/update/check
 * Query: ?version=1.2.1&platform=windows&client=pro|community
 * Returns: { ok, available, version?, downloadUrl?, releaseNotes?,
 *            manifest?, signature?, channel, minVersion, mandatory }
 *
 * channel / minVersion / mandatory are unsigned UX hints (older clients
 * ignore them). mandatory = an update is available and the client is below
 * the minimum version of its product. The client still verifies the signed
 * manifest and never installs anything that is not strictly newer.
 */
updateRouter.get('/check', async (req, res) => {
  try {
    const clientVersion = req.query.version;
    if (!clientVersion || typeof clientVersion !== 'string') {
      return res.status(400).json({ ok: false, error: 'Version parameter required' });
    }

    const clientType = resolveClientType(req);
    const { peer, channel, minVersion } = resolveUpdatePolicy(req, clientType);

    // Remember which version this peer runs (token-bound clients only).
    if (peer) {
      clientUpdates.recordClientVersion(peer.id, {
        version: clientVersion,
        product: clientType,
        platform: req.query.platform || req.headers['x-client-platform'],
      });
    }

    const policyFields = { channel, minVersion };
    const release = await fetchLatestRelease(clientType, channel);
    if (!release || !release.tag_name) {
      return res.json({ ok: true, available: false, ...policyFields, mandatory: false });
    }

    const latestVersion = release.tag_name.replace(/^v/, '');

    // Compare versions
    if (!isNewerVersion(latestVersion, clientVersion)) {
      return res.json({ ok: true, available: false, ...policyFields, mandatory: false });
    }

    const mandatory = !!minVersion && clientUpdates.compareVersions(clientVersion, minVersion) === -1;

    // Signed manifest (Windows clients only; passed through unchanged)
    const signed = await fetchSignedManifest(clientType, release, channel);

    // Find installer asset based on client type
    const installerAsset = pickInstallerAsset(clientType, release, signed);

    // For public repos, link directly to GitHub; for private, proxy through server
    let downloadUrl = null;
    if (installerAsset) {
      downloadUrl = githubToken()
        ? `${config.app.baseUrl}/api/v1/client/update/download?client=${clientType}`
        : installerAsset.browser_download_url;
    }

    const defaultFileName = clientType === 'android'
      ? `GateControl-Android-${latestVersion}.apk`
      : `GateControl-Setup-${latestVersion}.exe`;

    const body = {
      ok: true,
      available: true,
      version: latestVersion,
      downloadUrl,
      fileName: installerAsset?.name || defaultFileName,
      fileSize: installerAsset?.size || null,
      releaseNotes: release.body || '',
      prerelease: !!release.prerelease,
      ...policyFields,
      mandatory,
    };
    if (signed) {
      body.manifest = signed.manifest;
      body.signature = signed.signature;
    }
    res.json(body);
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
    // Same channel as the check that produced the download URL (resolved
    // from the token again — never from the query).
    const { channel } = resolveUpdatePolicy(req, clientType);
    const release = await fetchLatestRelease(clientType, channel);
    if (!release) {
      return res.status(404).json({ ok: false, error: 'No release found' });
    }

    const signed = await fetchSignedManifest(clientType, release, channel);
    const asset = pickInstallerAsset(clientType, release, signed);
    if (!asset) {
      return res.status(404).json({ ok: false, error: 'No installer asset found' });
    }

    // Redirect to browser_download_url for public repos
    if (!githubToken()) {
      return res.redirect(asset.browser_download_url);
    }

    // For private repos, proxy through GitHub API
    const headers = {
      'User-Agent': 'GateControl-Server',
      'Accept': 'application/octet-stream',
      'Authorization': `Bearer ${githubToken()}`,
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

module.exports = updateRouter;
module.exports._pickBetaRelease = pickBetaRelease;
// Test hook: drop cached releases/manifests.
module.exports._resetCache = () => {
  for (const k of Object.keys(releaseCache)) delete releaseCache[k];
  for (const k of Object.keys(signedCache)) delete signedCache[k];
};
