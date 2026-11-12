'use strict';

// Antwort-Zwischenspeicher des DNS-Filters: Upstream-Antworten (wire) mit
// Ablaufzeit; LRU über die Einfügereihenfolge der Map, begrenzt nach Anzahl
// und Bytes. Gesperrte Antworten werden nie gespeichert (die Entscheidung
// hängt vom Client und der Uhrzeit ab).

const MAX_TTL_S = 86_400;
const MAX_NEG_TTL_S = 3_600;
const DEFAULT_NEG_TTL_S = 60;

class ResponseCache {
  constructor({ maxEntries = 10_000, maxBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
    Object.assign(this, { maxEntries, maxBytes, now });
    this.map = new Map();
    this.bytes = 0;
  }

  get size() { return this.map.size; }

  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    const now = this.now();
    if (now >= e.expires) { this._delete(key, e); return null; }
    this.map.delete(key);
    this.map.set(key, e);
    return { ...e, ageSec: Math.floor((now - e.storedAt) / 1000) };
  }

  /** TTL aus der zerlegten Antwort ableiten (0 = nicht speichern). */
  static ttlFor(meta) {
    if (!meta || meta.tc) return 0;
    if (meta.rcode === 0 && meta.an > 0) return Math.min(MAX_TTL_S, meta.minTtl || 0);
    if (meta.rcode === 3 || (meta.rcode === 0 && meta.an === 0)) {
      return Math.min(MAX_NEG_TTL_S, meta.negTtl === null || meta.negTtl === undefined ? DEFAULT_NEG_TTL_S : meta.negTtl);
    }
    return 0;
  }

  set(key, wire, meta) {
    const ttl = ResponseCache.ttlFor(meta);
    if (ttl <= 0 || wire.length > this.maxBytes / 16) return false;
    const old = this.map.get(key);
    if (old) this._delete(key, old);
    const now = this.now();
    this.map.set(key, { wire, ttlOffsets: meta.ttlOffsets, storedAt: now, expires: now + ttl * 1000 });
    this.bytes += wire.length;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, e] = this.map.entries().next().value;
      this._delete(k, e);
    }
    return true;
  }

  _delete(key, e) {
    this.map.delete(key);
    this.bytes -= e.wire.length;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

module.exports = { ResponseCache };
