'use strict';

// Static wiring of the TLS-guard UI (docs/feature-tls-guard.md): every id the
// scripts query exists in the templates of all three themes, script order,
// the #tls-i18n island, i18n key coverage (tls.*, dns_check.*, settings.tls.*)
// in de.json + en.json, the appended tg- CSS sections and the event bridge.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const TG = require('../public/js/tls-ui.js');
const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)
const PREFIX_RE = /^(tls\.|dns_check\.|settings\.tls\.)/;

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tpl = (theme, page) => read(`templates/${theme}/pages/${page}.njk`);

function idsQueried(src) {
  const ids = new Set();
  for (const m of src.matchAll(/getElementById\('([a-z0-9-]+)'\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/\$\('([a-z0-9-]+)'\)/g)) ids.add(m[1]);
  return ids;
}

describe('TLS guard: DOM hooks per theme', () => {
  const certIds = idsQueried(stripComments(read('public/js/certificates.js')));
  // tiles are addressed as 'tg-tile-' + k(+'-val') at runtime
  for (const k of ['issued', 'expiring', 'failed', 'paused']) { certIds.add('tg-tile-' + k); certIds.add('tg-tile-' + k + '-val'); }
  const TLS_SETTINGS_IDS = ['tls-max-attempts', 'tls-max-attempts-status', 'domains-server-ipv6', 'domains-server-ipv6-input', 'domains-server-ip-input', 'domains-server-ip-save', 'domains-tbody', 'domains-table'];

  for (const theme of THEMES) {
    it(`${theme}/certificates.njk has every id certificates.js queries (+ tls-i18n) and the scripts in order`, () => {
      const src = tpl(theme, 'certificates');
      assert.ok(certIds.size >= 5, 'ids found in certificates.js');
      for (const id of certIds) assert.ok(src.includes(`id="${id}"`), `${theme}: #${id}`);
      assert.match(src, /include "partials\/tls-i18n\.njk"/);
      const ui = src.indexOf('/js/tls-ui.js?v=');
      const page = src.indexOf('/js/certificates.js?v=');
      assert.ok(ui > 0 && page > ui, 'tls-ui.js before certificates.js');
      assert.doesNotMatch(src, /certificates\.status_auto_tls|route-item/, 'old fake-status markup gone');
    });

    it(`${theme}/zones.njk loads tls-ui.js between zones-view.js and domain-modal.js and includes the island`, () => {
      const src = tpl(theme, 'zones');
      const view = src.indexOf('/js/zones-view.js?v=');
      const ui = src.indexOf('/js/tls-ui.js?v=');
      const dm = src.indexOf('/js/domain-modal.js?v=');
      assert.ok(view > 0 && ui > view && dm > ui, `${theme}: order zones-view < tls-ui < domain-modal`);
      assert.match(src, /include "partials\/tls-i18n\.njk"/);
      assert.ok(src.indexOf('id="zones-i18n"') < src.indexOf('partials/tls-i18n.njk'), 'tls island after the zones island');
    });

    it(`${theme}/settings.njk has the TLS fields, the IPv6 override and tls-ui.js before settings.js`, () => {
      const src = tpl(theme, 'settings');
      for (const id of TLS_SETTINGS_IDS) assert.ok(src.includes(`id="${id}"`), `${theme}: #${id}`);
      assert.match(src, /id="tls-max-attempts"[^>]*\bmin="0"[^>]*\bmax="10"[^>]*\bvalue="3"/, 'range 0–10, default 3');
      assert.match(src, /include "partials\/tls-i18n\.njk"/);
      const ui = src.indexOf('/js/tls-ui.js?v=');
      const core = src.indexOf('settingsAutosaveCore.js');
      const main = src.indexOf('/js/settings.js?v=');
      assert.ok(ui > 0 && main > ui, 'tls-ui.js before settings.js');
      assert.ok(core > 0 && core < main, 'autosave core still before settings.js');
      // the max-attempts field sits in the ACME e-mail card, right after its status line
      const acme = src.indexOf('id="acme-email-status"');
      const field = src.indexOf('id="tls-max-attempts"');
      assert.ok(acme > 0 && field > acme && field - acme < 900, 'field next to the ACME e-mail');
    });
  }

  it('the settings script sends both overrides and binds the max-attempts autosave to PUT /settings/tls', () => {
    const js = stripComments(read('public/js/settings.js'));
    assert.match(js, /\/api\/v1\/settings\/domains\/server-ip',\s*\{\s*ip:\s*ip,\s*ipv6:\s*ipv6\s*\}/);
    const i = js.indexOf("cluster: 'tls-guard'");
    assert.ok(i > 0, 'tls-guard autosave cluster');
    assert.match(js.slice(i, i + 900), /\/api\/v1\/settings\/tls',\s*\{\s*max_attempts:/);
    assert.match(js, /appendDnsInfo\(/);
  });

  it('zones scripts use the TLS guard hooks and keep a fallback without tls-ui.js', () => {
    const page = stripComments(read('public/js/zones-page.js'));
    const dm = stripComments(read('public/js/domain-modal.js'));
    assert.match(page, /TG\.hostProblemText\(host\)/);
    assert.match(page, /TG\.decorateChip\(/);
    assert.match(page, /TG\.dnsTag\(zone/);
    assert.match(page, /'gc:tls'/);
    assert.match(dm, /GCTlsUI\.entryTag\(e/);
    assert.match(dm, /GCTlsUI\.dnsTag\(zone/);
    assert.match(dm, /noteTlsPaused\(res/);
    assert.match(dm, /GCTlsUI\.noticeEl\(/);
    assert.match(dm, /\|\| verificationTag\(zone\)/, 'falls back to the plain verification tag');
  });

  it('events.js forwards the tls SSE event as gc:tls', () => {
    const list = read('public/js/events.js').match(/\[([^\]]*'routes'[^\]]*)\]\.forEach/);
    assert.ok(list && /'tls'/.test(list[1]), 'tls is in the forwarded SSE types');
  });

  it('tls-ui.js exposes the contract API and builds DOM without innerHTML', () => {
    const src = stripComments(read('public/js/tls-ui.js'));
    for (const f of ['openDetail', 'openPreflight', 'retry', 'shortReason', 'stateTag', 'openDnsCheck', 'dnsTag', 'entryTag', 'decorateChip', 'noticeEl']) {
      assert.match(src, new RegExp('\\b' + f + '\\b'), f);
    }
    for (const f of ['tls-ui.js', 'certificates.js']) {
      assert.doesNotMatch(stripComments(read('public/js/' + f)), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    }
    assert.match(src, /\/api\/v1\/tls\/status/);
    assert.match(src, /\/api\/v1\/tls\/preflight\//);
    assert.match(src, /\/retry'/);
    assert.match(src, /PREFLIGHT_FAILED/);
    assert.match(src, /tls\.backend_missing/, '404 degrades to a hint');
  });
});

describe('TLS guard: i18n', () => {
  // Every literal key + the ones built at runtime from code lists.
  function usedKeys() {
    const keys = new Set();
    const files = ['public/js/tls-ui.js', 'public/js/certificates.js', 'public/js/zones-page.js', 'public/js/domain-modal.js', 'public/js/settings.js',
      ...THEMES.flatMap((th) => ['certificates', 'zones', 'settings'].map((p) => `templates/${th}/pages/${p}.njk`)), 'templates/partials/tls-i18n.njk'];
    for (const f of files) {
      // full keys only — 'tls.err.' + code style prefixes are covered by the code lists below
      for (const m of read(f).matchAll(/['"]((?:tls|dns_check|settings\.tls)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*)['"]/g)) keys.add(m[1]);
    }
    for (const c of TG.TLS_ERR_CODES) keys.add('tls.err.' + c);
    for (const c of TG.DNS_CODES.concat(['unknown'])) { keys.add('dns_check.' + c); keys.add('dns_check.' + c + '_hint'); }
    for (const s of ['issued', 'expiring', 'pending', 'failed', 'failed_nomax', 'paused', 'internal', 'none', 'unknown']) keys.add('tls.state_' + s);
    return Array.from(keys).sort();
  }
  const pick = (o) => Object.keys(o).filter((k) => PREFIX_RE.test(k));

  it('every key used by scripts and templates exists in de.json and en.json', () => {
    const used = usedKeys();
    assert.ok(used.length > 80, 'keys collected');
    for (const k of used) {
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
  });

  it('de.json and en.json carry identical tls./dns_check./settings.tls. key sets with matching placeholders', () => {
    assert.deepEqual(pick(de).sort(), pick(en).sort());
    assert.ok(pick(de).length > 100);
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('the block is one contiguous block in both files', () => {
    // Contract: the block stays CONTIGUOUS and identical in de/en. Its former
    // "at the end of the file" clause was dropped once several feature blocks
    // (problems.*, entry.*, l4p.* …) shared the tail — see
    // docs/feature-next-package.md.
    for (const [nm, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const idx = keys.map((k, i) => (PREFIX_RE.test(k) ? i : -1)).filter((i) => i >= 0);
      assert.ok(idx.length > 0, `${nm}: block present`);
      assert.equal(idx[idx.length - 1] - idx[0], idx.length - 1, `${nm}: block is contiguous`);
    }
  });

  it('the shared island partial lists every contract key once, plus the common.* strings it needs', () => {
    const src = read('templates/partials/tls-i18n.njk');
    const m = /set tlsI18nKeys = \[([\s\S]*?)\]/.exec(src);
    assert.ok(m, 'tlsI18nKeys defined');
    const listed = Array.from(m[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
    assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    const contract = pick(de).sort();
    assert.deepEqual(listed.filter((k) => PREFIX_RE.test(k)).sort(), contract);
    for (const k of ['common.close', 'common.cancel', 'common.loading', 'common.refresh']) assert.ok(listed.includes(k), k);
    assert.match(src, /id="tls-i18n" nonce="\{\{ cspNonce \}\}"/);
  });
});

describe('TLS guard: styles', () => {
  it('each theme stylesheet has exactly one appended tg- section and no tg- rules before it', () => {
    for (const f of ['pro.css', 'aurora.css']) {
      const css = read('public/css/' + f);
      const marker = '/* ─── TLS guard (tg-) ─── */';
      const at = css.indexOf(marker);
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf(marker, at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at), /\.tg-/, `${f}: no tg- rules before the section`);
      const zn = css.indexOf('/* ─── Domain zones (zn-) ─── */');
      assert.ok(zn > 0 && zn < at, `${f}: appended after the zn- section`);
    }
    for (const f of ['pro.css']) {
      const css = read('public/css/' + f);
      for (const cls of ['.tg-tiles', '.tg-banner', '.tg-chips', '.tg-table', '.tg-orig', '.tg-actions', '.tg-records', '.tg-preflight', '.tg-notice', '.tg-chip-warn', '.tg-entry-tag', '.toast-warning']) {
        assert.ok(css.includes(cls), `${f}: ${cls}`);
      }
    }
  });
});
