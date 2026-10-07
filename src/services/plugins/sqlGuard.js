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

module.exports = { checkSql, MAX_SQL };
