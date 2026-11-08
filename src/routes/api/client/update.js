'use strict';

const { Router } = require('express');
const https = require('node:https');
const http = require('node:http');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');
const clientUpdates = require('../../../services/clientUpdates');
const gh = require('../../../utils/githubRelease');
const warnOnce = require('../../../utils/warnOnce');
const { trackPhases, describe: describePhase } = require('../../../utils/httpPhase');
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

// GitHub: every host a request or redirect of these fetchers may reach (https only)
const GITHUB_HOSTS = new Set([gh.DOWNLOAD_HOST, gh.API_HOST, ...gh.ASSET_HOSTS]);
const RELEASE_TIMEOUT_MS = 8000;
const RELEASE_MAX_BYTES = 5 * 1024 * 1024;
// the browser download path (github.com/…/releases/download/…): no answer in this time → the API route
const ASSET_PRIMARY_TIMEOUT_MS = 5000;
const ASSET_TIMEOUT_MS = 10000;
// a manifest of a given asset id never changes: kept as long as the release names the same assets
const SIGNED_KEEP_MS = 24 * 3600 * 1000;
const SIGNED_FAIL_MS = 60 * 1000;

/**
 * One GET (no redirects): { status, headers, location, body } — the body only
 * for 200 and never beyond `maxBytes` (then status 413). Never throws; a
 * network error or timeout answers status 0 (`error`: 'timeout' | message).
 */
function ghGetOnce(url, { headers, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    let done = false;
    let phase = null;
    // a failure says where the request hung (dns, connect, tls, first byte) and the address family
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (v.status === 0 && phase) v.where = describePhase(phase()); resolve(v); };
    let req;
    const timer = setTimeout(() => { finish({ status: 0, error: 'timeout' }); try { req && req.destroy(); } catch { /* gone */ } }, timeoutMs);
    if (timer.unref) timer.unref();
    try {
      req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.resume();
          return finish({ status, headers: res.headers || {}, location: res.headers && typeof res.headers.location === 'string' ? res.headers.location : null });
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (done) return;
          size += c.length;
          if (size > maxBytes) { finish({ status: 413, headers: res.headers || {} }); res.destroy(); return; }
          chunks.push(c);
        });
        res.on('end', () => finish({ status, headers: res.headers || {}, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish({ status: 0, error: e.message }));
      });
    } catch (e) { return finish({ status: 0, error: e.message }); }
    if (typeof req.once === 'function') phase = trackPhases(req);
    req.on('timeout', () => { finish({ status: 0, error: 'timeout' }); req.destroy(); });
    req.on('error', (e) => finish({ status: 0, error: e.message }));
  });
}

/**
 * GET with redirects (≤ 5) on GitHub's hosts only (https). `headers` go to
 * every hop; `auth` (a token) only to the first host — GitHub redirects to
 * pre-signed storage URLs. `onFirst(answer)` sees the first answer (rate limit).
 */
async function ghGet(startUrl, { headers, auth = '', timeoutMs, maxBytes, onFirst = null }) {
  let url = startUrl;
  let startHost = null;
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop <= 5; hop++) {
    let parsed;
    try { parsed = new URL(url); } catch { return { status: 0, error: 'bad url' }; }
    if (parsed.protocol !== 'https:' || !GITHUB_HOSTS.has(parsed.host.toLowerCase())) return { status: 0, error: 'host not allowed' };
    if (hop === 0) startHost = parsed.host;
    const h = { ...headers };
    if (auth && parsed.host === startHost) h.Authorization = `Bearer ${auth}`;
    const left = deadline - Date.now();
    if (left <= 0) return { status: 0, error: 'timeout' };
    const r = await ghGetOnce(url, { headers: h, timeoutMs: left, maxBytes });
    if (hop === 0 && onFirst) onFirst(r);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.location) {
      try { url = new URL(r.location, url).toString(); } catch { return { status: 0, error: 'bad redirect' }; }
      continue;
    }
    return r;
  }
  return { status: 0, error: 'too many redirects' };
}

/**
 * Fetch the newest release of a channel from the GitHub API (cached 2 min per
 * client type and channel, follows redirects on GitHub's hosts).
 *   stable: /releases/latest (GitHub never returns pre-releases or drafts)
 *   beta:   /releases listing incl. pre-releases, highest version
 * Asks with If-None-Match (a 304 does not count against GitHub's rate limit);
 * while the rate limit is used up (utils/githubRelease.js) the last answer
 * is used without asking.
 */
async function fetchLatestRelease(clientType = 'community', channel = 'stable') {
  const cacheKey = `${clientType}:${channel}`;
  const cached = releaseCache[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.data;
  }
  if (gh.rateLimited()) return cached ? cached.data : null;

  const repo = CLIENT_REPOS[clientType] || CLIENT_REPOS.community;
  const beta = channel === 'beta';
  const url = beta
    ? `https://api.github.com/repos/${repo}/releases?per_page=30`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = {
    'User-Agent': 'GateControl-Server',
    'Accept': 'application/vnd.github+json',
  };
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

  let limited = false;
  const r = await ghGet(url, { headers, auth: githubToken(), timeoutMs: RELEASE_TIMEOUT_MS, maxBytes: RELEASE_MAX_BYTES,
    onFirst: (a) => { limited = gh.noteRateLimit(a.status, a.headers); } });
  if (limited) {
    warnOnce.throttled(`client-release-limit:${repo}`, { repo, until: new Date(gh.rateLimitedUntil()).toISOString() }, 'GitHub API rate limit reached — using the last known release');
    return cached ? cached.data : null;
  }
  if (r.status === 304 && cached) {
    cached.fetchedAt = Date.now();
    return cached.data;
  }
  if (r.status === 0) {
    warnOnce.throttled(`client-release:${repo}:0`, { error: r.error, where: r.where || null, repo }, 'GitHub release fetch failed');
    return null;
  }
  if (r.status !== 200) {
    warnOnce.throttled(`client-release:${repo}:${r.status}`, { statusCode: r.status, repo }, 'GitHub release API error');
    return null;
  }
  try {
    const parsed = JSON.parse(r.body.toString('utf8'));
    const data = beta ? pickBetaRelease(parsed) : parsed;
    const etag = r.headers && typeof r.headers.etag === 'string' && r.headers.etag.length <= 200 ? r.headers.etag : null;
    releaseCache[cacheKey] = { data, fetchedAt: Date.now(), etag };
    return data;
  } catch {
    return null;
  }
}

/**
 * Download a small release asset (manifest/signature). Public repos use the
 * browser_download_url, private repos the API URL with the token. Redirects
 * are followed on GitHub's hosts only (https); the Authorization header is
 * dropped as soon as the host changes (GitHub redirects to a pre-signed
 * storage URL). When the browser download answers 5xx or not within
 * ASSET_PRIMARY_TIMEOUT_MS (github.com's download path degraded, 8 Nov 2026:
 * 504 after 11 s), the same asset comes over the API (asset.url with
 * Accept: application/octet-stream) — not while GitHub's rate limit is used
 * up. Resolves to the exact bytes as a utf8 string, or null on any error /
 * >maxBytes. The signature is still checked by the client, never here.
 */
async function fetchSmallAsset(asset, maxBytes = MAX_MANIFEST_BYTES) {
  const token = githubToken();
  const headers = { 'User-Agent': 'GateControl-Server', 'Accept': 'application/octet-stream' };
  const api = gh.parseAssetApiUrl(asset.url) ? asset.url : null;
  const done = (r, via) => {
    if (r.status === 200 && r.body) return r.body.toString('utf8');
    // once per asset, way and answer in 5 minutes (every update check of every client asks)
    if (r.status === 413) warnOnce.throttled(`update-asset:${asset.name}:${via}:413`, { asset: asset.name, via }, 'Update manifest asset too large');
    else if (r.status === 0) warnOnce.throttled(`update-asset:${asset.name}:${via}:0`, { error: r.error, where: r.where || null, asset: asset.name, via }, 'Update manifest asset fetch failed');
    else warnOnce.throttled(`update-asset:${asset.name}:${via}:${r.status}`, { statusCode: r.status, asset: asset.name, via }, 'Update manifest asset download failed');
    return null;
  };
  if (token) {
    if (!asset.url) return null;
    return done(await ghGet(asset.url, { headers, auth: token, timeoutMs: ASSET_TIMEOUT_MS, maxBytes }), 'api');
  }
  if (!asset.browser_download_url) return null;
  let first = null;
  if (!api || !gh.apiFirst()) {
    first = await ghGet(asset.browser_download_url, { headers, timeoutMs: api ? ASSET_PRIMARY_TIMEOUT_MS : ASSET_TIMEOUT_MS, maxBytes });
    if (first.status === 200 || !api || !gh.worthFallback(first.status || null)) return done(first, 'download');
    gh.noteDegraded();
  }
  if (gh.rateLimited()) return first ? done(first, 'download') : null;
  const r = await ghGet(api, { headers, timeoutMs: ASSET_TIMEOUT_MS, maxBytes, onFirst: (a) => gh.noteRateLimit(a.status, a.headers) });
  if (r.status === 200) {
    if (first) {
      warnOnce.throttled(`update-asset-api-ok:${asset.name}`, { asset: asset.name, statusCode: first.status || null, error: first.error || null, where: first.where || null },
        'Update manifest asset fetched over the GitHub API', { level: 'info', everyMs: gh.API_FIRST_MS });
    }
    return r.body.toString('utf8');
  }
  if (first) done(first, 'download');
  return done(r, 'api');
}

/**
 * Manifest + signature of a Windows client release, cached per client type
 * and release: as long as the release names the same assets (an asset id
 * never changes its bytes), at most SIGNED_KEEP_MS; a failure SIGNED_FAIL_MS.
 * null when the release has no signed manifest (old releases) or the download
 * failed.
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
  if (cached && cached.key === key && (Date.now() - cached.fetchedAt) < (cached.value ? SIGNED_KEEP_MS : SIGNED_FAIL_MS)) {
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
 *            manifest?, signature?, channel, minVersion, mandatory, lan? }
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
    // SHA-256 of the installer as GitHub publishes it (asset.digest
    // "sha256:<hex>"): a client that downloads it itself (the Android app's
    // own APK download) checks the bytes against it — on the normal way as on
    // the home cache's (lan.sha256 is the same value). Absent for old releases.
    const sha256 = installerAsset ? assetSha256(installerAsset) : null;
    if (sha256) body.sha256 = sha256;
    // Home cache (gateways phase 3b): the same installer from the gateway of
    // the home network the client is in, when that gateway holds it —
    // lan { url, sha256, tlsSha256, exp }. The client loads it there with
    // certificate pinning (tlsSha256), checks sha256 and falls back to
    // downloadUrl otherwise. Needs the device's LAN address (?local= or
    // X-GC-Local) for the gateway-site rule (services/homeNetwork.js).
    try {
      const lan = await require('../../../services/homeCache').lanForUpdate(req, clientType, installerAsset, peer);
      if (lan) body.lan = lan;
    } catch (err) { logger.debug({ err: err.message }, 'Update check: no home cache hint'); }
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

/** The published SHA-256 of a release asset (GitHub "digest": "sha256:<hex>") as lower-case hex, or null. */
function assetSha256(asset) {
  const d = asset && typeof asset.digest === 'string' ? asset.digest : '';
  return /^sha256:[0-9a-f]{64}$/i.test(d) ? d.slice(7).toLowerCase() : null;
}

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
// The home cache (services/homeCache.js refreshUpdates) keeps the installers the clients get here.
module.exports._internals = { fetchLatestRelease, fetchSignedManifest, pickInstallerAsset, resolveClientType };
// Test hook: a release as if GitHub had answered it (cached like a real one).
module.exports._setReleaseForTest = (clientType, channel, data) => { releaseCache[`${clientType}:${channel}`] = { data, fetchedAt: Date.now() }; };
// Test hook: drop cached releases/manifests.
module.exports._resetCache = () => {
  for (const k of Object.keys(releaseCache)) delete releaseCache[k];
  for (const k of Object.keys(signedCache)) delete signedCache[k];
  gh._resetForTest();
  warnOnce._resetForTest();
};
// Test hook: the cached releases count as old (the next check asks GitHub again, conditionally).
module.exports._expireReleasesForTest = () => { for (const v of Object.values(releaseCache)) v.fetchedAt = 0; };
