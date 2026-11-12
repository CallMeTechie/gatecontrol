'use strict';

// Sperrlisten lesen (Formate laut Vertrag Phase 3b §1.1):
//   domains  – eine Domain je Zeile (auch "*.domain"); sperrt samt Subdomains
//   hosts    – "0.0.0.0 domain …" (hosts-Datei); sperrt genau diesen Namen
//   adblock  – "||domain^" (samt Subdomains), "@@||domain^" = Ausnahme;
//              Regeln mit anderen Optionen, Pfaden oder Kosmetik werden übersprungen
//
// Gelesen wird direkt auf den Bytes: keine Zeichenkette je Zeile, der Hash
// entsteht beim Prüfen. So bleibt auf dem Pi kaum Müll für die
// Speicherbereinigung (eine Liste mit 240 000 Zeilen erzeugt sonst
// > 20 MB kurzlebige Strings und lässt den Prozess dauerhaft wachsen).
// Die Listen kommen aus dem Internet: Zeilenlänge und Eintragszahl sind begrenzt.

const { Readable } = require('node:stream');
const { cleanDomain, hash53, HashBuilder, CompactList } = require('./domainSet');

const FORMATS = new Set(['domains', 'hosts', 'adblock']);
const MAX_LINE = 1024;
const TWO32 = 4294967296;
const NL = 0x0a;
const HOSTS_SKIP = new Set(['localhost.localdomain', 'local.localdomain', 'ip6-localhost.localdomain'].map(hash53));
const ADBLOCK_OPTS = new Set(['', '$important', '$all', '$document']);

class ListTooLarge extends Error {
  constructor(max) { super(`list has more than ${max} entries`); this.code = 'too_many_entries'; }
}

const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0b || c === 0x0c;
const isAlnum = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);

/**
 * Domain in buf[s, e) prüfen und hashen (wie hash53 über den kleingeschriebenen
 * Namen). → Hash (Zahl), null = ungültig, undefined = Nicht-ASCII (langsamer Weg).
 */
function hashDomainBytes(buf, s, e) {
  if (e > s && buf[e - 1] === 0x2e) e--;          // Punkt am Ende
  const len = e - s;
  if (len < 3 || len > 253) return null;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  let labelLen = 0;
  let dots = 0;
  let prev = 0x2e;
  let alpha = false;
  for (let i = s; i < e; i++) {
    let c = buf[i];
    if (c >= 0x80) return undefined;
    if (c >= 0x41 && c <= 0x5a) c += 32;
    if (c === 0x2e) {
      if (labelLen === 0 || prev === 0x2d) return null;   // leeres Label / endet mit '-'
      dots++;
      labelLen = 0;
    } else if (isAlnum(c) || c === 0x5f || (c === 0x2d && labelLen > 0)) {
      if (++labelLen > 63) return null;
      if (c > 0x39) alpha = true;
    } else {
      return null;
    }
    prev = c;
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  if (labelLen === 0 || prev === 0x2d || dots === 0 || !alpha) return null; // !alpha: IPv4-Adresse
  h2 = Math.imul(h2 ^ (h2 >>> 15), 0x85ebca6b);
  h2 ^= h2 >>> 16;
  return (h1 & 0x1fffff) * TWO32 + (h2 >>> 0);
}

function domainHash(buf, s, e) {
  const h = hashDomainBytes(buf, s, e);
  if (h !== undefined) return h;
  const d = cleanDomain(buf.toString('utf8', s, e)); // IDN → Punycode
  return d ? hash53(d) : null;
}

function isIpToken(buf, s, e) {
  if (e - s < 2 || e - s > 39) return false;
  for (let i = s; i < e; i++) {
    const c = buf[i] | 0x20;
    if (!((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x3a || (c >= 0x61 && c <= 0x66))) return false;
  }
  return true;
}

/** Eine Zeile buf[s, e) → ruft add(kind, hash) für jeden Eintrag. */
function parseLineBytes(buf, s, e, format, add) {
  while (s < e && isSpace(buf[s])) s++;
  while (e > s && isSpace(buf[e - 1])) e--;
  if (s >= e) return false;
  const first = buf[s];
  if (format === 'adblock') {
    if (first === 0x21 || first === 0x5b || first === 0x23) return false; // ! [ #
    let p = s;
    let kind = 'suffix';
    if (first === 0x40 && buf[s + 1] === 0x40) { kind = 'except'; p += 2; }
    if (buf[p] !== 0x7c || buf[p + 1] !== 0x7c) return false;          // ||
    p += 2;
    const caret = buf.indexOf(0x5e, p);                                  // ^
    if (caret === -1 || caret >= e) return false;
    if (!ADBLOCK_OPTS.has(buf.toString('latin1', caret + 1, e))) return false;
    const h = domainHash(buf, p, caret);
    if (h === null) return false;
    add(kind, h);
    return true;
  }
  if (first === 0x23 || first === 0x21) return false;                    // # !
  const hashPos = buf.indexOf(0x23, s);
  if (hashPos !== -1 && hashPos < e) {
    e = hashPos;
    while (e > s && isSpace(buf[e - 1])) e--;
  }
  if (format === 'hosts') {
    let p = s;
    while (p < e && !isSpace(buf[p])) p++;
    if (!isIpToken(buf, s, p)) return false;
    let any = false;
    while (p < e) {
      while (p < e && isSpace(buf[p])) p++;
      const t = p;
      while (p < e && !isSpace(buf[p])) p++;
      if (p > t) {
        const h = domainHash(buf, t, p);
        if (h !== null && !HOSTS_SKIP.has(h)) { add('exact', h); any = true; }
      }
    }
    return any;
  }
  // domains
  for (let i = s; i < e; i++) if (isSpace(buf[i])) return false;
  if (buf[s] === 0x2a && buf[s + 1] === 0x2e) s += 2;                    // *.
  else if (buf[s] === 0x2e) s += 1;
  const h = domainHash(buf, s, e);
  if (h === null) return false;
  add('suffix', h);
  return true;
}

/**
 * Lesbaren Strom (Buffer-Stücke) parsen → { list: CompactList, entries, lines, skipped }.
 * Wirft ListTooLarge über `maxEntries`.
 */
async function parseListStream(stream, format, { maxEntries = 1_500_000, expectedEntries = 0 } = {}) {
  if (!FORMATS.has(format)) throw new Error(`unknown list format ${format}`);
  // Den Hauptpuffer gleich passend anlegen (Zeilenzahl aus countLines):
  // eine große Zuteilung statt wiederholtem Verdoppeln.
  const main = format === 'hosts' ? 'exact' : 'suffix';
  const cap = Math.min(maxEntries, Math.max(1024, expectedEntries | 0));
  const b = { suffix: new HashBuilder(), exact: new HashBuilder(), except: new HashBuilder() };
  b[main] = new HashBuilder(cap);
  let lines = 0;
  let skipped = 0;
  let total = 0;
  const add = (kind, h) => {
    if (++total > maxEntries) throw new ListTooLarge(maxEntries);
    b[kind].addHash(h);
  };
  const line = (buf, s, e) => {
    lines++;
    if (!parseLineBytes(buf, s, e, format, add)) {
      let p = s;
      while (p < e && isSpace(buf[p])) p++;
      if (p < e && buf[p] !== 0x23 && buf[p] !== 0x21 && buf[p] !== 0x5b) skipped++;
    }
  };
  let rest = null;      // angefangene Zeile aus dem letzten Stück
  let overlong = false; // Zeile > MAX_LINE: bis zum nächsten Zeilenende verwerfen
  for await (const chunk0 of stream) {
    const chunk = Buffer.isBuffer(chunk0) ? chunk0 : Buffer.from(chunk0);
    let s = 0;
    for (;;) {
      const nl = chunk.indexOf(NL, s);
      if (nl === -1) break;
      if (overlong) { overlong = false; skipped++; }
      else if (rest) {
        const full = Buffer.concat([rest, chunk.subarray(s, nl)]);
        rest = null;
        if (full.length <= MAX_LINE) line(full, 0, full.length); else skipped++;
      } else if (nl - s <= MAX_LINE) line(chunk, s, nl);
      else skipped++;
      s = nl + 1;
    }
    if (s < chunk.length && !overlong) {
      const tail = chunk.subarray(s);
      rest = rest ? Buffer.concat([rest, tail]) : Buffer.from(tail);
      if (rest.length > MAX_LINE) { rest = null; overlong = true; }
    }
  }
  if (rest && !overlong) line(rest, 0, rest.length);
  const list = new CompactList({ suffix: b.suffix.finish(), exact: b.exact.finish(), except: b.except.finish() });
  return { list, entries: list.size, lines, skipped };
}

/** Zeilen einer Datei zählen (obere Grenze der Einträge für parseListStream). */
async function countLines(stream) {
  let n = 0;
  let last = NL;
  for await (const c of stream) {
    let i = -1;
    while ((i = c.indexOf(NL, i + 1)) !== -1) n++;
    if (c.length) last = c[c.length - 1];
  }
  return last === NL ? n : n + 1;
}

/** Text (Tests, kleine Listen) parsen. */
function parseListText(text, format, opts) {
  return parseListStream(Readable.from([Buffer.from(String(text), 'utf8')]), format, opts);
}

module.exports = { parseListStream, parseListText, countLines, hashDomainBytes, FORMATS, ListTooLarge, MAX_LINE };
