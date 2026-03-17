'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const qrcode = require('../src/services/qrcode');

describe('qrcode', () => {
  const testText = '[Interface]\nPrivateKey = abc123\nAddress = 10.8.0.2/32';

  it('toDataUrl returns a base64 PNG data URL', async () => {
    const url = await qrcode.toDataUrl(testText);
    assert.ok(url.startsWith('data:image/png;base64,'));
    assert.ok(url.length > 100);
  });
});
