'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePeerName,
  validateDomain,
  validateIp,
  validatePort,
  validateDescription,
  validateBasicAuthUser,
  validateBasicAuthPassword,
  validateCssColor,
  validateCssBg,
  sanitize,
} = require('../src/utils/validate');

describe('validatePeerName', () => {
  it('accepts valid names', () => {
    assert.equal(validatePeerName('my-peer'), null);
    assert.equal(validatePeerName('Peer_01'), null);
    assert.equal(validatePeerName('a'), null);
    assert.equal(validatePeerName('Server.Home'), null);
    assert.equal(validatePeerName('Peer with spaces'), null);
  });

  it('rejects empty/missing names', () => {
    assert.notEqual(validatePeerName(''), null);
    assert.notEqual(validatePeerName(null), null);
    assert.notEqual(validatePeerName(undefined), null);
  });

  it('rejects names starting with special chars', () => {
    assert.notEqual(validatePeerName('-invalid'), null);
    assert.notEqual(validatePeerName('.invalid'), null);
  });

  it('rejects names exceeding 63 chars', () => {
    assert.notEqual(validatePeerName('a'.repeat(64)), null);
    assert.equal(validatePeerName('a'.repeat(63)), null);
  });
});

describe('validateDomain', () => {
  it('accepts valid domains', () => {
    assert.equal(validateDomain('example.com'), null);
    assert.equal(validateDomain('sub.domain.example.com'), null);
    assert.equal(validateDomain('my-site.co.uk'), null);
  });

  it('rejects empty/missing domains', () => {
    assert.notEqual(validateDomain(''), null);
    assert.notEqual(validateDomain(null), null);
  });

  it('rejects invalid formats', () => {
    assert.notEqual(validateDomain('just-a-word'), null);
    assert.notEqual(validateDomain('http://example.com'), null);
    assert.notEqual(validateDomain('.example.com'), null);
  });

  it('rejects domains exceeding 253 chars', () => {
    const long = 'a'.repeat(250) + '.com';
    assert.notEqual(validateDomain(long), null);
  });
});

describe('validateIp', () => {
  it('accepts valid IPs', () => {
    assert.equal(validateIp('10.8.0.1'), null);
    assert.equal(validateIp('192.168.1.255'), null);
    assert.equal(validateIp('0.0.0.0'), null);
  });

  it('rejects invalid IPs', () => {
    assert.notEqual(validateIp('256.1.1.1'), null);
    assert.notEqual(validateIp('10.8.0'), null);
    assert.notEqual(validateIp('not-an-ip'), null);
    assert.notEqual(validateIp(''), null);
  });
});

describe('validatePort', () => {
  it('accepts valid ports', () => {
    assert.equal(validatePort(80), null);
    assert.equal(validatePort(443), null);
    assert.equal(validatePort(65535), null);
    assert.equal(validatePort(1), null);
    assert.equal(validatePort('8080'), null);
  });

  it('rejects invalid ports', () => {
    assert.notEqual(validatePort(0), null);
    assert.notEqual(validatePort(65536), null);
    assert.notEqual(validatePort(-1), null);
    assert.notEqual(validatePort('abc'), null);
  });
});

describe('validateDescription', () => {
  it('accepts valid descriptions', () => {
    assert.equal(validateDescription('My peer description'), null);
    assert.equal(validateDescription(null), null);
    assert.equal(validateDescription(''), null);
  });

  it('rejects descriptions exceeding 255 chars', () => {
    assert.notEqual(validateDescription('a'.repeat(256)), null);
    assert.equal(validateDescription('a'.repeat(255)), null);
  });
});

describe('validateBasicAuthUser', () => {
  it('accepts valid usernames', () => {
    assert.equal(validateBasicAuthUser('admin'), null);
    assert.equal(validateBasicAuthUser('user@domain.com'), null);
    assert.equal(validateBasicAuthUser('my-user_01'), null);
  });

  it('rejects empty/missing usernames', () => {
    assert.notEqual(validateBasicAuthUser(''), null);
    assert.notEqual(validateBasicAuthUser(null), null);
  });

  it('rejects usernames with invalid chars', () => {
    assert.notEqual(validateBasicAuthUser('user name'), null);
    assert.notEqual(validateBasicAuthUser('user<script>'), null);
  });

  it('rejects usernames exceeding 64 chars', () => {
    assert.notEqual(validateBasicAuthUser('a'.repeat(65)), null);
    assert.equal(validateBasicAuthUser('a'.repeat(64)), null);
  });
});

describe('validateBasicAuthPassword', () => {
  it('accepts valid passwords', () => {
    assert.equal(validateBasicAuthPassword('secure1234'), null);
    assert.equal(validateBasicAuthPassword('a'.repeat(128)), null);
  });

  it('rejects short passwords', () => {
    assert.notEqual(validateBasicAuthPassword('short'), null);
    assert.notEqual(validateBasicAuthPassword('1234567'), null);
  });

  it('rejects passwords exceeding 128 chars', () => {
    assert.notEqual(validateBasicAuthPassword('a'.repeat(129)), null);
  });
});

describe('validateCssColor', () => {
  it('accepts valid colors', () => {
    assert.equal(validateCssColor('#fff'), null);
    assert.equal(validateCssColor('#FF5733'), null);
    assert.equal(validateCssColor('#aabbccdd'), null);
    assert.equal(validateCssColor('red'), null);
    assert.equal(validateCssColor('dodgerblue'), null);
    assert.equal(validateCssColor('rgb(255, 0, 0)'), null);
    assert.equal(validateCssColor('rgba(255, 0, 0, 0.5)'), null);
    assert.equal(validateCssColor('hsl(120, 100%, 50%)'), null);
    assert.equal(validateCssColor('hsla(120, 100%, 50%, 0.8)'), null);
  });

  it('allows null/empty (optional field)', () => {
    assert.equal(validateCssColor(null), null);
    assert.equal(validateCssColor(''), null);
    assert.equal(validateCssColor(undefined), null);
  });

  it('rejects CSS injection payloads', () => {
    assert.notEqual(validateCssColor('red; } body { background: url(https://evil.com)'), null);
    assert.notEqual(validateCssColor('red; } </style><script>alert(1)</script>'), null);
    assert.notEqual(validateCssColor('url(https://evil.com/exfil)'), null);
    assert.notEqual(validateCssColor('expression(alert(1))'), null);
  });

  it('rejects values exceeding 120 chars', () => {
    assert.notEqual(validateCssColor('#' + 'a'.repeat(121)), null);
  });
});

describe('validateCssBg', () => {
  it('accepts valid backgrounds', () => {
    assert.equal(validateCssBg('#fff'), null);
    assert.equal(validateCssBg('darkblue'), null);
    assert.equal(validateCssBg('rgb(10, 20, 30)'), null);
    assert.equal(validateCssBg('linear-gradient(90deg, #fff, #000)'), null);
    assert.equal(validateCssBg('radial-gradient(circle, red, blue)'), null);
  });

  it('allows null/empty (optional field)', () => {
    assert.equal(validateCssBg(null), null);
    assert.equal(validateCssBg(''), null);
  });

  it('rejects CSS injection payloads', () => {
    assert.notEqual(validateCssBg('red; } body::after { content: url(https://evil.com) }'), null);
    assert.notEqual(validateCssBg('url(https://evil.com/exfil?v=1)'), null);
    assert.notEqual(validateCssBg('red; } </style><script>alert(1)</script>'), null);
  });

  it('rejects values exceeding 200 chars', () => {
    assert.notEqual(validateCssBg('a'.repeat(201)), null);
  });
});

describe('sanitize', () => {
  it('trims whitespace', () => {
    assert.equal(sanitize('  hello  '), 'hello');
  });

  it('handles null/undefined', () => {
    assert.equal(sanitize(null), '');
    assert.equal(sanitize(undefined), '');
  });

  it('converts to string', () => {
    assert.equal(sanitize(123), '123');
  });
});
