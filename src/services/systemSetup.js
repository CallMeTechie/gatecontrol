'use strict';
// Serves the vendored server `update.sh` (byte-identical to repo-root update.sh;
// enforced by scripts/check-vendored-templates.js).
const fs = require('node:fs');
const path = require('node:path');
const UPDATE_SH = path.join(__dirname, 'systemSetup', 'templates', 'update.sh');
function readUpdateSh() { return fs.readFileSync(UPDATE_SH, 'utf8'); }
module.exports = { readUpdateSh };
