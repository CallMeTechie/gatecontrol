'use strict';

// Child-process helper for the sftp/smbclient transports: argv only (no
// shell), a minimal environment (the app's env carries GC_ENCRYPTION_KEY /
// GC_SECRET — a child never needs them), stdin input, hard timeout, capped
// output. Private temp files live in <dataDir>/offsite (0700) and are removed
// by the caller in `finally`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensurePrivateDir, PRIVATE_FILE_MODE } = require('../../utils/fileModes');

const MAX_OUTPUT = 1024 * 1024;

function dataDir() {
  return process.env.GC_DATA_PATH || process.env.GC_DATA_DIR || '/data';
}

const TEMP_RE = /^(?:upload|probe|smbauth|id_ed25519)-[0-9a-f]{16}$/;
let swept = false;

function workDir() {
  const dir = path.join(dataDir(), 'offsite');
  ensurePrivateDir(dir);
  // First use in this process: nothing of ours is in flight yet, so any temp
  // file left there was orphaned by a crash/kill mid-transfer (it may hold a
  // key or an SMB password) — remove it.
  if (!swept) {
    swept = true;
    try {
      for (const n of fs.readdirSync(dir)) if (TEMP_RE.test(n)) rmQuiet(path.join(dir, n));
    } catch { /* best effort */ }
  }
  return dir;
}

/** Write a 0600 temp file in the private work dir; returns its path. */
function writeTemp(prefix, content) {
  const p = path.join(workDir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}`);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE);
  try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  return p;
}

function rmQuiet(p) { if (p) { try { fs.unlinkSync(p); } catch { /* gone */ } } }

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [o]
 * @param {string} [o.input]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
function run(cmd, args, { input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: workDir(),
      LANG: 'C',
      LC_ALL: 'C',
    };
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s, d) => (s.length < MAX_OUTPUT ? s + d.toString('utf8') : s);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        const e = new Error(`${cmd} is not installed in this image`);
        e.code = 'TRANSPORT';
        reject(e);
      } else reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => { /* child exited early; reported via close */ });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

module.exports = { run, writeTemp, rmQuiet, workDir, dataDir };
