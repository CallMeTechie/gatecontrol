'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const wgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'gc-wg-')), 'wg0.conf');
fs.writeFileSync(wgFile, '[Interface]\nPrivateKey = AA==\nListenPort = 51820\n');
process.env.GC_WG_CONFIG_PATH = wgFile;                 // BEFORE setup requires config
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
let peers, wireguard, accessRules, origSync, origIsDenied, peerId;
beforeEach(async () => {
  await setup();
  wireguard = require('../src/services/wireguard'); origSync = wireguard.syncConfig;
  wireguard.syncConfig = async () => null;              // no real `wg`
  accessRules = require('../src/services/accessRules'); origIsDenied = accessRules.isDenied;
  peers = require('../src/services/peers');
  peerId = getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('p1','PUBKEY_P1=','10.8.0.5/32',1)").run().lastInsertRowid;
});
afterEach(() => { wireguard.syncConfig = origSync; accessRules.isDenied = origIsDenied; teardown(); });

test('denied peer is omitted from the rewritten WG config; allowed peer present', async () => {
  // Stub isDenied for deterministic, clock-independent assertion (schedule->state is covered in T4).
  accessRules.isDenied = () => false;
  await peers.rewriteWgConfig();
  assert.match(fs.readFileSync(wgFile,'utf8'), /PUBKEY_P1=/);          // allowed -> present
  accessRules.isDenied = (t, id) => t === 'peer' && id === peerId;     // deny our peer
  await peers.rewriteWgConfig();
  assert.doesNotMatch(fs.readFileSync(wgFile,'utf8'), /PUBKEY_P1=/);   // denied -> omitted
});
