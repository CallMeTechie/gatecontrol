'use strict';

// What a plugin may send as SQL to its own database. The database is the
// plugin's own SQLite file, opened by the host in a worker thread — the
// statements below are the ways out of that file (ATTACH/VACUUM INTO write
// or read other files, PRAGMA changes the engine, load_extension loads
// code) or into the host's bookkeeping tables (_gc_*). Keywords must be one
// contiguous token in SQLite, so a word match on the raw text is enough;
// a string that merely contains such a word is rejected too (conservative).

const DENY = /\b(attach|detach|vacuum|pragma|load_extension|sqlite_dbpage|fts3_tokenizer)\b|_gc_/i;
const MAX_SQL = 100 * 1024;

function checkSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return 'empty statement';
  if (sql.length > MAX_SQL) return 'statement too long';
  if (sql.includes('\0')) return 'invalid statement';
  if (DENY.test(sql)) return 'statement not allowed';
  return null;
}

const isWord = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
const isDigit = (c) => c >= '0' && c <= '9';

/**
 * A statement for a log line: its text without the values — string and number
 * literals become ?, lists of placeholders one "?,…", white space one blank —
 * and at most `max` characters. A plain loop (no regular expression over the
 * plugin's text). Parameters (?) are never in the text anyway.
 */
function fingerprint(sql, max = 160) {
  const s = String(sql == null ? '' : sql).slice(0, 4000);
  let out = '';
  let space = false;
  const put = (t) => { if (space && out && out[out.length - 1] !== '(' && out[out.length - 1] !== ',') out += ' '; space = false; out += t; };
  let i = 0;
  for (; i < s.length && out.length <= max * 2; i++) {
    const c = s[i];
    if (c === "'") { // a string literal, '' inside it
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1;
      put('?');
    } else if (c <= ' ') {
      space = true;
    } else if (isDigit(c) && (space || !isWord(out[out.length - 1] || ''))) {
      while (i + 1 < s.length && (isDigit(s[i + 1]) || s[i + 1] === '.')) i++;
      put('?');
    } else {
      if (c === ',' || c === ')') space = false;
      put(c);
    }
  }
  // "IN (?,?,?,?)" → "IN (?,…)"
  let fp = '';
  for (let j = 0; j < out.length; j++) {
    fp += out[j];
    if (out[j] === '?' && out[j + 1] === ',' && out[j + 2] === '?') {
      while (out[j + 1] === ',' && out[j + 2] === '?') j += 2;
      fp += ',…';
    }
  }
  return fp.length > max || i < s.length || s.length < String(sql == null ? '' : sql).length ? fp.slice(0, max) + '…' : fp;
}

module.exports = { checkSql, fingerprint, MAX_SQL };
