'use strict';

// The user guide docs/handbuch (German) and docs/guide (English): both have
// the same chapters, every relative link and #anchor points to something that
// exists, and the Synology example compose in chapter 6 is exactly what the
// gateway assistant builds (public/js/gateway-kit.js buildCompose) — so the
// guide cannot drift from the assistant.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../public/js/gateway-kit');

const ROOT = path.join(__dirname, '..');
const DIRS = ['docs/handbuch', 'docs/guide'];

function mdFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.md')).sort();
}

// GitHub's heading anchors: lower case, punctuation dropped (letters, digits,
// spaces, '-' and '_' stay), spaces → '-'; repeated headings get -1, -2 …
function anchors(text) {
  const out = new Set();
  const seen = new Map();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1].replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

function links(text) {
  const out = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  }
  return out;
}

describe('user guide (docs/handbuch, docs/guide)', () => {
  it('both languages have the same number of chapters and a README', () => {
    const de = mdFiles(DIRS[0]);
    const en = mdFiles(DIRS[1]);
    assert.ok(de.includes('README.md') && en.includes('README.md'));
    assert.equal(de.length, en.length);
    assert.deepEqual(de.map((f) => f.slice(0, 3)), en.map((f) => f.slice(0, 3)));
  });

  for (const dir of [...DIRS, '.']) {
    const files = dir === '.' ? ['README.md', 'README.de.md', 'INSTALL.md', 'INSTALL.de.md'] : mdFiles(dir);
    for (const f of files) {
      it(`${dir}/${f}: relative links and anchors resolve`, () => {
        const file = path.join(ROOT, dir, f);
        const text = fs.readFileSync(file, 'utf8');
        for (const l of links(text)) {
          if (/^[a-z]+:/i.test(l)) continue; // http(s), mailto
          const [target, hash] = l.split('#');
          // only check links into the guide or out of it
          const abs = target ? path.resolve(path.dirname(file), target) : file;
          const rel = path.relative(ROOT, abs);
          const inGuide = DIRS.some((d) => rel.startsWith(d)) || DIRS.some((d) => path.relative(ROOT, file).startsWith(d));
          if (!inGuide) continue;
          assert.ok(fs.existsSync(abs), `${f}: missing link target ${l}`);
          if (hash && abs.endsWith('.md')) {
            assert.ok(anchors(fs.readFileSync(abs, 'utf8')).has(hash), `${f}: missing anchor ${l}`);
          }
        }
      });
    }
  }

  it('chapter 6 carries exactly the Synology compose of the assistant', () => {
    const want = kit.buildCompose({ platform: 'synology', network: 'host' });
    assert.match(want, /\$\{GC_CACHE_DIR:-\.\/gateway-cache\}:\/cache/);
    for (const dir of DIRS) {
      const f = mdFiles(dir).find((n) => n.startsWith('06-'));
      const text = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      const m = /<!-- compose:synology-host -->\n```yaml\n([\s\S]*?)```\n<!-- \/compose -->/.exec(text);
      assert.ok(m, `${dir}/${f}: compose block missing`);
      assert.equal(m[1], want, `${dir}/${f}: compose block differs from buildCompose() — copy it again`);
    }
  });
});
