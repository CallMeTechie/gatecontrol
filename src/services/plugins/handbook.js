'use strict';

// The handbook of a plugin (plugin.json `handbook` { de, en }, since 1.241.0,
// docs/plugins.md "Handbook"): Markdown files of the installed package,
// rendered here (services/plugins/markdown.js — no HTML of the plugin gets
// through) for the tab "Handbuch" under Einstellungen › Plugins › <plugin>
// and GET /api/v1/plugins/:id/handbook?lang=. The language of the interface,
// else German, else English.

const fs = require('node:fs');
const path = require('node:path');
const { codeDir } = require('./constants');
const { HANDBOOK_MAX_BYTES, isFile } = require('./manifest');
const markdown = require('./markdown');

const CACHE_MAX = 32;
const cache = new Map(); // `${id}@${version}:${file}` → { mtimeMs, size, out }

class HandbookError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function filesOf(p) {
  const h = p && p.manifest && p.manifest.handbook;
  return h && typeof h === 'object' ? h : null;
}

/** Does the installed version of this plugin bring a handbook? */
function has(p) {
  const h = filesOf(p);
  return !!(h && (h.de || h.en));
}

/** The language shown: the one asked for when the package has it, else de, else en. */
function pickLang(h, lang) {
  if (lang === 'en' && h.en) return 'en';
  if (lang === 'de' && h.de) return 'de';
  return h.de ? 'de' : 'en';
}

/**
 * @param {object} p      installed plugin (registry row)
 * @param {string} lang   'de' | 'en'
 * @returns {{ version, handbookVersion, lang, html, toc }}
 */
function get(p, lang) {
  const h = filesOf(p);
  if (!has(p)) throw new HandbookError('no_handbook', 'this plugin has no handbook');
  const l = pickLang(h, lang);
  const rel = h[l];
  if (!isFile(rel)) throw new HandbookError('handbook_missing', 'handbook file invalid');
  const root = path.resolve(codeDir(p.id, p.version));
  const file = path.resolve(root, ...rel.split('/'));
  if (!file.startsWith(root + path.sep)) throw new HandbookError('handbook_missing', 'handbook outside the plugin folder');
  // one handle for the checks and the read (no check-then-read race; no symlink)
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try { fd = fs.openSync(file, flags); } catch { throw new HandbookError('handbook_missing', 'handbook file missing'); }
  let out;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > HANDBOOK_MAX_BYTES) throw new HandbookError('handbook_missing', 'handbook file invalid');
    const key = `${p.id}@${p.version}:${rel}`;
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) out = hit.out;
    else {
      const buf = Buffer.alloc(Math.min(st.size, HANDBOOK_MAX_BYTES));
      let n = 0;
      while (n < buf.length) {
        const r = fs.readSync(fd, buf, n, buf.length - n, n);
        if (r <= 0) break;
        n += r;
      }
      out = markdown.render(buf.subarray(0, n).toString('utf8'));
      cache.delete(key);
      cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, out });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { version: p.version, handbookVersion: out.version, lang: l, html: out.html, toc: out.toc };
}

module.exports = { HandbookError, has, get, pickLang };
