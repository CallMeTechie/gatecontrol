'use strict';

// Software WebAuthn authenticator for tests (docs/feature-admin-passkeys.md).
//
// Produces real, verifiable registration ("none" attestation) and assertion
// responses with an ES256 key — the same bytes a browser would send — so the
// server side runs the unmodified @simplewebauthn/server checks. Every knob a
// test needs to forge a bad response is an option: origin, rpId, UV/UP
// flags, counter, user handle, challenge.

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ── minimal CBOR encoder (just what attestation objects and COSE keys use) ──
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, val] of v) parts.push(cbor(k), cbor(val));
    return Buffer.concat(parts);
  }
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error('cbor: unsupported ' + typeof v);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function authData({ rpId, up = true, uv = true, counter = 0, attested = null }) {
  let flags = 0;
  if (up) flags |= FLAG_UP;
  if (uv) flags |= FLAG_UV;
  if (attested) flags |= FLAG_AT;
  const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter >>> 0, 0);
  const parts = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), cnt];
  if (attested) {
    const len = Buffer.alloc(2); len.writeUInt16BE(attested.credId.length, 0);
    parts.push(Buffer.alloc(16), len, attested.credId, attested.cose);
  }
  return Buffer.concat(parts);
}

function coseKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
}

class SoftAuthenticator {
  constructor({ origin = 'http://localhost:3000', rpId = 'localhost' } = {}) {
    this.origin = origin;
    this.rpId = rpId;
    this.credentials = [];
  }

  /**
   * navigator.credentials.create() equivalent. `options` is the JSON the
   * server sent; overrides forge a bad response.
   */
  create(options, o = {}) {
    // `reuse`: register an already known credential again (same id + key).
    const keys = o.reuse
      ? { privateKey: o.reuse.privateKey, publicKey: crypto.createPublicKey(o.reuse.privateKey) }
      : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey, publicKey } = keys;
    const credId = o.reuse ? o.reuse.credId : crypto.randomBytes(32);
    const cred = {
      id: b64u(credId),
      credId,
      privateKey,
      userHandle: options.user.id, // base64url, as sent by the server
      counter: o.counter != null ? o.counter : 0,
    };
    const clientData = Buffer.from(JSON.stringify({
      type: o.type || 'webauthn.create',
      challenge: o.challenge || options.challenge,
      origin: o.origin || this.origin,
      crossOrigin: false,
    }));
    const ad = authData({
      rpId: o.rpId || this.rpId, up: o.up !== false, uv: o.uv !== false, counter: cred.counter,
      attested: { credId, cose: coseKey(publicKey) },
    });
    const attObj = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
    if (o.store !== false) this.credentials.push(cred);
    return {
      credential: cred,
      response: {
        id: cred.id,
        rawId: cred.id,
        type: 'public-key',
        response: {
          clientDataJSON: b64u(clientData),
          attestationObject: b64u(attObj),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      },
    };
  }

  /**
   * navigator.credentials.get() equivalent with a discoverable credential.
   * The counter advances by one per call unless `counter` is given.
   */
  get(options, o = {}) {
    const cred = o.credential || this.credentials[this.credentials.length - 1];
    if (!cred) throw new Error('no credential');
    const counter = o.counter != null ? o.counter : (o.keepCounter ? cred.counter : cred.counter + 1);
    if (o.counter == null && !o.keepCounter) cred.counter = counter;
    const clientData = Buffer.from(JSON.stringify({
      type: o.type || 'webauthn.get',
      challenge: o.challenge || options.challenge,
      origin: o.origin || this.origin,
      crossOrigin: false,
    }));
    const ad = authData({ rpId: o.rpId || this.rpId, up: o.up !== false, uv: o.uv !== false, counter });
    const signed = Buffer.concat([ad, crypto.createHash('sha256').update(clientData).digest()]);
    const signature = crypto.sign('sha256', signed, o.signWith || cred.privateKey);
    return {
      id: o.id || cred.id,
      rawId: o.id || cred.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(ad),
        signature: b64u(signature),
        userHandle: o.userHandle !== undefined ? o.userHandle : cred.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

module.exports = { SoftAuthenticator, cbor };
