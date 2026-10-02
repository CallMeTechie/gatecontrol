'use strict';

// Server-side redaction pass for support bundles (src/utils/supportRedact.js).
// Same rule set as gatecontrol-client-core src/support/redact.js and the
// Android SupportRedactor.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactValue, isSecretKey, MASK } = require('../src/utils/supportRedact');

const WG_KEY = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';

describe('redactText', () => {
  it('masks WireGuard PrivateKey / PresharedKey lines', () => {
    const out = redactText(`[Interface]\nPrivateKey = ${WG_KEY}\nAddress = 10.8.0.2/32\n[Peer]\npresharedkey=${WG_KEY}\nEndpoint = vpn.example.com:51820`);
    assert.ok(!out.includes(WG_KEY));
    assert.match(out, /PrivateKey = \[REDACTED\]/);
    assert.match(out, /presharedkey=\[REDACTED\]/);
    assert.match(out, /Address = 10\.8\.0\.2\/32/);
    assert.match(out, /Endpoint = vpn\.example\.com:51820/);
  });

  it('masks auth headers and API tokens', () => {
    for (const line of [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'authorization=Basic dXNlcjpwYXNz',
      'X-API-Token: gc_live_0123456789abcdef',
      '"x-api-key":"gc_abcdefabcdef"',
      'Cookie: gc.sid=s%3Aabc; other=1',
      'Set-Cookie: session=xyz; Path=/; HttpOnly',
      'using token gc_0123456789abcdef0123',
    ]) {
      const out = redactText(line);
      assert.ok(out.includes(MASK), `not masked: ${line} → ${out}`);
      assert.ok(!/dXNlcjpwYXNz|0123456789abcdef|gc\.sid=s|session=xyz|c2lnbmF0dXJl/.test(out), `leak: ${out}`);
    }
  });

  it('masks key=value / JSON pairs with secret names', () => {
    const out = redactText('password=hunter2&user=bob {"apiKey": "k-123", "client_secret":"s3", "refresh_token": "r1"} setupCode: AB12-CD34-EF56-7890');
    for (const s of ['hunter2', 'k-123', '"s3"', 'r1', 'AB12-CD34-EF56-7890']) assert.ok(!out.includes(s), `leak ${s}: ${out}`);
    assert.match(out, /user=bob/);
  });

  it('masks key-like values: WG keys, long hex, PEM blocks, setup codes', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----';
    const out = redactText(`peer ${WG_KEY} fp ${'ab'.repeat(32)} code 1a2b-3c4d-5e6f-7a8b ${pem}`);
    assert.ok(!out.includes(WG_KEY));
    assert.ok(!out.includes('ab'.repeat(32)));
    assert.ok(!out.includes('1a2b-3c4d-5e6f-7a8b'));
    assert.ok(!out.includes('b3BlbnNzaC1rZXk='));
  });

  it('leaves ordinary diagnostics alone', () => {
    const line = '[2026-10-02 10:00:00.123] [info] Tunnel connected to 203.0.113.5:51820 after 2 attempts (handshake 4s)';
    assert.equal(redactText(line), line);
    assert.equal(redactText('uuid 123e4567-e89b-12d3-a456-426614174000'), 'uuid 123e4567-e89b-12d3-a456-426614174000');
  });
});

describe('redactValue', () => {
  it('masks secret-named keys at any depth and redacts strings', () => {
    const out = redactValue({
      server: { url: 'https://gate.example.com', apiKey: 'gc_x', peerId: '7' },
      list: [{ password: 'p' }, `PrivateKey = ${WG_KEY}`],
      tunnel: { killSwitch: true, presharedKey: { nested: 1 } },
      hasToken: false,
      emptySecret: '',
    });
    assert.equal(out.server.apiKey, MASK);
    assert.equal(out.server.url, 'https://gate.example.com');
    assert.equal(out.server.peerId, '7');
    assert.equal(out.list[0].password, MASK);
    assert.equal(out.list[1], `PrivateKey = ${MASK}`);
    assert.equal(out.tunnel.killSwitch, true);
    assert.equal(out.tunnel.presharedKey, MASK);
    assert.equal(out.hasToken, false);
    assert.equal(out.emptySecret, '');
  });

  it('drops prototype-related keys and never writes through the prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":"yes"},"a":{"constructor":{"prototype":{"x":1}},"prototype":2,"b":"c"}}');
    const out = redactValue(input);
    assert.equal({}.polluted, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, '__proto__'));
    assert.deepEqual(Object.keys(out.a), ['b']);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });

  it('isSecretKey', () => {
    for (const k of ['apiKey', 'api_key', 'privateKey', 'PresharedKey', 'password', 'token', 'X-API-Token', 'cookie', 'Authorization', 'enrollmentCode', 'setup_code', 'machineKey', 'clientSecret']) {
      assert.equal(isSecretKey(k), true, k);
    }
    for (const k of ['url', 'peerId', 'killSwitch', 'endpoint', 'version', 'dnsServers']) {
      assert.equal(isSecretKey(k), false, k);
    }
  });
});
