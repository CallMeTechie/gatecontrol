'use strict';

// Public links of plugins (docs/plugins.md "Public links",
// services/plugins/publicLinks.js, since 1.193.0; Links v2 since 1.206.0) —
// no login; mounted in routes/index.js before every authenticated route:
//
//   GET  /s/<token>            the page (templates/public-link.njk, de/en by
//                              the browser's Accept-Language): title, sender,
//                              expiry; with a PIN first only the PIN form.
//                              Kind 'files': the note, the files with their
//                              sizes, a download button each and "Alle als ZIP"
//                              (mode 'view': "Ansehen" for pictures, videos and
//                              sound, no download). Kind 'folder' (?p=<sub
//                              folder>): breadcrumbs, its sub folders, a
//                              gallery of pictures and videos, the other files,
//                              "Ordner als ZIP". Kind 'upload': name field,
//                              file choice (script /js/public-link-upload.js),
//                              the limits and the visitor's own uploads
//   POST /s/<token>/unlock     { pin } (form or JSON) → 303 back to the page
//                              with the unlock cookie (JSON: { ok: true });
//                              wrong → 403 (the page with the attempts left,
//                              JSON { ok: false, code: 'wrong_pin', left }),
//                              the fifth wrong PIN locks the link (410)
//   GET  /s/<token>/f/<n>      file n (1 …) of a 'files' link as a download:
//                              Range, the name as Content-Disposition
//                              attachment (UTF-8); a counted download sets the
//                              file's resume cookie — only with it a Range later
//                              in the file is free (publicLinks.js "Downloads"),
//                              else it counts like a new download. ?view=1: a
//                              picture / video / sound inline, not counted
//                              (mode 'view': only that)
//   GET  /s/<token>/m/<id>     a file of a 'folder' link (below its folder, a
//                              current file): download (logged), ?view=1 inline
//                              for pictures / videos / sound (mode 'view': only that)
//   GET  /s/<token>/zip        every file of a 'files' link, or of the folder
//                              ?p= of a 'folder' link with its sub folders, as one
//                              ZIP (stored, streamed, Content-Length known)
//   PUT  /s/<token>/u          ?name=<file name>&by=<name>&type=<MIME> — one file
//                              into an 'upload' link (the body is the file;
//                              Content-Length; same origin) → { ok, name, bytes }
//
// Unknown token → 404, an ended link (expired, revoked, locked, used up, a
// file deleted, the area gone) → 410, a PIN link without the unlock cookie →
// 403 (files) or the PIN form (page). Every answer: no-store, noindex, no
// referrer, nosniff; the pages a strict CSP (scripts only on the upload page,
// from this server). Nothing but what belongs to that link is ever served —
// the media ids come from the link's own rows or are checked against its folder.

const { Router } = require('express');
const links = require('../services/plugins/publicLinks');
const media = require('../services/plugins/media');
const { zipStream, zipLength } = require('../services/plugins/zipStream');
const { publicLinkLimiter, publicLinkUnlockLimiter, publicLinkMediaLimiter, publicLinkUploadLimiter } = require('../middleware/rateLimit');
const logger = require('../utils/logger');

const router = Router();
const FILE_RE = /^[1-9]\d?$/;
const ID_RE = /^[0-9a-f]{32}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const ZIP_ENTRY_MAX = 0xfffffffe;

function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

function lang(req) { return req.language === 'en' ? 'en' : 'de'; }

function fmtDate(ms, l) {
  try { return new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)); } catch { return new Date(ms).toISOString(); }
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : (v < 10 ? v.toFixed(1) : Math.round(v))} ${units[i]}`;
}

/** Shown in the page (inline) — pictures, videos, sound; never a type a browser would run. */
function previewable(mime) {
  return media.INLINE_RE.test(String(mime || '')) && !require('../services/plugins/manifest').MIME_DENY_RE.test(String(mime || ''));
}

/**
 * The page: `view.kind` 'missing' | 'expired' | 'revoked' | 'locked' | 'used'
 * | 'gone' | 'pin' | 'files' | 'folder' | 'upload'. Scripts only for the
 * upload page (its own file from this server); pictures and videos from here.
 */
function page(req, res, status, view) {
  baseHeaders(res);
  const script = view.kind === 'upload' ? "script-src 'self'; connect-src 'self'; " : '';
  res.setHeader('Content-Security-Policy', `default-src 'none'; ${script}style-src 'self' 'nonce-${res.locals.cspNonce}'; img-src 'self' data:; `
    + "media-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return res.status(status).render('public-link.njk', { ...view, lang: lang(req) });
}

/** Title, sender and expiry every view of a known link shows. */
function head(r, req) {
  return {
    title: r.link.title, sender: links.senderName(r.link),
    expires: r.link.no_expiry ? null : fmtDate(Date.parse(r.link.expires_at), lang(req)),
  };
}

function token(req) {
  const t = String(req.params.token || '');
  return links.TOKEN_RE.test(t) ? t : null;
}

function wantsJson(req) {
  return req.is('application/json') === 'application/json' || /^application\/json/i.test(String(req.headers.accept || ''));
}

/** The visitor's id; a new one gets its cookie. */
function visitorOf(req, res, t) {
  const v = links.visitor(req, t);
  if (v.cookie) res.append('Set-Cookie', v.cookie);
  return v.id;
}

/** A request of this server's own pages (no foreign Origin). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// ─── The page ───────────────────────────────────

function filesView(r, t) {
  const viewOnly = r.link.mode === 'view';
  const files = r.files.map((f) => ({
    href: `/s/${t}/f/${f.idx}`, view: previewable(f.mime) ? `/s/${t}/f/${f.idx}?view=1` : null, name: f.name || f.media_name || `file-${f.idx}`,
    size: fmtBytes(f.bytes), usedUp: links.fileUsedUp(r.link, f),
  }));
  return {
    kind: 'files', viewOnly, files, note: r.link.note,
    total: fmtBytes(r.files.reduce((n, f) => n + f.bytes, 0)),
    zip: !viewOnly && r.files.length > 1 && !files.some((f) => f.usedUp) ? `/s/${t}/zip` : null,
  };
}

function folderView(r, t, req) {
  const sub = typeof req.query.p === 'string' ? req.query.p : '';
  const full = links.folderPath(r.link, sub);
  if (full == null) return null;
  const root = r.link.root_path || '';
  const rel = root ? full.slice(root.length).replace(/^\//, '') : full;
  const q = (p) => (p ? `/s/${t}?p=${encodeURIComponent(p)}` : `/s/${t}`);
  const list = links.listFolder(r.link, full);
  const viewOnly = r.link.mode === 'view';
  const crumbs = [{ name: null, href: q('') }];
  const segs = rel ? rel.split('/') : [];
  segs.forEach((s, i) => crumbs.push({ name: s, href: q(segs.slice(0, i + 1).join('/')) }));
  const gallery = [];
  const others = [];
  for (const f of list.files) {
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    const item = { name, size: fmtBytes(f.bytes), href: viewOnly ? null : `/s/${t}/m/${f.id}`, view: previewable(f.mime) ? `/s/${t}/m/${f.id}?view=1` : null,
      image: /^image\//.test(f.mime), video: /^video\//.test(f.mime), audio: /^audio\//.test(f.mime) };
    if ((item.image || item.video) && item.view) gallery.push(item);
    else others.push(item);
  }
  return {
    kind: 'folder', viewOnly, note: r.link.note, crumbs, here: segs.length ? segs[segs.length - 1] : null,
    folders: list.folders.map((n) => ({ name: n, href: q(rel ? `${rel}/${n}` : n) })),
    gallery, files: others, more: list.more, empty: !list.folders.length && !list.files.length,
    zip: !viewOnly && (list.folders.length || list.files.length) ? `/s/${t}/zip${rel ? `?p=${encodeURIComponent(rel)}` : ''}` : null,
  };
}

function uploadView(r, t, visitorId) {
  const l = r.link;
  const types = (() => { try { return l.upload_types ? JSON.parse(l.upload_types) : null; } catch { return null; } })();
  const decl = media.declOf(r.plugin);
  const left = Math.max(0, l.upload_max_files - l.uploads);
  const bytesLeft = Math.max(0, l.upload_max_bytes - l.upload_bytes);
  return {
    kind: 'upload', token: t, note: l.note, types: types ? types.join(', ') : null,
    accept: types ? types.join(',') : null,
    filesLeft: left, bytesLeft: fmtBytes(bytesLeft), bytesLeftRaw: bytesLeft, perFile: fmtBytes(decl ? decl.maxBytes : 0), perFileRaw: decl ? decl.maxBytes : 0,
    full: left === 0 || bytesLeft === 0,
    mine: links.visitorUploads(l, visitorId).map((u) => ({ name: u.name, size: fmtBytes(u.bytes) })),
  };
}

router.get('/s/:token', publicLinkLimiter, (req, res) => {
  const t = token(req);
  const r = t ? links.resolve(t) : null;
  if (!r) return page(req, res, 404, { kind: 'missing' });
  if (r.state !== 'active') return page(req, res, 410, { kind: r.state, ...head(r, req) });
  const vid = visitorOf(req, res, t);
  if (!links.unlocked(req, r.link)) return page(req, res, 200, { kind: 'pin', token: t, ...head(r, req), count: r.files.length });
  let v;
  if (r.link.kind === 'folder') v = folderView(r, t, req);
  else if (r.link.kind === 'upload') v = uploadView(r, t, vid);
  else v = filesView(r, t);
  if (!v) return page(req, res, 404, { kind: 'missing' });
  links.noteOpen(r.link, req, vid);
  return page(req, res, 200, { token: t, ...head(r, req), ...v });
});

// ─── PIN ────────────────────────────────────────

router.post('/s/:token/unlock', publicLinkUnlockLimiter, async (req, res) => {
  const t = token(req);
  const json = wantsJson(req);
  // a form of this page only: a foreign Origin never tries PINs in a visitor's name
  if (!sameOrigin(req)) { baseHeaders(res); return res.status(403).type('text/plain').send('forbidden'); }
  const r = t ? links.resolve(t) : null;
  if (!r) {
    if (json) { baseHeaders(res); return res.status(404).json({ ok: false, code: 'not_found' }); }
    return page(req, res, 404, { kind: 'missing' });
  }
  if (r.state !== 'active') {
    if (json) { baseHeaders(res); return res.status(410).json({ ok: false, code: r.state }); }
    return page(req, res, 410, { kind: r.state, ...head(r, req) });
  }
  const vid = links.visitor(req, t).id;
  const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  let out;
  try { out = await links.tryPin(r.link, pin, { req, visitorId: vid }); } catch (e) {
    logger.warn({ plugin: r.link.plugin, err: e.message }, 'public link: PIN check failed');
    out = { ok: false, locked: false, left: 0 };
  }
  baseHeaders(res);
  if (out.ok) {
    res.append('Set-Cookie', links.unlockCookie(r.link, t));
    return json ? res.json({ ok: true }) : res.redirect(303, `/s/${t}`);
  }
  if (out.locked) return json ? res.status(410).json({ ok: false, code: 'locked' }) : page(req, res, 410, { kind: 'locked', ...head(r, req) });
  return json ? res.status(403).json({ ok: false, code: 'wrong_pin', left: out.left })
    : page(req, res, 403, { kind: 'pin', token: t, ...head(r, req), count: r.files.length, wrong: true, left: out.left });
});

// ─── Files ──────────────────────────────────────

/** The link of a request, or null (answered: 404 / 410 / 403). `kinds`: the link kinds this route serves. */
function servable(req, res, kinds) {
  baseHeaders(res);
  const t = token(req);
  const r = t ? links.resolve(t) : null;
  if (!r || !kinds.includes(r.link.kind)) { res.status(404).type('text/plain').send('not found'); return null; }
  if (r.state !== 'active') { res.status(410).type('text/plain').send(r.state); return null; }
  if (!links.unlocked(req, r.link)) { res.status(403).type('text/plain').send('pin required'); return null; }
  return r;
}

router.get('/s/:token/f/:n', publicLinkLimiter, async (req, res) => {
  const r = servable(req, res, ['files']);
  if (!r) return undefined;
  const n = FILE_RE.test(String(req.params.n || '')) ? Number(req.params.n) : 0;
  const f = r.files.find((x) => x.idx === n);
  const row = f ? media.row(r.link.plugin, f.media_id) : null;
  if (!f || !row) return res.status(404).type('text/plain').send('not found');
  const name = f.name || row.name || `file-${f.idx}`;
  // looked at in the page: pictures, videos, sound inline — not a download
  if (req.query.view === '1') {
    if (!previewable(row.mime)) return res.status(403).type('text/plain').send('no preview');
    return media.send(req, res, row, 'no-store', { name });
  }
  if (r.link.mode === 'view') return res.status(403).type('text/plain').send('view only');
  const range = media.parseRange(req.headers.range, row.bytes);
  if (range !== false && req.method === 'GET') {
    const start = range ? range.start : 0;
    // from 0, or a continuation without this client's resume cookie: a new, counted download
    if (start === 0 || !links.mayResume(req, r.link, f)) {
      if (!links.countDownload(r.link, [f], { req, visitorId: links.visitor(req, req.params.token).id })) return res.status(410).type('text/plain').send('used');
      res.append('Set-Cookie', links.resumeCookie(r.link, req.params.token, f));
    }
  }
  return media.send(req, res, row, 'no-store', { attachment: true, name });
});

router.get('/s/:token/m/:id', publicLinkMediaLimiter, async (req, res) => {
  const r = servable(req, res, ['folder']);
  if (!r) return undefined;
  const id = ID_RE.test(String(req.params.id || '')) ? req.params.id : null;
  const row = id ? links.folderFile(r.link, id) : null;
  if (!row) return res.status(404).type('text/plain').send('not found');
  const name = row.path.slice(row.path.lastIndexOf('/') + 1);
  if (req.query.view === '1') {
    if (!previewable(row.mime)) return res.status(403).type('text/plain').send('no preview');
    return media.send(req, res, row, 'no-store', { name });
  }
  if (r.link.mode === 'view') return res.status(403).type('text/plain').send('view only');
  const range = media.parseRange(req.headers.range, row.bytes);
  // a download from the start is logged (and the plugin told); continuations are not
  if (req.method === 'GET' && range !== false && (!range || range.start === 0)) {
    links.noteFolderDownload(r.link, { req, visitorId: links.visitor(req, req.params.token).id, name, mediaId: row.id, bytes: row.bytes, path: row.path });
  }
  return media.send(req, res, row, 'no-store', { attachment: true, name });
});

/** Stream `entries` as a ZIP named `zipName`. */
async function sendZip(req, res, entries, zipName, created, pluginId) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', media.contentDisposition('attachment', zipName, 'download.zip'));
  res.setHeader('Content-Length', String(zipLength(entries)));
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (req.method === 'HEAD') return res.end();
  try {
    for await (const part of zipStream(entries, created)) {
      if (res.destroyed) return undefined;
      if (!res.write(part)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
    }
    return res.end();
  } catch (e) {
    logger.warn({ plugin: pluginId, err: e.message }, 'public link: zip failed');
    return res.destroy();
  }
}

router.get('/s/:token/zip', publicLinkLimiter, async (req, res) => {
  const r = servable(req, res, ['files', 'folder']);
  if (!r) return undefined;
  if (r.link.mode === 'view') return res.status(403).type('text/plain').send('view only');
  const vid = links.visitor(req, req.params.token).id;
  if (r.link.kind === 'folder') {
    const sub = typeof req.query.p === 'string' ? req.query.p : '';
    const full = links.folderPath(r.link, sub);
    const list = full == null ? null : links.filesBelow(r.link, full);
    if (!list) return res.status(full == null ? 404 : 413).type('text/plain').send(full == null ? 'not found' : 'too many files');
    if (!list.length) return res.status(404).type('text/plain').send('empty');
    if (list.some((x) => x.row.bytes > ZIP_ENTRY_MAX)) return res.status(413).type('text/plain').send('a file is too large for a ZIP');
    const entries = list.map(({ row, rel }) => ({ name: rel, size: row.bytes, read: () => media.readRange(row, 0, row.bytes - 1) }));
    const base = full ? full.slice(full.lastIndexOf('/') + 1) : (r.link.title || 'download');
    if (req.method === 'GET') links.noteFolderDownload(r.link, { zip: true, req, visitorId: vid, bytes: list.reduce((n, x) => n + x.row.bytes, 0), path: full });
    return sendZip(req, res, entries, `${media.cleanName(base) || 'download'}.zip`, new Date(), r.link.plugin);
  }
  const rows = r.files.map((f) => ({ f, row: media.row(r.link.plugin, f.media_id) }));
  if (!rows.length || rows.some((x) => !x.row)) return res.status(404).type('text/plain').send('not found');
  if (r.files.some((f) => links.fileUsedUp(r.link, f))) return res.status(410).type('text/plain').send('used');
  const entries = rows.map(({ f, row }) => ({
    name: f.name || row.name || `file-${f.idx}`, size: row.bytes, read: () => media.readRange(row, 0, row.bytes - 1),
  }));
  // counted before the first byte (atomic: a parallel download of a last file loses here)
  if (req.method === 'GET' && !links.countDownload(r.link, r.files, { zip: true, req, visitorId: vid })) return res.status(410).type('text/plain').send('used');
  return sendZip(req, res, entries, `${media.cleanName(r.link.title) || 'download'}.zip`, new Date(r.link.created_at), r.link.plugin);
});

// ─── Uploads ────────────────────────────────────

const UPLOAD_STATUS = { name: 400, type: 415, limit: 413, exists: 409 };

router.put('/s/:token/u', publicLinkUploadLimiter, async (req, res) => {
  baseHeaders(res);
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, code: 'forbidden' });
  const t = token(req);
  const r = t ? links.resolve(t) : null;
  if (!r || r.link.kind !== 'upload') return res.status(404).json({ ok: false, code: 'not_found' });
  if (r.state !== 'active') return res.status(410).json({ ok: false, code: r.state });
  if (!links.unlocked(req, r.link)) return res.status(403).json({ ok: false, code: 'pin_required' });
  // the body is the file itself: one a body parser already read (JSON, a form) is refused
  if (req._body) return res.status(415).json({ ok: false, code: 'type' });
  const vid = visitorOf(req, res, t);
  // the browser names the type; the body comes as application/octet-stream (never parsed as JSON)
  const type = typeof req.query.type === 'string' && MIME_RE.test(req.query.type.toLowerCase()) ? req.query.type.toLowerCase() : null;
  if (type) req.headers['content-type'] = type;
  try {
    const out = await links.upload(r, req, { name: req.query.name, uploader: req.query.by, visitorId: vid });
    return res.json({ ok: true, name: out.name, bytes: out.bytes });
  } catch (e) {
    if (e instanceof links.LinkError) return res.status(UPLOAD_STATUS[e.code] || 400).json({ ok: false, code: e.code });
    if (e instanceof media.MediaError) return media.failure(res, e);
    const AreaError = require('../services/plugins/mediaAreas').AreaError;
    if (e instanceof AreaError) return res.status(e.status || 400).json({ ok: false, code: e.code });
    logger.warn({ plugin: r.link.plugin, err: e && e.message }, 'public link: upload failed');
    return res.status(500).json({ ok: false, code: 'internal' });
  }
});

module.exports = router;
