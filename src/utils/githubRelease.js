'use strict';

// Release downloads from GitHub when github.com's download path is degraded.
//
// https://github.com/<owner>/<repo>/releases/download/<tag>/<name> (the
// browser download) answered 504 after ~11 s on 8 Nov 2026 while the API
// route to the same file worked at once:
//
//   GET https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>
//       → the release with its assets (id per name)
//   GET https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>
//       Accept: application/octet-stream → 302 to the asset CDN → the bytes
//
// This module knows that route and keeps what it learnt: the asset id per
// file (ASSET_TTL_MS), the ETag of each release (If-None-Match — a 304 does
// not count against GitHub's rate limit), and the rate limit itself
// (unauthenticated 60 requests an hour per address: after a 403/429 with
// x-ratelimit-remaining 0 or Retry-After no API request until the reset).
// It is transport-agnostic: callers pass their own get() — the plugin
// catalogue its allow-listed client, the client updates https.get — so every
// caller keeps its own rules (https only, allowed hosts, size caps).
//
// Only URLs on github.com with that path take the other route; any other URL
// (an operator's own catalogue) never does.

const API_HOST = 'api.github.com';
const DOWNLOAD_HOST = 'github.com';
// the API answers an asset download with a 302 to one of these
const ASSET_HOSTS = Object.freeze(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ASSET_TTL_MS = 60 * 60 * 1000;
const RELEASE_MAX_BYTES = 1024 * 1024;
// after the download path failed once: the API route first for this long
const API_FIRST_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_WAIT_MS = 60 * 60 * 1000;

class GithubReleaseError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; if (status) this.status = status; }
}

/** https://github.com/<owner>/<repo>/releases/download/<tag>/<name> → { owner, repo, tag, name } | null */
function parseDownloadUrl(raw) {
  let u;
  try { u = raw instanceof URL ? raw : new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.host.toLowerCase() !== DOWNLOAD_HOST || u.username || u.password || u.search) return null;
  const seg = u.pathname.split('/');
  if (seg.length !== 7 || seg[0] !== '' || seg[3] !== 'releases' || seg[4] !== 'download') return null;
  let tag;
  let name;
  try { tag = decodeURIComponent(seg[5]); name = decodeURIComponent(seg[6]); } catch { return null; }
  if (!NAME_RE.test(seg[1]) || !NAME_RE.test(seg[2]) || !tag || tag.length > 200 || /[\0-\x1f]/.test(tag)
    || !name || name.length > 255 || /[\0-\x1f/\\]/.test(name)) return null;
  return { owner: seg[1], repo: seg[2], tag, name };
}

/** https://api.github.com/repos/<owner>/<repo>/releases/assets/<id> → { owner, repo, id } | null */
function parseAssetApiUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.host.toLowerCase() !== API_HOST || u.username || u.password || u.search) return null;
  const m = /^\/repos\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/releases\/assets\/(\d{1,20})$/.exec(u.pathname);
  return m ? { owner: m[1], repo: m[2], id: m[3] } : null;
}

const tagUrl = (r) => `https://${API_HOST}/repos/${r.owner}/${r.repo}/releases/tags/${encodeURIComponent(r.tag)}`;
const assetUrl = (r, id) => `https://${API_HOST}/repos/${r.owner}/${r.repo}/releases/assets/${encodeURIComponent(String(id))}`;

/** A failure of the download path that the API route may get round: 5xx, a timeout, no connection. Never 4xx. */
function worthFallback(status) {
  return status == null || (status >= 500 && status <= 599);
}

// ─── Rate limit ─────────────────────────────────

let limitedUntil = 0;
let apiFirstUntil = 0;

function header(h, name) {
  if (!h) return undefined;
  const v = typeof h.get === 'function' ? h.get(name) : h[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The rate-limit headers of an API answer (any status): a 403/429 that says
 * the limit is used up ends API requests until the reset (at most an hour).
 * → true when the answer was such a refusal.
 */
function noteRateLimit(status, headers, now = Date.now()) {
  const remaining = header(headers, 'x-ratelimit-remaining');
  const reset = Number(header(headers, 'x-ratelimit-reset'));
  const retry = Number(header(headers, 'retry-after'));
  const refused = (status === 403 || status === 429) && (String(remaining) === '0' || Number.isFinite(retry) || status === 429);
  if (!refused) return false;
  let until = now + 60 * 1000;
  if (Number.isFinite(retry) && retry > 0) until = now + retry * 1000;
  else if (Number.isFinite(reset) && reset > 0) until = reset * 1000;
  limitedUntil = Math.min(Math.max(until, now + 1000), now + RATE_LIMIT_MAX_WAIT_MS);
  return true;
}

function rateLimited(now = Date.now()) { return now < limitedUntil; }
function rateLimitedUntil() { return limitedUntil > Date.now() ? limitedUntil : 0; }

/** The download path failed: the API route first for API_FIRST_MS. */
function noteDegraded(now = Date.now()) { apiFirstUntil = now + API_FIRST_MS; }
function apiFirst(now = Date.now()) { return now < apiFirstUntil; }

// ─── Releases and asset ids ─────────────────────

const releases = new Map(); // "owner/repo@tag" → { etag, assets: Map(name → { id, size }), at }
const keyOf = (r) => `${r.owner}/${r.repo}@${r.tag}`.toLowerCase();

/**
 * The asset { id, size } of `ref` ({ owner, repo, tag, name }) — from what
 * was learnt (ASSET_TTL_MS), else from the release (conditional request).
 * `get(url, headers)` → { status, headers, body } (a Buffer for 200).
 */
async function assetOf(ref, get, { now = Date.now() } = {}) {
  const k = keyOf(ref);
  const known = releases.get(k);
  if (known && now - known.at < ASSET_TTL_MS && known.assets.has(ref.name)) return known.assets.get(ref.name);
  if (rateLimited(now)) throw new GithubReleaseError('rate_limited', 'GitHub API rate limit reached');
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (known && known.etag) headers['If-None-Match'] = known.etag;
  const r = await get(tagUrl(ref), headers);
  if (noteRateLimit(r.status, r.headers)) throw new GithubReleaseError('rate_limited', 'GitHub API rate limit reached', r.status);
  let entry = known;
  if (r.status === 304 && known) {
    entry = { ...known, at: now };
  } else if (r.status === 200 && Buffer.isBuffer(r.body)) {
    let rel;
    try { rel = JSON.parse(r.body.toString('utf8')); } catch { throw new GithubReleaseError('bad_release', 'release is not JSON'); }
    const assets = new Map();
    for (const a of Array.isArray(rel && rel.assets) ? rel.assets : []) {
      if (a && typeof a.name === 'string' && (Number.isSafeInteger(a.id) || /^\d{1,20}$/.test(String(a.id)))) {
        assets.set(a.name, { id: String(a.id), size: Number.isSafeInteger(a.size) ? a.size : null });
      }
    }
    const etag = header(r.headers, 'etag');
    entry = { etag: typeof etag === 'string' && etag.length <= 200 ? etag : null, assets, at: now };
  } else {
    throw new GithubReleaseError('api_failed', `HTTP ${r.status}`, r.status);
  }
  releases.set(k, entry);
  if (releases.size > 100) releases.delete(releases.keys().next().value);
  const a = entry.assets.get(ref.name);
  if (!a) throw new GithubReleaseError('asset_missing', 'the release has no such asset', 404);
  return a;
}

/**
 * The asset of `ref` was replaced (its id answered 404): the release is asked
 * again next time — still with its ETag (a changed release answers 200).
 */
function forget(ref) {
  const k = keyOf(ref);
  const e = releases.get(k);
  if (e) releases.set(k, { etag: e.etag, assets: new Map(), at: 0 });
}

function _resetForTest() { releases.clear(); limitedUntil = 0; apiFirstUntil = 0; }

module.exports = {
  API_HOST, DOWNLOAD_HOST, ASSET_HOSTS, ASSET_TTL_MS, API_FIRST_MS, RELEASE_MAX_BYTES, GithubReleaseError,
  parseDownloadUrl, parseAssetApiUrl, tagUrl, assetUrl, worthFallback,
  noteRateLimit, rateLimited, rateLimitedUntil, noteDegraded, apiFirst, assetOf, forget, _resetForTest,
};
