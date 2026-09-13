'use strict';

// Static wiring of the security-options UI (docs/feature-security-options.md):
// editor blocks (backend TLS, body limit, mTLS, header presets) in all three
// themes, license-locked mTLS rendering, script order + island keys on
// zones.njk, the TLS island (CAA, "Alias von"), integration points in the
// scripts, i18n (one contiguous block at the end of de/en, identical keys),
// the appended so- CSS sections with balanced braces, and the CSP nonce on
// every page <style> block.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const S = require('../public/js/secopt-ui.js');
const THEMES = ['default', 'pro', 'aurora'];
const BLOCK_RE = /^(alias\.|backend_tls\.|headers\.preset_|body_limit\.|tls_profile\.|mtls\.|caa\.)/;

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const hasId = (html, id) => html.includes('id="' + id + '"');
const editorTpl = (theme) => read(`templates/${theme}/partials/modals/route-edit.njk`);

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addFilter('bytes', (v) => String(v || 0) + ' B');
env.addFilter('reltime', () => '—');
env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
function render(theme, features) {
  const t = (key, params) => {
    let s = de[key] !== undefined ? de[key] : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    return s;
  };
  return env.render(`${theme}/pages/zones.njk`, {
    theme, language: 'de', t, availableLanguages: ['de', 'en'],
    license: { features: Object.assign({ http_routes: -1, l4_routes: -1 }, features || {}), hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'csrf-token', appVersion: '9.9.9', appName: 'GateControl',
    baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme },
    title: 'Domains & Routen', activeNav: 'routes', currentPath: '/routes', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0, gatewayPools: [], l4BlockedPorts: [],
  });
}
// Section of a template between data-panel="<name>" and the next panel.
function panel(src, name) {
  const at = src.indexOf(`data-panel="${name}"`);
  assert.ok(at > 0, `panel ${name}`);
  const next = src.indexOf('data-panel="', at + 20);
  return src.slice(at, next > 0 ? next : undefined);
}

const BACKEND_IDS = ['edit-backend-tls-block', 'edit-route-backend-tls-verify', 'edit-route-backend-tls-server-name', 'edit-route-backend-tls-ca', 'edit-backend-tls-fields', 'edit-backend-tls-hint'];
const MTLS_IDS = ['edit-mtls-block', 'edit-route-mtls', 'edit-route-mtls-ca', 'edit-mtls-fields', 'edit-mtls-hint'];
const BODY_IDS = ['edit-body-limit-block', 'edit-route-max-body-mb'];

describe('security options: entry editor markup per theme', () => {
  for (const theme of THEMES) {
    it(`${theme}: backend TLS block sits on the general tab right under "Backend HTTPS"`, () => {
      const src = editorTpl(theme);
      for (const id of BACKEND_IDS) assert.ok(hasId(src, id), `${theme}: #${id}`);
      const general = panel(src, 'general');
      const bh = general.indexOf('id="edit-route-backend-https"');
      const block = general.indexOf('id="edit-backend-tls-block"');
      assert.ok(bh > 0 && block > bh && block - bh < 700, 'directly below the Backend HTTPS toggle');
      assert.ok(general.indexOf('id="edit-http-fields"') < block, 'inside the HTTP-only fields');
      assert.match(src, /id="edit-route-backend-tls-verify"[^>]*type="checkbox"|type="checkbox" id="edit-route-backend-tls-verify"/);
      assert.match(src, /<textarea[^>]*id="edit-route-backend-tls-ca"/);
      for (const [attr, key] of [['data-hint-gateway', 'backend_tls.hint_gateway'], ['data-hint-https', 'backend_tls.hint_https'],
        ['data-err-backend-ca-invalid', 'backend_tls.err.ca_invalid'], ['data-err-backend-server-name-invalid', 'backend_tls.err.server_name_invalid']]) {
        assert.ok(src.includes(`${attr}="{{ t('${key}') }}"`), `${theme}: ${attr}`);
      }
      for (const key of ['backend_tls.verify', 'backend_tls.server_name', 'backend_tls.ca']) assert.ok(src.includes(`t('${key}')`), key);
    });

    it(`${theme}: body limit on the security tab after HSTS, 0…4096 with the "0 = unbegrenzt" hint`, () => {
      const src = editorTpl(theme);
      for (const id of BODY_IDS) assert.ok(hasId(src, id), `${theme}: #${id}`);
      const sec = panel(src, 'security');
      assert.ok(sec.indexOf('id="edit-body-limit-block"') > sec.indexOf('id="edit-hsts-block"'), 'after the HSTS block');
      assert.match(sec, /<input type="number"[^>]*id="edit-route-max-body-mb" min="0" max="4096" step="1"/);
      assert.ok(sec.includes("t('body_limit.label')") && sec.includes("t('body_limit.hint')"));
      assert.ok(src.includes(`data-err-max-body-invalid="{{ t('body_limit.err.invalid') }}"`));
      assert.match(de['body_limit.hint'], /^0 = unbegrenzt/);
      assert.equal(de['body_limit.label'], 'Maximale Anfragegröße (MB)');
    });

    it(`${theme}: mTLS block on the auth tab with toggle, PEM field, hint and license lock`, () => {
      const src = editorTpl(theme);
      for (const id of MTLS_IDS) assert.ok(hasId(src, id), `${theme}: #${id}`);
      const auth = panel(src, 'auth');
      assert.ok(auth.includes('id="edit-mtls-block"'), 'inside the auth panel');
      assert.ok(auth.indexOf('id="edit-mtls-block"') > auth.indexOf('id="edit-route-auth-fields"'), 'after the auth method fields');
      assert.match(src, /<textarea[^>]*id="edit-route-mtls-ca"/);
      assert.ok(src.includes(`data-licensed="{{ '1' if license.features.route_auth else '0' }}"`));
      for (const [attr, key] of [['data-hint-https', 'mtls.hint_https'], ['data-err-ca-required', 'mtls.err.ca_required'], ['data-err-license', 'mtls.err.license'],
        ['data-err-mtls-ca-invalid', 'mtls.err.ca_invalid'], ['data-err-mtls-requires-https', 'mtls.err.requires_https'], ['data-err-mtls-mode-invalid', 'mtls.err.mode_invalid']]) {
        assert.ok(src.includes(`${attr}="{{ t('${key}') }}"`), `${theme}: ${attr}`);
      }
      assert.ok(src.includes("t('mtls.hint')") && src.includes("t('mtls.title')"));
      assert.match(de['mtls.hint'], /^Zusätzlich zu den anderen Methoden; Browser ohne passendes Zertifikat sehen einen TLS-Fehler, keine Login-Seite/);
    });

    it(`${theme}: header presets offer "Sicherheits-Header (modern)" + "CSP (nur eigene Quellen)" with a warning, HSTS hint kept`, () => {
      const src = editorTpl(theme);
      const hdr = panel(src, 'headers');
      assert.match(hdr, /<option value="security">\{\{ t\('headers\.preset_security'\)/);
      assert.match(hdr, /<option value="csp">\{\{ t\('headers\.preset_csp'\) \}\}<\/option>/);
      const warn = hdr.indexOf('id="edit-headers-csp-warning"');
      assert.ok(warn > hdr.indexOf('id="edit-headers-hsts-hint"') && warn < hdr.indexOf('id="edit-headers-request-list"'), 'warning between the HSTS hint and the lists');
      assert.match(hdr, /id="edit-headers-csp-warning"[^>]*hidden>\{\{ t\('headers\.preset_csp_warning'\) \}\}/);
    });

    it(`${theme}: zones.njk renders the mTLS block licensed and locked`, () => {
      const on = render(theme, { route_auth: true });
      const off = render(theme, { route_auth: false });
      const blk = (html) => /<div id="edit-mtls-block"[^>]*>/.exec(html)[0];
      assert.match(blk(on), /data-licensed="1"/);
      assert.doesNotMatch(blk(on), /feature-locked/);
      assert.match(blk(off), /data-licensed="0"/);
      assert.match(blk(off), /feature-locked/);
      assert.match(off, /id="edit-route-mtls" data-managed="true" aria-disabled="true" tabindex="-1"/, 'locked toggle is not wired by app.js');
      assert.match(off, /<textarea[^>]*id="edit-route-mtls-ca"[^>]*disabled>/);
      assert.ok(off.includes(de['mtls.locked']), 'lock hint');
      assert.doesNotMatch(on, /id="edit-route-mtls" data-managed/);
      assert.ok(on.includes(de['backend_tls.verify']) && on.includes(de['headers.preset_csp']), 'German texts rendered');
    });
  }
});

describe('security options: zones page wiring', () => {
  for (const theme of THEMES) {
    it(`${theme}: secopt-ui.js loads after hsts-ui.js and before domain-modal.js, after the entry editor`, () => {
      const src = read(`templates/${theme}/pages/zones.njk`);
      const order = ['/js/entry-editor.js?v=', '/js/zones-view.js?v=', '/js/tls-ui.js?v=', '/js/hsts-ui.js?v=', '/js/secopt-ui.js?v=', '/js/domain-modal.js?v=', '/js/zones-page.js?v='].map((s) => src.indexOf(s));
      order.forEach((i, n) => assert.ok(i > 0, `script ${n}`));
      for (let n = 1; n < order.length; n++) assert.ok(order[n] > order[n - 1], `order ${n}`);
      assert.equal(src.split('/js/secopt-ui.js').length, 2, 'loaded once');
    });

    it(`${theme}: the zones island lists every alias.* / tls_profile.* key and the keys secopt-ui.js uses`, () => {
      const src = read(`templates/${theme}/pages/zones.njk`);
      const m = /set zonesI18nKeys = \[([\s\S]*?)\]/.exec(src);
      const listed = Array.from(m[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
      assert.equal(new Set(listed).size, listed.length, 'no duplicates');
      for (const k of Object.keys(de).filter((x) => /^(alias|tls_profile)\./.test(x))) assert.ok(listed.includes(k), `${theme}: island has ${k}`);
      const js = read('public/js/secopt-ui.js');
      const used = new Set(Array.from(js.matchAll(/'((?:alias|tls_profile|body_limit|mtls|zones|common)\.[a-z0-9_.]+)'/g)).map((x) => x[1]));
      Object.values(S.ERROR_KEYS).forEach((k) => used.add(k));
      ['invalid', 'duplicate', 'limit'].forEach((c) => used.add(S.aliasCheckKey(c)));
      ['redirect', 'serve'].forEach((mode) => { used.add('alias.mode_' + mode); used.add('alias.mode_' + mode + '_hint'); });
      for (const k of used) {
        if (/[._]$/.test(k)) continue; // prefixes of keys built at runtime (covered above)
        assert.ok(listed.includes(k), `${theme}: island has ${k}`);
      }
    });

    it(`${theme}: the island renders the German strings`, () => {
      const html = render(theme, { route_auth: true });
      const isl = JSON.parse(/<script type="application\/json" id="zones-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.equal(isl['alias.www_checkbox'], 'www-Alias anlegen (Weiterleitung auf Hauptname)');
      assert.equal(isl['alias.menu'], 'Alias-Namen…');
      assert.equal(isl['tls_profile.v12'], '1.2 (Standard)');
      assert.equal(isl['body_limit.tag'], '≤ {{mb}} MB');
      assert.equal(isl['mtls.tag'], 'mTLS');
    });
  }

  it('the shared TLS island carries the CAA strings and "Alias von"', () => {
    const src = read('templates/partials/tls-i18n.njk');
    const listed = Array.from(/set tlsI18nKeys = \[([\s\S]*?)\]/.exec(src)[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
    for (const k of Object.keys(de).filter((x) => x.startsWith('caa.'))) assert.ok(listed.includes(k), k);
    assert.ok(listed.includes('alias.of'));
    const used = new Set();
    for (const f of ['public/js/tls-ui.js', 'public/js/certificates.js', 'public/js/settings.js']) {
      for (const m of read(f).matchAll(/'((?:caa|alias)\.[a-z0-9_.]+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 5, 'keys found');
    for (const k of used) assert.ok(listed.includes(k), `tls island has ${k}`);
  });
});

describe('security options: script integration', () => {
  it('secopt-ui.js: contract API, no innerHTML, PUT /hosts/:id and /domains/:id/defaults', () => {
    const src = stripComments(read('public/js/secopt-ui.js'));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    for (const f of ['aliasTags', 'aliasMenuItem', 'openAliasDialog', 'wwwCheckbox', 'entryTags', 'tlsProfileControl', 'confirmTlsProfile', 'applyPreset', 'pausedNotice']) assert.match(src, new RegExp('\\b' + f + '\\b'), f);
    assert.match(src, /api\.put\('\/api\/v1\/hosts\/' \+ host\.id, \{ aliases: st\.labels\.slice\(\), alias_mode: st\.mode \}\)/);
    assert.match(src, /api\.put\('\/api\/v1\/domains\/' \+ zone\.domain_id \+ '\/defaults', \{ tls_min_version: next \}\)/);
    assert.match(src, /tls\.state === 'paused'/, 'paused alias warning');
    assert.match(src, /zones-i18n/, 'reads the zones island');
    for (const cls of ['so-alias-tag', 'so-alias-dialog', 'so-alias-input', 'so-alias-add-btn', 'so-alias-remove', 'so-btn-save', 'so-alias-mode-', 'so-www-cb', 'so-body-tag', 'so-mtls-tag', 'so-tls-min', 'so-btn-ok', 'so-field-error']) {
      assert.ok(src.includes(cls), cls);
    }
  });

  it('domain-modal.js renders alias tags, the menu item, the www checkbox, the TLS select and the entry tags', () => {
    const dm = stripComments(read('public/js/domain-modal.js'));
    assert.match(dm, /GCSecOptUI\.aliasTags\(host\)/);
    assert.match(dm, /GCSecOptUI\.aliasMenuItem\(host, zone, \{ onChanged:/);
    assert.match(dm, /noteAliasPaused\(res\)/);
    assert.match(dm, /SO\.wwwCheckbox\(nh, zone\)/);
    assert.match(dm, /GCSecOptUI\.wwwAliasFields\(nh, zone\)/);
    assert.match(dm, /www: true/, 'checkbox pre-checked in a fresh draft');
    assert.match(dm, /GCSecOptUI\.tlsProfileControl\(zone, \{ onChanged: afterMutation \}\)/);
    assert.match(dm, /tlsMin \? ' so-panel5' : ''/);
    assert.match(dm, /GCSecOptUI\.entryTags\(e\)/);
    assert.ok(dm.indexOf('GCSecOptUI.entryTags(e)') > dm.indexOf('GCHstsUI.entryTag(e'), 'after the HSTS tag');
    assert.match(dm, /window\.GCSecOptUI \?|window\.GCSecOptUI &&/, 'guards the absence of secopt-ui.js');
  });

  it('zones-page.js shows "+ www", certificates.js "Alias von …", tls-ui.js/settings.js the CAA hint', () => {
    assert.match(stripComments(read('public/js/zones-page.js')), /SO\.aliasSummary\(host\)/);
    const certs = stripComments(read('public/js/certificates.js'));
    assert.match(certs, /h\.alias_of \? el\('span', \{ class: 'tg-sub so-alias-of', text: t\('alias\.of', \{ host: h\.alias_of \}\) \}\)/);
    const tg = stripComments(read('public/js/tls-ui.js'));
    assert.match(tg, /caaEl\(pf\),\s*recordsEl\(pf\)/, 'preflight dialog shows the CAA block before the records');
    assert.match(tg, /caa_status/);
    assert.match(tg, /copyText\(text\)/);
    assert.match(tg, /navigator\.clipboard/);
    assert.match(stripComments(read('public/js/settings.js')), /TG\.caaEl\(check, \{ compact: true \}\)/);
  });

  it('entry-editor.js populates, greys out, validates, sends and maps the security-option fields', () => {
    const ed = stripComments(read('public/js/entry-editor.js'));
    assert.match(ed, /populateSecOpts\(route\)/);
    assert.match(ed, /setupSecOptControls\(\);/);
    assert.match(ed, /secoptTargetKind\(\) === 'gateway'/, 'greyed for gateway/pool targets');
    assert.match(ed, /isOn\('edit-route-backend-https'\)/);
    assert.match(ed, /\(target\.target_kind \|\| 'peer'\) !== 'gateway'/, 'backend TLS fields not sent for gateway targets');
    for (const f of ['backend_tls_verify', 'backend_tls_server_name', 'backend_tls_ca_pem', 'max_body_mb', 'mtls_enabled', 'mtls_ca_pem']) assert.match(ed, new RegExp('out\\.' + f + ' ='), f);
    assert.match(ed, /Object\.assign\(payload, secopt\.fields\)/);
    assert.match(ed, /mtlsLicensed\(\)/, 'mTLS only sent with the license');
    assert.match(ed, /data\.feature === 'route_auth'/, '403 of the route_auth gate mapped');
    assert.match(ed, /if \(showSecoptError\(data\.code\)\) return;/);
    for (const code of ['BACKEND_CA_INVALID', 'BACKEND_SERVER_NAME_INVALID', 'MAX_BODY_INVALID', 'MTLS_CA_INVALID', 'MTLS_REQUIRES_HTTPS', 'MTLS_MODE_INVALID']) assert.ok(ed.includes(code + ':'), code);
    assert.match(ed, /GCSecOptUI/);
    assert.match(ed, /SO\.applyPreset\(editHeadersResponse, val\)/);
    assert.match(ed, /cspWarn\.hidden = val !== 'csp'/);
    assert.doesNotMatch(ed, /X-XSS-Protection/, 'the old preset is gone');
    assert.doesNotMatch(ed, /Strict-Transport-Security/);
  });
});

describe('security options: i18n', () => {
  it('de.json and en.json carry identical key sets with matching placeholders', () => {
    const pick = (o) => Object.keys(o).filter((k) => BLOCK_RE.test(k)).sort();
    assert.deepEqual(pick(de), pick(en));
    assert.ok(pick(de).length >= 75);
    for (const k of pick(de)) {
      assert.ok(typeof de[k] === 'string' && de[k].length && typeof en[k] === 'string' && en[k].length, k);
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('is ONE contiguous block at the end of both files, right after hsts.*', () => {
    // The WAF block (docs/feature-waf.md: nav.waf + waf.*) may follow it.
    const LATER_BLOCKS = /^(waf\.|nav\.waf$)/;
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.findIndex((k) => BLOCK_RE.test(k) && k !== 'headers.preset_cors');
      assert.ok(first > 0, `${name}: block present`);
      assert.ok(keys[first - 1].startsWith('hsts.'), `${name}: appended after the HSTS block (${keys[first - 1]})`);
      let i = first;
      for (; i < keys.length && BLOCK_RE.test(keys[i]); i++) { /* security options block */ }
      for (; i < keys.length; i++) assert.ok(LATER_BLOCKS.test(keys[i]), `${name}: ${keys[i]} after the security options block`);
      assert.ok(keys.indexOf('headers.preset_security') >= first, `${name}: the updated preset label moved into the block`);
      assert.ok(keys.indexOf('headers.preset_cors') < first, `${name}: CORS label untouched`);
    }
  });

  it('every key used by the scripts and templates exists in both languages', () => {
    const keys = new Set();
    const files = ['public/js/secopt-ui.js', 'public/js/entry-editor.js', 'public/js/tls-ui.js', 'public/js/certificates.js', 'public/js/settings.js',
      'templates/partials/tls-i18n.njk', ...THEMES.flatMap((th) => [`templates/${th}/pages/zones.njk`, `templates/${th}/partials/modals/route-edit.njk`])];
    for (const f of files) for (const m of read(f).matchAll(/['"]((?:alias|backend_tls|body_limit|tls_profile|mtls|caa|headers\.preset)[a-z0-9_.]*)['"]/g)) keys.add(m[1]);
    Object.values(S.ERROR_KEYS).forEach((k) => keys.add(k));
    for (const k of keys) {
      if (!k.includes('.') || /[._]$/.test(k)) continue; // runtime prefixes ('alias.mode_' + mode)
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
    assert.ok(keys.size > 60, 'keys collected');
  });

  it('German contract texts', () => {
    assert.equal(de['alias.www_checkbox'], 'www-Alias anlegen (Weiterleitung auf Hauptname)');
    assert.equal(de['alias.menu'], 'Alias-Namen…');
    assert.equal(de['alias.of'], 'Alias von {{host}}');
    assert.equal(de['backend_tls.verify'], 'Backend-Zertifikat prüfen');
    assert.equal(de['backend_tls.server_name'], 'Servername (optional)');
    assert.equal(de['backend_tls.ca'], 'Eigene CA (PEM, optional)');
    assert.match(de['backend_tls.hint_gateway'], /Verbindung zum Ziel baut das Gateway auf/);
    assert.equal(de['tls_profile.label'], 'TLS mindestens');
    assert.match(de['tls_profile.confirm_13_detail'], /Alte Clients/);
    assert.equal(de['mtls.title'], 'Client-Zertifikat (mTLS)');
    assert.equal(de['caa.allows'], 'CAA schützt die Domain');
  });
});

describe('security options: styles and CSP', () => {
  it('app.css / pro.css / aurora.css end with one so- section after hs-, braces balanced', () => {
    for (const f of ['app.css', 'pro.css', 'aurora.css']) {
      const css = read('public/css/' + f);
      const marker = '/* ─── Security options (so-) ─── */';
      const at = css.indexOf(marker);
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf(marker, at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, ''), /\.so-[a-z]/, `${f}: no so- rules before the section`);
      const hs = css.indexOf('/* ─── HSTS (hs-) ─── */');
      assert.ok(hs > 0 && hs < at, `${f}: after the hs- section`);
      // Only the WAF section (docs/feature-waf.md) may follow.
      const next = css.indexOf('/* ─── ', at + 1);
      assert.ok(next === -1 || css.startsWith('/* ─── WAF (wf-) ─── */', next), `${f}: so- is the last section before wf-`);
      const whole = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length, `${f}: braces balanced`);
    }
    for (const f of ['app.css', 'pro.css']) {
      const css = read('public/css/' + f);
      for (const cls of ['.zn-panel.so-panel5', '.tag.so-alias-tag', '.so-alias-more', '.so-alias-row', '.so-radios', '.tag.so-body-tag', '.tag.so-mtls-tag',
        '.so-editor-block.so-locked', 'textarea.so-pem', '.so-switch-row', 'input.so-num', '.so-warn', '.so-caa-none', '.so-caa-ok', '.so-caa-record', '.btn.so-copy', '.so-alias-of', '.so-www-check']) {
        assert.ok(css.includes(cls), `${f}: ${cls}`);
      }
      assert.match(css, /@media \(max-width: 900px\) \{[^}]*\.zn-panel\.so-panel5, \.zn-panel\.hs-panel4\.so-panel5 \{ grid-template-columns: 1fr; \}/, `${f}: single column on phones`);
    }
  });

  it('every page <style> block carries the CSP nonce (users.njk fix)', () => {
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(dir + '/' + d.name) : [dir + '/' + d.name]));
    // gateway-offline.njk is rendered into a Caddy static_response (no app CSP).
    const files = walk('templates').filter((f) => f.endsWith('.njk') && !f.endsWith('/gateway-offline.njk'));
    const bad = [];
    for (const f of files) for (const m of read(f).matchAll(/<style\b[^>]*>/g)) if (!/nonce="\{\{ cspNonce \}\}"/.test(m[0])) bad.push(f + ': ' + m[0]);
    assert.deepEqual(bad, []);
    assert.match(read('templates/default/pages/users.njk'), /<style nonce="\{\{ cspNonce \}\}">/);
  });
});
