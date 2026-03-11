'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Save original env
const originalEnv = { ...process.env };

function resetEnv() {
  // Restore original env and clear config cache
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GC_')) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  delete require.cache[require.resolve('../config/default')];
  delete require.cache[require.resolve('../config/validate')];
}

describe('validateConfig', () => {
  beforeEach(() => resetEnv());
  afterEach(() => resetEnv());

  it('passes with default configuration', () => {
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.doesNotThrow(() => validateConfig());
  });

  it('rejects out-of-range GC_PORT', () => {
    process.env.GC_PORT = '99999';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_PORT/);
  });

  it('rejects invalid GC_WG_SUBNET', () => {
    process.env.GC_WG_SUBNET = 'not-a-cidr';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_WG_SUBNET/);
  });

  it('rejects invalid GC_WG_GATEWAY_IP', () => {
    process.env.GC_WG_GATEWAY_IP = '999.999.999.999';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_WG_GATEWAY_IP/);
  });

  it('rejects invalid GC_WG_PORT', () => {
    process.env.GC_WG_PORT = '99999';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_WG_PORT/);
  });

  it('rejects invalid GC_WG_DNS', () => {
    process.env.GC_WG_DNS = 'not-an-ip';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_WG_DNS/);
  });

  it('rejects invalid GC_LOG_LEVEL', () => {
    process.env.GC_LOG_LEVEL = 'verbose';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_LOG_LEVEL/);
  });

  it('rejects invalid GC_BASE_URL', () => {
    process.env.GC_BASE_URL = 'not-a-url';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_BASE_URL/);
  });

  it('rejects invalid GC_CADDY_ADMIN_URL', () => {
    process.env.GC_CADDY_ADMIN_URL = 'broken';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_CADDY_ADMIN_URL/);
  });

  it('rejects mismatched default language', () => {
    process.env.GC_DEFAULT_LANGUAGE = 'fr';
    process.env.GC_AVAILABLE_LANGUAGES = 'en,de';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    assert.throws(() => validateConfig(), /GC_DEFAULT_LANGUAGE/);
  });

  it('collects multiple errors', () => {
    process.env.GC_PORT = '99999';
    process.env.GC_WG_SUBNET = 'bad';
    process.env.GC_WG_GATEWAY_IP = 'bad';
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../config/validate')];
    const { validateConfig } = require('../config/validate');
    try {
      validateConfig();
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('GC_PORT'));
      assert.ok(err.message.includes('GC_WG_SUBNET'));
      assert.ok(err.message.includes('GC_WG_GATEWAY_IP'));
    }
  });
});
