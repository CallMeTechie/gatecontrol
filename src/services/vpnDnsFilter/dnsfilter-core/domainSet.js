'use strict';

// Kompakte Domain-Mengen für den DNS-Filter.
//
// Große Sperrlisten (OISD, HaGeZi … mit 50 000 – 500 000 Einträgen) liegen
// nicht als JS-Strings im Speicher (≈ 80–100 Bytes je Eintrag), sondern als
// sortierte 53-Bit-Hashwerte in einem Float64Array (8 Bytes je Eintrag);
// Suche per Binärsuche. Zwei unabhängige 32-Bit-Hashes ergeben 53 Bit – bei
// 1 Mio. Einträgen liegt die Wahrscheinlichkeit einer falschen Sperre je
// Anfrage bei ≈ 1e-10.
//
// Kleine Mengen (Ausnahmen, Kategorien, alwaysAllow) bleiben als Set<string>
// (PatternSet), damit `POST /api/dns/test` und Tests sie lesbar halten.

const { domainToASCII } = require('node:url');

const LABEL_RE = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const TWO32 = 4294967296;

/** 53-Bit-Hash eines (kleingeschriebenen ASCII-)Domainnamens. */
function hash53(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  h2 = Math.imul(h2 ^ (h2 >>> 15), 0x85ebca6b);
  h2 ^= h2 >>> 16;
  return (h1 & 0x1fffff) * TWO32 + (h2 >>> 0);
}

/** Alle Endstücke eines Namens: "a.b.c" → ["a.b.c", "b.c", "c"]. */
function suffixes(name) {
  const out = [name];
  let i = name.indexOf('.');
  while (i !== -1) {
    out.push(name.slice(i + 1));
    i = name.indexOf('.', i + 1);
  }
  return out;
}

/**
 * Domain säubern: kleinschreiben, Punkt am Ende weg, IDN → Punycode,
 * Labels prüfen. Ohne Punkt (einzelnes Label/TLD) → null. → string|null
 */
function cleanDomain(raw, { allowSingleLabel = false } = {}) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (!s || s.length > 253) return null;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(s)) {
    s = domainToASCII(s);
    if (!s) return null;
  }
  if (/^[0-9.]+$/.test(s)) return null; // IPv4-Adresse, kein Name
  const labels = s.split('.');
  if (!allowSingleLabel && labels.length < 2) return null;
  for (const l of labels) if (!LABEL_RE.test(l)) return null;
  return s;
}

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function hasHash(arr, v) {
  const i = lowerBound(arr, v);
  return i < arr.length && arr[i] === v;
}

/** Sammelt Hashes in wachsendem Puffer; finish() sortiert, entfernt Doppelte, gibt passgenaues Array. */
class HashBuilder {
  constructor(initial = 1024) {
    this.buf = new Float64Array(initial);
    this.n = 0;
  }

  add(domain) {
    this.addHash(hash53(domain));
  }

  addHash(h) {
    if (this.n === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = h;
  }

  get size() { return this.n; }

  /**
   * Sortieren, Doppelte entfernen. Bleibt höchstens ein Achtel ungenutzt,
   * wird der Puffer selbst weiterverwendet (keine zweite große Zuteilung –
   * wichtig gegen Zerstückelung des Speichers bei täglichem Neuladen).
   */
  finish() {
    const a = this.buf.subarray(0, this.n).sort();
    let w = 0;
    for (let r = 0; r < a.length; r++) {
      if (r === 0 || a[r] !== a[r - 1]) a[w++] = a[r];
    }
    const out = w >= this.buf.length - (this.buf.length >>> 3) ? this.buf.subarray(0, w) : a.slice(0, w);
    this.buf = null;
    return out;
  }
}

/**
 * Eine geladene Liste. `suffix`: Eintrag sperrt Domain samt Subdomains
 * (domains/adblock), `exact`: nur genau diesen Namen (hosts),
 * `except`: Adblock-Ausnahmen (@@||…^) – heben Sperren dieser Liste auf.
 */
class CompactList {
  constructor({ suffix, exact, except }) {
    this.suffix = suffix || new Float64Array(0);
    this.exact = exact || new Float64Array(0);
    this.except = except || new Float64Array(0);
  }

  get size() { return this.suffix.length + this.exact.length; }

  get bytes() { return (this.suffix.length + this.exact.length + this.except.length) * 8; }

  /** Treffer mit vorab berechneten Hashes aller Endstücke (h[0] = ganzer Name). */
  matchHashes(h) {
    if (this.except.length) {
      for (const x of h) if (hasHash(this.except, x)) return false;
    }
    if (this.exact.length && hasHash(this.exact, h[0])) return true;
    if (this.suffix.length) {
      for (const x of h) if (hasHash(this.suffix, x)) return true;
    }
    return false;
  }

  matches(name) {
    return this.matchHashes(suffixes(name).map(hash53));
  }
}

/**
 * Kleine Musterliste: 'example.com' = Domain samt Subdomains,
 * '*.example.com' = nur Subdomains.
 */
class PatternSet {
  constructor(patterns = []) {
    this.incl = new Set();
    this.sub = new Set();
    for (const p of patterns) this.add(p);
  }

  add(p) {
    if (typeof p !== 'string') return false;
    const wild = p.trim().startsWith('*.');
    const d = cleanDomain(wild ? p.trim().slice(2) : p);
    if (!d) return false;
    (wild ? this.sub : this.incl).add(d);
    return true;
  }

  get size() { return this.incl.size + this.sub.size; }

  matches(name) {
    if (!this.size) return false;
    if (this.incl.has(name)) return true;
    let i = name.indexOf('.');
    while (i !== -1) {
      const s = name.slice(i + 1);
      if (this.incl.has(s) || this.sub.has(s)) return true;
      i = name.indexOf('.', i + 1);
    }
    return false;
  }

  /** Normalisierte Muster (sortiert) – für Tests/Diagnose. */
  toArray() {
    return [...[...this.incl], ...[...this.sub].map((d) => `*.${d}`)].sort();
  }
}

module.exports = { hash53, suffixes, cleanDomain, HashBuilder, CompactList, PatternSet, hasHash };
