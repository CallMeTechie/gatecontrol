#!/usr/bin/env node
'use strict';

// Print a new Ed25519 key pair for signing plugins (docs/plugins.md).
//
//   node scripts/plugin-keygen.js
//
// Run it on YOUR machine. The private seed goes into the signing CI as the
// secret GC_PLUGIN_SIGNING_KEY and nowhere else — never commit it. The public
// key goes into BUILTIN_PUBLIC_KEYS (src/services/plugins/constants.js) or,
// for a test install, into GC_PLUGIN_PUBKEYS='["<public key>"]'.

const { generateKeyPair, keyId } = require('../src/services/plugins/signature');

const kp = generateKeyPair();
process.stdout.write([
  'GateControl plugin signing key pair',
  '',
  `public key (base64, 32 bytes):  ${kp.publicKey}`,
  `key id:                         ${keyId(kp.publicKey)}`,
  '',
  'PRIVATE seed (base64, 32 bytes) — keep secret, store as GC_PLUGIN_SIGNING_KEY:',
  kp.privateSeed,
  '',
].join('\n'));
