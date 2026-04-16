'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Write content to a file atomically: write to a sibling tmp file, fsync,
 * then rename over the target. Prevents partial-write visibility to
 * readers (e.g. dnsmasq reading an addn-hosts file while it's rewritten).
 *
 * The tmp file lives in the same directory as the target so the rename is
 * a POSIX-atomic operation on the same filesystem.
 *
 * If the rename fails (e.g. target directory disappeared), the tmp file
 * is removed on best-effort basis and the original exception is rethrown.
 *
 * @param {string} targetPath Absolute path to the destination file
 * @param {string|Buffer} content File contents
 * @param {object} [opts]
 * @param {number} [opts.mode=0o644] File mode for the target
 * @returns {void}
 */
function atomicWrite(targetPath, content, opts = {}) {
  const mode = opts.mode ?? 0o644;
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const suffix = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${base}.${suffix}.tmp`);

  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

module.exports = { atomicWrite };
