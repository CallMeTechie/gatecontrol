'use strict';

// Sperrlisten selbst laden (Vertrag Phase 3b §1.2): täglich, mit ETag /
// If-Modified-Since, nur HTTPS (auch bei Weiterleitungen), Größen- und
// Formatgrenzen. Die letzte gute Fassung bleibt im State-Verzeichnis
// (/state/dns-lists/<id>.txt) und wird nach einem Neustart sofort geladen.
// State-Verzeichnis und Logger (info/warn/debug, pino-Aufruf) werden übergeben.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./stateFile');
const { parseListStream, countLines } = require('./listParser');

const DIR = 'dns-lists';
const META = 'meta.json';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES_LIST = 1_500_000;
const MAX_ENTRIES_TOTAL = 3_000_000;
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'GateControl-Gateway';
const NO_LOG = Object.freeze({ info() {}, warn() {}, debug() {} });
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class FetchError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * Liste nach `dest` laden. → { status: 304 } | { status: 200, bytes, sha256, etag, lastModified }
 */
function fetchList(url, dest, { etag = null, lastModified = null, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, agent, redirects = 0, userAgent = USER_AGENT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_e) { reject(new FetchError('bad_url')); return; }
    if (u.protocol !== 'https:') { reject(new FetchError('not_https')); return; }
    const headers = { 'user-agent': userAgent, accept: 'text/plain, */*' };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;
    const req = https.get(u, { headers, agent, timeout: timeoutMs }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) { reject(new FetchError('too_many_redirects')); return; }
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (_e) { reject(new FetchError('bad_redirect')); return; }
        resolve(fetchList(next, dest, { etag, lastModified, maxBytes, timeoutMs, agent, redirects: redirects + 1, userAgent }));
        return;
      }
      if (code === 304) { res.resume(); resolve({ status: 304 }); return; }
      if (code !== 200) { res.resume(); reject(new FetchError('http_status', `HTTP ${code}`)); return; }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); reject(new FetchError('too_large')); return; }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      let bytes = 0;
      let failed = false;
      const fail = (e) => {
        if (failed) return;
        failed = true;
        res.destroy();
        out.destroy();
        fs.rm(dest, { force: true }, () => reject(e));
      };
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) { fail(new FetchError('too_large')); return; }
        hash.update(c);
      });
      res.on('error', (e) => fail(new FetchError('network', e.message)));
      out.on('error', (e) => fail(new FetchError('write', e.message)));
      out.on('finish', () => {
        if (failed) return;
        resolve({
          status: 200, bytes, sha256: hash.digest('hex'),
          etag: typeof res.headers.etag === 'string' ? res.headers.etag.slice(0, 256) : null,
          lastModified: typeof res.headers['last-modified'] === 'string' ? res.headers['last-modified'].slice(0, 64) : null,
        });
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new FetchError('timeout')));
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError('network', e.message)));
  });
}

async function parseFile(file, format, maxEntries) {
  const expectedEntries = await countLines(fs.createReadStream(file));
  return parseListStream(fs.createReadStream(file, { highWaterMark: 64 * 1024 }), format, { maxEntries, expectedEntries });
}

class ListManager {
  constructor({ stateDir, fetch = fetchList, now = Date.now, rand = Math.random, onChange = () => {}, logger = NO_LOG }) {
    this.dir = path.join(stateDir, DIR);
    Object.assign(this, { fetch, now, rand, onChange, logger });
    this.catalog = {};
    this.used = new Set();
    this.lists = new Map();      // id → CompactList
    this.meta = {};              // id → { url, format, etag, lastModified, sha256, entries, bytes, updatedAt, checkedAt, nextAt, error }
    this.loadedMeta = false;
    this.busy = null;
  }

  _ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); return true; } catch (_e) { return false; }
  }

  _file(id, ext = 'txt') {
    if (!ID_RE.test(id)) throw new Error('bad list id');
    const root = path.resolve(this.dir);
    const file = path.resolve(root, `${id}.${ext}`);
    if (!file.startsWith(root + path.sep)) throw new Error('bad list id');
    return file;
  }

  _loadMeta() {
    if (this.loadedMeta) return;
    this.loadedMeta = true;
    const m = readJson(this.dir, META);
    if (m && m.lists && typeof m.lists === 'object') {
      for (const [id, v] of Object.entries(m.lists)) if (ID_RE.test(id) && v && typeof v === 'object') this.meta[id] = v;
    }
  }

  _saveMeta() {
    if (this._ensureDir()) writeJson(this.dir, META, { v: 1, lists: this.meta }, this.logger);
  }

  totalEntries(except = null) {
    let n = 0;
    for (const [id, l] of this.lists) if (id !== except) n += l.size;
    return n;
  }

  /**
   * Katalog + benutzte Listen setzen. Nicht mehr benutzte Listen fallen aus
   * dem Speicher; Listen, die es im Katalog nicht mehr gibt, auch von der Platte.
   */
  async setWanted(catalog, usedIds) {
    this._loadMeta();
    this.catalog = catalog;
    this.used = new Set([...usedIds].filter((id) => catalog[id]));
    let changed = false;
    for (const id of [...this.lists.keys()]) {
      if (!this.used.has(id)) { this.lists.delete(id); changed = true; }
    }
    for (const id of Object.keys(this.meta)) {
      if (!catalog[id]) {
        delete this.meta[id];
        fs.rm(this._file(id), { force: true }, () => {});
      }
    }
    for (const id of this.used) {
      const c = catalog[id];
      const m = this.meta[id];
      const same = m && m.url === c.url && m.format === c.format && (!c.sha256 || c.sha256 === m.sha256);
      if (!same) {
        this.meta[id] = { url: c.url, format: c.format, etag: null, lastModified: null, sha256: null, entries: 0, bytes: 0, updatedAt: null, checkedAt: null, nextAt: 0, error: null };
        if (this.lists.delete(id)) changed = true;
        continue;
      }
      if (!this.lists.has(id)) {
        try {
          const r = await parseFile(this._file(id), c.format, MAX_ENTRIES_LIST);
          this.lists.set(id, r.list);
          m.entries = r.entries;
          changed = true;
        } catch (_e) {
          m.nextAt = 0; // Datei fehlt/kaputt → gleich neu laden
        }
      }
    }
    this._saveMeta();
    if (changed) this.onChange();
  }

  /** Fällige Listen nacheinander laden (eine zur Zeit). */
  refreshDue() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      for (const id of this.used) {
        const m = this.meta[id];
        if (!m || (m.nextAt || 0) > this.now()) continue;
        await this._refresh(id);
      }
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  async _refresh(id) {
    const c = this.catalog[id];
    const m = this.meta[id];
    if (!c || !m || !this._ensureDir()) return;
    const part = this._file(id, 'part');
    const jitter = Math.floor(this.rand() * 3600_000);
    try {
      const haveFile = this.lists.has(id);
      const r = await this.fetch(c.url, part, haveFile ? { etag: m.etag, lastModified: m.lastModified } : {});
      m.checkedAt = this.now();
      if (r.status === 304) {
        m.error = null;
        m.nextAt = this.now() + REFRESH_MS + jitter;
        this._saveMeta();
        return;
      }
      if (c.sha256 && r.sha256 !== c.sha256) throw new FetchError('sha256_mismatch');
      const room = Math.min(MAX_ENTRIES_LIST, MAX_ENTRIES_TOTAL - this.totalEntries(id));
      const parsed = await parseFile(part, c.format, Math.max(0, room));
      if (!parsed.entries) throw new FetchError('empty', 'no valid entries');
      fs.renameSync(part, this._file(id));
      if (this.catalog[id] !== c || !this.used.has(id)) return; // inzwischen geändert
      this.lists.set(id, parsed.list);
      Object.assign(m, {
        etag: r.etag, lastModified: r.lastModified, sha256: r.sha256, entries: parsed.entries,
        bytes: r.bytes, updatedAt: this.now(), error: null, nextAt: this.now() + REFRESH_MS + jitter,
      });
      this._saveMeta();
      this.logger.info({ list: id, entries: parsed.entries, bytes: r.bytes }, 'dns: list updated');
      this.onChange();
    } catch (err) {
      fs.rm(part, { force: true }, () => {});
      m.checkedAt = this.now();
      m.error = { at: this.now(), code: err.code || 'error' };
      m.nextAt = this.now() + RETRY_MS + jitter;
      this._saveMeta();
      this.logger.warn({ list: id, err: err.code || err.message }, 'dns: list update failed (keeping last good version)');
    }
  }

  telemetry() {
    const out = {};
    for (const id of this.used) {
      const m = this.meta[id] || {};
      out[id] = {
        loaded: this.lists.has(id),
        entries: this.lists.has(id) ? this.lists.get(id).size : 0,
        updatedAt: m.updatedAt || null,
        checkedAt: m.checkedAt || null,
        error: m.error || null,
      };
    }
    return out;
  }

  memoryBytes() {
    let n = 0;
    for (const l of this.lists.values()) n += l.bytes;
    return n;
  }
}

module.exports = { ListManager, fetchList, FetchError, MAX_BYTES, REFRESH_MS };
