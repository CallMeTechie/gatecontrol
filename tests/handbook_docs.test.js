'use strict';

// The user guide docs/handbuch (German) and docs/guide (English): both have
// the same chapters, every relative link and #anchor points to something that
// exists, and the Synology example compose in chapter 6 is exactly what the
// gateway assistant builds (public/js/gateway-kit.js buildCompose) — so the
// guide cannot drift from the assistant. The help links of the interface
// (public/js/handbook.js) point to files and #anchors that exist.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../public/js/gateway-kit');
const handbook = require('../public/js/handbook');

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

describe('help links into the user guide (public/js/handbook.js)', () => {
  const LANG_DIR = { de: 'docs/handbuch', en: 'docs/guide' };

  it('the address of the guide is set in one place', () => {
    assert.equal(handbook.BASE, 'https://github.com/CallMeTechie/gatecontrol/blob/master/docs/');
    assert.deepEqual(handbook.DIRS, { de: 'handbuch/', en: 'guide/' });
    assert.equal(handbook.url('index', 'de'), handbook.BASE + 'handbuch/README.md');
    assert.equal(handbook.url('index', 'en'), handbook.BASE + 'guide/README.md');
    assert.equal(handbook.url('index', 'en-GB'), handbook.BASE + 'guide/README.md');
    assert.equal(handbook.url('index', 'fr'), handbook.BASE + 'handbuch/README.md');
    assert.equal(handbook.url('no.such.topic', 'de'), null);
    // no other file of the interface carries the address itself
    const files = [
      ...fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js') && f !== 'handbook.js').map((f) => 'public/js/' + f),
      'templates/aurora/partials/topbar.njk', 'templates/aurora/pages/gateways.njk',
    ];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.equal(/gatecontrol\/blob\/master\/docs\/(handbuch|guide)/.test(text), false, f);
    }
  });

  for (const [topic, files] of Object.entries(handbook.TOPICS)) {
    it(`topic ${topic}: file and anchor exist in German and English`, () => {
      for (const lang of ['de', 'en']) {
        const ref = files[lang];
        assert.ok(ref, `${topic}: no ${lang} target`);
        const [file, hash] = ref.split('#');
        const abs = path.join(ROOT, LANG_DIR[lang], file);
        assert.ok(fs.existsSync(abs), `${topic} (${lang}): missing file ${file}`);
        if (hash) assert.ok(anchors(fs.readFileSync(abs, 'utf8')).has(hash), `${topic} (${lang}): missing anchor #${hash} in ${file}`);
        assert.equal(handbook.url(topic, lang), handbook.BASE + handbook.DIRS[lang] + ref);
      }
    });
  }

  it('every topic the interface names exists', () => {
    const used = new Set();
    const files = ['public/js/gateway-edge.js', 'public/js/gateway-net.js', 'public/js/gateway-home.js',
      'templates/aurora/partials/topbar.njk', 'templates/aurora/pages/gateways.njk'];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of text.matchAll(/\b(?:guide|handbookUrl)\('([^']+)'\)/g)) used.add(m[1]);
    }
    // the rows of the card "Funktionen dieses Gateways" name their topic as 'feat.' + key
    for (const k of ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'edge', 'zigbee']) used.add('feat.' + k);
    for (const tpc of ['index', 'gw.rpi', 'gw.synology', 'gw.linux', 'gw.proxmox', 'edge', 'mqtt', 'faq.utc', 'feat.dns', 'feat.cache']) {
      assert.ok(used.has(tpc), `${tpc} is not linked anywhere`);
    }
    for (const tpc of used) assert.ok(handbook.TOPICS[tpc], `unknown topic ${tpc}`);
  });

  it('the reasons of the edge channel lead to the guide (Edge-Dienst fehlt → chapter 6)', () => {
    const EK = require('../public/js/gateway-edge-kit');
    for (const r of EK.REASONS) {
      for (const platform of [null, 'rpi', 'synology', 'linux', 'proxmox']) {
        for (const lang of ['de', 'en']) {
          const u = EK.reasonDoc(r, platform, lang);
          assert.ok(u && u.startsWith(handbook.BASE + handbook.DIRS[lang]), `${r}/${platform}/${lang}`);
        }
      }
    }
    assert.match(EK.reasonDoc('edge_missing', 'synology', 'de'), /\/06-gateway-aktualisieren\.md#/);
    assert.match(EK.reasonDoc('edge_missing', 'linux', 'en'), /\/06-updating-a-gateway\.md#/);
  });

  it('the pages load the module and the server hands the helper to the templates', () => {
    const njk = fs.readFileSync(path.join(ROOT, 'templates/aurora/pages/gateways.njk'), 'utf8');
    assert.ok(njk.indexOf('/js/handbook.js') > 0 && njk.indexOf('/js/handbook.js') < njk.indexOf('/js/gateway-edge-kit.js'));
    assert.match(fs.readFileSync(path.join(ROOT, 'src/middleware/i18n.js'), 'utf8'), /res\.locals\.handbookUrl = /);
    for (const k of ['nav.handbook', 'gwiz.guide', 'gwe.reason.guide']) {
      for (const lang of ['de', 'en']) {
        const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n', lang + '.json'), 'utf8'));
        assert.ok(dict[k], `${k} (${lang})`);
      }
    }
  });
});
