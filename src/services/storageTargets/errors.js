'use strict';

// One error type for every storage target driver. `code` is what the admin
// API and the media store act on:
//   not_found         the object (or the folder / bucket / share) does not exist
//   auth              user name, password or keys rejected
//   denied            signed in, but not allowed (read-only share, bucket policy)
//   unreachable       no connection (DNS, refused, timeout, TLS)
//   tls_fingerprint   the certificate does not match the pinned fingerprint
//   blocked_address   an address a storage target may not use
//   full              no space left on the target
//   length_mismatch   fewer / more bytes than announced
//   protocol          an answer the driver does not understand
//   failed            anything else

class StorageError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }

  /** Any error → a StorageError (network and file system codes mapped). */
  static from(e) {
    if (e instanceof StorageError) return e;
    const c = e && e.code;
    if (c === 'ENOENT') return new StorageError('not_found', e.message);
    if (c === 'EACCES' || c === 'EPERM' || c === 'EROFS') return new StorageError('denied', e.message);
    if (c === 'ENOSPC' || c === 'EDQUOT') return new StorageError('full', e.message);
    if (c === 'tls_fingerprint' || c === 'blocked_address') return new StorageError(c, e.message);
    if (c === 'dns' || c === 'net' || c === 'timeout' || c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EHOSTUNREACH'
      || c === 'ETIMEDOUT' || c === 'ENETUNREACH' || /^ERR_TLS|CERT|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO/.test(String(c))) {
      return new StorageError('unreachable', e.message);
    }
    return new StorageError('failed', (e && e.message) || String(e));
  }
}

module.exports = { StorageError };
