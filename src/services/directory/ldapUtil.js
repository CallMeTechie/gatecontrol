'use strict';

/**
 * Small, dependency-free LDAP helpers shared by the AD and the generic LDAP
 * adapter (and tested on their own):
 *
 *   escapeFilterValue(v)   RFC 4515 escaping of a value inside a filter:
 *                          \ * ( ) NUL and every other control character
 *                          become \xx. EVERY value that ends up in a filter
 *                          goes through this (login names, ids, DNs,
 *                          search text).
 *   escapeBinary(buf)      every byte as \xx (objectGUID in a filter).
 *   guidToString(buf)      AD objectGUID (16 bytes, mixed endian) →
 *                          'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.
 *   guidToBuffer(str)      the reverse (for searching by objectGUID).
 *   isGuid(str)
 *   first(entry, attr)     first value of an attribute of an ldapts entry
 *                          as a string ('' when missing), case-insensitive
 *                          attribute name.
 *   all(entry, attr)       every value as an array of strings.
 *   normDn(dn)             DN for comparisons: lower case, no spaces around
 *                          ',' and '='.
 *   loginNameOk(name)      the fixed format accepted for login names before
 *                          anything is sent to a directory.
 *   isUnder(dn, base)      dn is base or lies below it (normalised compare).
 *   fullSyncRequired(reason)  the error an adapter's fetchDelta throws when
 *                          only a full read is correct (sync.js then reads
 *                          everything in the same run).
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hex2(n) { return n.toString(16).padStart(2, '0'); }

function escapeFilterValue(value) {
  const s = value == null ? '' : String(value);
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '*' || ch === '(' || ch === ')' || code < 0x20 || code === 0x7f) {
      out += '\\' + hex2(code);
    } else {
      out += ch;
    }
  }
  return out;
}

function escapeBinary(buf) {
  let out = '';
  for (const b of Buffer.from(buf)) out += '\\' + hex2(b);
  return out;
}

function isGuid(s) { return typeof s === 'string' && GUID_RE.test(s); }

function guidToString(buf) {
  const b = Buffer.from(buf);
  if (b.length !== 16) return '';
  const h = (i) => hex2(b[i]);
  return (h(3) + h(2) + h(1) + h(0) + '-' + h(5) + h(4) + '-' + h(7) + h(6) + '-'
    + h(8) + h(9) + '-' + h(10) + h(11) + h(12) + h(13) + h(14) + h(15)).toLowerCase();
}

function guidToBuffer(str) {
  if (!isGuid(str)) throw new Error('not a GUID');
  const x = str.replace(/-/g, '');
  const bytes = (from, to) => Buffer.from(x.slice(from, to), 'hex');
  return Buffer.concat([
    bytes(0, 8).reverse(), bytes(8, 12).reverse(), bytes(12, 16).reverse(), bytes(16, 32),
  ]);
}

function attrKey(entry, attr) {
  if (!entry || !attr) return null;
  if (Object.prototype.hasOwnProperty.call(entry, attr)) return attr;
  const lower = String(attr).toLowerCase();
  return Object.keys(entry).find((k) => k.toLowerCase() === lower) || null;
}

function toStr(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

function all(entry, attr) {
  const k = attrKey(entry, attr);
  if (!k) return [];
  const v = entry[k];
  if (Array.isArray(v)) return v.map(toStr);
  return v == null ? [] : [toStr(v)];
}

function first(entry, attr) { return all(entry, attr)[0] || ''; }

function rawFirst(entry, attr) {
  const k = attrKey(entry, attr);
  if (!k) return null;
  const v = entry[k];
  return Array.isArray(v) ? (v[0] == null ? null : v[0]) : v;
}

function normDn(dn) {
  return String(dn || '').split(',').map((rdn) => rdn.split('=').map((p) => p.trim()).join('=')).join(',').toLowerCase();
}

// Login names: user name, UPN / e-mail, or DOMAIN\name. Letters (any
// script), digits and . _ - @ ' and one optional backslash; 1–256 chars.
const LOGIN_RE = /^(?:[\p{L}\p{N}._-]{1,64}\\)?[\p{L}\p{N}._@'+-]{1,256}$/u;
function loginNameOk(name) { return typeof name === 'string' && name.length <= 256 && LOGIN_RE.test(name); }

function isUnder(dn, base) {
  const d = normDn(dn);
  const b = normDn(base);
  if (!b) return true;
  return d === b || d.endsWith(',' + b);
}

function fullSyncRequired(reason, message) {
  const err = new Error(message || `full sync required (${reason})`);
  err.code = 'FULL_SYNC_REQUIRED';
  err.reason = reason;
  return err;
}

module.exports = {
  isUnder, fullSyncRequired,
  escapeFilterValue, escapeBinary, isGuid, guidToString, guidToBuffer, first, all, rawFirst, normDn, loginNameOk,
};
