'use strict';

// Test helpers for the plugin platform: build .gcplugin packages from the
// example plugin (tests/fixtures/plugins/hello) and sign them with a key
// generated for this test run (trusted via GC_PLUGIN_PUBKEYS).

const path = require('node:path');
const { packDir } = require('../../scripts/plugin-pack');
const signature = require('../../src/services/plugins/signature');

const HELLO = path.join(__dirname, '..', 'fixtures', 'plugins', 'hello');

const trusted = signature.generateKeyPair();
const stranger = signature.generateKeyPair();
process.env.GC_PLUGIN_PUBKEYS = JSON.stringify([trusted.publicKey]);

/**
 * @param {{sign?: 'trusted'|'stranger'|false, overrides?: object, extra?: Map}} [o]
 * @returns {Buffer}
 */
function helloPackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(HELLO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

module.exports = { HELLO, helloPackage, trusted, stranger };
