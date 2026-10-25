'use strict';

/**
 * Connections to Active Directory / LDAP servers (ldapts).
 *
 * Only encrypted connections: 'ldaps' (TLS from the first byte, usually port
 * 636) or 'starttls' (ldap:// upgraded with StartTLS before anything else is
 * sent, usually port 389). The certificate is always verified
 * (rejectUnauthorized) — against the system CAs or the uploaded CA
 * certificate (config.caCert, PEM). config.tlsServerName names the host the
 * certificate is checked for when the server is reached through another
 * address (an L4 route, a peer's VPN IP).
 *
 * The server must be reachable from GateControl as host:port — directly, via
 * a peer's VPN address or an L4 route of a gateway in the home network (like
 * other home targets).
 */

const net = require('node:net');
const { isMetadataHost } = require('../../utils/lanFetch');

const CONNECT_TIMEOUT_MS = 10000;
const OP_TIMEOUT_MS = 30000;
const PAGE_SIZE = 500;
const MAX_ENTRIES = 200000;

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/** Validates host / port / security; returns a normalised copy. */
function checkServer(cfg) {
  const host = String((cfg && cfg.host) || '').trim();
  if (!host || !(HOST_RE.test(host) || net.isIP(host))) throw codedError('INVALID_HOST', 'host must be a host name or an IP address');
  if (isMetadataHost(host)) throw codedError('INVALID_HOST', 'this address is not allowed');
  const security = cfg.security === 'starttls' ? 'starttls' : (cfg.security === 'ldaps' || cfg.security == null || cfg.security === '' ? 'ldaps' : null);
  if (!security) throw codedError('INVALID_SECURITY', 'security must be ldaps or starttls');
  const port = cfg.port == null || cfg.port === '' ? (security === 'ldaps' ? 636 : 389) : Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw codedError('INVALID_PORT', 'port must be 1–65535');
  return { host, port, security };
}

function urlFor(cfg) {
  const { host, port, security } = checkServer(cfg);
  const h = net.isIPv6(host) ? `[${host}]` : host;
  return `${security === 'ldaps' ? 'ldaps' : 'ldap'}://${h}:${port}`;
}

function tlsOptionsFor(cfg) {
  const { host } = checkServer(cfg);
  const opts = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  const name = String(cfg.tlsServerName || '').trim();
  if (name) opts.servername = name;
  else if (!net.isIP(host)) opts.servername = host;
  if (cfg.caCert && String(cfg.caCert).includes('BEGIN CERTIFICATE')) opts.ca = [String(cfg.caCert)];
  return opts;
}

let clientFactory = (options) => {
  const { Client } = require('ldapts');
  return new Client(options);
};

/** Tests replace the ldapts client. */
function _setClientFactory(fn) { clientFactory = fn || null; }

/**
 * An open, TLS-protected connection that is NOT bound yet. The caller binds
 * (service account or user) and must call client.unbind().
 */
async function open(cfg) {
  const url = urlFor(cfg);
  const tlsOptions = tlsOptionsFor(cfg);
  const security = checkServer(cfg).security;
  const client = clientFactory({
    url,
    timeout: OP_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    tlsOptions: security === 'ldaps' ? tlsOptions : undefined,
    strictDN: false,
  });
  if (security === 'starttls') {
    try {
      await client.startTLS(tlsOptions);
    } catch (err) {
      try { await client.unbind(); } catch { /* closed */ }
      throw err;
    }
  }
  return client;
}

/** open + service bind + fn(client) + unbind. */
async function withServiceClient(cfg, secret, fn) {
  const client = await open(cfg);
  try {
    const bindDn = String(cfg.bindDn || '').trim();
    if (!bindDn || !secret) throw codedError('NO_CREDENTIALS', 'service account and password are required');
    await client.bind(bindDn, secret);
    return await fn(client);
  } finally {
    try { await client.unbind(); } catch { /* already closed */ }
  }
}

/** Every entry of a (paged) search, at most MAX_ENTRIES. */
async function searchAll(client, base, options) {
  const out = [];
  const opts = { scope: 'sub', ...options, paged: { pageSize: PAGE_SIZE } };
  for await (const page of client.searchPaginated(base, opts)) {
    for (const e of page.searchEntries || []) {
      out.push(e);
      if (out.length >= MAX_ENTRIES) return out;
    }
  }
  return out;
}

/** The first `limit` entries of a search (one page). */
async function searchSome(client, base, options, limit = 50) {
  const out = [];
  const opts = { scope: 'sub', ...options, paged: { pageSize: Math.max(1, Math.min(limit, 500)) } };
  for await (const page of client.searchPaginated(base, opts)) {
    for (const e of page.searchEntries || []) {
      out.push(e);
      if (out.length >= limit) return out;
    }
    break;
  }
  return out;
}

/** True when the error is a wrong-password answer of the server (49). */
function isInvalidCredentials(err) {
  if (!err) return false;
  if (err.name === 'InvalidCredentialsError' || err.code === 49) return true;
  try {
    const { InvalidCredentialsError } = require('ldapts');
    return err instanceof InvalidCredentialsError;
  } catch { return false; }
}

module.exports = {
  checkServer, urlFor, tlsOptionsFor, open, withServiceClient, searchAll, searchSome, isInvalidCredentials,
  _setClientFactory, CONNECT_TIMEOUT_MS, OP_TIMEOUT_MS,
};
