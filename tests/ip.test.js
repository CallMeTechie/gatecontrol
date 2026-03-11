'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ipToNum, numToIp, parseCidr } = require('../src/utils/ip');

describe('ipToNum', () => {
  it('converts IP strings to numbers', () => {
    assert.equal(ipToNum('0.0.0.0'), 0);
    assert.equal(ipToNum('0.0.0.1'), 1);
    assert.equal(ipToNum('10.8.0.1'), (10 << 24 | 8 << 16 | 0 << 8 | 1) >>> 0);
    assert.equal(ipToNum('255.255.255.255'), 4294967295);
    assert.equal(ipToNum('192.168.1.100'), (192 << 24 | 168 << 16 | 1 << 8 | 100) >>> 0);
  });
});

describe('numToIp', () => {
  it('converts numbers to IP strings', () => {
    assert.equal(numToIp(0), '0.0.0.0');
    assert.equal(numToIp(1), '0.0.0.1');
    assert.equal(numToIp(4294967295), '255.255.255.255');
  });

  it('roundtrips with ipToNum', () => {
    const ips = ['10.8.0.1', '192.168.1.100', '172.16.0.254', '255.255.255.255'];
    for (const ip of ips) {
      assert.equal(numToIp(ipToNum(ip)), ip);
    }
  });
});

describe('parseCidr', () => {
  it('parses CIDR notation correctly', () => {
    const result = parseCidr('10.8.0.0/24');
    assert.equal(result.prefixLen, 24);
    assert.equal(numToIp(result.ipNum >>> 0), '10.8.0.0');
  });

  it('handles /16 subnet', () => {
    const result = parseCidr('172.16.0.0/16');
    assert.equal(result.prefixLen, 16);
    assert.equal(numToIp(result.ipNum >>> 0), '172.16.0.0');
  });

  it('handles /32 single host', () => {
    const result = parseCidr('10.8.0.5/32');
    assert.equal(result.prefixLen, 32);
    assert.equal(numToIp(result.ipNum >>> 0), '10.8.0.5');
  });
});
