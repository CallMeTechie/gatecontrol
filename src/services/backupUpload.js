'use strict';

// Uploaded backups (Einstellungen › Backup › Wiederherstellen, the routes in
// routes/api/settings/backup.js): stored in a private folder on the backup
// disk instead of in memory — a backup with plugin data has up to ~860 MB
// (services/plugins/backup.js) — and read in pieces (backup.readBackupFile).
// An off-site archive (.gcbk) is decrypted into a second file next to it
// (gcbk.decryptBackupFileTo). Both files stay until the request is done:
// the large plugin parts of the parsed backup are still read from them.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const gcbk = require('./offsite/gcbk');
const logger = require('../utils/logger');

const STALE_MS = 24 * 60 * 60 * 1000;
const PLAIN_SUFFIX = '.plain.json';

function incomingDir() {
  return path.join(require('./autobackup').BACKUP_DIR, '.incoming');
}

/** Old files of an interrupted request (a crash in the middle) are removed. */
function sweep(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true }); } catch { /* gone */ }
    }
  } catch { /* best effort */ }
}

/** multer storage: <backup dir>/.incoming/<random>.upload (folder 0700, file 0600 by umask-independent chmod). */
function storage() {
  return multer.diskStorage({
    destination(req, file, cb) {
      const dir = incomingDir();
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        sweep(dir);
        cb(null, dir);
      } catch (err) { cb(err); }
    },
    filename(req, file, cb) { cb(null, crypto.randomBytes(12).toString('hex') + '.upload'); },
  });
}

/**
 * The uploaded backup FILE → { data, archive }. data: the backup (large plugin
 * parts spooled); archive: { header, payload } of a .gcbk (payload without
 * the backup), else null. Throws GcbkError (archive), or code INVALID_JSON.
 */
async function readUpload(file, passphrase) {
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  const backup = require('./backup');
  if (!(await gcbk.isGcbkFile(file))) {
    try { return { data: await backup.readBackupFile(file), archive: null }; } catch (err) {
      if (err && (err.code === 'ENOSPC' || err.code === 'EIO')) throw err;
      throw Object.assign(new Error('not a JSON file'), { code: 'INVALID_JSON' });
    }
  }
  if (!passphrase) throw new gcbk.GcbkError('PASSPHRASE_REQUIRED', 'passphrase required for an encrypted backup');
  const plain = file + PLAIN_SUFFIX;
  const { header } = await gcbk.decryptBackupFileTo(file, passphrase, plain);
  let payload;
  try { payload = await backup.readBackupFile(plain, { under: ['backup'] }); } catch {
    throw new gcbk.GcbkError('CORRUPT', 'decrypted content is not a GateControl backup');
  }
  gcbk.checkPayload(payload);
  const data = payload.backup;
  delete payload.backup;
  return { data, archive: { header, payload } };
}

/** Remove the files of an upload request (the upload, a decrypted archive). */
async function removeUpload(req) {
  const file = req && req.file && req.file.path;
  if (!file) return;
  for (const p of [file, file + PLAIN_SUFFIX]) {
    await fs.promises.rm(p, { force: true }).catch((err) => logger.warn({ err: err.message }, 'backup upload: temp file not removed'));
  }
}

module.exports = { storage, readUpload, removeUpload, incomingDir };
