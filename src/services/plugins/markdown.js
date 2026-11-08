'use strict';

// A small, safe Markdown renderer for plugin handbooks (docs/plugins.md
// "Handbook", services/plugins/handbook.js) — and for the handbook of the
// Gateways page (services/gatewayHandbook.js). The text comes from a plugin
// package, so nothing of it is passed through as HTML: every character of the
// source is escaped and only the elements below are written by the renderer.
//
// Subset (the handbook contract):
//   # / ## / ###          headings → <h2>/<h3>/<h4> (#### … → <h5>), each with
//                         an anchor id "hb-<slug>"; levels 1–3 form the TOC
//   paragraphs            lines joined; two trailing spaces or "\" → <br>
//   - * +  /  1. 1)       lists, nested by indentation (ordered: start=)
//   **strong** __strong__ *em* _em_ `code` ``code``
//   ``` / ~~~             code blocks
//   [text](url)           links: only https:// (target=_blank,
//                         rel="noopener noreferrer") and "#anchor" of this
//                         handbook; anything else stays plain text
//   <https://…>           autolink
//   | a | b |             tables with :--: alignment (classes, no style)
//   > **Hinweis:** …      note blocks (data-tone info / warn)
//   --- *** ___           <hr>
//   <!-- … -->            dropped (the first line "<!-- version: X.Y.Z -->"
//                         is the handbook's version)
//   ![alt](src)           no images (yet): the alt text only
// Raw HTML is never interpreted: "<b>" stays the visible text "<b>".
//
// Anchors: "{#anchor}" at the end of a heading (the same anchor in every
// language, e.g. for setupNotices[].handbook), else the slug of the heading text — lower case, ä/ö/ü/ß → ae/oe/ue/ss,
// other accents dropped, everything else but a–z/0–9 → "-"; repeated slugs
// get "-2", "-3". The element id is "hb-" + slug (no clash with the ids of
// the page), links and the TOC use the bare slug.

const MAX_DEPTH = 8;
const INLINE_DEPTH = 6;
const SLUG_MAX = 100;
const LINK_TEXT_MAX = 500; // longest [text] of a link (bounds the scan)
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PUNCT = '\\`*_{}[]()#+-.!|>~<"\':;,?/=&$%@^';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const NOTE_TONES = {
  hinweis: 'info', note: 'info', tipp: 'info', tip: 'info', info: 'info', gut: 'info',
  achtung: 'warn', warnung: 'warn', warning: 'warn', wichtig: 'warn', important: 'warn', caution: 'warn', vorsicht: 'warn',
};

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ESC[c]); }

/** Heading text → anchor slug (German transliteration). */
function slugify(text) {
  const s = String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '-') a++;
  while (b > a && s[b - 1] === '-') b--;
  let out = s.slice(a, b).slice(0, SLUG_MAX);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out;
}

function isBlank(l) { return l.trim() === ''; }

function indentOf(l) {
  let n = 0;
  for (const ch of l) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Leading spaces/tabs of a line expanded to spaces (list indentation). */
function expandTabs(l) {
  const n = indentOf(l);
  let i = 0;
  while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++;
  return ' '.repeat(n) + l.slice(i);
}

function headingOf(l) {
  if (indentOf(l) > 3) return null;
  const s = l.trim();
  let n = 0;
  while (n < s.length && s[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  if (n < s.length && s[n] !== ' ' && s[n] !== '\t') return null;
  let text = s.slice(n).trim();
  // optional closing #s (after a space)
  let e = text.length;
  while (e > 0 && text[e - 1] === '#') e--;
  if (e < text.length && (e === 0 || text[e - 1] === ' ' || text[e - 1] === '\t')) text = text.slice(0, e).trim();
  return { level: n, text };
}

function isHr(l) {
  if (indentOf(l) > 3) return false;
  const t = l.replace(/[ \t]/g, '');
  if (t.length < 3) return false;
  const c = t[0];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  for (const ch of t) if (ch !== c) return false;
  return true;
}

function fenceOf(l) {
  if (indentOf(l) > 3) return null;
  const s = l.trim();
  const c = s[0];
  if (c !== '`' && c !== '~') return null;
  let n = 0;
  while (n < s.length && s[n] === c) n++;
  if (n < 3) return null;
  if (c === '`' && s.slice(n).includes('`')) return null;
  return { ch: c, n };
}

function isFenceClose(l, f) {
  if (indentOf(l) > 3) return false;
  const s = l.trim();
  if (s.length < f.n) return false;
  for (const ch of s) if (ch !== f.ch) return false;
  return true;
}

function quoteOf(l) {
  if (indentOf(l) > 3) return null;
  const s = l.replace(/^[ \t]+/, '');
  if (s[0] !== '>') return null;
  return s[1] === ' ' ? s.slice(2) : s.slice(1);
}

/** List marker of a line → { indent, ordered, start, content (column of the text), text } or null. */
function listOf(raw) {
  const l = expandTabs(raw);
  const indent = indentOf(l);
  let i = indent;
  let ordered = false;
  let start = 1;
  if (l[i] === '-' || l[i] === '*' || l[i] === '+') i++;
  else {
    let j = i;
    while (j < l.length && j - i < 9 && l[j] >= '0' && l[j] <= '9') j++;
    if (j === i || (l[j] !== '.' && l[j] !== ')')) return null;
    ordered = true;
    start = parseInt(l.slice(i, j), 10);
    i = j + 1;
  }
  if (i < l.length && l[i] !== ' ') return null;
  let sp = 0;
  while (i + sp < l.length && l[i + sp] === ' ') sp++;
  const text = l.slice(i + sp);
  if (sp > 4) sp = 1; // an indented code-like rest: the text starts after one space
  return { indent, ordered, start, content: i + Math.max(1, sp), text: sp > 0 || i >= l.length ? text : '' };
}

function isComment(l) {
  const s = l.trim();
  return s.startsWith('<!--') && s.endsWith('-->');
}

/** Cells of a table row ("\|" is a literal bar). */
function splitRow(l) {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += code ? '|' : '\\|'; i++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function tableAlign(l) {
  if (!l.includes('-')) return null;
  const s = l.trim();
  if (!s.includes('|') && !/^:?-+:?$/.test(s)) return null;
  const cells = splitRow(l);
  if (!cells.length) return null;
  const out = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    out.push(c.startsWith(':') && c.endsWith(':') ? 'c' : (c.endsWith(':') ? 'r' : (c.startsWith(':') ? 'l' : null)));
  }
  return out;
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && tableAlign(lines[i + 1]) !== null
    && splitRow(lines[i]).length === tableAlign(lines[i + 1]).length;
}

function blockStart(lines, i) {
  const l = lines[i];
  return !!(headingOf(l) || fenceOf(l) || isHr(l) || quoteOf(l) !== null || listOf(l) || isTableStart(lines, i));
}

// ─── Inline ───────────────────────────────────────────────

/** A link target of a handbook → the href or null (not allowed: shown as text). */
function safeHref(raw) {
  const u = String(raw || '').trim();
  if (u.startsWith('#')) {
    const slug = u.slice(1);
    return SLUG_RE.test(slug) ? { href: '#' + slug, anchor: slug } : null;
  }
  if (!/^https:\/\//i.test(u) || u.length > 2000) return null;
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return { href: url.href };
}

function linkHtml(h, inner) {
  if (h.anchor) return `<a href="${esc(h.href)}" data-hb-anchor="${esc(h.anchor)}">${inner}</a>`;
  return `<a href="${esc(h.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

/**
 * [text](url) at s[i] === '[' → { text, url, end } or null.
 * Brackets nest; the url has no spaces (an optional "title" is ignored).
 */
function linkAt(s, i, memo) {
  if (memo.noClose) return null;
  let depth = 0;
  let j = i;
  const stop = Math.min(s.length, i + LINK_TEXT_MAX);
  for (; j < stop; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) break; }
  }
  if (j >= stop) { if (s.indexOf(']', i) === -1) memo.noClose = true; return null; }
  if (s[j + 1] !== '(') return null;
  // the closing ")" — parentheses inside the url nest (https://de.wikipedia.org/wiki/A_(B))
  let close = -1;
  let par = 0;
  for (let k = j + 2; k < s.length && k < j + 2 + 2100; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '(') par++;
    else if (c === ')') { if (par === 0) { close = k; break; } par--; }
  }
  if (close === -1) return null;
  const inside = s.slice(j + 2, close).trim();
  const sp = inside.search(/\s/);
  const url = sp === -1 ? inside : inside.slice(0, sp);
  return { text: s.slice(i + 1, j), url: url.replace(/^<|>$/g, ''), end: close + 1 };
}

/** The closing delimiter `d` for an emphasis opened before `from` (not after a space), or -1. */
function closeOf(s, from, d, memo) {
  if (memo['no' + d]) return -1;
  let k = from;
  for (;;) {
    const e = s.indexOf(d, k);
    if (e === -1) { memo['no' + d] = true; return -1; }
    const before = s[e - 1];
    if (e > from && before !== ' ' && before !== '\t' && before !== '\\'
      && !(d.length === 1 && s[e + 1] === d)
      && !(d.length === 1 && before === d)) {
      // "_" only closes at the end of a word
      if (d[0] !== '_' || !/[A-Za-z0-9]/.test(s[e + d.length] || '')) return e;
    }
    k = e + d.length;
  }
}

/** Inline markup → HTML; everything else escaped. */
function inline(s, ctx, depth = 0, noLink = false) {
  let out = '';
  let buf = '';
  const memo = {};
  const flush = () => { if (buf) { out += esc(buf); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && PUNCT.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let end = memo['nb' + n] ? -1 : s.indexOf(fence, i + n);
      while (end !== -1 && s[end + n] === '`') {
        let m = end;
        while (s[m] === '`') m++;
        end = s.indexOf(fence, m);
      }
      if (end === -1) { memo['nb' + n] = true; buf += fence; i += n; continue; }
      flush();
      let code = s.slice(i + n, end);
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      out += '<code>' + esc(code) + '</code>';
      i = end + n;
      continue;
    }
    if ((ch === '*' || ch === '_') && depth < INLINE_DEPTH) {
      const intraword = ch === '_' && i > 0 && /[A-Za-z0-9]/.test(s[i - 1]);
      if (!intraword) {
        const dbl = s[i + 1] === ch;
        const d = dbl ? ch + ch : ch;
        const from = i + d.length;
        if (s[from] && s[from] !== ' ' && s[from] !== '\t' && !(dbl === false && s[from] === ch)) {
          const end = closeOf(s, from, d, memo);
          if (end !== -1) {
            flush();
            const tag = dbl ? 'strong' : 'em';
            out += `<${tag}>` + inline(s.slice(from, end), ctx, depth + 1, noLink) + `</${tag}>`;
            i = end + d.length;
            continue;
          }
        }
      }
      // a run of the same character stays text as a whole
      let n = 1;
      while (s[i + n] === ch) n++;
      buf += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      const l = linkAt(s, i + 1, memo);
      if (l) { flush(); out += inline(l.text, ctx, depth + 1, true); i = l.end; continue; }
    }
    if (ch === '[' && depth < INLINE_DEPTH) {
      const l = noLink ? null : linkAt(s, i, memo);
      if (l) {
        flush();
        const inner = inline(l.text, ctx, depth + 1, true);
        const h = safeHref(l.url);
        out += h ? linkHtml(h, inner) : inner;
        i = l.end;
        continue;
      }
    }
    if (ch === '<' && !noLink && s.startsWith('https://', i + 1)) {
      const end = s.indexOf('>', i + 1);
      const u = end === -1 ? '' : s.slice(i + 1, end);
      const h = u && !/[\s<]/.test(u) ? safeHref(u) : null;
      if (h) { flush(); out += linkHtml(h, esc(u)); i = end + 1; continue; }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** The plain text of a heading (for its slug and the TOC). */
function plainText(s) {
  return String(s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\(.)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
    .trim();
}

// ─── Blocks ───────────────────────────────────────────────

function heading(h, ctx) {
  // an explicit anchor "## Camera settings {#kamera-einstellungen}": the same anchor in every language
  let src = h.text;
  let given = null;
  const k = src.lastIndexOf('{#');
  if (k !== -1 && src.endsWith('}')) {
    const cand = src.slice(k + 2, -1);
    if (SLUG_RE.test(cand)) { given = cand; src = src.slice(0, k).trimEnd(); }
  }
  const text = plainText(src);
  let slug = given || slugify(text) || 'abschnitt';
  if (ctx.slugs.has(slug)) {
    let n = 2;
    while (ctx.slugs.has(`${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  ctx.slugs.add(slug);
  if (h.level <= 3) ctx.toc.push({ level: h.level, text, anchor: slug });
  if (ctx.heads) ctx.heads.push({ level: h.level, source: src, anchor: slug });
  const tag = 'h' + Math.min(h.level + 1, 5);
  return `<${tag} id="hb-${esc(slug)}" class="hb-h">${inline(src, ctx)}</${tag}>`;
}

function paragraph(lines, ctx, tight) {
  let body = '';
  lines.forEach((l, k) => {
    const last = k === lines.length - 1;
    const hard = !last && (l.endsWith('  ') || l.trimEnd().endsWith('\\'));
    const text = l.trim().replace(/\\$/, last ? '\\' : '');
    body += inline(text, ctx) + (last ? '' : (hard ? '<br>' : ' '));
  });
  return tight ? body : `<p>${body}</p>`;
}

function table(lines, i, ctx) {
  const head = splitRow(lines[i]);
  const align = tableAlign(lines[i + 1]);
  const cls = (k) => (align[k] === 'c' ? ' class="hb-al-c"' : (align[k] === 'r' ? ' class="hb-al-r"' : ''));
  let html = '<div class="hb-table"><table><thead><tr>' + head.map((c, k) => `<th${cls(k)}>${inline(c, ctx)}</th>`).join('') + '</tr></thead><tbody>';
  let j = i + 2;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (isBlank(l) || !l.includes('|') || headingOf(l) || fenceOf(l) || quoteOf(l) !== null) break;
    const cells = splitRow(l);
    html += '<tr>' + head.map((_, k) => `<td${cls(k)}>${inline(cells[k] || '', ctx)}</td>`).join('') + '</tr>';
  }
  return { html: html + '</tbody></table></div>', next: j };
}

function list(lines, i, ctx, depth) {
  const first = listOf(lines[i]);
  const items = [];
  let loose = false;
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      const nx = j < lines.length ? listOf(lines[j]) : null;
      if (!nx || nx.ordered !== first.ordered || nx.indent < first.indent || nx.indent > first.indent + 1 || isHr(lines[j])) break;
      loose = true;
      i = j;
    }
    const lm = listOf(lines[i]);
    if (!lm || isHr(lines[i]) || lm.ordered !== first.ordered || lm.indent < first.indent || lm.indent > first.indent + 1) break;
    const body = [lm.text];
    i++;
    while (i < lines.length) {
      const l = expandTabs(lines[i]);
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(expandTabs(lines[j])) >= lm.content) {
          for (let k = i; k < j; k++) body.push('');
          loose = true;
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= lm.content || (ind > first.indent + 1 && listOf(l))) {
        body.push(l.slice(Math.min(ind, lm.content)));
        i++;
        continue;
      }
      // lazy continuation of the item's paragraph
      if (!blockStart(lines, i) && body[body.length - 1].trim() !== '' && !isComment(l)) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    items.push(body);
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const start = first.ordered && first.start !== 1 && Number.isSafeInteger(first.start) ? ` start="${first.start}"` : '';
  const lis = items.map((b) => '<li>' + blocks(b, ctx, depth + 1, !loose) + '</li>').join('');
  return { html: `<${tag}${start}>${lis}</${tag}>`, next: i };
}

function noteTone(inner) {
  const m = /^\s*\*\*([^*\n]{1,30}?):?\*\*/.exec(inner);
  if (!m) return null;
  return NOTE_TONES[m[1].replace(/:$/, '').trim().toLowerCase()] || null;
}

/** Lines → HTML of their blocks. */
function blocks(lines, ctx, depth = 0, tight = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }
    if (isComment(l)) { i++; continue; }
    if (l.trim().startsWith('<!--')) {
      // a comment over several lines: dropped up to its end (or the end of the text)
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
      continue;
    }
    const f = fenceOf(l);
    if (f) {
      const body = [];
      const ind = indentOf(l);
      i++;
      while (i < lines.length && !isFenceClose(lines[i], f)) {
        const x = lines[i];
        body.push(x.slice(Math.min(ind, indentOf(x))));
        i++;
      }
      i++;
      out.push('<pre class="hb-code"><code>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }
    const h = headingOf(l);
    if (h) { out.push(heading(h, ctx)); i++; continue; }
    if (isHr(l)) { out.push('<hr>'); i++; continue; }
    if (quoteOf(l) !== null && depth < MAX_DEPTH) {
      const inner = [];
      while (i < lines.length && quoteOf(lines[i]) !== null) { inner.push(quoteOf(lines[i])); i++; }
      const tone = noteTone(inner.join('\n'));
      out.push(`<blockquote class="hb-note"${tone ? ` data-tone="${tone}"` : ''}>` + blocks(inner, ctx, depth + 1) + '</blockquote>');
      continue;
    }
    if (listOf(l) && depth < MAX_DEPTH) {
      const r = list(lines, i, ctx, depth);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const r = table(lines, i, ctx);
      out.push(r.html);
      i = r.next;
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !lines[i].trim().startsWith('<!--') && (para.length === 0 || !blockStart(lines, i))) { para.push(lines[i]); i++; }
    out.push(paragraph(para, ctx, tight));
  }
  return out.join(tight ? '' : '\n');
}

/** "<!-- version: X.Y.Z -->" of the first line → "X.Y.Z" or null. */
function versionOf(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0] || '';
  const m = /^\s*<!--\s*version:\s*([0-9A-Za-z.+-]{1,40})\s*-->\s*$/.exec(first.replace(/^\uFEFF/, ''));
  return m ? m[1] : null;
}

/**
 * Render a handbook.
 * @param {string} text  Markdown
 * @param {{ heads?: boolean }} [opts]  heads: also every heading (all levels) with its
 *   Markdown source and anchor, in document order (the gateway handbook,
 *   services/gatewayHandbook.js, maps the GitHub anchors of its chapters with it)
 * @returns {{ html: string, toc: {level:number,text:string,anchor:string}[], version: string|null, heads?: {level:number,source:string,anchor:string}[] }}
 */
function render(text, opts) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  const ctx = { slugs: new Set(), toc: [], heads: opts && opts.heads ? [] : null };
  const html = blocks(src.split('\n'), ctx);
  const out = { html, toc: ctx.toc, version: versionOf(src) };
  if (ctx.heads) out.heads = ctx.heads;
  return out;
}

module.exports = { render, slugify, safeHref, inline, versionOf, esc };
