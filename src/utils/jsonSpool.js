'use strict';

// JSON files that are too large for one JSON.parse (backups with hundreds of
// MB of plugin data, docs/plugins.md "Backup"): the file is read in pieces,
// every string longer than SPOOL_MIN bytes stays in the file — the parsed
// value holds a SpooledString (file, byte range) in its place — and only the
// rest (the tables, a few MB) goes through JSON.parse. One giant string from
// the whole file would need the file's size several times in memory and fails
// above V8's string limit (~512 MB) anyway.
//
// A SpooledString gives its text (text(), short strings outside the plugin
// parts), its base64-decoded bytes (buffer(), bufferSync()) or writes them
// decoded to a file in pieces (writeDecoded(), a plugin database of several
// hundred MB). The file must stay unchanged while the value is used.
//
// No dependencies beyond Node core modules (also used by src/bin/offsite-decrypt.js).

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');

const SPOOL_MIN = 16 * 1024; // strings longer than this (bytes) stay in the file
const READ_CHUNK = 1024 * 1024;
const DECODE_CHUNK = 4 * 1024 * 1024; // base64 characters per decode step (multiple of 4)
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

class SpooledString {
  /**
   * @param {string} file
   * @param {number} start  first byte of the string's content (after the quote)
   * @param {number} end    the closing quote
   * @param {boolean} escaped  the content has backslash escapes
   */
  constructor(file, start, end, escaped) {
    this.file = file;
    this.start = start;
    this.end = end;
    this.escaped = escaped;
  }

  /** bytes of the JSON text between the quotes (base64: its length in characters) */
  get byteLength() { return this.end - this.start; }

  /** about the decoded size of base64 content */
  get decodedLength() { return Math.floor(this.byteLength * 3 / 4); }

  rawSync() {
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(this.byteLength);
      let at = 0;
      while (at < buf.length) {
        const n = fs.readSync(fd, buf, at, buf.length - at, this.start + at);
        if (n === 0) throw new Error('spooled JSON file became shorter');
        at += n;
      }
      return buf;
    } finally { fs.closeSync(fd); }
  }

  /** the string (synchronous; for strings of moderate size) */
  text() {
    const raw = this.rawSync();
    return this.escaped ? JSON.parse('"' + raw.toString('utf8') + '"') : raw.toString('utf8');
  }

  toJSON() { return this.text(); }

  /** base64 content → Buffer (synchronous) */
  bufferSync() {
    if (this.escaped) return Buffer.from(this.text(), 'base64');
    const out = Buffer.alloc(this.decodedLength);
    let n = 0;
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(DECODE_CHUNK, this.byteLength));
      for (let at = this.start; at < this.end;) {
        const want = Math.min(buf.length, this.end - at);
        const got = fs.readSync(fd, buf, 0, want, at);
        if (got === 0) throw new Error('spooled JSON file became shorter');
        const usable = at + got >= this.end ? got : got - (got % 4);
        n += out.write(buf.toString('latin1', 0, usable), n, 'base64');
        at += usable;
      }
    } finally { fs.closeSync(fd); }
    return n === out.length ? out : out.subarray(0, n);
  }

  /** base64 content → Buffer, read in pieces (the event loop runs in between) */
  async buffer() {
    if (this.escaped) return Buffer.from(this.text(), 'base64');
    const out = Buffer.alloc(this.decodedLength);
    let n = 0;
    for await (const piece of this.decodedChunks()) { piece.copy(out, n); n += piece.length; }
    return n === out.length ? out : out.subarray(0, n);
  }

  /** the base64-decoded content in pieces */
  async* decodedChunks() {
    if (this.escaped) { yield Buffer.from(this.text(), 'base64'); return; }
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(Math.max(4, Math.min(DECODE_CHUNK, this.byteLength)));
      for (let at = this.start; at < this.end;) {
        const want = Math.min(buf.length, this.end - at);
        const { bytesRead } = await fh.read(buf, 0, want, at);
        if (bytesRead === 0) throw new Error('spooled JSON file became shorter');
        const usable = at + bytesRead >= this.end ? bytesRead : bytesRead - (bytesRead % 4);
        yield Buffer.from(buf.toString('latin1', 0, usable), 'base64');
        at += usable;
      }
    } finally { await fh.close(); }
  }

  /** write the base64-decoded content to `target` (a new file, flag 'wx') → bytes written */
  async writeDecoded(target, { mode = 0o600, flag = 'wx' } = {}) {
    const fh = await fs.promises.open(target, flag, mode);
    let total = 0;
    try {
      for await (const piece of this.decodedChunks()) {
        let at = 0;
        while (at < piece.length) {
          const { bytesWritten } = await fh.write(piece, at, piece.length - at);
          at += bytesWritten;
        }
        total += piece.length;
        await yieldLoop();
      }
    } finally { await fh.close(); }
    return total;
  }

  /** the JSON text of the string, quotes included, in pieces (utils/jsonStream writes it as it is) */
  async* rawJsonChunks() {
    yield '"';
    const fh = await fs.promises.open(this.file, 'r');
    const dec = new StringDecoder('utf8');
    try {
      const buf = Buffer.alloc(Math.max(1, Math.min(READ_CHUNK, this.byteLength)));
      for (let at = this.start; at < this.end;) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, this.end - at), at);
        if (bytesRead === 0) throw new Error('spooled JSON file became shorter');
        at += bytesRead;
        yield dec.write(buf.subarray(0, bytesRead));
      }
      const rest = dec.end();
      if (rest) yield rest;
    } finally { await fh.close(); }
    yield '"';
  }
}

/**
 * Parse the JSON file `file`; strings longer than `spoolMin` bytes become
 * SpooledString values (object keys never do — they are short in every file
 * this is used for). Async: the file is read in pieces with the event loop
 * running in between; only the short rest goes through JSON.parse.
 *
 * @param {string} file
 * @param {{spoolMin?: number, readChunk?: number}} [opts]  (readChunk: tests)
 * @returns {Promise<{value: *, spooled: number, bytes: number}>}
 */
async function parseFile(file, { spoolMin = SPOOL_MIN, readChunk = READ_CHUNK } = {}) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const marker = '\u0000gcspool' + nonce + ':';
  const spools = [];
  const out = []; // copies (never slices: a slice would keep its whole read buffer alive)
  let outLen = 0;
  const emit = (b) => { out.push(b); outLen += b.length; };

  let inString = false;
  let strStart = 0; // absolute offset of the first content byte
  let pending = []; // content of the current string while it is short
  let pendingLen = 0;
  let spooling = false;
  let escaped = false;
  let backslashes = 0; // backslashes right before the current position (inside a string)

  const fh = await fs.promises.open(file, 'r');
  let pos = 0;
  try {
    const buf = Buffer.alloc(readChunk);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let i = 0;
      while (i < chunk.length) {
        if (!inString) {
          const q = chunk.indexOf(QUOTE, i);
          if (q === -1) { emit(Buffer.from(chunk.subarray(i))); i = chunk.length; break; }
          if (q > i) emit(Buffer.from(chunk.subarray(i, q)));
          inString = true; strStart = pos + q + 1; pending = []; pendingLen = 0; spooling = false; escaped = false; backslashes = 0;
          i = q + 1;
          continue;
        }
        // inside a string: the next quote that is not escaped ends it
        let q = chunk.indexOf(QUOTE, i);
        while (q !== -1) {
          let n = 0;
          for (let k = q - 1; k >= i && chunk[k] === BACKSLASH; k--) n++;
          if (n === q - i) n += backslashes; // the whole stretch since i are backslashes: count the run before it
          if (n % 2 === 0) break;
          q = chunk.indexOf(QUOTE, q + 1);
        }
        const segEnd = q === -1 ? chunk.length : q;
        if (!escaped) { const b = chunk.indexOf(BACKSLASH, i); if (b !== -1 && b < segEnd) escaped = true; }
        if (segEnd > i) {
          let run = 0;
          for (let k = segEnd - 1; k >= i && chunk[k] === BACKSLASH; k--) run++;
          backslashes = run === segEnd - i ? backslashes + run : run;
          if (!spooling) {
            pending.push(Buffer.from(chunk.subarray(i, segEnd)));
            pendingLen += segEnd - i;
            if (pendingLen > spoolMin) { spooling = true; pending = []; }
          }
        }
        if (q === -1) { i = chunk.length; break; }
        // the string ends at absolute offset pos + q
        if (spooling) {
          emit(Buffer.from(JSON.stringify(marker + spools.length), 'utf8'));
          spools.push(new SpooledString(file, strStart, pos + q, escaped));
        } else {
          emit(Buffer.from('"'));
          for (const p of pending) emit(p);
          emit(Buffer.from('"'));
        }
        pending = []; pendingLen = 0; inString = false;
        i = q + 1;
      }
      pos += bytesRead;
      await yieldLoop();
    }
  } finally { await fh.close(); }
  if (inString) throw new SyntaxError('Unterminated string in JSON file');

  const text = Buffer.concat(out, outLen).toString('utf8');
  out.length = 0;
  const value = JSON.parse(text, spools.length ? (key, v) => {
    if (typeof v === 'string' && v.charCodeAt(0) === 0 && v.startsWith(marker)) {
      const idx = Number(v.slice(marker.length));
      return Number.isInteger(idx) && spools[idx] ? spools[idx] : v;
    }
    return v;
  } : undefined);
  return { value, spooled: spools.length, bytes: pos };
}

/**
 * Replace every SpooledString in `v` by its text, except where `keep(path)`
 * says so (path: array of keys from the root). In place for plain objects and
 * arrays. → v
 */
function resolve(v, keep = () => false, at = []) {
  if (v instanceof SpooledString) return keep(at) ? v : v.text();
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = resolve(v[i], keep, at.concat(i)); return v; }
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const k of Object.keys(v)) v[k] = resolve(v[k], keep, at.concat(k));
  }
  return v;
}

const isSpooled = (v) => v instanceof SpooledString;

module.exports = { parseFile, resolve, isSpooled, SpooledString, SPOOL_MIN };
