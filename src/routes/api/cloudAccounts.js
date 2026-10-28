'use strict';

/**
 * Admin API of the cloud accounts (docs/cloud-accounts.md,
 * services/cloudAccounts/). Admin session only (API tokens and members:
 * 403); CSRF and the API limiter come from the /api/v1 router. Client
 * secrets and tokens are write-only / never answered.
 *
 *   GET    /api/v1/cloud-accounts                  { apps, redirectUri, https, connections, targets }
 *   PUT    /api/v1/cloud-accounts/apps/:provider   { clientId, clientSecret?, tenant? } (an empty secret keeps the stored one)
 *   DELETE /api/v1/cloud-accounts/apps/:provider   (409 while a storage target uses it)
 *   POST   /api/v1/cloud-accounts/connect          { provider, targetId? } → { url } — the administrator's own
 *                                                  account for a storage target "Google Drive" / "OneDrive"
 *   GET    /api/v1/cloud-accounts/drafts/:id       → { draft: { id, provider, kind, account, targetId } }
 *   GET    /api/v1/cloud-accounts/folders?draft=|target=&parent=   → { folders: [{ id, name }], driveId }
 *   POST   /api/v1/cloud-accounts/folders          { draft | target, parent, name } → { folder: { id, name } }
 *   DELETE /api/v1/cloud-accounts/connections/:id  a person's connection (gc.cloud)
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const cloud = require('../../services/cloudAccounts');
const folders = require('../../services/cloudAccounts/folders');
const providers = require('../../services/cloudAccounts/providers');
const activity = require('../../services/activity');
const logger = require('../../utils/logger');
const config = require('../../../config/default');

const router = express.Router();
router.use(requireAdminSession);

const STATUS = { ERR_INVALID: 400, ERR_CLOUD_NOT_FOUND: 404, ERR_IN_USE: 409, ERR_CLOUD_NOT_CONFIGURED: 409, ERR_CLOUD_AUTH: 409, ERR_RATE_LIMIT: 429,
  ERR_TIMEOUT: 504, ERR_CLOUD_PROVIDER: 502, ERR_CLOUD_TOO_LARGE: 502 };

function tr(req, key, fallback) {
  const s = req.t ? req.t(key) : key;
  return s && s !== key ? s : fallback;
}

function fail(req, res, e) {
  const code = (e && e.code) || 'internal';
  if (!STATUS[code]) logger.warn({ err: e && e.message }, 'cloud accounts request failed');
  return res.status(STATUS[code] || 500).json({ ok: false, code, field: (e && e.field) || null, error: tr(req, `cloud.err.${code}`, (e && e.message) || 'failed') });
}

function body(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }

function log(req, event, message, details) {
  activity.log(event, message, { source: 'admin', ipAddress: req.ip, severity: 'info', details });
}

const NAMES = { google: 'Google', microsoft: 'Microsoft' };

function pluginNames() {
  const out = new Map();
  try { for (const p of require('../../services/plugins/registry').list()) out.set(p.id, p.manifest && p.manifest.name ? p.manifest.name : p.id); } catch { /* none */ }
  return out;
}

router.get('/', (req, res) => {
  const names = pluginNames();
  const lang = req.language === 'en' ? 'en' : 'de';
  const pick = (n) => (typeof n === 'string' ? n : (n && (n[lang] || n.de || n.en)) || null);
  const { getDb } = require('../../db/connection');
  const targets = getDb().prepare("SELECT id, kind, label FROM storage_targets WHERE kind IN ('gdrive', 'onedrive') ORDER BY label COLLATE NOCASE").all();
  res.json({
    ok: true, apps: cloud.appsView(), redirectUri: cloud.redirectUri(), https: /^https:\/\//.test(String(config.app.baseUrl || '')),
    hosts: [...require('../../services/cloudAccounts/http').HOSTS],
    connections: cloud.adminConnections().map((c) => ({ ...c, pluginName: pick(names.get(c.plugin)) || c.plugin })),
    targets,
  });
});

router.put('/apps/:provider', (req, res) => {
  try {
    const a = cloud.setApp(String(req.params.provider), body(req));
    log(req, 'cloud_app_changed', `OAuth app for ${NAMES[req.params.provider]} saved`, { provider: req.params.provider });
    res.json({ ok: true, app: a });
  } catch (e) { fail(req, res, e); }
});

router.delete('/apps/:provider', (req, res) => {
  try {
    cloud.removeApp(String(req.params.provider));
    log(req, 'cloud_app_removed', `OAuth app for ${NAMES[req.params.provider]} removed`, { provider: req.params.provider });
    res.json({ ok: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/connect', (req, res) => {
  const b = body(req);
  try {
    let targetId = null;
    if (b.targetId != null) {
      const t = require('../../services/storageTargets').rowOf(b.targetId);
      const kind = b.provider === 'google' ? 'gdrive' : 'onedrive';
      if (!t || t.kind !== kind) return fail(req, res, Object.assign(new Error('no such storage target'), { code: 'ERR_CLOUD_NOT_FOUND' }));
      targetId = t.id;
    }
    const f = cloud.createFlow({ provider: String(b.provider || ''), purpose: 'target', userId: req.session.userId, targetId });
    res.json({ ok: true, url: f.url });
  } catch (e) { fail(req, res, e); }
});

router.get('/drafts/:id', (req, res) => {
  const d = cloud.draft(String(req.params.id));
  if (!d || d.userId !== req.session.userId) return fail(req, res, Object.assign(new Error('expired'), { code: 'ERR_CLOUD_NOT_FOUND' }));
  res.json({ ok: true, draft: cloud.draftView(d) });
});

/** The API session for a draft (this administrator's) or a stored cloud target. */
function apiOf(req, src) {
  if (src.draft) {
    const d = cloud.draft(String(src.draft));
    if (!d || d.userId !== req.session.userId) throw Object.assign(new Error('the connection expired — connect again'), { code: 'ERR_CLOUD_NOT_FOUND' });
    return { provider: d.provider, api: cloud.draftApi(d) };
  }
  const targets = require('../../services/storageTargets');
  const row = targets.rowOf(src.target);
  const provider = row && targets.CLOUD[row.kind];
  if (!provider) throw Object.assign(new Error('no such storage target'), { code: 'ERR_CLOUD_NOT_FOUND' });
  const { encrypt } = require('../../utils/crypto');
  const { getDb } = require('../../db/connection');
  const sec = targets.secretOf(row);
  if (!sec.refresh) throw Object.assign(new Error('connect the account again'), { code: 'ERR_CLOUD_AUTH' });
  const api = providers.session(provider, () => cloud.needApp(provider), sec, (t) => {
    getDb().prepare('UPDATE storage_targets SET secret_enc = ? WHERE id = ?').run(encrypt(JSON.stringify(t)), row.id);
  });
  return { provider, api };
}

router.get('/folders', async (req, res) => {
  const q = req.query || {};
  try {
    const { provider, api } = apiOf(req, { draft: typeof q.draft === 'string' ? q.draft : null, target: q.target });
    const r = await folders.list(provider, api, typeof q.parent === 'string' ? q.parent : null);
    res.json({ ok: true, ...r });
  } catch (e) { fail(req, res, e); }
});

router.post('/folders', async (req, res) => {
  const b = body(req);
  try {
    const { provider, api } = apiOf(req, { draft: typeof b.draft === 'string' ? b.draft : null, target: b.target });
    const folder = await folders.make(provider, api, typeof b.parent === 'string' ? b.parent : null, b.name);
    res.json({ ok: true, folder });
  } catch (e) { fail(req, res, e); }
});

router.delete('/connections/:id', async (req, res) => {
  try {
    const r = await cloud.adminRemove(String(req.params.id));
    if (!r) return fail(req, res, Object.assign(new Error('not found'), { code: 'ERR_CLOUD_NOT_FOUND' }));
    log(req, 'cloud_connection_removed', `Cloud connection (${NAMES[r.provider]}) of a person removed in ${r.plugin}`, r);
    res.json({ ok: true });
  } catch (e) { fail(req, res, e); }
});

module.exports = router;
