'use strict';

// Network side of gc.mail (docs/plugins.md "Mail", since 1.216.0): which mail
// server a plugin may reach and how the host talks to it.
//
//   * Any host name (people enter their own server), but every resolved
//     address must be public — the very check of gc.http.fetch
//     (netPolicy.checkInternet with an anyPublic policy): private, loopback,
//     link-local, CGNAT, ULA, multicast, reserved, the WireGuard network,
//     Docker networks and this server's own addresses → ERR_NETWORK_DENIED.
//     The connection goes to the checked address (DNS pinned); TLS names the
//     host (SNI) and checks the certificate against it.
//   * Ports: IMAP 993 (tls) and 143 (starttls), SMTP 465 (tls) and 587
//     (starttls); anything else → ERR_NETWORK_DENIED. Never in plain text:
//     with starttls the host stops when the server cannot do STARTTLS.
//   * TLS always verified, at least TLS 1.2 — there is no switch to turn it off.

const netPolicy = require('../netPolicy');

const PORTS = Object.freeze({
  imap: Object.freeze({ 993: 'tls', 143: 'starttls' }),
  smtp: Object.freeze({ 465: 'tls', 587: 'starttls' }),
});
const HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;
const SERVER_TEXT_MAX = 200;
const MIN_TLS = 'TLSv1.2';

class MailError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

function fail(code, message, extra) { throw new MailError(code, message, extra); }
function need(cond, code, message) { if (!cond) fail(code, message); }

// Test seams (NODE_ENV=test only): the tests' own servers listen on high
// ports and present a certificate of a test CA. The checks above still run
// against the port the plugin asked for.
const testSeams = { ports: null, ca: null };

function _setTestSeams(o) {
  if (process.env.NODE_ENV !== 'test') return;
  testSeams.ports = (o && o.ports) || null;
  testSeams.ca = (o && o.ca) || null;
}

/** The TLS options of every mail connection: verified, SNI = host, ≥ TLS 1.2. */
function tlsOptions(host) {
  const o = { rejectUnauthorized: true, minVersion: MIN_TLS };
  if (!netPolicy.isIpLiteral(host)) o.servername = host;
  if (testSeams.ca) o.ca = testSeams.ca;
  return o;
}

/**
 * Check { host, port, security } of a mail server of kind 'imap' | 'smtp'
 * and resolve it to one public address.
 * @returns {Promise<{ host, port, security, address, family, connectPort }>}
 */
async function endpoint(kind, o, opts = {}) {
  need(o && typeof o === 'object', 'ERR_INVALID', 'invalid server');
  const host = typeof o.host === 'string' ? o.host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') : '';
  need(host && (netPolicy.isIpLiteral(host) || HOST_RE.test(host)), 'ERR_INVALID', 'invalid host');
  const port = o.port == null ? null : o.port;
  need(Number.isInteger(port) && port >= 1 && port <= 65535, 'ERR_INVALID', 'invalid port');
  const allowed = PORTS[kind];
  if (!Object.prototype.hasOwnProperty.call(allowed, port)) {
    fail('ERR_NETWORK_DENIED', `${kind.toUpperCase()} only on port ${Object.keys(allowed).join(' or ')}`);
  }
  const security = o.security == null ? allowed[port] : o.security;
  need(security === 'tls' || security === 'starttls', 'ERR_INVALID', "security must be 'tls' or 'starttls'");
  need(allowed[port] === security, 'ERR_INVALID', `port ${port} needs security '${allowed[port]}'`);
  const r = await netPolicy.checkInternet(netPolicy.anyPublic([[port, port]]), host, port, { lookup: opts.lookup, reserved: opts.reserved });
  if (!r.ok) {
    if (r.reason === 'dns') fail('ERR_MAIL_NET', `the server ${host} was not found`);
    if (r.reason === 'invalid_host' || r.reason === 'invalid_port') fail('ERR_INVALID', 'invalid server');
    fail('ERR_NETWORK_DENIED', `connection refused by the mail policy: ${r.reason}`);
  }
  const mapped = testSeams.ports && testSeams.ports[port];
  return { host, port, security, address: r.address, family: r.family, connectPort: mapped || port };
}

/** Server text for the plugin: one line, ≤ 200 characters, without the credentials used. */
function serverText(text, secrets) {
  let s = String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  for (const x of secrets || []) {
    if (typeof x === 'string' && x.length >= 3) s = s.split(x).join('***');
  }
  return s.slice(0, SERVER_TEXT_MAX);
}

const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT', 'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectText',
  'ClosedAfterConnectTLS', 'STARTTLS_INJECTION', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ETLS', 'EREQUIRETLS']);

function isTlsError(e) {
  const c = String((e && e.code) || '');
  return !!(e && (e.tlsFailed || /^ERR_TLS_|^ERR_SSL_|CERT|^UNABLE_TO_|^DEPTH_ZERO|^SELF_SIGNED|^HOSTNAME_MISMATCH/.test(c)
    || /certificate|self.signed|altnames|TLS|SSL|STARTTLS/i.test(String(e.message || ''))));
}

/**
 * An error of imapflow / nodemailer → MailError with the contract's codes:
 * ERR_MAIL_AUTH (login refused, serverText), ERR_MAIL_NET (unreachable,
 * timeout, TLS), ERR_MAIL_REJECTED (SMTP refused the mail, serverText),
 * ERR_MAIL_PROTOCOL (anything else the server answered).
 */
function mapError(e, secrets) {
  if (e instanceof MailError) return e;
  const code = String((e && e.code) || '');
  const text = serverText((e && (e.responseText || e.response || e.serverResponseCode)) || '', secrets);
  if ((e && e.authenticationFailed) || code === 'EAUTH' || code === 'ENOAUTH' || code === 'EOAUTH2' || code === 'AUTHENTICATIONFAILED') {
    return new MailError('ERR_MAIL_AUTH', 'the server refused the login', { serverText: text });
  }
  if (isTlsError(e) || NET_CODES.has(code)) {
    const what = isTlsError(e) ? 'tls' : 'net';
    return new MailError('ERR_MAIL_NET', serverText(`${what === 'tls' ? 'TLS: ' : ''}${(e && e.message) || code}`, secrets) || 'the server is not reachable');
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE' || (e && Number(e.responseCode) >= 500 && Number(e.responseCode) < 600)) {
    return new MailError('ERR_MAIL_REJECTED', 'the server refused the message', { serverText: text });
  }
  return new MailError('ERR_MAIL_PROTOCOL', serverText((e && e.message) || 'mail server error', secrets) || 'mail server error', text ? { serverText: text } : null);
}

module.exports = { PORTS, MailError, fail, need, endpoint, tlsOptions, serverText, mapError, _setTestSeams, MIN_TLS };
