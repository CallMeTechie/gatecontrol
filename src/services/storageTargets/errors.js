'use strict';

// One error type for every storage target driver. `code` is what the admin
// API and the media store act on:
//   not_found         the object (or the folder / bucket / share) does not exist
//   auth              user name, password or keys rejected
//   denied            signed in, but not allowed (read-only share, bucket policy)
//   unreachable       no connection (DNS, refused, timeout, TLS)
//   tls               the server's certificate is not trusted (expired, self-signed
//                     without the target's own certificate, wrong host name)
//   not_tls           the other side does not speak TLS at all (an http port, another
//                     protocol): `sys` keeps the system's code
//   tls_handshake     the TLS handshake failed for another reason than the certificate
//                     (an alert, no common protocol or cipher): `sys` keeps the code
//   blocked_address   an address a storage target may not use
//   full              no space left on the target
//   length_mismatch   fewer / more bytes than announced
//   exists            the destination of a move / a readable file is taken already
//   changed           the object on the target is not what was stored (changed there)
//   protocol          an answer the driver does not understand
//   failed            anything else

// the certificate checks of OpenSSL and Node — only these are `tls`
const CERT_RE = /^(?:ERR_TLS_CERT|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_)/;
// what OpenSSL says when the answer is no TLS record: http on that port (Synology 5000/5005), SSH, …
const NOT_TLS_RE = /wrong version number|packet length too long|record layer failure|http request|unknown protocol/i;

/**
 * An OpenSSL handshake error that is not about the certificate → { code, sys } or null.
 * Node gives it as ERR_SSL_<REASON> or as EPROTO with the OpenSSL text ("SSL routines:…:wrong version number").
 */
function handshakeError(e) {
  const c = String((e && e.code) || '');
  const msg = String((e && e.message) || '');
  const ssl = /^ERR_SSL_/.test(c);
  if (!ssl && !(c === 'EPROTO' && /SSL routines/.test(msg))) return null;
  const m = /SSL routines:[^:]*:([^:]+):/.exec(msg);
  // one spelling for both ways ("ERR_SSL_SSL/TLS_ALERT_…" → "ERR_SSL_SSL_TLS_ALERT_…")
  const sys = (ssl ? c : (m ? 'ERR_SSL_' + m[1].trim().toUpperCase() : c)).replace(/[^A-Z0-9_]+/g, '_');
  return { code: NOT_TLS_RE.test(sys.replace(/_/g, ' ')) || NOT_TLS_RE.test(msg) ? 'not_tls' : 'tls_handshake', sys };
}

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
    if (c === 'EEXIST' || c === 'ENOTEMPTY') return new StorageError('exists', e.message);
    if (c === 'EACCES' || c === 'EPERM' || c === 'EROFS') return new StorageError('denied', e.message);
    if (c === 'ENOSPC' || c === 'EDQUOT') return new StorageError('full', e.message);
    if (c === 'blocked_address') return new StorageError(c, e.message);
    if (CERT_RE.test(String(c))) return new StorageError('tls', e.message);
    const hs = handshakeError(e);
    if (hs) return new StorageError(hs.code, `${hs.sys}: ${e.message}`, { sys: hs.sys });
    if (['dns', 'net', 'timeout', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH',
      'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EPROTO'].includes(c) || String(c).startsWith('ERR_TLS')) {
      return new StorageError('unreachable', e.message);
    }
    return new StorageError('failed', (e && e.message) || String(e));
  }
}

module.exports = { StorageError, handshakeError };
