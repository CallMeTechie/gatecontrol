'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const test = require('node:test');
const assert = require('node:assert');
const { resolveConnectEndpoint } = require('../src/services/rdp');

const OPTS = { baseUrl: 'https://gc.example.com' };

test('internal → host:port', () => {
  const r = { access_mode: 'internal', host: '10.8.0.5', port: 3389 };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: '10.8.0.5', connect_port: 3389 });
});

test('external mit external_hostname → external endpoint', () => {
  const r = { access_mode: 'external', host: '10.8.0.5', port: 3389, external_hostname: 'rdp.example.com', external_port: 13389 };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: 'rdp.example.com', connect_port: 13389 });
});

test('gateway → baseUrl-host : listen_port', () => {
  const r = { access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: 13389 };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: 'gc.example.com', connect_port: 13389 });
});

test('gateway ohne listen_port → fällt auf port zurück', () => {
  const r = { access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: null };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: 'gc.example.com', connect_port: 3389 });
});

test('gateway mit publicHost-Override → schlägt baseUrl', () => {
  const r = { access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: 13389 };
  const opts = { baseUrl: 'https://gc.example.com', publicHost: 'rdp.direct.example.com' };
  assert.deepStrictEqual(resolveConnectEndpoint(r, opts), { connect_address: 'rdp.direct.example.com', connect_port: 13389 });
});

test('publicHost gilt NUR für gateway, nicht external', () => {
  const r = { access_mode: 'external', host: '10.8.0.5', port: 3389, external_hostname: 'rdp.example.com', external_port: 13389 };
  const opts = { baseUrl: 'https://gc.example.com', publicHost: 'should.be.ignored' };
  assert.deepStrictEqual(resolveConnectEndpoint(r, opts), { connect_address: 'rdp.example.com', connect_port: 13389 });
});
