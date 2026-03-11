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

  it('toBuffer returns a PNG buffer', async () => {
    const buf = await qrcode.toBuffer(testText);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100);
    // PNG magic bytes
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50); // P
    assert.equal(buf[2], 0x4E); // N
    assert.equal(buf[3], 0x47); // G
  });

  it('toSvg returns an SVG string', async () => {
    const svg = await qrcode.toSvg(testText);
    assert.ok(typeof svg === 'string');
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('</svg>'));
  });
});
