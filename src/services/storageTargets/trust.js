'use strict';

// Trusting a NAS's own certificate without a PEM file (docs/storage-targets.md
// "Certificates"). Shared by the storage targets (WebDAV, S3) and the
// off-site backups (WebDAV, S3): one verdict, one rule for "remember it on
// first contact", so the same NAS behaves the same in both places.
//
// After a connection failed on the certificate, net.inspectTls says what the
// server presents and why it is not trusted; assess() turns that into what
// the pages show and may offer:
//   'untrusted'   a certificate GateControl does not know (self-signed, an
//                 unknown CA, the intermediate missing) and none is stored
//                 → "Diesem Gerät vertrauen"; through a VPN device or a route
//                 on the first contact it is remembered on its own
//   'changed'     a certificate is stored and the server presents another one
//                 (renewed on the NAS) → "Neues Zertifikat vertrauen", never
//                 accepted on its own
//   'name'        a valid certificate for another name → fix the address
//   'expired', 'not_yet_valid'   the dates — nothing to trust
//   'decrypts'    GateControl's own route decrypts (Caddy's internal CA, an
//                 L4 route that terminates TLS) — nothing to trust
//   null          nothing a click could change (no TLS, the handshake refused)
//
// What gets stored is always the presented leaf: pinned, valid under every
// name and IP (net.caOptions), until it expires or the NAS replaces it.
//
// Remembered on its own (trust on first use, like SFTP's accept-new) only
// when all of these hold — anything else needs the click:
//   - the connection goes through a VPN device or a GateControl route
//     ("Verbindung"), never "Direkt zur Adresse", and the address dialled is
//     not a public one (VPN, LAN, loopback)
//   - nothing is stored yet (`tlsCa` / `tls_ca` empty)
//   - this place was never reached with a trusted certificate before (`seen`)
//   - the certificate's only problem is that GateControl does not know it

const netPolicy = require('../plugins/netPolicy');

// ranges a tunnelled connection may end in for a certificate to be remembered on first contact
const TUNNEL_RANGES = new Set(['private', 'loopback', 'uniqueLocal', 'carrierGradeNat']);
const UNTRUSTED = new Set(['self_signed', 'untrusted_ca', 'missing_intermediate', 'untrusted']);

// English, for logs, last_error and API callers; the pages have their own text per code
const CHANGED_TEXT = 'the NAS presents another certificate than the stored one (renewed?) — trust the new one on the page if that is expected';
const UNTRUSTED_TEXT = 'the NAS identifies itself with its own certificate — trust this device on the page';
const NAME_TEXT = 'the certificate is valid for another name than the address';

/** "CN=synology, O=…" → "synology". */
function cn(dn) {
  const m = /(?:^|, )CN=([^,]+)/.exec(String(dn || ''));
  return m ? m[1].trim() : '';
}

/** The device a certificate names: its first DNS name, else its common name. */
function deviceName(cert) {
  if (!cert) return '';
  const dns = (cert.names || []).find((n) => /[a-z]/i.test(n) && !n.startsWith('*.'));
  return dns || cn(cert.subject) || (cert.names || [])[0] || '';
}

/** What the pages show of a certificate (and its PEM, to store it). */
function card(cert) {
  if (!cert) return null;
  return {
    device: deviceName(cert), names: cert.names || [], subject: cert.subject, issuer: cert.issuer, issuerName: cn(cert.issuer),
    validFrom: cert.validFrom, validTo: cert.validTo, fingerprint: cert.fingerprint, selfSigned: !!cert.selfSigned, pem: cert.pem,
  };
}

/** Does GateControl decrypt the connection itself (Caddy's internal CA)? */
function caddyDecrypts(diag) {
  return !!diag && (diag.chain || []).some((c) => /Caddy Local Authority/i.test(c.issuer) || /Caddy Local Authority/i.test(c.subject));
}

/**
 * net.inspectTls's result → the state (see the top), or null.
 * opts: { stored (an own anchor is set), decrypts (GateControl decrypts itself) }
 */
function assess(diag, opts = {}) {
  if (!diag || !diag.cert || !diag.reason) return null;
  if (opts.decrypts) return 'decrypts';
  const r = diag.reason;
  if (r === 'expired' || r === 'not_yet_valid' || r === 'name') return r;
  if (r === 'not_stored') return 'changed';
  if (UNTRUSTED.has(r)) return opts.stored ? 'changed' : 'untrusted';
  return null;
}

/** Can a click make this certificate trusted (store it as the own anchor)? */
function trustable(state) { return state === 'untrusted' || state === 'changed'; }

/** Is `address` one a tunnelled connection may end in (not public)? */
function privateAddress(address) {
  try { return TUNNEL_RANGES.has(netPolicy.toAddr(String(address).replace(/^\[|\]$/g, '')).range()); } catch { return false; }
}

/**
 * Does a connection go through a VPN device or a route to a non-public
 * address? `kind`: the via's kind; `dial`: a function → { host, port } (or a
 * promise of it), asked once. Never throws (false when unsure).
 */
async function tunnelled(kind, dial) {
  if (kind !== 'peer' && kind !== 'route') return false;
  try {
    const d = await dial();
    if (!d || !d.host) return false;
    const r = await require('./net').resolve(d.host, d.port || 443);
    return privateAddress(r.address);
  } catch { return false; }
}

/** First contact through a tunnel: remember the certificate without asking? */
function autoTrust({ state, stored, seen, tunnel }) {
  return state === 'untrusted' && !stored && !seen && !!tunnel;
}

module.exports = {
  CHANGED_TEXT, UNTRUSTED_TEXT, NAME_TEXT,
  cn, deviceName, card, caddyDecrypts, assess, trustable, privateAddress, tunnelled, autoTrust,
};
