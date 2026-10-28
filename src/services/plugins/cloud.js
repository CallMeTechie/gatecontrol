'use strict';

// gc.cloud — Google Drive and OneDrive of a person for plugins with
// plugin.json `permissions.cloudImport: { purpose: { de, en } }`
// (docs/plugins.md "Cloud import", services/cloudAccounts/).
//
//   available()                                → { google, microsoft }: an OAuth app is entered
//   connectUrl({ user, provider, returnTo })   → { url }: /oauth/cloud/start?flow=… on this server;
//                                                afterwards back to returnTo (a /portal… path or
//                                                gatecontrol://…) with ?cloud=connected | error
//   connections({ user })                      → [{ id, provider, account, connectedAt, error? }]
//   disconnect({ user, connection })           → boolean
//   list({ user, connection, folderId, cursor }) → { items: [{ id, name, isDir, size, mime, modifiedAt }], next }
//   import({ user, connection, fileId })       → { mediaId, name, size, mime, modifiedAt }
//
// A connection belongs to exactly one person and one plugin: every call names
// the person, and a plugin only ever finds its own connections. import()
// streams the file into the plugin's media store (unclaimed, owner = the
// person, removed after 24 h unless claimed) under the plugin's media.types,
// maxBytes and quota. Google Docs / Sheets / Slides come as docx / xlsx /
// pptx, Drawings as pdf; other Google types (Forms, Sites, shortcuts) are not
// listed. Limits: LIST_PER_MINUTE, IMPORTS_PER_HOUR, CONNECTS_PER_HOUR per
// plugin and person; IMPORTS_PER_PLUGIN / IMPORTS_TOTAL at the same time;
// a list within LIST_TIMEOUT_MS, an import within IMPORT_TIMEOUT_MS.

const cloud = require('../cloudAccounts');
const http = require('../cloudAccounts/http');
const providers = require('../cloudAccounts/providers');

const { CloudError } = http;

const LIST_PER_MINUTE = 120;
const IMPORTS_PER_HOUR = 3000;
const CONNECTS_PER_HOUR = 30;
const IMPORTS_PER_PLUGIN = 4;
const IMPORTS_TOTAL = 8;
const LIST_TIMEOUT_MS = 30 * 1000;
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
const EXPORT_MAX_BYTES = 64 * 1024 * 1024; // Google exports at most 10 MB anyway
const PAGE = 100;

const FOLDER = 'application/vnd.google-apps.folder';
const OOXML = 'application/vnd.openxmlformats-officedocument.';
const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': { mime: OOXML + 'wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: OOXML + 'spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: OOXML + 'presentationml.presentation', ext: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
};
const GOOGLE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MS_ID_RE = /^[A-Za-z0-9!._-]{1,200}$/;

function fail(code, message) { throw new CloudError(code, message); }
function need(cond, code, message) { if (!cond) fail(code, message); }

function declared(plugin) {
  const c = plugin && plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.cloudImport;
  return !!(c && typeof c === 'object');
}

// ─── Budgets ────────────────────────────────────

const windows = new Map(); // `${kind}:${plugin}:${user}` → [timestamps]
const running = new Map(); // plugin id → imports running
let runningTotal = 0;

function budget(kind, plugin, user, max, windowMs) {
  const k = `${kind}:${plugin.id}:${user}`;
  const now = Date.now();
  const list = (windows.get(k) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { windows.set(k, list); fail('ERR_RATE_LIMIT', `too many ${kind} calls — try again later`); }
  list.push(now);
  windows.set(k, list);
  if (windows.size > 20000) windows.clear();
}

// ─── Arguments ──────────────────────────────────

function args0(a) { return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; }

function userOf(a) {
  const uid = a.user;
  need(cloud.userEnabled(uid), 'ERR_INVALID', 'user: an enabled person');
  return uid;
}

/** The person's connection in this plugin (ERR_CLOUD_NOT_FOUND) with its app set up (ERR_CLOUD_NOT_CONFIGURED). */
function connectionOf(plugin, uid, a) {
  const row = cloud.connectionRow(plugin.id, uid, a.connection);
  need(row, 'ERR_CLOUD_NOT_FOUND', 'no such connection');
  cloud.needApp(row.provider);
  return row;
}

function idOf(provider, v, what) {
  need(typeof v === 'string' && (provider === 'google' ? GOOGLE_ID_RE : MS_ID_RE).test(v), 'ERR_INVALID', `${what}: invalid`);
  return v;
}

/** Run `fn` within `ms` (ERR_TIMEOUT); `onTimeout` stops what is still running. */
async function within(ms, fn, onTimeout) {
  let timer;
  const t = new Promise((_r, rej) => { timer = setTimeout(() => { try { if (onTimeout) onTimeout(); } catch { /* stopping */ } rej(new CloudError('ERR_TIMEOUT', 'the provider took too long')); }, ms); });
  try { return await Promise.race([fn(), t]); } finally { clearTimeout(timer); }
}

function isoOrNull(v) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }

// ─── list ───────────────────────────────────────

function googleItem(f) {
  const isDir = f.mimeType === FOLDER;
  const exp = GOOGLE_EXPORT[f.mimeType];
  if (!isDir && !exp && String(f.mimeType || '').startsWith('application/vnd.google-apps.')) return null; // forms, sites, shortcuts …
  const name = String(f.name || '');
  return {
    id: String(f.id), name: exp && !name.toLowerCase().endsWith('.' + exp.ext) ? `${name}.${exp.ext}` : name, isDir,
    size: isDir || exp || f.size == null ? null : Number(f.size), mime: isDir ? null : (exp ? exp.mime : (f.mimeType || null)),
    modifiedAt: isoOrNull(f.modifiedTime),
  };
}

function msItem(f) {
  if (f.package || f.remoteItem) return null; // OneNote notebooks, items of other drives
  const isDir = !!f.folder;
  return {
    id: String(f.id), name: String(f.name || ''), isDir, size: isDir || f.size == null ? null : Number(f.size),
    mime: isDir ? null : ((f.file && f.file.mimeType) || mimeOfName(f.name)), modifiedAt: isoOrNull(f.lastModifiedDateTime),
  };
}

function mimeOfName(name) { return require('./mediaAreas').mimeOf(String(name || '')); }

const MS_NEXT_PREFIX = `${providers.GRAPH}/me/drive/`;

async function list(plugin, a) {
  const uid = userOf(a);
  const row = connectionOf(plugin, uid, a);
  budget('list', plugin, uid, LIST_PER_MINUTE, 60 * 1000);
  const api = cloud.connectionApi(row);
  let url;
  if (row.provider === 'google') {
    const folder = a.folderId == null || a.folderId === '' ? 'root' : idOf('google', a.folderId, 'folderId');
    need(a.cursor == null || (typeof a.cursor === 'string' && a.cursor.length <= 4096 && /^[\x21-\x7e]+$/.test(a.cursor)), 'ERR_INVALID', 'cursor: invalid');
    const q = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false`, pageSize: String(PAGE), orderBy: 'folder,name',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (a.cursor) q.set('pageToken', a.cursor);
    url = `${providers.GOOGLE.drive}/files?${q.toString()}`;
  } else if (a.cursor) {
    let next = '';
    try { next = Buffer.from(String(a.cursor), 'base64url').toString('utf8'); } catch { next = ''; }
    need(typeof a.cursor === 'string' && a.cursor.length <= 8192 && next.startsWith(MS_NEXT_PREFIX) && !/[\s\\]/.test(next), 'ERR_INVALID', 'cursor: invalid');
    url = next;
  } else {
    const where = a.folderId == null || a.folderId === '' ? 'root' : `items/${encodeURIComponent(idOf('microsoft', a.folderId, 'folderId'))}`;
    url = `${providers.GRAPH}/me/drive/${where}/children?$top=${PAGE}&$select=id,name,size,file,folder,package,remoteItem,lastModifiedDateTime`;
  }
  return within(LIST_TIMEOUT_MS, async () => {
    const res = await api.call({ url, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw await providers.apiError(res, 'list');
    const json = await http.readJson(res.stream);
    if (row.provider === 'google') {
      const items = (Array.isArray(json.files) ? json.files : []).map(googleItem).filter(Boolean);
      return { items, next: typeof json.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : null };
    }
    const items = (Array.isArray(json.value) ? json.value : []).map(msItem).filter(Boolean);
    const next = typeof json['@odata.nextLink'] === 'string' && json['@odata.nextLink'].startsWith(MS_NEXT_PREFIX) ? Buffer.from(json['@odata.nextLink']).toString('base64url') : null;
    return { items, next };
  });
}

// ─── import ─────────────────────────────────────

const MEDIA_ERRORS = { unsupported_type: 'ERR_MEDIA_TYPE', too_large: 'ERR_CLOUD_TOO_LARGE', quota_exceeded: 'ERR_MEDIA_QUOTA', empty: 'ERR_MEDIA_EMPTY',
  server_full: 'ERR_MEDIA_QUOTA', storage_unavailable: 'ERR_BUSY', length_mismatch: 'ERR_CLOUD_PROVIDER', aborted: 'ERR_CLOUD_PROVIDER' };

function mediaFailure(media, e, timedOut) {
  if (timedOut) return new CloudError('ERR_TIMEOUT', 'the download did not finish in time');
  if (e instanceof media.MediaError) return new CloudError(MEDIA_ERRORS[e.code] || 'ERR_CLOUD_PROVIDER', e.code === 'length_mismatch' || e.code === 'aborted' ? 'the download broke off' : e.code);
  return e;
}

/** Type, size and quota before a byte is fetched. */
function precheck(plugin, media, decl, mime, size) {
  need(media.typeAllowed(decl, mime), 'ERR_MEDIA_TYPE', `type ${mime || '(none)'} is not declared in media.types`);
  if (size != null) {
    need(size >= 1, 'ERR_MEDIA_EMPTY', 'the file is empty');
    need(size <= decl.maxBytes, 'ERR_CLOUD_TOO_LARGE', `the file is larger than ${decl.maxBytes} bytes`);
    need(media.usage(plugin.id).bytes + size <= media.quotaOf(plugin), 'ERR_MEDIA_QUOTA', 'the media quota is used up');
  }
}

async function importFile(plugin, a) {
  const media = require('./media');
  const decl = media.declOf(plugin);
  need(decl, 'ERR_MEDIA_DENIED', 'plugin.json declares no media');
  const uid = userOf(a);
  const row = connectionOf(plugin, uid, a);
  const fileId = idOf(row.provider, a.fileId, 'fileId');
  budget('import', plugin, uid, IMPORTS_PER_HOUR, 3600 * 1000);
  const mine = running.get(plugin.id) || 0;
  need(mine < IMPORTS_PER_PLUGIN && runningTotal < IMPORTS_TOTAL, 'ERR_RATE_LIMIT', 'too many imports at the same time — try again shortly');
  running.set(plugin.id, mine + 1);
  runningTotal++;
  const streams = [];
  let timedOut = false;
  try {
    return await within(IMPORT_TIMEOUT_MS, async () => {
      try {
        return await (row.provider === 'google' ? importGoogle : importMicrosoft)(plugin, media, decl, cloud.connectionApi(row), fileId, uid, streams);
      } catch (e) { throw mediaFailure(media, e, timedOut); }
    }, () => { timedOut = true; for (const s of streams) s.destroy(new CloudError('ERR_TIMEOUT', 'the download did not finish in time')); });
  } finally {
    const n = (running.get(plugin.id) || 1) - 1;
    if (n > 0) running.set(plugin.id, n); else running.delete(plugin.id);
    runningTotal = Math.max(0, runningTotal - 1);
  }
}

function done(stored, size, mime, modifiedAt) {
  return { mediaId: stored.mediaId, name: stored.name, size: stored.bytes != null ? stored.bytes : size, mime: stored.mime || mime, modifiedAt };
}

async function importGoogle(plugin, media, decl, api, fileId, uid, streams) {
  const base = `${providers.GOOGLE.drive}/files/${encodeURIComponent(fileId)}`;
  const m = await api.call({ url: `${base}?fields=id,name,mimeType,size,modifiedTime,trashed&supportsAllDrives=true` });
  if (m.status !== 200) throw await providers.apiError(m, 'file');
  const f = await http.readJson(m.stream, 256 * 1024);
  need(f.mimeType !== FOLDER, 'ERR_INVALID', 'a folder cannot be imported — list it and import its files');
  const item = googleItem(f);
  need(item && !f.trashed, 'ERR_CLOUD_NOT_FOUND', 'this file cannot be imported');
  const exp = GOOGLE_EXPORT[f.mimeType];
  if (exp) {
    precheck(plugin, media, decl, exp.mime, null);
    const res = await api.call({ url: `${base}/export?mimeType=${encodeURIComponent(exp.mime)}` });
    if (res.status !== 200) throw await providers.apiError(res, 'export');
    streams.push(res.stream);
    let buf;
    try { buf = await http.readBody(res.stream, Math.min(decl.maxBytes, EXPORT_MAX_BYTES)); } catch (e) {
      if (e && e.code === 'ERR_CLOUD_TOO_LARGE') fail('ERR_CLOUD_TOO_LARGE', 'the exported file is too large');
      throw e;
    }
    precheck(plugin, media, decl, exp.mime, buf.length);
    return done(await media.storeBuffer(plugin, buf, { mime: exp.mime, name: item.name, owner: uid }), buf.length, exp.mime, item.modifiedAt);
  }
  const size = Number(f.size);
  need(Number.isSafeInteger(size), 'ERR_CLOUD_PROVIDER', 'the provider names no size');
  const mime = typeOf(media, f.mimeType, item.name);
  precheck(plugin, media, decl, mime, size);
  const res = await api.call({ url: `${base}?alt=media&supportsAllDrives=true` });
  if (res.status !== 200) throw await providers.apiError(res, 'download');
  streams.push(res.stream);
  return done(await media.storeStream(plugin, res.stream, { length: size, mime, name: item.name, owner: uid }), size, mime, item.modifiedAt);
}

async function importMicrosoft(plugin, media, decl, api, fileId, uid, streams) {
  const base = `${providers.GRAPH}/me/drive/items/${encodeURIComponent(fileId)}`;
  const m = await api.call({ url: `${base}?$select=id,name,size,file,folder,package,remoteItem,lastModifiedDateTime` });
  if (m.status !== 200) throw await providers.apiError(m, 'file');
  const f = await http.readJson(m.stream, 256 * 1024);
  need(!f.folder, 'ERR_INVALID', 'a folder cannot be imported — list it and import its files');
  const item = msItem(f);
  need(item && f.file, 'ERR_CLOUD_NOT_FOUND', 'this file cannot be imported');
  const size = Number(f.size);
  need(Number.isSafeInteger(size), 'ERR_CLOUD_PROVIDER', 'the provider names no size');
  const mime = typeOf(media, f.file.mimeType, item.name);
  precheck(plugin, media, decl, mime, size);
  let res = await api.call({ url: `${base}/content` });
  // Graph answers with a redirect to a pre-authenticated address on its storage hosts (http.js: no token there)
  if (res.status === 302 || res.status === 301 || res.status === 307) {
    const loc = res.headers.location;
    await http.drain(res.stream);
    need(typeof loc === 'string' && loc, 'ERR_CLOUD_PROVIDER', 'download: no address');
    res = await http.request({ url: loc, content: true });
  }
  if (res.status !== 200) throw await providers.apiError(res, 'download');
  streams.push(res.stream);
  return done(await media.storeStream(plugin, res.stream, { length: size, mime, name: item.name, owner: uid }), size, mime, item.modifiedAt);
}

/** The provider's type; a generic or missing one from the file name. */
function typeOf(media, mime, name) {
  const t = media.baseType(mime);
  return !t || t === 'application/octet-stream' || t === 'binary/octet-stream' ? mimeOfName(name) : t;
}

// ─── Entry ──────────────────────────────────────

async function call(plugin, op, raw) {
  need(declared(plugin), 'ERR_CLOUD_DENIED', 'this plugin has no cloud import permission (permissions.cloudImport)');
  const a = args0(raw);
  switch (op) {
    case 'available': return cloud.available();
    case 'connectUrl': {
      const uid = userOf(a);
      need(cloud.PROVIDERS.includes(a.provider), 'ERR_INVALID', "provider: 'google' or 'microsoft'");
      const rt = cloud.checkReturnTo(a.returnTo);
      need(rt, 'ERR_INVALID', 'returnTo: a /portal… path or a gatecontrol:// address');
      budget('connect', plugin, uid, CONNECTS_PER_HOUR, 3600 * 1000);
      return { url: cloud.createFlow({ provider: a.provider, purpose: 'import', userId: uid, pluginId: plugin.id, returnTo: rt }).url };
    }
    case 'connections': return cloud.connections(plugin.id, userOf(a));
    case 'disconnect': return cloud.disconnect(plugin.id, userOf(a), a.connection);
    case 'list': return list(plugin, a);
    case 'import': return importFile(plugin, a);
    default: return fail('ERR_UNKNOWN_API', 'unknown host API');
  }
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  windows.clear();
  running.clear();
  runningTotal = 0;
}

module.exports = {
  call, declared, GOOGLE_EXPORT, LIST_PER_MINUTE, IMPORTS_PER_HOUR, CONNECTS_PER_HOUR, IMPORTS_PER_PLUGIN, IMPORTS_TOTAL,
  LIST_TIMEOUT_MS, IMPORT_TIMEOUT_MS, CALL_TIMEOUT_MS: IMPORT_TIMEOUT_MS + 60 * 1000, _resetForTest,
};
