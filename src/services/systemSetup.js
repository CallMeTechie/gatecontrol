'use strict';
// Serves the vendored server `update.sh` (byte-identical to repo-root update.sh;
// enforced by scripts/check-vendored-templates.js).
//
// Both sides carry a version marker line "# gc-update-sh: <n>"
// (docs/feature-next-package.md §S2.2): update.sh writes its own number into
// .auto-update-state.json, the server reads the number of the copy shipped in
// this image here, and GET /api/v1/system/auto-update compares the two.
const fs = require('node:fs');
const path = require('node:path');
const UPDATE_SH = path.join(__dirname, 'systemSetup', 'templates', 'update.sh');
const VERSION_RE = /^# gc-update-sh: (\d{1,9})$/m;

function readUpdateSh() { return fs.readFileSync(UPDATE_SH, 'utf8'); }

/** Version marker of a script's text; null when it has none. */
function parseUpdateShVersion(text) {
  const m = VERSION_RE.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** Version of the update.sh shipped in this image; null when unreadable. */
function updateShVersion() {
  try { return parseUpdateShVersion(readUpdateSh()); } catch { return null; }
}

module.exports = { readUpdateSh, updateShVersion, parseUpdateShVersion };
