'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Alle drei Themes müssen ALLE drei Theme-Optionen anbieten — in der Profilseite
// (persönliches Design) und in den Einstellungen (systemweites Standard-Design).
// Ohne diesen Test bleibt eine Auslassung unsichtbar: genau das passierte beim
// Hinzufügen von Aurora, wo `templates/{default,pro}/pages/settings.njk` den
// Aurora-Knopf nie bekamen — ein Admin in Classic oder Pro konnte das
// Standard-Design also nicht auf Aurora stellen, obwohl der Server den Wert
// längst akzeptiert (src/routes/api/settings/appearance.js: validThemes).
const THEMES = ['aurora', 'default', 'pro'];
const OPTIONS = ['default', 'pro', 'aurora'];

function read(theme, page) {
  return fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'pages', page), 'utf8');
}

test('every theme offers every theme option on the profile page', () => {
  for (const theme of THEMES) {
    const html = read(theme, 'profile.njk');
    for (const opt of OPTIONS) {
      assert.match(html, new RegExp(`data-theme="${opt}"`), `${theme}/profile.njk fehlt data-theme="${opt}"`);
    }
  }
});

test('every theme offers every theme option as system default in the settings', () => {
  for (const theme of THEMES) {
    const html = read(theme, 'settings.njk');
    for (const opt of OPTIONS) {
      assert.match(html, new RegExp(`data-default-theme="${opt}"`), `${theme}/settings.njk fehlt data-default-theme="${opt}"`);
    }
  }
});

test('the server accepts exactly the theme options the templates offer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api', 'settings', 'appearance.js'), 'utf8');
  const m = src.match(/const validThemes = \[([^\]]+)\]/);
  assert.ok(m, 'validThemes nicht gefunden');
  const valid = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(valid.slice().sort(), OPTIONS.slice().sort(),
    'Serverseitige Whitelist und angebotene Optionen laufen auseinander');
});
