'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateIfProvided,
  validateBrandingFields,
  validateBotBlockerConfig,
} = require('../src/services/routesValidation');

describe('routesValidation: validateIfProvided', () => {
  it('skips validation when the field is undefined on the patch', () => {
    let calls = 0;
    validateIfProvided({}, 'foo', () => { calls++; return 'never'; });
    assert.equal(calls, 0);
  });

  it('runs validation when the field is null (null is "explicit clear", not "absent")', () => {
    let calls = 0;
    validateIfProvided({ foo: null }, 'foo', (v) => { calls++; return null; });
    assert.equal(calls, 1);
  });

  it('runs validation on empty string and 0 (not skipped as "falsy")', () => {
    let received = [];
    validateIfProvided({ port: 0 }, 'port', (v) => { received.push(v); return null; });
    validateIfProvided({ name: '' }, 'name', (v) => { received.push(v); return null; });
    assert.deepEqual(received, [0, '']);
  });

  it('throws Error(message) when the validator returns a string', () => {
    assert.throws(
      () => validateIfProvided({ port: 99999 }, 'port', () => 'Port must be between 1 and 65535'),
      /Port must be between 1 and 65535/,
    );
  });

  it('passes silently when the validator returns null / undefined / empty string', () => {
    assert.doesNotThrow(() => validateIfProvided({ port: 80 }, 'port', () => null));
    assert.doesNotThrow(() => validateIfProvided({ port: 80 }, 'port', () => undefined));
    assert.doesNotThrow(() => validateIfProvided({ port: 80 }, 'port', () => ''));
  });

  it('passes the actual field value into the validator', () => {
    let seen;
    validateIfProvided({ x: 'hello' }, 'x', (v) => { seen = v; return null; });
    assert.equal(seen, 'hello');
  });
});

describe('routesValidation: validateBrandingFields', () => {
  it('passes when branding fields are absent', () => {
    assert.doesNotThrow(() => validateBrandingFields({}));
    assert.doesNotThrow(() => validateBrandingFields({ branding_title: '' }));
    assert.doesNotThrow(() => validateBrandingFields({ branding_text: null }));
  });

  it('passes when branding fields are within limits', () => {
    assert.doesNotThrow(() => validateBrandingFields({
      branding_title: 'a'.repeat(255),
      branding_text: 'b'.repeat(2000),
    }));
  });

  it('throws when branding_title exceeds 255 chars', () => {
    assert.throws(
      () => validateBrandingFields({ branding_title: 'a'.repeat(256) }),
      /Branding title must be 255 characters or less/,
    );
  });

  it('throws when branding_text exceeds 2000 chars', () => {
    assert.throws(
      () => validateBrandingFields({ branding_text: 'b'.repeat(2001) }),
      /Branding text must be 2000 characters or less/,
    );
  });
});

describe('routesValidation: validateBotBlockerConfig', () => {
  it('passes on empty / no-op input', () => {
    assert.doesNotThrow(() => validateBotBlockerConfig({}));
    assert.doesNotThrow(() => validateBotBlockerConfig({ bot_blocker_enabled: 0 }));
  });

  it('throws on an unknown mode', () => {
    assert.throws(
      () => validateBotBlockerConfig({ bot_blocker_mode: 'launch_nukes' }),
      /Invalid bot blocker mode/,
    );
  });

  it('accepts each known mode without a config', () => {
    for (const mode of ['block', 'tarpit', 'drop', 'garbage', 'redirect', 'custom']) {
      assert.doesNotThrow(() => validateBotBlockerConfig({ bot_blocker_mode: mode }));
    }
  });

  it('redirect mode requires a valid http(s) URL inside the config', () => {
    assert.throws(
      () => validateBotBlockerConfig({
        bot_blocker_mode: 'redirect',
        bot_blocker_config: { url: 'not-a-url' },
      }),
      /Redirect mode requires a valid URL/,
    );
    assert.throws(
      () => validateBotBlockerConfig({
        bot_blocker_mode: 'redirect',
        bot_blocker_config: {},
      }),
      /Redirect mode requires a valid URL/,
    );
    assert.doesNotThrow(() => validateBotBlockerConfig({
      bot_blocker_mode: 'redirect',
      bot_blocker_config: { url: 'https://example.com/blocked' },
    }));
  });

  it('custom mode rejects invalid status codes and overlong messages', () => {
    assert.throws(
      () => validateBotBlockerConfig({
        bot_blocker_mode: 'custom',
        bot_blocker_config: { status_code: 99 },
      }),
      /Invalid status code/,
    );
    assert.throws(
      () => validateBotBlockerConfig({
        bot_blocker_mode: 'custom',
        bot_blocker_config: { status_code: 600 },
      }),
      /Invalid status code/,
    );
    assert.throws(
      () => validateBotBlockerConfig({
        bot_blocker_mode: 'custom',
        bot_blocker_config: { message: 'x'.repeat(501) },
      }),
      /Message too long/,
    );
  });

  it('normalises object configs to a JSON string in place (preserves pre-refactor mutation)', () => {
    const data = {
      bot_blocker_mode: 'redirect',
      bot_blocker_config: { url: 'https://example.com' },
    };
    validateBotBlockerConfig(data);
    assert.equal(typeof data.bot_blocker_config, 'string');
    assert.equal(JSON.parse(data.bot_blocker_config).url, 'https://example.com');
  });

  it('keeps an already-string config as-is (no double-stringify)', () => {
    const original = JSON.stringify({ url: 'https://example.com' });
    const data = { bot_blocker_mode: 'redirect', bot_blocker_config: original };
    validateBotBlockerConfig(data);
    assert.equal(data.bot_blocker_config, original);
  });
});
