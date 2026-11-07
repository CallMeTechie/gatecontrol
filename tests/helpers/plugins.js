'use strict';

// Test helpers for the plugin platform: build .gcplugin packages from the
// example plugin (tests/fixtures/plugins/hello) and sign them with a key
// generated for this test run (trusted via GC_PLUGIN_PUBKEYS).

const path = require('node:path');
const { packDir } = require('../../scripts/plugin-pack');
const signature = require('../../src/services/plugins/signature');

const HELLO = path.join(__dirname, '..', 'fixtures', 'plugins', 'hello');
// a plugin with an edge part (plugin.json `edge`, tests/edge_*.test.js)
const EDGE_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'edge-demo');
// a plugin with permissions.homePresence (gc.homeNetwork, tests/gateway_presence.test.js)
const PRESENCE_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'presence-demo');
// a plugin with permissions.homeInternet + homeCache (tests/gateway_home_plugins.test.js)
const HOME_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'home-demo');
// a plugin with permissions.print (gc.print, tests/print_scan.test.js)
const PRINT_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'print-demo');
// a plugin with permissions.radio (gc.radio, tests/gateway_radio.test.js)
const RADIO_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'radio-demo');
const CAMERA_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'camera-demo');
// a plugin with a handbook and setup notices (plugin.json handbook / setupNotices, tests/plugins_handbook.test.js)
const HANDBOOK_DEMO = path.join(__dirname, '..', 'fixtures', 'plugins', 'handbook-demo');

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

/** The edge test plugin, like helloPackage (overrides replace top-level plugin.json keys). */
function edgePackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(EDGE_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

/** The presence test plugin, like helloPackage. */
function presencePackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(PRESENCE_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

/** The home network test plugin (DNS pause, home cache), like helloPackage. */
function homePackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(HOME_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

/** The print test plugin, like helloPackage. */
function printPackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(PRINT_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

/** The radio test plugin, like helloPackage. */
function radioPackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(RADIO_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

/** The camera test plugin, like helloPackage. */
function cameraPackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(CAMERA_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

/** The handbook test plugin, like helloPackage. */
function handbookPackage(o = {}) {
  const key = o.sign === undefined || o.sign === 'trusted' ? trusted.privateSeed : (o.sign === 'stranger' ? stranger.privateSeed : '');
  return packDir(HANDBOOK_DEMO, { signingKey: key, overrides: o.overrides, extra: o.extra }).buffer;
}

module.exports = { HANDBOOK_DEMO, handbookPackage, CAMERA_DEMO, cameraPackage, HELLO, EDGE_DEMO, PRESENCE_DEMO, HOME_DEMO, PRINT_DEMO, RADIO_DEMO, helloPackage, edgePackage, presencePackage, homePackage, printPackage, radioPackage, trusted, stranger };
