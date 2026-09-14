'use strict';

// Structured CHANGELOG.md for "What's new" (docs/feature-release-b.md §6).
//
// The server never ships HTML: every list item becomes an array of inline
// tokens {t:'text'|'code'|'strong', v} that the UI renders with textContent.
// Supported markdown subset — exactly what CHANGELOG.md uses:
//   ## [1.2.3] — 2026-09-14     version section (other `## …` headings, e.g.
//                               orphaned `## [Unreleased]` blocks, are skipped)
//   ### Features                group
//   - item text                 list item; indented lines continue the item,
//                               an indented `- ` starts a new one
//   `code`, **strong**, [text](url) → text; anything else stays literal text.
// The file is shipped in the image (.dockerignore exception) at /app/CHANGELOG.md.

const fs = require('node:fs');
const path = require('node:path');

const CHANGELOG_PATH = process.env.GC_CHANGELOG_PATH || path.join(__dirname, '..', '..', 'CHANGELOG.md');
const VERSION_RE = /^## \[(\d+\.\d+\.\d+)\](?:\s*[—–-]+\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const MAX_SECTIONS = 5;

/** Compare dotted numeric versions; non-numeric parts count as 0. */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function isVersion(v) {
  return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v);
}

/**
 * Inline markdown → tokens. Adjacent text tokens are merged.
 * @param {string} s
 * @returns {{t:string,v:string}[]}
 */
function tokenize(s) {
  const out = [];
  const push = (t, v) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (t === 'text' && last && last.t === 'text') last.v += v;
    else out.push({ t, v });
  };
  let i = 0;
  let buf = '';
  const flush = () => { push('text', buf); buf = ''; };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      // Run of N backticks closes with the same run (CommonMark-ish).
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end !== -1) {
        flush();
        let code = s.slice(i + n, end);
        if (n > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        push('code', code);
        i = end + n;
        continue;
      }
      buf += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        // Nested code inside strong collapses to plain strong text.
        push('strong', tokenize(s.slice(i + 2, end)).map((x) => x.v).join(''));
        i = end + 2;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        buf += m[1];
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * @param {string} text  CHANGELOG.md content
 * @returns {{version:string,date:string|null,groups:{title:string,items:{t:string,v:string}[][]}[]}[]}
 */
function parseChangelog(text) {
  const sections = [];
  let section = null;
  let group = null;
  let item = null; // raw string of the current item
  let skipping = true;

  const endItem = () => {
    if (item !== null && group) {
      const tokens = tokenize(item.replace(/\s+/g, ' ').trim());
      if (tokens.length) group.items.push(tokens);
    }
    item = null;
  };
  const ensureGroup = (title) => {
    group = { title, items: [] };
    section.groups.push(group);
  };

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^## /.test(line)) {
      endItem();
      const m = VERSION_RE.exec(line);
      if (m) {
        section = { version: m[1], date: m[2] || null, groups: [] };
        sections.push(section);
        group = null;
        skipping = false;
      } else {
        section = null;
        group = null;
        skipping = true;
      }
      continue;
    }
    if (skipping || !section) continue;
    if (/^# /.test(line)) { endItem(); skipping = true; section = null; continue; }
    if (/^### /.test(line)) {
      endItem();
      ensureGroup(line.slice(4).trim());
      continue;
    }
    if (line.trim() === '' || line.trim() === '---') {
      // A blank line ends a paragraph item but an indented continuation after
      // it still belongs to the item (CHANGELOG uses "  **Hinweis:** …").
      if (line.trim() === '---') endItem();
      continue;
    }
    const bullet = /^(\s*)[-*] (.*)$/.exec(line);
    if (bullet) {
      endItem();
      if (!group) ensureGroup('');
      item = bullet[2];
      continue;
    }
    if (/^\s+/.test(line) && item !== null) {
      item += ' ' + line.trim();
      continue;
    }
    // Loose paragraph text inside a section: its own item.
    endItem();
    if (!group) ensureGroup('');
    item = line.trim();
  }
  endItem();
  for (const s of sections) s.groups = s.groups.filter((g) => g.items.length > 0);
  return sections;
}

let _cache = { mtimeMs: -1, size: -1, sections: [] };

/** Parsed CHANGELOG (cached by mtime/size). Missing file → []. */
function getSections(file = CHANGELOG_PATH) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (_cache.file === file && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size) return _cache.sections;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sections = parseChangelog(text);
  _cache = { file, mtimeMs: st.mtimeMs, size: st.size, sections };
  return sections;
}

/**
 * Sections newer than `lastSeen` up to and including `current`, newest
 * first, at most MAX_SECTIONS. lastSeen = null (never dismissed, e.g. the
 * first boot with this feature or a new account): only the current release.
 *
 * @param {object} o
 * @param {string} o.current
 * @param {string|null} o.lastSeen
 * @param {boolean} [o.all]   latest MAX_SECTIONS ≤ current regardless of lastSeen
 * @param {Array} [o.sections]
 */
function whatsNew({ current, lastSeen, all = false, sections = getSections() }) {
  const byNewest = (list) => list.slice().sort((a, b) => compareVersions(b.version, a.version)).slice(0, MAX_SECTIONS);
  const upTo = sections.filter((s) => compareVersions(s.version, current) <= 0);
  const fresh = isVersion(lastSeen || '')
    ? upTo.filter((s) => compareVersions(s.version, lastSeen) > 0)
    : upTo.filter((s) => compareVersions(s.version, current) === 0);
  return { current, unseen: fresh.length > 0, sections: byNewest(all ? upTo : fresh) };
}

/** Plain-text rendering of an item (e-mail). */
function itemToText(tokens) {
  return tokens.map((t) => (t.t === 'code' ? `\`${t.v}\`` : t.v)).join('');
}

module.exports = {
  CHANGELOG_PATH,
  MAX_SECTIONS,
  compareVersions,
  isVersion,
  tokenize,
  parseChangelog,
  getSections,
  whatsNew,
  itemToText,
};
