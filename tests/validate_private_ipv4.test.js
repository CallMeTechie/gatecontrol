'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIpv4 } = require('../src/utils/validate');

describe('isPrivateIpv4', () => {
  it('accepts RFC1918 private ranges', () => {
    assert.equal(isPrivateIpv4('10.0.0.1'), true);
    assert.equal(isPrivateIpv4('172.16.5.4'), true);
    assert.equal(isPrivateIpv4('172.31.255.255'), true);
    assert.equal(isPrivateIpv4('192.168.2.228'), true);
  });
  it('rejects public, loopback, zero, and malformed', () => {
    assert.equal(isPrivateIpv4('8.8.8.8'), false);
    assert.equal(isPrivateIpv4('127.0.0.1'), false);
    assert.equal(isPrivateIpv4('0.0.0.0'), false);
    assert.equal(isPrivateIpv4('172.32.0.1'), false);
    assert.equal(isPrivateIpv4('not-an-ip'), false);
    assert.equal(isPrivateIpv4(''), false);
    assert.equal(isPrivateIpv4(null), false);
  });
});

describe('isLoopbackHost', () => {
  const { isLoopbackHost } = require('../src/utils/validate');
  it('detects 127.0.0.0/8 and loopback names', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('127.0.1.1'), true);
    assert.equal(isLoopbackHost('127.255.255.255'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('LOCALHOST'), true);
    assert.equal(isLoopbackHost(' ::1 '), true);
  });
  it('rejects real LAN/public hosts and empties', () => {
    assert.equal(isLoopbackHost('192.168.2.228'), false);
    assert.equal(isLoopbackHost('10.0.0.1'), false);
    assert.equal(isLoopbackHost('example.com'), false);
    assert.equal(isLoopbackHost(''), false);
    assert.equal(isLoopbackHost(null), false);
  });
});
