'use strict';

// MIME side of gc.mail (since 1.216.0): reading a mail (mailparser) into the
// contract's plain object, attachments either described only ('meta') or
// streamed into the plugin's media as unclaimed files ('media'), and writing
// one (nodemailer's MailComposer) from the plugin's message object.
// Attachments never pass through the plugin process.
// Since 1.219.0 invitations (iMIP): the text/calendar parts of a mail come
// along as `calendar` (also as attachments, as before), and a message can
// carry an `icalEvent` the host writes as text/calendar plus .ics.

const { PassThrough, Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { fail, need } = require('./net');

const COMPOSE_MAX_BYTES = 50 * 1024 * 1024;   // a whole mail the host writes or sends
const TEXT_MAX = 10 * 1024 * 1024;            // html / text of a message the plugin hands over
const ADDRESSES_MAX = 500;                    // to + cc + bcc
const ATTACHMENTS_MAX = 100;
const HEADERS_MAX = 20;
const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[^\s@<>()",;:\\[\]]{1,255}$/;
const MSGID_RE = /^<[^\s<>]{1,995}>$/;
const HEADER_RE = /^(?:X-[A-Za-z0-9-]{1,64}|List-Unsubscribe)$/i;
const CID_RE = /^[A-Za-z0-9._@$%+=-]{1,200}$/;
const MIME_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
const HAS_CTRL_RE = /[\u0000-\u001f\u007f]/;
// iMIP (since 1.219.0): the calendar parts of a mail and the invitation a mail carries
const CAL_MAX = 512 * 1024;                   // one calendar part / icalEvent.content
const CAL_PARTS_MAX = 3;                      // calendar parts per mail (the first ones)
const CAL_CANDIDATES_MAX = 10;                // parts read to find them
const CAL_TYPES = new Set(['text/calendar', 'application/ics', 'text/x-vcalendar']);
const CAL_METHODS = new Set(['REQUEST', 'REPLY', 'CANCEL', 'COUNTER', 'DECLINECOUNTER', 'PUBLISH']);
const ICAL_SEND_METHODS = new Set(['REQUEST', 'REPLY', 'CANCEL', 'COUNTER', 'DECLINECOUNTER']);

function media() { return require('../media'); }

// ─── Reading ────────────────────────────────────

/** "a" | { value } of mailparser → plain string or null */
function headerText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && typeof v.value === 'string') return v.value.trim() || null;
  return null;
}

/** mailparser address objects (also several headers and groups) → [{ name, address }] */
function addresses(v) {
  const out = [];
  const walk = (list) => {
    for (const a of list || []) {
      if (!a) continue;
      if (Array.isArray(a.group)) walk(a.group);
      else if (a.address || a.name) out.push({ name: String(a.name || ''), address: String(a.address || '') });
    }
  };
  for (const h of [].concat(v || [])) walk(h && h.value);
  return out;
}

function references(v) {
  const ids = [];
  for (const x of [].concat(v || [])) for (const m of String(x).match(/<[^<>\s]+>/g) || []) ids.push(m);
  return ids.slice(0, 100);
}

/** List-Unsubscribe of mailparser's `list` header → { url?, mail? } | null (only http(s) / mail addresses) */
function unsubscribe(list) {
  const u = list && list.unsubscribe;
  if (!u || typeof u !== 'object') return null;
  const out = {};
  if (typeof u.url === 'string' && /^https?:\/\//i.test(u.url) && u.url.length <= 2048) out.url = u.url;
  if (typeof u.mail === 'string' && u.mail.length <= 2048 && !HAS_CTRL_RE.test(u.mail)) out.mail = u.mail;
  return Object.keys(out).length ? out : null;
}

const MEDIA_CODES = { quota_exceeded: 'ERR_MEDIA_QUOTA', too_large: 'ERR_MEDIA_TOO_LARGE', no_media: 'ERR_MEDIA_DENIED', empty: 'ERR_MEDIA_EMPTY' };

/** iCalendar text with its folded lines joined (RFC 5545 3.1). */
function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, '');
}

/** The METHOD properties of an iCalendar text, upper-case. */
function methodsOf(text) {
  return [...unfold(text).matchAll(/^METHOD(?:;[^:\r\n]*)?:([^\r\n]*)$/gim)].map((m) => m[1].trim().toUpperCase());
}

/** Is this part of a mail a calendar (text/calendar, also as an .ics attachment)? */
function isCalendarPart(entry) {
  return CAL_TYPES.has(entry.contentType) || (!!entry.filename && /\.ics$/i.test(entry.filename));
}

/**
 * A collected calendar part → { partId, method, text } or null (too large, not
 * an iCalendar file). Decoded from its charset (UTF-8 when it names none);
 * the method from its METHOD property, else from the Content-Type parameter.
 */
function calendarEntry(c) {
  if (!c.parts) return null;
  const raw = Buffer.concat(c.parts);
  let text;
  try { text = new TextDecoder(c.charset || 'utf-8').decode(raw); } catch { text = new TextDecoder('utf-8').decode(raw); }
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) return null;
  const m = methodsOf(text)[0] || (c.method ? String(c.method).trim().toUpperCase() : null);
  return { partId: c.partId, method: m && CAL_METHODS.has(m) ? m : null, text };
}

/**
 * Parse one RFC 822 message from `source` (a Readable). mode 'meta': the
 * attachments are described only; 'media': each becomes an unclaimed media
 * file of `plugin` (≤ `maxAttachment` bytes each). An attachment that cannot
 * be stored (quota, size) keeps mediaId null and names the reason in
 * `mediaError`.
 * @returns {Promise<object>} the contract's message object
 */
function parse(source, { plugin, mode = 'meta', maxAttachment = null } = {}) {
  const { MailParser } = require('mailparser');
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ checksumAlgo: 'sha256', skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
    let headers = new Map();
    let html = null;
    let text = null;
    const attachments = [];
    const calendars = []; // candidates for `calendar`, in the order of the mail
    const work = [];
    let failed = false;
    const fail2 = (e) => { if (failed) return; failed = true; try { source.destroy(); } catch { /* gone */ } reject(e); };
    parser.on('headers', (h) => { headers = h; });
    parser.on('data', (data) => {
      if (data.type === 'text') {
        html = typeof data.html === 'string' && data.html ? data.html : null;
        text = typeof data.text === 'string' && data.text ? data.text : null;
        return;
      }
      if (data.type !== 'attachment') return;
      const a = data;
      const entry = {
        partId: a.partId || null,
        filename: a.filename ? String(a.filename).replace(CTRL_RE, '').slice(0, 255) : null,
        contentType: String(a.contentType || 'application/octet-stream').toLowerCase(),
        size: 0,
        contentId: a.cid ? String(a.cid) : null,
        inline: a.contentDisposition === 'inline' || (!!a.related && !!a.cid),
        checksum: null,
        mediaId: null,
      };
      attachments.push(entry);
      if (isCalendarPart(entry) && calendars.length < CAL_CANDIDATES_MAX) {
        // read along (≤ 512 KB) while the part goes its usual way (media or skipped)
        const ct = a.headers && typeof a.headers.get === 'function' ? a.headers.get('content-type') : null;
        const params = ct && typeof ct === 'object' && ct.params ? ct.params : {};
        const c = { partId: entry.partId, charset: typeof params.charset === 'string' ? params.charset : null,
          method: typeof params.method === 'string' ? params.method : null, parts: [], size: 0 };
        calendars.push(c);
        a.content.on('data', (chunk) => {
          if (!c.parts) return;
          c.size += chunk.length;
          if (c.size > CAL_MAX) c.parts = null;
          else c.parts.push(chunk);
        });
      }
      work.push((async () => {
        const ended = finished(a.content).catch(() => null);
        if (mode === 'media') {
          const pass = new PassThrough();
          a.content.pipe(pass);
          try {
            const r = await media().storeHostStream(plugin, pass, { mime: entry.contentType, name: entry.filename, max: maxAttachment });
            entry.mediaId = r.mediaId;
          } catch (e) {
            a.content.unpipe(pass);
            pass.destroy();
            a.content.resume();
            entry.mediaError = (e && MEDIA_CODES[e.code]) || 'ERR_MEDIA';
          }
        } else {
          a.content.resume();
        }
        await ended;
        entry.size = Number(a.size) || 0;
        entry.checksum = typeof a.checksum === 'string' ? a.checksum : null;
        if (typeof a.release === 'function') a.release();
      })().catch(fail2));
    });
    parser.on('error', fail2);
    parser.on('end', () => {
      Promise.all(work).then(() => {
        if (failed) return;
        const list = headers.get('list') || {};
        const date = headers.get('date');
        const from = addresses(headers.get('from'));
        const id = list.id && typeof list.id === 'object' ? list.id.id : null;
        resolve({
          messageId: headerText(headers.get('message-id')),
          inReplyTo: headerText(headers.get('in-reply-to')),
          references: references(headers.get('references')),
          date: date instanceof Date && !Number.isNaN(date.getTime()) ? date.getTime() : null,
          subject: headerText(headers.get('subject')) || '',
          from: from[0] || null,
          to: addresses(headers.get('to')),
          cc: addresses(headers.get('cc')),
          bcc: addresses(headers.get('bcc')),
          replyTo: addresses(headers.get('reply-to')),
          html,
          text,
          listUnsubscribe: unsubscribe(list),
          autoSubmitted: headerText(headers.get('auto-submitted')),
          precedence: headerText(headers.get('precedence')),
          listId: typeof id === 'string' && id ? id.replace(/^<|>$/g, '') : null,
          attachments,
          // since 1.219.0: the calendar parts (invitations), ≤ 512 KB each, the first 3
          calendar: calendars.map(calendarEntry).filter(Boolean).slice(0, CAL_PARTS_MAX),
        });
      }, fail2);
    });
    source.on('error', fail2);
    source.pipe(parser);
  });
}

/** A media file of the plugin as a Readable (decrypted on the way). */
function mediaReadable(row) {
  if (row.bytes < 1) return Readable.from([]);
  return Readable.from(media().readRange(row, 0, row.bytes - 1));
}

/** The plugin's media file `id` (its own only) or ERR_INVALID. */
function ownMedia(plugin, id, what = 'media id') {
  need(typeof id === 'string' && media().ID_RE.test(id), 'ERR_INVALID', `invalid ${what}`);
  const row = media().row(plugin.id, id);
  need(row, 'ERR_INVALID', `unknown ${what}`);
  return row;
}

// ─── Writing ────────────────────────────────────

function line(v, max, what) {
  need(v == null || typeof v === 'string', 'ERR_INVALID', `invalid ${what}`);
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(CTRL_RE, '').trim();
  need(s.length <= max, 'ERR_INVALID', `${what} too long`);
  return s;
}

function address(v, what) {
  if (typeof v === 'string') v = { address: v };
  need(v && typeof v === 'object' && !Array.isArray(v), 'ERR_INVALID', `invalid ${what}`);
  const addr = line(v.address, 320, what);
  need(ADDRESS_RE.test(addr), 'ERR_INVALID', `invalid ${what} address`);
  const name = line(v.name, 200, what);
  return name ? { name, address: addr } : { address: addr };
}

function addressList(v, what) {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  need(list.length <= ADDRESSES_MAX, 'ERR_INVALID', `too many ${what} addresses`);
  return list.map((x) => address(x, what));
}

function messageIdOf(v, what) {
  const s = line(v, 998, what);
  need(MSGID_RE.test(s), 'ERR_INVALID', `invalid ${what}`);
  return s;
}

/**
 * message.icalEvent (since 1.219.0): { method, content, filename? } → nodemailer's
 * icalEvent (a text/calendar alternative with that method and the same file as
 * .ics attachment). Only content of the plugin — never a path or a URL.
 */
function icalEventOf(v) {
  need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => k === 'method' || k === 'content' || k === 'filename'),
    'ERR_INVALID', 'invalid icalEvent');
  const method = typeof v.method === 'string' ? v.method.trim().toUpperCase() : '';
  need(ICAL_SEND_METHODS.has(method), 'ERR_INVALID', `icalEvent.method must be one of ${[...ICAL_SEND_METHODS].join(', ')}`);
  need(typeof v.content === 'string' && Buffer.byteLength(v.content) <= CAL_MAX, 'ERR_INVALID', 'icalEvent.content must be a string of at most 512 KB');
  need(/^BEGIN:VCALENDAR\r?\n/i.test(v.content), 'ERR_INVALID', 'icalEvent.content must begin with BEGIN:VCALENDAR');
  const methods = methodsOf(v.content);
  need(methods.length === 1 && methods[0] === method, 'ERR_INVALID', `icalEvent.content needs METHOD:${method}`);
  let filename = 'invite.ics';
  if (v.filename != null) {
    filename = line(v.filename, 255, 'icalEvent.filename');
    need(/^[^/\\]{1,251}\.ics$/i.test(filename), 'ERR_INVALID', 'icalEvent.filename must end with .ics');
  }
  return { method, content: v.content, filename };
}

/**
 * The plugin's message → MailComposer options (checked). Attachments name
 * the plugin's own media files; the host reads them itself.
 */
function composerOptions(plugin, m) {
  need(m && typeof m === 'object' && !Array.isArray(m), 'ERR_INVALID', 'invalid message');
  const from = address(m.from, 'from');
  const to = addressList(m.to, 'to');
  const cc = addressList(m.cc, 'cc');
  const bcc = addressList(m.bcc, 'bcc');
  need(to.length + cc.length + bcc.length <= ADDRESSES_MAX, 'ERR_INVALID', 'too many recipients');
  const o = { from, subject: line(m.subject, 2000, 'subject'), disableFileAccess: true, disableUrlAccess: true, keepBcc: false };
  if (to.length) o.to = to;
  if (cc.length) o.cc = cc;
  if (bcc.length) o.bcc = bcc;
  if (m.replyTo != null) o.replyTo = addressList(m.replyTo, 'replyTo');
  for (const k of ['html', 'text']) {
    if (m[k] == null) continue;
    need(typeof m[k] === 'string' && Buffer.byteLength(m[k]) <= TEXT_MAX, 'ERR_INVALID', `invalid ${k}`);
    o[k] = m[k];
  }
  if (m.inReplyTo != null) o.inReplyTo = messageIdOf(m.inReplyTo, 'inReplyTo');
  if (m.references != null) {
    need(Array.isArray(m.references) && m.references.length <= 100, 'ERR_INVALID', 'invalid references');
    o.references = m.references.map((r) => messageIdOf(r, 'references'));
  }
  if (m.headers != null) {
    need(typeof m.headers === 'object' && !Array.isArray(m.headers) && Object.keys(m.headers).length <= HEADERS_MAX, 'ERR_INVALID', 'invalid headers');
    o.headers = {};
    for (const [k, v] of Object.entries(m.headers)) {
      need(HEADER_RE.test(k), 'ERR_INVALID', `header ${String(k).slice(0, 40)} not allowed (X-… and List-Unsubscribe only)`);
      o.headers[k] = line(v, 998, `header ${k}`);
    }
  }
  if (m.date != null) {
    const d = new Date(typeof m.date === 'number' ? m.date : String(m.date));
    need(!Number.isNaN(d.getTime()), 'ERR_INVALID', 'invalid date');
    o.date = d;
  }
  if (m.icalEvent != null) o.icalEvent = icalEventOf(m.icalEvent);
  if (m.attachments != null) {
    need(Array.isArray(m.attachments) && m.attachments.length <= ATTACHMENTS_MAX, 'ERR_INVALID', 'invalid attachments');
    o.attachments = m.attachments.map((a) => {
      need(a && typeof a === 'object' && !Array.isArray(a), 'ERR_INVALID', 'invalid attachment');
      const row = ownMedia(plugin, a.mediaId, 'attachment media id');
      const filename = a.filename == null ? (row.name || 'attachment') : line(a.filename, 255, 'attachment filename');
      const type = a.contentType == null ? row.mime : String(a.contentType).toLowerCase();
      need(MIME_RE.test(type), 'ERR_INVALID', 'invalid attachment contentType');
      const att = { filename: filename || 'attachment', contentType: type, content: mediaReadable(row) };
      if (a.cid != null) {
        need(typeof a.cid === 'string' && CID_RE.test(a.cid), 'ERR_INVALID', 'invalid attachment cid');
        att.cid = a.cid;
        att.contentDisposition = 'inline';
      }
      return att;
    });
  }
  return o;
}

/** Collect a stream into one Buffer, at most `max` bytes (else ERR_MAIL_LIMIT). */
async function collect(stream, max) {
  const parts = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > max) { stream.destroy(); fail('ERR_MAIL_LIMIT', `the message is larger than ${Math.round(max / 1048576)} MB`); }
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/**
 * Write the plugin's message as RFC 822.
 * @returns {Promise<{ raw: Buffer, messageId: string, envelope: { from, to: string[] } }>}
 */
async function compose(plugin, message) {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const o = composerOptions(plugin, message);
  const node = new MailComposer(o).compile();
  node.keepBcc = false;
  const messageId = node.messageId();
  let raw;
  try { raw = await collect(node.createReadStream(), COMPOSE_MAX_BYTES); } catch (e) {
    if (e && e.code && /^ERR_/.test(e.code)) throw e;
    fail('ERR_INVALID', 'the message could not be written: ' + String((e && e.message) || e).slice(0, 150));
  }
  const rcpt = [...(o.to || []), ...(o.cc || []), ...(o.bcc || [])].map((a) => a.address);
  return { raw, messageId, envelope: { from: o.from.address, to: [...new Set(rcpt)] } };
}

module.exports = { parse, compose, mediaReadable, ownMedia, COMPOSE_MAX_BYTES, CAL_MAX, CAL_PARTS_MAX };
