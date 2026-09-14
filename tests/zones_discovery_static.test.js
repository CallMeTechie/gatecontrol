'use strict';

// Static guarantees for the LAN-discovery picker of the domain dialog
// (public/js/domain-modal.js + zones-view.js; docs/feature-tls-guard.md,
// "LAN-Erkennung im Domain-Dialog"): i18n block placement, JSON-island keys,
// CSS classes, endpoints, and a vm load of domain-modal.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)

const modalJs = read('public', 'js', 'domain-modal.js');
const viewJs = read('public', 'js', 'zones-view.js');
const deRaw = read('src', 'i18n', 'de.json');
const enRaw = read('src', 'i18n', 'en.json');
const de = JSON.parse(deRaw);
const en = JSON.parse(enRaw);

const KEYS = Object.keys(de).filter((k) => k.startsWith('zones.discovery.'));
const USED_KEYS = Array.from(modalJs.matchAll(/'(zones\.discovery\.[a-z0-9_]+)'/g)).map((m) => m[1]);
const CSS = { pro: read('public', 'css', 'pro.css') }; // Aurora's base stylesheet
const CSS_SECTION = '/* ─── Domain zones: LAN discovery (zn-disc-) ─── */';

describe('zones.discovery i18n', () => {
  it('exists in both locales with identical key sets', () => {
    assert.ok(KEYS.length >= 20, 'has keys');
    for (const k of KEYS) assert.ok(typeof en[k] === 'string' && en[k], `en: ${k}`);
    assert.deepEqual(Object.keys(en).filter((k) => k.startsWith('zones.discovery.')).sort(), KEYS.slice().sort());
  });
  it('every key domain-modal.js uses exists (incl. runtime-built err_* keys)', () => {
    for (const k of new Set(USED_KEYS)) assert.ok(de[k] !== undefined, `de: ${k}`);
    for (const k of ['zones.discovery.err_no_subnet', 'zones.discovery.err_gateway_unreachable', 'zones.discovery.hint_license', 'zones.discovery.scanning', 'zones.discovery.timed_out', 'zones.discovery.age']) {
      assert.ok(de[k] !== undefined && en[k] !== undefined, k);
    }
  });
  it('is ONE contiguous block immediately after the "host.create" line (de + en)', () => {
    for (const [name, raw] of [['de', deRaw], ['en', enRaw]]) {
      const lines = raw.split('\n');
      const anchor = lines.findIndex((l) => l.includes('"host.create"'));
      assert.ok(anchor >= 0, `${name}: host.create present`);
      const idx = lines.map((l, i) => (/^\s*"zones\.discovery\./.test(l) ? i : -1)).filter((i) => i >= 0);
      assert.equal(idx.length, KEYS.length, `${name}: one line per key`);
      assert.equal(idx[0], anchor + 1, `${name}: block starts right after host.create`);
      assert.equal(idx[idx.length - 1] - idx[0] + 1, idx.length, `${name}: block is contiguous`);
    }
  });
  it('uses {{param}} placeholders as the modal t() expects', () => {
    for (const loc of [de, en]) {
      assert.match(loc['zones.discovery.age'], /\{\{n\}\}/);
      assert.match(loc['zones.discovery.adopted'], /\{\{ip\}\}/);
      assert.match(loc['zones.discovery.err_scan'], /\{\{error\}\}/);
      for (const k of KEYS) assert.doesNotMatch(loc[k], /(^|[^{])\{[a-z]+\}([^}]|$)/, `${k}: single-brace placeholder`);
    }
  });
  for (const theme of THEMES) {
    it(`${theme}: zones.njk lists every zones.discovery key in the #zones-i18n island`, () => {
      const tpl = read('templates', theme, 'pages', 'zones.njk');
      const listed = new Set(Array.from(tpl.matchAll(/'(zones\.discovery\.[a-z0-9_]+)'/g)).map((m) => m[1]));
      for (const k of KEYS) assert.ok(listed.has(k), `${theme}: ${k} in zonesI18nKeys`);
    });
  }
});

describe('domain-modal.js: discovery wiring', () => {
  it('renders the button/hint in renderNewHostCard and resets capability in open()', () => {
    const card = modalJs.slice(modalJs.indexOf('function renderNewHostCard('), modalJs.indexOf('async function openTemplateMenu('));
    assert.match(card, /renderDiscoveryControl\(zone\)/, 'card calls renderDiscoveryControl');
    const open = modalJs.slice(modalJs.indexOf('function open(domainId, opts)'), modalJs.indexOf('function close()'));
    assert.match(open, /discReset\(\)/, 'open() resets the discovery cache');
  });
  it('uses the contract endpoints and the SSE event', () => {
    assert.match(modalJs, /api\.get\('\/api\/v1\/gateways'\)/);
    assert.match(modalJs, /'\/api\/v1\/gateways\/' \+ [^\n]+ \+ '\/discovered'/);
    assert.match(modalJs, /'\/api\/v1\/gateways\/' \+ [^\n]+ \+ '\/discover'/);
    assert.match(modalJs, /\/api\/v1\/gateway-pools\/' \+ [^\n]+ \+ '\/members'/);
    assert.match(modalJs, /addEventListener\('gc:gateway_discovery'/);
    assert.match(modalJs, /removeEventListener\('gc:gateway_discovery'/);
    for (const code of ['scan_in_progress', 'discovery_disabled', 'capability_unavailable', 'no_subnet', 'gateway_unreachable', 'gateway_lan_discovery']) {
      assert.ok(modalJs.includes(`'${code}'`), `handles ${code}`);
    }
    assert.match(modalJs, /href: '\/gateways'/, 'hint links to /gateways');
  });
  it('never submits after adopting and never uses innerHTML', () => {
    const adopt = modalJs.slice(modalJs.indexOf('function adoptDiscoveredDevice('));
    assert.doesNotMatch(adopt, /submitNewHost|api\.post/);
    assert.match(adopt, /data-zn-key="nhsub"/, 'focuses the subdomain field');
    assert.doesNotMatch(modalJs, /\.innerHTML\b/);
  });
  it('DOM hooks used by the E2E scenario exist', () => {
    for (const cls of ['zn-disc-btn', 'zn-disc-hint', 'zn-disc-dialog', 'zn-disc-gw', 'zn-disc-filter', 'zn-disc-scan', 'zn-disc-status', 'zn-disc-hintbox', 'zn-disc-list', 'zn-disc-row', 'zn-disc-port', 'zn-disc-adopt', 'zn-disc-empty']) {
      assert.ok(modalJs.includes(cls), `class ${cls}`);
    }
    assert.match(modalJs, /'data-zn-key': 'nhdisc'/);
  });
  it('every layout-relevant zn-disc- class is styled in pro.css (aurora loads pro.css)', () => {
    // Hook-only classes (E2E selectors / text targets) inherit their look from
    // .btn, .zn-link, .zn-input, .modal-overlay etc. and need no rule.
    const HOOK_ONLY = new Set(['zn-disc-btn', 'zn-disc-link', 'zn-disc-dialog', 'zn-disc-filter', 'zn-disc-hintmsg', 'zn-disc-scanning', 'zn-disc-host', 'zn-disc-adopt']);
    const used = new Set(Array.from(modalJs.matchAll(/\bzn-disc-[a-z0-9-]+/g)).map((m) => m[0]));
    assert.ok(used.size >= 15);
    for (const [theme, css] of Object.entries(CSS)) {
      const sec = css.indexOf(CSS_SECTION);
      assert.ok(sec > 0, `${theme}: CSS section present`);
      assert.equal(css.indexOf(CSS_SECTION, sec + 1), -1, `${theme}: section appears once`);
      assert.ok(css.slice(sec).trim().length > 200, `${theme}: section is at the end of the file with content`);
      const tail = css.slice(sec);
      for (const cls of used) if (!HOOK_ONLY.has(cls)) assert.ok(tail.includes('.' + cls), `${theme}: .${cls} styled`);
    }
  });
});

describe('zones-view.js: discovery helpers', () => {
  it('are appended after the UMD factory and exported', () => {
    const V = require('../public/js/zones-view.js');
    for (const fn of ['suggestSubdomain', 'classifyDiscoveredPort', 'entryDraftFromPort', 'devicePorts', 'filterDiscovered', 'discoveryAgeMinutes', 'discoveryStateOf']) {
      assert.equal(typeof V[fn], 'function', fn);
    }
    assert.ok(viewJs.indexOf('classifyDiscoveredPort') > viewJs.indexOf('root.GCZonesView = factory()'), 'helpers live in the appended block');
  });
  it('load in a browser-like scope onto window.GCZonesView', () => {
    const window = {};
    const ctx = vm.createContext({ window, self: window, console });
    vm.runInContext(viewJs, ctx, { filename: 'zones-view.js' });
    assert.equal(typeof window.GCZonesView.suggestSubdomain, 'function');
    assert.equal(typeof window.GCZonesView.previewFqdn, 'function');
  });
});

describe('domain-modal.js loads in a vm (stub DOM, no modal)', () => {
  it('exports GCZonesUI and stops before the modal wiring', () => {
    const noop = () => {};
    const stubEl = () => ({ id: '', style: {}, dataset: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, appendChild: noop, addEventListener: noop, setAttribute: noop, replaceChildren: noop });
    const document = {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: stubEl, createElementNS: stubEl, createTextNode: (s) => ({ text: s }),
      addEventListener: noop, removeEventListener: noop, body: { appendChild: noop },
    };
    const window = { GC: { t: {}, csrfToken: 'x' } };
    const ctx = vm.createContext({ window, document, console, setTimeout, clearTimeout, setInterval, clearInterval, localStorage: { getItem: () => null, setItem: noop } });
    vm.runInContext(viewJs, ctx, { filename: 'zones-view.js' });
    vm.runInContext(modalJs, ctx, { filename: 'domain-modal.js' });
    assert.equal(typeof window.GCZonesUI.dialog, 'function');
    assert.equal(window.GCDomainModal, undefined, 'no modal in the page → no GCDomainModal');
  });
});
