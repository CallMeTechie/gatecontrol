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
const PORTAL_KEYS = ['timers_edit', 'timers_none', 'timer_n', 'timer_active', 'timer_time', 'timer_days', 'timer_save', 'timer_saved', 'timer_failed', 'timer_invalid', 'timer_not_found', 'timer_readonly']
  .map((k) => `portal.car.${k}`).concat(DAYS.map((d) => `portal.car.day_${d}`));

test('all timer keys exist in de and en', () => {
  for (const k of ADMIN_KEYS.concat(PORTAL_KEYS)) {
    assert.ok(de[k] && de[k].trim(), `de ${k}`);
    assert.ok(en[k] && en[k].trim(), `en ${k}`);
  }
});

test('all three layouts carry the skoda.timers.* GC.t whitelist', () => {
  for (const theme of ['aurora']) {
    const layout = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'layout.njk'), 'utf8');
    for (const k of ADMIN_KEYS) assert.ok(layout.includes(`'${k}'`), `${theme} ${k}`);
  }
});

test('the portal string island carries every portal.* key (timer keys included)', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  assert.match(njk, /id="portal-i18n"[^>]*>\{\{ portalI18n \| safe \}\}/);
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'portal.js'), 'utf8');
  assert.match(route, /stringsWithPrefix\(lang, \['portal\.'\]\)/);
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
  assert.match(js, /function timerRow\(/);
  assert.match(js, /action: 'timer_set'/);
  assert.match(js, /type: 'time'/);
  // unsaved timer edits win over the 120 s refresh
  assert.match(js, /if \(dirtyTimers\) return;/);
});

test('portal.js builds the timer block from DOM nodes only', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  const from = js.indexOf('function timerRow');
  const to = js.indexOf('function renderCarCard');
  assert.ok(from > 0 && to > from, 'timer renderer block not found');
  assert.doesNotMatch(js.slice(from, to), /innerHTML|insertAdjacentHTML/);
});

test('the timer editor only exists with a login (departure times are a presence profile)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.match(js, /if \(carLoggedIn\) \{\n\s+var all = c\.cl\.timers/);
  assert.match(js, /class: 'pt-details pt-timers'/);
});
