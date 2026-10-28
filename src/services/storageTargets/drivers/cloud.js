'use strict';

// What the storage targets "Google Drive" and "OneDrive" share
// (drivers/gdrive.js, drivers/onedrive.js): an API session on the target's
// OAuth token (services/cloudAccounts/providers.js — refreshed when needed,
// the new token kept through config.saveToken) and the mapping of the
// providers' errors to StorageError codes.

const providers = require('../../cloudAccounts/providers');
const { CloudError } = require('../../cloudAccounts/http');
const { StorageError } = require('../errors');

/** An API session for the target's token. */
function sessionOf(provider, cfg, secret) {
  const appOf = () => {
    const a = require('../../cloudAccounts').app(provider);
    if (!a) throw new CloudError('ERR_CLOUD_NOT_CONFIGURED', 'no OAuth app is set up for this provider');
    return a;
  };
  return providers.session(provider, appOf, Object.assign({}, secret), (tok) => { if (typeof cfg.saveToken === 'function') cfg.saveToken(tok); });
}

const FULL_RE = /^(?:storageQuotaExceeded|quotaExceeded|insufficientStorage|quotaLimitReached|teamDriveFileLimitExceeded)$/i;

/** A CloudError (or anything) → StorageError. */
function toStorageError(e) {
  if (e instanceof StorageError) return e;
  if (!(e instanceof CloudError)) return StorageError.from(e);
  const reason = String(e.reason || '');
  switch (e.code) {
    case 'ERR_CLOUD_AUTH':
    case 'ERR_CLOUD_NOT_CONFIGURED': return new StorageError('auth', e.message);
    case 'ERR_CLOUD_NOT_FOUND': return new StorageError('not_found', e.message);
    case 'ERR_RATE_LIMIT':
    case 'ERR_TIMEOUT': return new StorageError('unreachable', e.message);
    default: break;
  }
  if (FULL_RE.test(reason) || e.status === 507) return new StorageError('full', e.message);
  if (e.status === 403) return new StorageError('denied', e.message);
  if (e.status === 409 || e.status === 412) return new StorageError('exists', e.message);
  if (e.status >= 500 || e.status == null) return new StorageError('unreachable', e.message);
  return new StorageError('failed', e.message);
}

/** Bounded remembered ids (folder paths → ids). */
function idCache(max = 20000) {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set: (k, v) => { if (m.size >= max) m.clear(); m.set(k, v); },
    delete: (k) => m.delete(k),
    deletePrefix: (p) => { for (const k of m.keys()) if (k === p || k.startsWith(p + '/')) m.delete(k); },
  };
}

/** Run `fn` for `key` one at a time (no two folders of the same name created at once). */
function serial() {
  const tails = new Map();
  return async (key, fn) => {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    try { await prev; return await fn(); } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/** "a/b/c" → { dir: 'a/b', name: 'c' }. */
function split(key) {
  const k = String(key).replace(/^\/+|\/+$/g, '');
  const i = k.lastIndexOf('/');
  return i < 0 ? { dir: '', name: k } : { dir: k.slice(0, i), name: k.slice(i + 1) };
}

async function collect(stream, max) {
  const parts = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > max) throw new StorageError('length_mismatch', 'more bytes than announced');
    parts.push(c);
  }
  return Buffer.concat(parts);
}

module.exports = { sessionOf, toStorageError, idCache, serial, split, collect };
