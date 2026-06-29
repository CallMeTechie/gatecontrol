'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const ADMIN = ['midea.fan.label', 'midea.fan.auto', 'midea.fan.silent', 'midea.extras.label', 'midea.turbo', 'midea.eco', 'midea.device.outdoor'];
const PORTAL = ['portal.midea.fan', 'portal.midea.fan_auto', 'portal.midea.fan_silent', 'portal.midea.extras', 'portal.midea.turbo', 'portal.midea.eco', 'portal.midea.outdoor', 'portal.midea.target', 'portal.midea.mode'];

test('admin + portal midea extra keys exist in de and en', () => {
  for (const k of [...ADMIN, ...PORTAL]) {
    assert.ok(de[k] && de[k].trim(), `de missing ${k}`);
    assert.ok(en[k] && en[k].trim(), `en missing ${k}`);
  }
});

test('admin midea.js renders fan slider + auto/turbo/eco chips + outdoor', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../public/js/midea.js'), 'utf8');
  for (const m of ['data-act="fan"', 'data-act="fan-auto"', 'data-act="turbo"', 'data-act="eco"', 'ac-ring-wrap', 'ac-outdoor']) {
    assert.ok(src.includes(m), `admin midea.js missing marker ${m}`);
  }
});

test('admin layouts register the new midea keys in client GC.t bridge', () => {
  const fs = require('fs'), path = require('path');
  const KEYS = ['midea.fan.label', 'midea.fan.auto', 'midea.fan.silent', 'midea.extras.label', 'midea.turbo', 'midea.eco', 'midea.device.outdoor'];
  for (const layout of ['aurora', 'default', 'pro']) {
    const src = fs.readFileSync(path.join(__dirname, `../templates/${layout}/layout.njk`), 'utf8');
    for (const k of KEYS) assert.ok(src.includes(`'${k}'`), `${layout}/layout.njk missing client i18n key ${k}`);
  }
});
