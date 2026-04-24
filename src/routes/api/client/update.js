'use strict';

const { Router } = require('express');
const https = require('node:https');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');

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

module.exports = updateRouter;
