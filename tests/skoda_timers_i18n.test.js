'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const BASE = ['title', 'none', 'timer', 'active', 'time', 'days', 'save', 'saved', 'save_failed', 'invalid', 'not_found', 'readonly'];
const ADMIN_KEYS = BASE.map((k) => `skoda.timers.${k}`).concat(DAYS.map((d) => `skoda.timers.day.${d}`));
const PORTAL_KEYS = BASE.map((k) => `portal.skoda.timers.${k}`).concat(DAYS.map((d) => `portal.skoda.timers.day.${d}`));

test('all timer keys exist in de and en', () => {
  for (const k of ADMIN_KEYS.concat(PORTAL_KEYS)) {
    assert.ok(de[k] && de[k].trim(), `de ${k}`);
    assert.ok(en[k] && en[k].trim(), `en ${k}`);
  }
});

test('all three layouts carry the skoda.timers.* GC.t whitelist', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const layout = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'layout.njk'), 'utf8');
    for (const k of ADMIN_KEYS) assert.ok(layout.includes(`'${k}'`), `${theme} ${k}`);
  }
});

test('the portal PT block carries every timer key', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  for (const k of PORTAL_KEYS) assert.ok(njk.includes(`t('${k}')`), `PT block ${k}`);
});

test('skoda.js renders the timer block and wires timer_set', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'skoda.js'), 'utf8');
  assert.match(js, /skoda-timers-block/);
  assert.match(js, /timer_set/);
  assert.match(js, /type="time"/);
  // Der Timer-Block darf NICHT die Details-Klasse tragen — sonst laufen der
  // Rebuild-Erhalt und der Toggle-Handler auf einen fehlenden .skoda-enrich.
  // Zeilenweise prüfen: im selben Markup-Fragment dürfen beide nicht stehen.
  assert.doesNotMatch(js, /skoda-timers-block[^\n]*skoda-enrich/);
});

test('skoda.js guards every enrich lookup and never shows raw server messages', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'skoda.js'), 'utf8');
  const lookups = (js.match(/querySelector\('\.skoda-enrich'\)/g) || []).length;
  const guards = (js.match(/if \(!box\) return;/g) || []).length;
  assert.ok(lookups >= 2, `expected at least two enrich lookups, found ${lookups}`);
  assert.ok(guards >= lookups, `every enrich lookup needs a null-guard (${guards} guards for ${lookups} lookups)`);
  assert.doesNotMatch(js, /skoda-timer-msg[\s\S]{0,400}e\.message/);
});

test('portal.js renders the timer block and wires timer_set', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.match(js, /skoda-timers/);
  assert.match(js, /timer_set/);
  assert.match(js, /data-dirty/);
});

test('portal.js escapes every value inside the timer renderer', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  const from = js.indexOf('function skodaTimerRow');
  const to = js.indexOf('function renderSkodaCard');
  assert.ok(from > 0 && to > from, 'timer renderer block not found');
  const body = js.slice(from, to);
  // CodeQL js/xss-through-dom: PT stammt aus #portal-i18n.textContent, ist also
  // eine DOM-Text-Quelle. Jeder PT-Zugriff im Renderer muss in escHtml( stehen.
  for (const m of body.matchAll(/PT[.[]/g)) {
    assert.ok(/escHtml\($/.test(body.slice(0, m.index)),
      'unescaped PT value: …' + body.slice(Math.max(0, m.index - 60), m.index + 30));
  }
  assert.match(body, /data-timer="' \+ escHtml\(t\.id/);
  assert.match(body, /value="' \+ escHtml\(t\.time/);
  assert.equal((body.match(/innerHTML/g) || []).length, 0, 'renderer builds strings, never assigns innerHTML');
});

test('skodaTimersBlock bails out early without a login', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  const from = js.indexOf('function skodaTimersBlock');
  const to = js.indexOf('function', from + 1);
  assert.ok(from > 0 && to > from, 'skodaTimersBlock not found');
  const body = js.slice(from, to);
  assert.match(body, /if \(!loggedIn\) return '';/);
});

test('portal.js narrows the details selectors so the timer block is not mistaken for it', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.doesNotMatch(js, /querySelector\('details'\)/);
  assert.match(js, /querySelector\('details\.skoda-details'\)/);
  assert.match(js, /querySelector\('details\.skoda-timers'\)/);
});
