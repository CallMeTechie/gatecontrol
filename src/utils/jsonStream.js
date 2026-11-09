'use strict';

// JSON written piece by piece to an async sink, without building the whole
// text in memory and without long synchronous stretches on the main thread.
// Used for backups (services/backup.js): with plugin data they reach a few
// hundred MB, and JSON.stringify of the whole object blocked the event loop
// for tens of seconds on a slow NAS.
//
// The output is byte-identical to JSON.stringify(value, null, indent) — the
// tests compare both. Large binary parts are Base64Value objects: they hold
// the raw bytes and are written as a base64 string in chunks; their toJSON()
// gives the same string, so JSON.stringify of the same object still works.
//
// Small subtrees (few nodes, no Base64Value) go through JSON.stringify in one
// piece; everything else is walked here, and the sink yields to the event
// loop after each flushed chunk.
//
// FileBase64Value is a Base64Value whose bytes stay in a file until they are
// written (read in pieces then): a backup with hundreds of MB of plugin data
// never holds them in memory (services/plugins/backup.js). A value with a
// `rawJsonChunks()` method (utils/jsonSpool.js SpooledString: a string of a
// parsed file, left in that file) is written as its JSON text as it is.

const fs = require('node:fs');

const CHUNK_CHARS = 256 * 1024; // flush the pending text from this size on
const B64_RAW_CHUNK = 3 * 64 * 1024; // raw bytes per base64 piece (multiple of 3: no padding inside)
const SMALL_NODES = 2000; // subtrees up to this many nodes are stringified natively

class Base64Value {
  /** @param {Buffer} buf */
  constructor(buf) { this.buf = buf; }
  get length() { return this.buf.length; }
  toJSON() { return this.buf.toString('base64'); }
}

/**
 * Raw bytes of a file (`size` of them, from the start), read only when
 * written. A hard link in a snapshot folder keeps the bytes of a file the
 * plugin deletes or replaces meanwhile; one rewritten in place is read as it
 * is then (never more than `size` bytes).
 */
class FileBase64Value extends Base64Value {
  /** @param {string} file @param {number} size */
  constructor(file, size) { super(null); this.file = file; this.size = size; }
  get length() { return this.size; }
  /** the bytes (synchronous, whole file: materialize / JSON.stringify only) */
  read() {
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(this.size);
      let at = 0;
      while (at < buf.length) {
        const n = fs.readSync(fd, buf, at, buf.length - at, at);
        if (n === 0) break; // shortened meanwhile (rewritten in place): what is there now
        at += n;
      }
      return at === buf.length ? buf : buf.subarray(0, at);
    } finally { fs.closeSync(fd); }
  }
  toJSON() { return this.read().toString('base64'); }
  /** The base64 text in pieces (async; whole multiples of 3 bytes: no padding inside). */
  async* base64Chunks() {
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(B64_RAW_CHUNK * 4);
      let at = 0;
      while (at < this.size) {
        const want = Math.min(buf.length, this.size - at);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await fh.read(buf, got, want - got, at + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        if (got > 0) yield buf.toString('base64', 0, got);
        // shortened meanwhile (rewritten in place): what is there now — every
        // piece before was a whole multiple of 3 bytes, so the text stays valid base64
        if (got < want) return;
        at += got;
      }
    } finally { await fh.close(); }
  }
}
const isRaw = (v) => v !== null && typeof v === 'object' && typeof v.rawJsonChunks === 'function';

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Buffers text and hands it to `out(string)` (may return a promise) in
 * chunks of about CHUNK_CHARS, giving the event loop a turn after each.
 */
function makeWriter(out) {
  let parts = [];
  let size = 0;
  const flush = async () => {
    if (!size) return;
    const text = parts.length === 1 ? parts[0] : parts.join('');
    parts = [];
    size = 0;
    await out(text);
    await yieldLoop();
  };
  return {
    write(s) {
      parts.push(s);
      size += s.length;
      return size >= CHUNK_CHARS ? flush() : null;
    },
    flush,
  };
}

// JSON.stringify semantics of a value before it is written
function prepare(v, key) {
  if (v instanceof Base64Value || isRaw(v)) return v;
  if (v !== null && typeof v === 'object' && typeof v.toJSON === 'function') return v.toJSON(key);
  return v;
}
const isSkipped = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

/** true when `v` is a small subtree without Base64Value (safe for one JSON.stringify call) */
function isSmall(v) {
  let budget = SMALL_NODES;
  const walk = (x) => {
    if (--budget < 0) return false;
    if (x instanceof Base64Value || isRaw(x)) return false;
    if (x === null || typeof x !== 'object') return true;
    if (typeof x.toJSON === 'function') return true; // Date, Buffer, … — a leaf for our purposes
    if (Array.isArray(x)) { for (const e of x) if (!walk(e)) return false; return true; }
    for (const k of Object.keys(x)) if (!walk(x[k])) return false;
    return true;
  };
  return walk(v);
}

/**
 * Write `value` as JSON.
 * @param {(chunk: string) => (Promise<void>|void)} out
 * @param {*} value
 * @param {object} [opts]
 * @param {number} [opts.indent=0] spaces per level (like JSON.stringify's third argument)
 */
async function writeJson(out, value, { indent = 0 } = {}) {
  const gap = indent > 0 ? ' '.repeat(Math.min(10, indent)) : '';
  const w = makeWriter(out);
  const pad = (depth) => (gap ? '\n' + gap.repeat(depth) : '');
  const colon = gap ? ': ' : ':';

  const writeValue = async (v, depth) => {
    if (v instanceof FileBase64Value) {
      w.write('"');
      for await (const piece of v.base64Chunks()) {
        const p = w.write(piece);
        if (p) await p;
      }
      w.write('"');
      return;
    }
    if (isRaw(v)) {
      for await (const piece of v.rawJsonChunks()) {
        const p = w.write(piece);
        if (p) await p;
      }
      return;
    }
    if (v instanceof Base64Value) {
      w.write('"');
      for (let at = 0; at < v.buf.length; at += B64_RAW_CHUNK) {
        const p = w.write(v.buf.toString('base64', at, Math.min(v.buf.length, at + B64_RAW_CHUNK)));
        if (p) await p;
      }
      w.write('"');
      return;
    }
    if (v === null || typeof v !== 'object' || isSmall(v)) {
      let s = JSON.stringify(v, null, gap);
      if (s === undefined) s = 'null'; // only reachable for array items (object props are skipped before)
      else if (gap && depth) s = s.replace(/\n/g, pad(depth));
      const p = w.write(s);
      if (p) await p;
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) { w.write('[]'); return; }
      w.write('[');
      for (let i = 0; i < v.length; i++) {
        if (i) w.write(',');
        w.write(pad(depth + 1));
        const item = prepare(v[i], String(i));
        await writeValue(isSkipped(item) ? null : item, depth + 1);
      }
      w.write(pad(depth) + ']');
      return;
    }
    w.write('{');
    let first = true;
    for (const k of Object.keys(v)) {
      const item = prepare(v[k], k);
      if (isSkipped(item)) continue;
      if (!first) w.write(',');
      first = false;
      w.write(pad(depth + 1) + JSON.stringify(k) + colon);
      await writeValue(item, depth + 1);
    }
    w.write(first ? '}' : pad(depth) + '}');
  };

  const top = prepare(value, '');
  if (isSkipped(top)) throw new TypeError('value is not JSON-serialisable');
  await writeValue(top, 0);
  await w.flush();
}

/** Replace every Base64Value in `v` by its base64 string (in place for plain objects/arrays). → v */
function materialize(v) {
  if (v instanceof Base64Value) return v.toJSON();
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = materialize(v[i]); return v; }
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const k of Object.keys(v)) v[k] = materialize(v[k]);
  }
  return v;
}

module.exports = { Base64Value, FileBase64Value, writeJson, materialize, yieldLoop };
