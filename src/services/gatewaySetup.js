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
    // and ./gateway-cache:/cache (home cache) — Synology's Container Manager does not create a
    // missing bind-mount folder ("Bind mount failed: … does not exist"), so the bundle brings it
    { name: 'gateway-cache/' },
    { name: 'update.sh', data: readUpdateSh(), mode: 0o755 },
  ]);
  return Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
}

// "Nur docker-compose.yml herunterladen" (gateway page): the assistant's compose for an existing
// gateway — no gateway.env, no token rotation. Platform as the assistant stored it → compose
// profile (proxmox runs Docker in a Debian LXC like any Linux host); rpi and unknown → null (the
// Pi image keeps its own compose, an unknown platform has to be chosen).
const COMPOSE_PLATFORMS = ['synology', 'linux'];
const COMPOSE_NETWORKS = ['host', 'bridge'];
function composePlatformOf(platform) {
  if (platform === 'synology') return 'synology';
  if (platform === 'linux' || platform === 'proxmox') return 'linux';
  return null;
}
/** → the compose text, or null when platform/network is not one of the profiles. */
function buildCompose(platform, network, { zigbee = false, zigbee2mqtt = false, thread = false, ai = false, aiGpu = null, cameras = false, cameraDir = null, office = false } = {}) {
  if (COMPOSE_PLATFORMS.indexOf(platform) < 0 || COMPOSE_NETWORKS.indexOf(network) < 0) return null;
  return kit.buildCompose({ platform, network, zigbee: zigbee === true, zigbee2mqtt: zigbee2mqtt === true, thread: thread === true, ai: ai === true, aiGpu: typeof aiGpu === 'string' ? aiGpu : null, cameras: cameras === true, cameraDir: typeof cameraDir === 'string' ? cameraDir : null, office: office === true });
}

module.exports = {
  readUpdateSh, buildNasBundle, NAS_BUNDLE_NAME,
  buildCompose, composePlatformOf, COMPOSE_PLATFORMS, COMPOSE_NETWORKS,
};
