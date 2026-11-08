'use strict';

// The handbook of the Gateways page: the gateway chapters of the user guide
// (docs/handbuch in German, docs/guide in English — chapters 3 to 7: setting
// up, edge and Smart Home, features, updating, FAQ) as ONE document, rendered
// with the safe renderer of the plugin handbooks (services/plugins/markdown.js:
// every character escaped, only its own elements written). The Gateways page
// shows it like the tab "Handbuch" of a plugin (public/js/gateway-docs.js,
// GET /api/v1/gateways/handbook?lang=).
//
// The chapters link to each other with GitHub addresses ("05-funktionen.md#dns-filter").
// Inside the one document those become anchors of the in-app renderer
// ("#dns-filter", "#3-3-raspberry-pi"); links to chapters that are not part of
// it (server set-up, the overview, INSTALL.md) point to the guide on GitHub.
// `anchors` maps every "<file>#<GitHub anchor>" (and "<file>" itself) to the
// in-app anchor, so the help links of the interface (public/js/handbook.js
// topics) open the right heading.

const fs = require('node:fs');
const path = require('node:path');
const markdown = require('./plugins/markdown');
const guide = require('../../public/js/handbook');

const DOCS = process.env.GC_HANDBOOK_DIR || path.join(__dirname, '..', '..', 'docs');
// the chapters of the gateways (by their number; both languages have the same files)
const CHAPTERS = ['03', '04', '05', '06', '07'];
const MAX_FILE = 512 * 1024;
const TOC_LEVEL = 2; // chapters and their sections; the FAQ questions stay in the text

class GatewayHandbookError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const cache = new Map(); // lang → { sig, out }

function langOf(lang) { return guide.langOf(lang); }

/** The chapter files of a language, in order: [{ file, abs }]. */
function chapterFiles(lang) {
  const dir = path.join(DOCS, guide.DIRS[langOf(lang)]);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return CHAPTERS.map((n) => names.filter((f) => f.startsWith(n + '-') && f.endsWith('.md')).sort()[0])
    .filter(Boolean).map((file) => ({ file, abs: path.join(dir, file) }));
}

// GitHub's heading anchors (as tests/handbook_docs.test.js derives them): lower
// case, backticks dropped, punctuation dropped (letters, digits, spaces, "-" and
// "_" stay), spaces → "-"; a repeated heading gets "-1", "-2" …
function githubSlugger() {
  const seen = new Map();
  return (source) => {
    const plain = String(source).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    const base = plain.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

// the line under each chapter title: "← back · contents · next →" — the table of
// contents of the page does that job here
const NAV_LINE = /^\s*\[[^\]]*\]\([^)\s]*\.md\)(\s*·\s*\[[^\]]*\]\([^)\s]*\.md\))+\s*$/;

function dropNav(text) {
  const lines = text.split('\n');
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    if (NAV_LINE.test(lines[i])) { lines.splice(i, 1); break; }
  }
  return lines.join('\n');
}

/**
 * Rewrite the targets of "[text](target)" outside code (fences and `code`).
 * The docs are this repository's own files; the result still goes through the
 * escaping renderer, so a target it does not allow stays plain text.
 */
function rewriteLinks(text, map) {
  let fence = null;
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null; return line; }
    if (f) { fence = f[1]; return line; }
    // only the parts outside inline code
    return line.split(/(`+[^`]*`+)/).map((part, k) => (k % 2 ? part
      : part.replace(/\]\(([^)\s]+)\)/g, (m, target) => '](' + map(target) + ')'))).join('');
  }).join('\n');
}

function signature(files) {
  return files.map((f) => {
    try { const st = fs.statSync(f.abs); return `${f.file}:${st.size}:${st.mtimeMs}`; } catch { return `${f.file}:-`; }
  }).join('|');
}

function readChapter(f) {
  const st = fs.statSync(f.abs);
  if (!st.isFile() || st.size > MAX_FILE) throw new GatewayHandbookError('handbook_missing', 'chapter too large');
  return fs.readFileSync(f.abs, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function build(lang, files) {
  const l = langOf(lang);
  const texts = files.map((f) => dropNav(readChapter(f)));
  // pass 1: the anchors of the one document, the GitHub anchors per file
  const whole = markdown.render(texts.join('\n\n'), { heads: true }).heads;
  const anchors = {};
  let k = 0;
  files.forEach((f, i) => {
    const own = markdown.render(texts[i], { heads: true }).heads;
    const gh = githubSlugger();
    own.forEach((h, j) => {
      const target = whole[k + j];
      if (!target) return;
      if (j === 0) anchors[f.file] = target.anchor;
      anchors[f.file + '#' + gh(h.source)] = target.anchor;
    });
    k += own.length;
  });
  // pass 2: the links between the chapters → anchors of this document; the rest → the guide on GitHub
  const base = guide.BASE + guide.DIRS[l];
  const files0 = new Set(files.map((f) => f.file));
  const resolve = (file) => (target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target; // https:, mailto: …
    const at = target.indexOf('#');
    const p = at === -1 ? target : target.slice(0, at);
    let hash = at === -1 ? '' : target.slice(at + 1);
    try { hash = decodeURIComponent(hash); } catch { /* keep as written */ }
    const name = p === '' ? file : (p.includes('/') ? null : p);
    if (name && files0.has(name)) {
      const a = hash ? anchors[name + '#' + hash] : anchors[name];
      if (a) return '#' + a;
    }
    try { return new URL(target || file, base + file).href; } catch { return target; }
  };
  const text = texts.map((t, i) => rewriteLinks(t, resolve(files[i].file))).join('\n\n');
  const out = markdown.render(text);
  return {
    lang: l,
    html: out.html,
    toc: out.toc.filter((x) => x.level <= TOC_LEVEL),
    anchors,
    chapters: files.map((f) => ({ file: f.file, anchor: anchors[f.file] || null, url: base + f.file })),
    source_url: base + 'README.md',
  };
}

/**
 * The gateway handbook in `lang` ('de' | 'en'; anything else: German).
 * @returns {{ lang, html, toc, anchors, chapters, source_url }}
 */
function get(lang) {
  const l = langOf(lang);
  const files = chapterFiles(l);
  if (!files.length) throw new GatewayHandbookError('handbook_missing', 'the gateway chapters of the user guide are missing');
  const sig = signature(files);
  const hit = cache.get(l);
  if (hit && hit.sig === sig) return hit.out;
  let out;
  try { out = build(l, files); } catch (e) {
    if (e instanceof GatewayHandbookError) throw e;
    throw new GatewayHandbookError('handbook_missing', e.message);
  }
  cache.set(l, { sig, out });
  return out;
}

module.exports = { GatewayHandbookError, get, CHAPTERS, _githubSlugger: githubSlugger, _rewriteLinks: rewriteLinks, _dropNav: dropNav, _clear: () => cache.clear() };
