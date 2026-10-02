'use strict';

// Minimal WebAuthn glue (docs/feature-admin-passkeys.md): turns the JSON
// options from @simplewebauthn/server into navigator.credentials calls and
// the resulting credential back into JSON (base64url everywhere). No
// dependency, no CDN. Exposes window.GCWebAuthn.
(function () {
  function toB64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(str) {
    var b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create && window.isSecureContext);
  }

  function mapCreds(list) {
    return (list || []).map(function (c) {
      var d = { id: fromB64url(c.id), type: c.type || 'public-key' };
      if (c.transports) d.transports = c.transports;
      return d;
    });
  }

  async function register(opts) {
    var publicKey = Object.assign({}, opts, {
      challenge: fromB64url(opts.challenge),
      user: Object.assign({}, opts.user, { id: fromB64url(opts.user.id) }),
      excludeCredentials: mapCreds(opts.excludeCredentials),
    });
    // Unknown dictionary members are ignored by browsers; keep only what
    // create() understands to avoid surprises.
    delete publicKey.hints;
    var cred = await navigator.credentials.create({ publicKey: publicKey });
    if (!cred) throw new Error('No credential');
    var r = cred.response;
    var transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
    var out = {
      id: cred.id,
      rawId: toB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        attestationObject: toB64url(r.attestationObject),
        transports: transports,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
    if (typeof r.getPublicKeyAlgorithm === 'function') out.response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
    if (typeof r.getAuthenticatorData === 'function') out.response.authenticatorData = toB64url(r.getAuthenticatorData());
    return out;
  }

  async function authenticate(opts) {
    var publicKey = Object.assign({}, opts, {
      challenge: fromB64url(opts.challenge),
      allowCredentials: mapCreds(opts.allowCredentials),
    });
    delete publicKey.hints;
    var cred = await navigator.credentials.get({ publicKey: publicKey });
    if (!cred) throw new Error('No credential');
    var r = cred.response;
    return {
      id: cred.id,
      rawId: toB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        authenticatorData: toB64url(r.authenticatorData),
        signature: toB64url(r.signature),
        userHandle: r.userHandle ? toB64url(r.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
  }

  // The user dismissed the browser dialog or it timed out — not an error
  // worth a red message.
  function isCancel(err) {
    return !!err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
  }

  window.GCWebAuthn = { supported: supported, register: register, authenticate: authenticate, isCancel: isCancel };
})();
