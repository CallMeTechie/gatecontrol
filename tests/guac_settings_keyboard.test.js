'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// server-layout of RDP sessions (guacSettings.applyKeyboard): the device's keyboard_layout, else the
// browser's language — without it guacd loads en-us-qwerty and a German PC gets y/z and symbols wrong.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConnectionSettings, layoutForLanguage, requestLanguage, KEYBOARD_LAYOUTS } = require('../src/services/guacSettings');

const rdp = (over = {}) => Object.assign({ access_mode: 'internal', host: '10.0.0.5', protocol: 'rdp', port: 3389 }, over);

describe('layoutForLanguage', () => {
  it('de → de-de-qwertz, regions where they have their own layout', () => {
    assert.equal(layoutForLanguage('de'), 'de-de-qwertz');
    assert.equal(layoutForLanguage('de-DE'), 'de-de-qwertz');
    assert.equal(layoutForLanguage('de-AT'), 'de-de-qwertz');
    assert.equal(layoutForLanguage('de_CH'), 'de-ch-qwertz');
    assert.equal(layoutForLanguage('fr-CH'), 'fr-ch-qwertz');
    assert.equal(layoutForLanguage('fr'), 'fr-fr-azerty');
    assert.equal(layoutForLanguage('en-GB'), 'en-gb-qwerty');
    assert.equal(layoutForLanguage('nb-NO'), 'no-no-qwerty');
  });
  it('anything else → en-us-qwerty', () => {
    for (const t of ['en', 'en-US', 'zh-CN', '', null, undefined, 42, '*']) assert.equal(layoutForLanguage(t), 'en-us-qwerty', String(t));
  });
  it('every result is a known keymap', () => {
    for (const t of ['de', 'de-CH', 'fr', 'fr-BE', 'fr-CH', 'it', 'es', 'pt-BR', 'sv', 'da', 'no', 'hu', 'cs', 'pl', 'ja', 'tr', 'en-GB', 'xx']) {
      assert.ok(KEYBOARD_LAYOUTS.includes(layoutForLanguage(t)), t);
    }
  });
});

describe('requestLanguage', () => {
  it('the first tag of Accept-Language, else the page language', () => {
    assert.equal(requestLanguage({ headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' }, language: 'en' }), 'de-DE');
    assert.equal(requestLanguage({ headers: { 'accept-language': 'fr-CH;q=1' } }), 'fr-CH');
    assert.equal(requestLanguage({ headers: {}, language: 'de' }), 'de');
    assert.equal(requestLanguage({ headers: { 'accept-language': '*' }, language: 'de' }), 'de');
    assert.equal(requestLanguage({ headers: { 'accept-language': '<script>' } }), null);
    assert.equal(requestLanguage(null), null);
  });
});

describe('server-layout in the settings', () => {
  it('rdp: from the language, the device setting wins', () => {
    assert.equal(buildConnectionSettings(rdp({ language: 'de-DE' }), {}).settings['server-layout'], 'de-de-qwertz');
    assert.equal(buildConnectionSettings(rdp({ language: 'en-US' }), {}).settings['server-layout'], 'en-us-qwerty');
    assert.equal(buildConnectionSettings(rdp(), {}).settings['server-layout'], 'en-us-qwerty');
    assert.equal(buildConnectionSettings(rdp({ language: 'de', keyboard_layout: 'fr-ch-qwertz' }), {}).settings['server-layout'], 'fr-ch-qwertz');
    assert.equal(buildConnectionSettings(rdp({ language: 'de', keyboard_layout: 'bogus' }), {}).settings['server-layout'], 'de-de-qwertz');
  });
  it('not for vnc, ssh or telnet', () => {
    for (const protocol of ['vnc', 'ssh', 'telnet']) {
      assert.equal(buildConnectionSettings(rdp({ protocol, language: 'de' }), {}).settings['server-layout'], undefined, protocol);
    }
  });
});
