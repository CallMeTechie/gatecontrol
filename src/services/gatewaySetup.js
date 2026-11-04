'use strict';
// Serves the vendored gateway `update.sh` (byte-identical to the gatecontrol-gateway repo at the
// tag in templates/VENDORED.md; enforced by scripts/check-vendored-templates.js). The script is
// generic (reads GATEWAY_STATE_DIR + auto-resolves the compose dir) — no per-gateway tailoring.
//
// buildNasBundle: the Synology set-up package of the gateway assistant
// (docs/feature-gateway-wizard.md) — the onboarding compose (Synology variant:
// wireguard-go, host network, from public/js/gateway-kit.js like the browser),
// config/gateway.env and update.sh. Fixed entry names only; nothing of the
// caller ends up in a path.
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../../public/js/gateway-kit');

const UPDATE_SH = path.join(__dirname, 'gatewaySetup', 'templates', 'update.sh');

function readUpdateSh() {
  return fs.readFileSync(UPDATE_SH, 'utf8');
}

const NAS_BUNDLE_NAME = 'gatecontrol-gateway-nas.zip';

/**
 * @param {string} envContent  the gateway.env (fresh tokens)
 * @returns {Buffer} gatecontrol-gateway-nas.zip
 */
function buildNasBundle(envContent) {
  if (typeof envContent !== 'string' || !envContent) throw new Error('env_required');
  const zip = kit.zipStored([
    { name: 'docker-compose.yml', data: kit.buildCompose({ platform: 'synology', network: 'host' }) },
    { name: 'config/' },
    { name: 'config/gateway.env', data: envContent, mode: 0o600 },
    // the compose mounts ./gateway-state:/state (auto-update flag, last pull)
    { name: 'gateway-state/' },
    { name: 'update.sh', data: readUpdateSh(), mode: 0o755 },
  ]);
  return Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
}

module.exports = { readUpdateSh, buildNasBundle, NAS_BUNDLE_NAME };
