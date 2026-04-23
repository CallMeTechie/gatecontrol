'use strict';

const crypto = require('node:crypto');

function hasColumn(db, table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some((c) => c.name === column);
}

function tableExists(db, table) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  return !!row;
}

function computeChecksum(sql) {
  return crypto.createHash('sha256').update(sql.trim()).digest('hex');
}

module.exports = { hasColumn, tableExists, computeChecksum };
