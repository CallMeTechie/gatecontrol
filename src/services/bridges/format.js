'use strict';

// The format of a bridged message (docs/feature-messenger-bridges.md, "Format and link preview"): what a bridge sends as
// HTML (`formatted_body`, format org.matrix.custom.html) becomes plain text plus `marks` — never HTML for an app.
//
// mautrix-whatsapp v0.2610.0 writes WhatsApp's *bold* _italic_ ~strike~ `code` and ```blocks``` as <strong> <em> <del>
// <code> <pre><code>, lines as <br>, "- " / "1. " lists as <ul>/<ol><li>, "> " as <blockquote>, a mention as
// <a href="https://matrix.to/#/@…">name</a> (pkg/msgconv/wa-text.go parseWAFormattingToHTML, from-whatsapp.go
// addMentions) — and keeps WhatsApp's own markers in `body`. So the text an app shows comes from the HTML, parsed
// strictly: one tag this file does not know, an attribute value it cannot read, a closing tag that does not fit or an
// entity it does not know, and the whole HTML is dropped — the message is shown as its plain `body`, without marks.
//
//   marks   [{ type: bold | italic | strike | code | link, start, end, url? }] — offsets in UTF-16 code units of the
//           returned text (JavaScript string indices), end exclusive; marks may nest. `link` only for an http(s) address
//           a bridge wrote as a link — never a mention (matrix.to) or another scheme; the apps find plain addresses in
//           the text themselves.

const MAX_HTML = 64000;
const MAX_MARKS = 500;
const URL_MAX = 2000;

const INLINE = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', del: 'strike', s: 'strike', strike: 'strike', code: 'code' };
const BLOCK = new Set(['p', 'div', 'blockquote', 'ul', 'ol', 'li', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const PLAIN = new Set(['span', 'u', 'sup', 'sub', 'a']);
const VOID = new Set(['br']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const NAME_RE = /^(\/?)([a-zA-Z][a-zA-Z0-9-]{0,20})(?=\s|\/|$)/;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]{0,40})(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/y;

/** Entities of a piece of text → the text, or null for one this parser does not know. */
function decode(s) {
  let bad = false;
  const out = s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{1,10});?/g, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isSafeInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) { bad = true; return ''; }
      return String.fromCodePoint(n);
    }
    if (!Object.prototype.hasOwnProperty.call(ENTITIES, e)) { bad = true; return ''; }
    return ENTITIES[e];
  });
  // a bare "&" without a known name is taken as it is (browsers do the same); "<" never comes here
  return bad ? null : out;
}

/** The attributes of a tag (` name="value" …`): every character must belong to one, else null. */
function attrsOf(s) {
  const a = {};
  let k = 0;
  while (k < s.length) {
    if (/\s/.test(s[k])) { k++; continue; }
    ATTR_RE.lastIndex = k;
    const m = ATTR_RE.exec(s);
    if (!m || !m[0]) return null;
    k = ATTR_RE.lastIndex;
    const v = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
    const d = decode(v);
    if (d == null) return null;
    a[m[1].toLowerCase()] = d;
  }
  return a;
}

/** `<…>` at `lt` → { closing, tag, attrs (the raw text after the name), selfClosing, end } or null. */
function tagAt(html, lt) {
  const gt = html.indexOf('>', lt);
  if (gt < 0 || gt - lt > 4096) return null;
  let inner = html.slice(lt + 1, gt);
  const m = NAME_RE.exec(inner);
  if (!m) return null;
  inner = inner.slice(m[0].length);
  const selfClosing = inner.endsWith('/');
  if (selfClosing) inner = inner.slice(0, -1);
  return { closing: m[1] === '/', tag: m[2].toLowerCase(), attrs: inner, selfClosing, end: gt + 1 };
}

/** An address a link mark may carry: http(s) only, never a Matrix address (a mention names an account of the bridge). */
function linkUrl(href) {
  if (typeof href !== 'string' || !href || href.length > URL_MAX) return null;
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.hostname === 'matrix.to' || /(^|\.)gc\.internal$/i.test(u.hostname)) return null;
  return u.href;
}

/**
 * parse(html, { max }) → { text, marks } or null (not HTML this parser takes — the caller shows `body`).
 * `max`: the longest text kept (marks are cut to it).
 */
function parse(html, { max = 16000 } = {}) {
  if (typeof html !== 'string' || !html || html.length > MAX_HTML) return null;
  let text = '';
  const marks = [];
  const stack = [];
  let skip = 0;        // inside <mx-reply> or the forwarded notice: nothing of it is shown
  let pre = 0;         // inside <pre>: line breaks are kept
  const ensureBreak = () => { if (text && !text.endsWith('\n')) text += '\n'; };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const chunk = lt < 0 ? html.slice(i) : html.slice(i, lt);
    if (chunk) {
      const d = decode(chunk);
      if (d == null) return null;
      if (!skip) text += pre ? d.replace(/\r\n?/g, '\n') : d.replace(/[\r\n\t]+/g, ' ');
    }
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) return null;
    const tg = tagAt(html, lt);
    if (!tg) return null;
    i = tg.end;
    const { closing, tag } = tg;
    if (closing && tg.attrs.trim()) return null;
    if (tag === 'mx-reply') {
      if (closing) { if (!skip || stack.pop() !== 'mx-reply') return null; skip--; } else { stack.push('mx-reply'); skip++; }
      continue;
    }
    const known = INLINE[tag] || BLOCK.has(tag) || PLAIN.has(tag) || VOID.has(tag);
    if (!known) return null;
    if (VOID.has(tag)) { if (!skip && !closing) text += '\n'; continue; }
    if (!closing) {
      const attrs = attrsOf(tg.attrs);
      if (attrs == null) return null;
      if (tg.selfClosing) continue; // <span/>: nothing
      const entry = { tag, start: text.length, mark: INLINE[tag] || null, url: null, skip: false };
      if (tag === 'p' && Object.prototype.hasOwnProperty.call(attrs, 'data-mx-forwarded-notice')) { entry.skip = true; skip++; }
      if (tag === 'a') entry.url = linkUrl(attrs.href);
      if (/^h[1-6]$/.test(tag)) entry.mark = 'bold';
      if (tag === 'pre') { entry.mark = 'code'; pre++; }
      if (tag === 'ol') entry.n = Number.isSafeInteger(Number(attrs.start)) ? Number(attrs.start) : 1;
      if (BLOCK.has(tag) && !skip) ensureBreak();
      if (!skip && tag === 'blockquote') text += '> ';
      if (!skip && tag === 'li') {
        const list = [...stack].reverse().find((x) => x.tag === 'ul' || x.tag === 'ol');
        if (list && list.tag === 'ol') {
          const v = Number(attrs.value);
          if (Number.isSafeInteger(v)) list.n = v;
          text += `${list.n}. `;
          list.n += 1;
        } else text += '• ';
      }
      // inside a <pre>, the <code> adds nothing: the block is one code mark
      if (tag === 'code' && pre) entry.mark = null;
      entry.start = text.length;
      stack.push(entry);
      continue;
    }
    const top = stack.pop();
    if (!top || typeof top !== 'object' || top.tag !== tag) return null;
    if (top.skip) { skip--; continue; }
    if (tag === 'pre') pre--;
    if (skip) continue;
    if (top.mark && text.length > top.start) marks.push({ type: top.mark, start: top.start, end: text.length });
    if (tag === 'a' && top.url && text.length > top.start) marks.push({ type: 'link', start: top.start, end: text.length, url: top.url });
    if (BLOCK.has(tag)) ensureBreak();
  }
  if (stack.length) return null;
  // the lines around the text go, the marks move with it
  const lead = text.length - text.replace(/^\n+/, '').length;
  let out = text.slice(lead).replace(/\n+$/, '');
  if (out.length > max) out = out.slice(0, max);
  if (!out.trim()) return null;
  const kept = [];
  for (const mk of marks) {
    const start = Math.max(0, mk.start - lead);
    const end = Math.min(out.length, mk.end - lead);
    if (end > start) kept.push(mk.url ? { type: mk.type, start, end, url: mk.url } : { type: mk.type, start, end });
  }
  kept.sort((a, b) => a.start - b.start || b.end - a.end);
  return { text: out, marks: kept.length > MAX_MARKS ? [] : kept };
}

module.exports = { parse, linkUrl, MAX_MARKS };
