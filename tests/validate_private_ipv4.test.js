'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIpv4, isLoopbackHost, isUlaIpv6 } = require('../src/utils/validate');

describe('isUlaIpv6 (the private address of a home network without IPv4)', () => {
  it('accepts unique local addresses (fc00::/7)', () => {
    for (const ip of ['fd00::1', 'fc00::1', 'fd12:3456:789a:1::10', 'FD12:3456:789A:1:0:0:0:10', ' fd00::1 ', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']) assert.equal(isUlaIpv6(ip), true, ip);
  });
  it('rejects link-local, global, loopback, zone, brackets, embedded IPv4 and anything that is no address', () => {
    for (const ip of ['fe80::1', 'fe00::1', '2a02:8070::5', '::1', '::', 'fd00::1%eth0', '[fd00::1]', '::ffff:10.0.0.1', 'fd00::10.0.0.1', '192.168.1.10', 'fd00', 'fd00:::1', '', null, undefined, 5, {}]) {
      assert.equal(isUlaIpv6(ip), false, String(ip));
    }
  });
});

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
    assert.equal(isLoopbackHost('127.999.0.0'), false);
  });
});
