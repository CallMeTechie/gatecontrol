'use strict';

// Public download links of plugins (docs/plugins.md "Public links",
// services/plugins/publicLinks.js, since 1.193.0) — no login; mounted in
// routes/index.js before every authenticated route:
//
//   GET  /s/<token>            the page (templates/public-link.njk, de/en by
//                              the browser's Accept-Language): title, sender,
//                              expiry; with a PIN first only the PIN form,
//                              then the note, the files with their sizes, a
//                              download button each and "Alle als ZIP"
//   POST /s/<token>/unlock     { pin } (form or JSON) → 303 back to the page
//                              with the unlock cookie (JSON: { ok: true });
//                              wrong → 403 (the page with the attempts left,
//                              JSON { ok: false, code: 'wrong_pin', left }),
//                              the fifth wrong PIN locks the link (410)
//   GET  /s/<token>/f/<n>      file n (1 …) as a download: Range, the name as
//                              Content-Disposition attachment (UTF-8); a counted
//                              download sets the file's resume cookie — only with
//                              it a Range later in the file is free (publicLinks.js
//                              "Downloads"), else it counts like a new download
//   GET  /s/<token>/zip        every file of the link as one ZIP (stored,
//                              streamed, Content-Length known)
//
// Unknown token → 404, an ended link (expired, revoked, locked, used up, a
// file deleted) → 410, a PIN link without the unlock cookie → 403 (files) or
// the PIN form (page). Every answer: no-store, noindex, no referrer, nosniff;
// the page a strict CSP without scripts. Nothing but the files of that link
// is ever served — the media ids come from the link's own rows.

const { Router } = require('express');
const links = require('../services/plugins/publicLinks');
const media = require('../services/plugins/media');
const { zipStream, zipLength } = require('../services/plugins/zipStream');
const { publicLinkLimiter, publicLinkUnlockLimiter } = require('../middleware/rateLimit');
const logger = require('../utils/logger');

const router = Router();
const FILE_RE = /^[1-9]\d?$/;

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

/** The page: `view.kind` 'missing' | 'expired' | 'revoked' | 'locked' | 'used' | 'gone' | 'pin' | 'files'. */
function page(req, res, status, view) {
  baseHeaders(res);
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'self' 'nonce-${res.locals.cspNonce}'; img-src 'self' data:; `
    + "font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return res.status(status).render('public-link.njk', { ...view, lang: lang(req) });
}

/** Title, sender and expiry every view of a known link shows. */
function head(r, req) {
  return { title: r.link.title, sender: links.senderName(r.link), expires: fmtDate(Date.parse(r.link.expires_at), lang(req)) };
}

function token(req) {
  const t = String(req.params.token || '');
  return links.TOKEN_RE.test(t) ? t : null;
}

function wantsJson(req) {
  return req.is('application/json') === 'application/json' || /^application\/json/i.test(String(req.headers.accept || ''));
}

// ─── The page ───────────────────────────────────

router.get('/s/:token', publicLinkLimiter, (req, res) => {
  const t = token(req);
  const r = t ? links.resolve(t) : null;
  if (!r) return page(req, res, 404, { kind: 'missing' });
  if (r.state !== 'active') return page(req, res, 410, { kind: r.state, ...head(r, req) });
  if (!links.unlocked(req, r.link)) return page(req, res, 200, { kind: 'pin', token: t, ...head(r, req), count: r.files.length });
  const files = r.files.map((f) => ({
    href: `/s/${t}/f/${f.idx}`, name: f.name || f.media_name || `file-${f.idx}`, size: fmtBytes(f.bytes), usedUp: links.fileUsedUp(r.link, f),
  }));
  return page(req, res, 200, {
    kind: 'files', token: t, ...head(r, req), note: r.link.note, files,
    total: fmtBytes(r.files.reduce((n, f) => n + f.bytes, 0)),
    zip: r.files.length > 1 && !files.some((f) => f.usedUp) ? `/s/${t}/zip` : null,
  });
});

// ─── PIN ────────────────────────────────────────

router.post('/s/:token/unlock', publicLinkUnlockLimiter, async (req, res) => {
  const t = token(req);
  const json = wantsJson(req);
  // a form of this page only: a foreign Origin never tries PINs in a visitor's name
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let same = false;
    try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
    if (!same) { baseHeaders(res); return res.status(403).type('text/plain').send('forbidden'); }
  }
  const r = t ? links.resolve(t) : null;
  if (!r) {
    if (json) { baseHeaders(res); return res.status(404).json({ ok: false, code: 'not_found' }); }
    return page(req, res, 404, { kind: 'missing' });
  }
  if (r.state !== 'active') {
    if (json) { baseHeaders(res); return res.status(410).json({ ok: false, code: r.state }); }
    return page(req, res, 410, { kind: r.state, ...head(r, req) });
  }
  const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  let out;
  try { out = await links.tryPin(r.link, pin); } catch (e) {
    logger.warn({ plugin: r.link.plugin, err: e.message }, 'public link: PIN check failed');
    out = { ok: false, locked: false, left: 0 };
  }
  baseHeaders(res);
  if (out.ok) {
    res.setHeader('Set-Cookie', links.unlockCookie(r.link, t));
    return json ? res.json({ ok: true }) : res.redirect(303, `/s/${t}`);
  }
  if (out.locked) return json ? res.status(410).json({ ok: false, code: 'locked' }) : page(req, res, 410, { kind: 'locked', ...head(r, req) });
  return json ? res.status(403).json({ ok: false, code: 'wrong_pin', left: out.left })
    : page(req, res, 403, { kind: 'pin', token: t, ...head(r, req), count: r.files.length, wrong: true, left: out.left });
});

// ─── Files ──────────────────────────────────────

/** The link of a download request, or null (answered: 404 / 410 / 403). */
function servable(req, res) {
  baseHeaders(res);
  const t = token(req);
  const r = t ? links.resolve(t) : null;
  if (!r) { res.status(404).type('text/plain').send('not found'); return null; }
  if (r.state !== 'active') { res.status(410).type('text/plain').send(r.state); return null; }
  if (!links.unlocked(req, r.link)) { res.status(403).type('text/plain').send('pin required'); return null; }
  return r;
}

router.get('/s/:token/f/:n', publicLinkLimiter, async (req, res) => {
  const r = servable(req, res);
  if (!r) return undefined;
  const n = FILE_RE.test(String(req.params.n || '')) ? Number(req.params.n) : 0;
  const f = r.files.find((x) => x.idx === n);
  const row = f ? media.row(r.link.plugin, f.media_id) : null;
  if (!f || !row) return res.status(404).type('text/plain').send('not found');
  const range = media.parseRange(req.headers.range, row.bytes);
  if (range !== false && req.method === 'GET') {
    const start = range ? range.start : 0;
    // from 0, or a continuation without this client's resume cookie: a new, counted download
    if (start === 0 || !links.mayResume(req, r.link, f)) {
      if (!links.countDownload(r.link, [f])) return res.status(410).type('text/plain').send('used');
      res.setHeader('Set-Cookie', links.resumeCookie(r.link, req.params.token, f));
    }
  }
  return media.send(req, res, row, 'no-store', { attachment: true, name: f.name || row.name || `file-${f.idx}` });
});

router.get('/s/:token/zip', publicLinkLimiter, async (req, res) => {
  const r = servable(req, res);
  if (!r) return undefined;
  const rows = r.files.map((f) => ({ f, row: media.row(r.link.plugin, f.media_id) }));
  if (!rows.length || rows.some((x) => !x.row)) return res.status(404).type('text/plain').send('not found');
  if (r.files.some((f) => links.fileUsedUp(r.link, f))) return res.status(410).type('text/plain').send('used');
  const entries = rows.map(({ f, row }) => ({
    name: f.name || row.name || `file-${f.idx}`, size: row.bytes, read: () => media.readRange(row, 0, row.bytes - 1),
  }));
  const zipName = `${media.cleanName(r.link.title) || 'download'}.zip`;
  // counted before the first byte (atomic: a parallel download of a last file loses here)
  if (req.method === 'GET' && !links.countDownload(r.link, r.files, { zip: true })) return res.status(410).type('text/plain').send('used');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', media.contentDisposition('attachment', zipName, 'download.zip'));
  res.setHeader('Content-Length', String(zipLength(entries)));
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (req.method === 'HEAD') return res.end();
  try {
    for await (const part of zipStream(entries, new Date(r.link.created_at))) {
      if (res.destroyed) return undefined;
      if (!res.write(part)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
    }
    return res.end();
  } catch (e) {
    logger.warn({ plugin: r.link.plugin, err: e.message }, 'public link: zip failed');
    return res.destroy();
  }
});

module.exports = router;
