'use strict';
// Serves the vendored gateway `update.sh` (byte-identical to the gatecontrol-gateway repo at the
// tag in templates/VENDORED.md; enforced by scripts/check-vendored-templates.js). The script is
// generic (reads GATEWAY_STATE_DIR + auto-resolves the compose dir) — no per-gateway tailoring.
const fs = require('node:fs');
const path = require('node:path');

const UPDATE_SH = path.join(__dirname, 'gatewaySetup', 'templates', 'update.sh');

function readUpdateSh() {
  return fs.readFileSync(UPDATE_SH, 'utf8');
}

module.exports = { readUpdateSh };
