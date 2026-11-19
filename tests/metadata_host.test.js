'use strict';

// utils/metadataHost.js: cloud metadata addresses are never a LAN target
// (the LDAP server of the directory sync, services/directory/ldapConn.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMetadataHost } = require('../src/utils/metadataHost');

test('metadata addresses, in every spelling', () => {
  for (const h of ['169.254.169.254', '100.100.100.200', 'fd00:ec2::254', '[fd00:ec2::254]', 'FD00:EC2:0::254',
    '::ffff:169.254.169.254', '[::ffff:a9fe:a9fe]']) {
    assert.equal(isMetadataHost(h), true, h);
  }
});

test('anything else is not', () => {
  for (const h of ['192.168.1.2', '127.0.0.1', '169.254.169.253', 'ldap.example.com', '::1', '', null, undefined]) {
    assert.equal(isMetadataHost(h), false, String(h));
  }
});
