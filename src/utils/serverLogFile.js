'use strict';

// Server log file: the host's own log (pino JSON lines, already redacted by
// the logger) in <data>/logs/server.log, next to stdout. Rotated by size —
// server.log, server.log.1 … server.log.<files-1>, oldest dropped — and read
// by Logs & Monitoring › Server-Log (services/serverLog.js).
//
// Writing never blocks the main thread and never disturbs the host:
//   * write() only appends to a memory buffer; a short timer writes the batch
//     asynchronously (no fsync — the kernel's page cache is enough for a log);
//   * a full buffer (disk stalled) drops lines instead of growing, the next
//     successful write notes how many were lost;
//   * any error (permissions, full disk, missing directory) is swallowed,
//     reported once per failure streak through onError, and retried later
//     with a growing pause;
//   * on process exit the rest of the buffer is written synchronously, so
//     the last line before a crash (logger.fatal + exit) is not lost.
//
// GC_SERVER_LOG=off switches the file off (stdout only). Without the
// variable it is on, except under NODE_ENV=test. GC_SERVER_LOG_DIR,
// GC_SERVER_LOG_MAX_MB and GC_SERVER_LOG_FILES override place and size.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FILE_NAME = 'server.log';
const DEFAULT_MAX_MB = 5;
const DEFAULT_FILES = 5;
const FLUSH_DELAY_MS = 100;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60 * 1000;

function intEnv(env, key, def, min, max) {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function dataDir(env) {
  return env.GC_DATA_DIR || env.GC_DATA_PATH || '/data';
}

/**
 * Place and size of the server log, from the environment.
 * → { enabled, dir, file, maxBytes, files }
 */
function resolveOptions(env = process.env) {
  const flag = String(env.GC_SERVER_LOG || '').trim().toLowerCase();
  const enabled = flag
    ? !['off', 'false', '0', 'no'].includes(flag)
    : env.NODE_ENV !== 'test';
  const dir = env.GC_SERVER_LOG_DIR || path.join(dataDir(env), 'logs');
  return {
    enabled,
    dir,
    file: path.join(dir, FILE_NAME),
    maxBytes: intEnv(env, 'GC_SERVER_LOG_MAX_MB', DEFAULT_MAX_MB, 1, 100) * 1024 * 1024,
    files: intEnv(env, 'GC_SERVER_LOG_FILES', DEFAULT_FILES, 1, 20),
  };
}

/** Every file of the rotation, newest first: server.log, server.log.1, … */
function rotationFiles(file, files) {
  const out = [file];
  for (let i = 1; i < files; i++) out.push(`${file}.${i}`);
  return out;
}

class RotatingFileStream {
  /**
   * @param {object} o
   * @param {string} o.file      path of server.log
   * @param {number} o.maxBytes  rotate before a write would pass this size
   * @param {number} o.files     files kept, the current one included
   * @param {Function} [o.onError] (err) once per failure streak
   */
  constructor(o) {
    this.file = o.file;
    this.dir = path.dirname(o.file);
    this.maxBytes = o.maxBytes;
    this.files = Math.max(1, o.files);
    this.maxBuffer = o.maxBuffer || MAX_BUFFER_BYTES;
    this.flushDelayMs = o.flushDelayMs == null ? FLUSH_DELAY_MS : o.flushDelayMs;
    this.onError = typeof o.onError === 'function' ? o.onError : null;
    this.buf = [];
    this.bufBytes = 0;
    this.fh = null;
    this.size = 0;
    this.writing = null;
    this.timer = null;
    this.dropped = 0;
    this.failures = 0;
    this.retryAt = 0;
    this.closed = false;
  }

  /** pino destination: one serialised line (with its newline). Never throws. */
  write(chunk) {
    try {
      if (this.closed) return true;
      const s = typeof chunk === 'string' ? chunk : String(chunk);
      if (this.bufBytes + s.length > this.maxBuffer || (this.retryAt && Date.now() < this.retryAt)) {
        this.dropped += 1;
        return true;
      }
      this.buf.push(s);
      this.bufBytes += s.length;
      this._schedule();
    } catch { /* never disturb the logger */ }
    return true;
  }

  _schedule() {
    if (this.timer || this.writing || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush();
    }, this.flushDelayMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _take() {
    let text = this.buf.join('');
    this.buf = [];
    this.bufBytes = 0;
    if (this.dropped) {
      const note = JSON.stringify({ level: 40, time: Date.now(), pid: process.pid, msg: `server log file: ${this.dropped} lines dropped` });
      this.dropped = 0;
      text = note + '\n' + text;
    }
    return Buffer.from(text, 'utf8');
  }

  async _open() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const fh = await fsp.open(this.file, 'a', 0o600);
    try {
      const st = await fh.stat();
      this.size = st.size;
      // An existing file (older version, copied in) gets the same rights.
      if ((st.mode & 0o777) !== 0o600) await fh.chmod(0o600);
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
    this.fh = fh;
  }

  async _rotate() {
    if (this.fh) {
      const fh = this.fh;
      this.fh = null;
      await fh.close().catch(() => {});
    }
    const names = rotationFiles(this.file, this.files);
    if (names.length === 1) {
      await fsp.rm(this.file, { force: true });
    } else {
      for (let i = names.length - 1; i >= 1; i--) {
        try {
          await fsp.rename(names[i - 1], names[i]);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
    }
    this.size = 0;
  }

  async _writeBatch(data) {
    if (!this.fh) await this._open();
    if (this.size > 0 && this.size + data.length > this.maxBytes) {
      await this._rotate();
      await this._open();
    }
    let off = 0;
    while (off < data.length) {
      const { bytesWritten } = await this.fh.write(data, off, data.length - off);
      if (!bytesWritten) throw new Error('short write');
      off += bytesWritten;
    }
    this.size += data.length;
  }

  _flush() {
    if (this.writing) return this.writing;
    if (!this.buf.length || this.closed) return Promise.resolve();
    const data = this._take();
    this.writing = this._writeBatch(data)
      .then(() => {
        this.failures = 0;
        this.retryAt = 0;
      })
      .catch((err) => this._fail(err, data))
      .finally(() => {
        this.writing = null;
        if (this.buf.length) this._schedule();
      });
    return this.writing;
  }

  _fail(err, data) {
    // Lines of the failed batch are lost; count them for the note.
    let lines = 0;
    for (let i = 0; i < data.length; i++) if (data[i] === 10) lines += 1;
    this.dropped += lines;
    if (this.fh) {
      const fh = this.fh;
      this.fh = null;
      fh.close().catch(() => {});
    }
    this.failures += 1;
    this.retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(6, this.failures - 1));
    if (this.failures === 1 && this.onError) {
      const cb = this.onError;
      setImmediate(() => { try { cb(err); } catch { /* ignore */ } });
    }
  }

  /** Write what is buffered now (async); resolves when it is on disk. */
  flush(cb) {
    const p = (async () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.writing) await this.writing;
      await this._flush();
    })().catch(() => {});
    if (typeof cb === 'function') p.then(() => cb(), () => cb());
    return p;
  }

  /** Process exit: write the rest synchronously (no event loop left). */
  flushSync() {
    try {
      if (this.closed || !this.buf.length) return;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      const data = this._take();
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(this.file, 'a', 0o600);
      try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
    } catch { /* nothing left to do */ }
  }

  async close() {
    await this.flush();
    this.closed = true;
    if (this.fh) {
      const fh = this.fh;
      this.fh = null;
      await fh.close().catch(() => {});
    }
  }

  end() { this.close().catch(() => {}); }
}

module.exports = { resolveOptions, rotationFiles, RotatingFileStream, FILE_NAME };
