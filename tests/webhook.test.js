'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateWebhookUrl } = require('../src/services/webhook');

describe('validateWebhookUrl', () => {
  it('accepts valid public HTTPS URLs', () => {
    assert.ok(validateWebhookUrl('https://hooks.slack.com/services/123'));
    assert.ok(validateWebhookUrl('https://example.com/webhook'));
    assert.ok(validateWebhookUrl('http://203.0.113.50:8080/hook'));
  });

  it('rejects non-http(s) protocols', () => {
    assert.throws(() => validateWebhookUrl('ftp://example.com'), /http or https/);
    assert.throws(() => validateWebhookUrl('file:///etc/passwd'), /http or https/);
    assert.throws(() => validateWebhookUrl('gopher://evil.com'), /http or https/);
  });

  it('rejects invalid URLs', () => {
    assert.throws(() => validateWebhookUrl('not-a-url'), /Invalid webhook URL/);
    assert.throws(() => validateWebhookUrl(''), /Invalid webhook URL/);
  });

  it('blocks localhost', () => {
    assert.throws(() => validateWebhookUrl('http://localhost/hook'), /localhost/);
    assert.throws(() => validateWebhookUrl('http://127.0.0.1/hook'), /localhost/);
    assert.throws(() => validateWebhookUrl('http://[::1]/hook'), /localhost/);
  });

  it('blocks private IPv4 ranges (10.x.x.x)', () => {
    assert.throws(() => validateWebhookUrl('http://10.0.0.1/hook'), /private or reserved/);
    assert.throws(() => validateWebhookUrl('http://10.255.255.255/hook'), /private or reserved/);
  });

  it('blocks private IPv4 ranges (172.16-31.x.x)', () => {
    assert.throws(() => validateWebhookUrl('http://172.16.0.1/hook'), /private or reserved/);
    assert.throws(() => validateWebhookUrl('http://172.31.255.255/hook'), /private or reserved/);
    // 172.15 and 172.32 should be allowed
    assert.ok(validateWebhookUrl('http://172.15.0.1/hook'));
    assert.ok(validateWebhookUrl('http://172.32.0.1/hook'));
  });

  it('blocks private IPv4 ranges (192.168.x.x)', () => {
    assert.throws(() => validateWebhookUrl('http://192.168.1.1/hook'), /private or reserved/);
    assert.throws(() => validateWebhookUrl('http://192.168.0.100/hook'), /private or reserved/);
  });

  it('blocks link-local / cloud metadata (169.254.x.x)', () => {
    assert.throws(() => validateWebhookUrl('http://169.254.169.254/latest/meta-data/'), /private or reserved/);
    assert.throws(() => validateWebhookUrl('http://169.254.0.1/hook'), /private or reserved/);
  });

  it('blocks 0.0.0.0/8', () => {
    assert.throws(() => validateWebhookUrl('http://0.0.0.0/hook'), /private or reserved/);
  });
});
