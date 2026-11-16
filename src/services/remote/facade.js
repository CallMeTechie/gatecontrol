'use strict';

// The old app API /api/v1/client/rdp* (routes/api/client/rdp.js) answered
// from the plugin "Fernzugriff" (docs/plugins.md "Remote access",
// "Facade for the old app API"). Apps released before the plugin keep
// working once the targets live in the plugin.
//
// Active only when ALL of this holds — otherwise the core answers exactly
// as before:
//   * the plugin of the dataset `remote` is installed (gatecontrol-remote, or
//     the plugin that replaced it), trusted (plugins/legacy.js eligibility)
//     and holds permissions.remote;
//   * its built-in data was taken over (Daten übernehmen, legacy.everImported).
// Then each request goes to the plugin's hook
//   clientFacade({ op, id, query, body, user, ip }) → { handled: false } | { status, body } | { status, body, credential } | { guac }
// where op is list | status | connect | browserSession | sessionStart | sessionHeartbeat | sessionEnd,
// and (version 2, stage 2) wake | statusAdmin | statusAll for the parts of the
// admin API /api/v1/rdp the Windows app uses (routes/api/rdp.js; app tokens only):
//   wake         POST /api/v1/rdp/:id/wol         → { ok, message }
//   statusAdmin  GET  /api/v1/rdp/:id/status, /:id/wol/status → { ok, id, online, responseTime, lastCheck }
//   statusAll    GET  /api/v1/rdp/status          → { ok, statuses: { <id>: { online, responseTime, lastCheck } } }
// { handled: false } (or a plugin without the hook) leaves the request to
// the core. A plugin that does not run answers 503 plugin_unavailable (403
// license_required without a licence): the core data may be outdated.
//
// Credentials never pass through the plugin: for `connect` it names a vault
// handle (`credential: { handle, fields? }`) and the core encrypts the
// values for the app — with ECDH only (`ecdhPublicKey`); without a key the
// answer is 400 ecdh_required (no plaintext fallback, no RSA).
// `{ guac: { target, protocol, mode?, credential?, options? } }` for
// browserSession: the core makes a ticket for the app's person and answers
// { ok, token, wsPath, ttl } like the old endpoint.
//
// What only the core knows (stage 1 of the plugin): the payload carries
// `server: { connectHost }` — the address an app connects to for a target
// behind a home gateway (GC_RDP_PUBLIC_HOST, else the host of the base URL),
// the one resolveConnectEndpoint uses — and the core completes the plugin's
// answer like the old endpoints: a route / connection of a gateway target
// without connect_address gets it, a connection without the DNS names of its
// host (peer_hostname, peer_fqdn, peer_fqdn_primary — undefined in the answer)
// gets them (internal_dns), so the plugin needs no access to the peers.

const logger = require('../../utils/logger');

const DATASET_PLUGIN = 'gatecontrol-remote';
const HOOK_MS = 10000;
const OPS = new Set(['list', 'status', 'connect', 'browserSession', 'sessionStart', 'sessionHeartbeat', 'sessionEnd',
  // version 2 (stage 2): what the Windows app asks of the admin API /api/v1/rdp — POST /:id/wol,
  // GET /:id/status and /:id/wol/status, GET /status — for app tokens only (a session there is the core's page)
  'wake', 'statusAdmin', 'statusAll']);
const ADMIN_OPS = new Set(['wake', 'statusAdmin', 'statusAll']);
// keys of the plugin's answer that would carry credentials — the core alone writes them
const CREDENTIAL_KEYS = ['username', 'password', 'username_encrypted', 'password_encrypted', 'credentials', 'credentials_e2ee'];

/** The plugin that answers the old app API now, or null (then the core answers). */
function active() {
  let legacy, registry;
  try { legacy = require('../plugins/legacy'); registry = require('../plugins/registry'); } catch { return null; }
  let p = null;
  try { p = registry.resolve(DATASET_PLUGIN); } catch { p = null; }
  if (!p || !p.manifest || !p.manifest.permissions || p.manifest.permissions.remote !== true) return null;
  if (legacy.eligibility(p) !== null) return null;
  if (!legacy.everImported(p.id)) return null;
  return p;
}

function running(id) {
  try { return require('../plugins/runtime').info(id).state === 'running'; } catch { return false; }
}

function licensed(p) {
  try { return !!require('../plugins/licensing').status(p).licensed; } catch { return false; }
}

function selfIpOf(req) {
  if (!req.tokenAuth || req.tokenPeerId == null) return null;
  try {
    const peer = require('../peers').getById(req.tokenPeerId);
    return peer && peer.allowed_ips ? String(peer.allowed_ips).split(',')[0].split('/')[0].trim() : null;
  } catch { return null; }
}

/** The address an app connects to for a gateway target (rdp.resolveConnectEndpoint). */
function connectHost() {
  const config = require('../../../config/default');
  if (config.rdp && config.rdp.publicHost) return config.rdp.publicHost;
  try { return new URL(config.app.baseUrl).hostname || null; } catch { return null; }
}

/** The DNS names of a VPN address (the old /connect: internal_dns, the legacy and the primary zone) or nulls. */
function peerNames(host) {
  const none = { peer_hostname: null, peer_fqdn: null, peer_fqdn_primary: null };
  if (typeof host !== 'string' || !host) return none;
  try {
    if (!require('../license').hasFeature('internal_dns')) return none;
    const row = require('../../db/connection').getDb().prepare('SELECT hostname FROM peers WHERE hostname IS NOT NULL AND allowed_ips LIKE ?').get(`${host}/%`);
    if (!row || !row.hostname) return none;
    const config = require('../../../config/default');
    return { peer_hostname: row.hostname, peer_fqdn: `${row.hostname}.${config.dns.domain}`, peer_fqdn_primary: `${row.hostname}.${require('../vpnNames').current().primary}` };
  } catch { return none; }
}

/** Complete the plugin's answer with what only the core knows (see the head). */
function complete(op, body) {
  if (!body || typeof body !== 'object') return body;
  const fill = (r) => {
    if (r && typeof r === 'object' && r.access_mode === 'gateway' && (r.connect_address === null || r.connect_address === undefined)) r.connect_address = connectHost();
  };
  if (op === 'list' && Array.isArray(body.routes)) body.routes.forEach(fill);
  if (op === 'connect' && body.connection && typeof body.connection === 'object') {
    fill(body.connection);
    if (body.connection.peer_hostname === undefined) Object.assign(body.connection, peerNames(body.connection.host));
  }
  return body;
}

function payloadOf(op, req) {
  let platform = null;
  try { const d = require('../plugins/devices').viewerDevice(req); platform = d ? d.platform : null; } catch { platform = null; }
  // the query without the app's keys (they are the core's business)
  const query = {};
  for (const [k, v] of Object.entries(req.query || {})) if (k !== 'ecdhPublicKey' && k !== 'publicKey' && typeof v === 'string') query[k] = v.slice(0, 200);
  const id = req.params && req.params.id != null ? String(req.params.id).slice(0, 64) : null;
  return {
    op, id, query,
    body: req.body && typeof req.body === 'object' ? req.body : null,
    user: {
      id: req.tokenUserId || null, tokenId: req.tokenId || null, peerId: req.tokenPeerId || null,
      scopes: Array.isArray(req.tokenScopes) ? req.tokenScopes.slice(0, 20) : [], platform, selfIp: selfIpOf(req),
    },
    ip: req.ip || null,
    // what only the core knows; its presence tells the plugin that the core completes the answers (complete())
    server: { connectHost: connectHost() },
  };
}

function strip(body) {
  if (!body || typeof body !== 'object') return body;
  const out = Array.isArray(body) ? body.slice() : { ...body };
  if (out.connection && typeof out.connection === 'object') {
    out.connection = { ...out.connection };
    for (const k of CREDENTIAL_KEYS) delete out.connection[k];
  }
  for (const k of CREDENTIAL_KEYS) delete out[k];
  return out;
}

/** The ECDH answer for a vault handle → { credentials_e2ee } | { error } */
function credentialsFor(plugin, cred, ecdhPublicKey) {
  if (!cred || typeof cred !== 'object' || typeof cred.handle !== 'string') return { error: 'credential_invalid', status: 500 };
  if (!ecdhPublicKey || typeof ecdhPublicKey !== 'string') return { error: 'ecdh_required', status: 400 };
  const secret = require('./vault').resolve(plugin.id, cred.handle);
  if (!secret) return { error: 'credentials_invalid', status: 409 };
  const want = Array.isArray(cred.fields) ? cred.fields : ['username', 'password', 'domain'];
  const json = JSON.stringify({
    username: want.includes('username') ? (secret.username || null) : null,
    password: want.includes('password') ? (secret.password || null) : null,
    domain: want.includes('domain') ? (secret.domain || null) : null,
  });
  try {
    return { credentials_e2ee: require('../../utils/crypto').ecdhEncrypt(json, ecdhPublicKey) };
  } catch {
    return { error: 'ecdh_invalid', status: 400 };
  }
}

async function browserSession(plugin, req, g) {
  const sessions = require('./sessions');
  if (!req.tokenUserId) return { status: 403, body: { ok: false, error: 'not_authorized' } };
  let t;
  try {
    const r = await sessions.create(plugin, { user: req.tokenUserId, target: g.target, protocol: g.protocol, mode: g.mode, credential: g.credential, options: g.options });
    t = sessions.claim(r.ref, Number(req.tokenUserId), 'token:' + req.tokenId);
  } catch (e) {
    const status = e && e.code === 'limit' ? 429 : (e && e.code === 'unlicensed' ? 403 : 409);
    return { status, body: { ok: false, error: (e && e.code) || 'mint_failed' } };
  }
  if (!t) return { status: 500, body: { ok: false, error: 'mint_failed' } };
  const m = await sessions.mint(t, { clientIp: req.ip });
  if (!m.ok) return { status: m.status, body: { ok: false, error: m.code } };
  return { status: 200, body: { ok: true, token: m.token, wsPath: m.wsPath, ttl: m.ttl } };
}

/**
 * Express middleware for one operation of the old app API. Calls next() when the core answers.
 */
function middleware(op) {
  if (!OPS.has(op)) throw new Error('unknown facade op ' + op);
  return async (req, res, next) => {
    // the admin API: only the app tokens; the admin's browser session keeps the core's answers
    if (ADMIN_OPS.has(op) && !req.tokenAuth) return next();
    const plugin = active();
    if (!plugin) return next();
    if (!running(plugin.id)) {
      return licensed(plugin)
        ? res.status(503).json({ ok: false, error: 'plugin_unavailable' })
        : res.status(403).json({ ok: false, error: 'license_required' });
    }
    let answer;
    try {
      answer = await require('../plugins/runtime').call(plugin.id, 'clientFacade', payloadOf(op, req), module.exports._hookMs || HOOK_MS);
    } catch (e) {
      logger.warn({ plugin: plugin.id, op, err: e && e.message }, 'clientFacade failed');
      return res.status(502).json({ ok: false, error: 'plugin_error' });
    }
    if (!answer || typeof answer !== 'object' || answer.handled === false) return next();
    if (answer.guac && typeof answer.guac === 'object') {
      const r = await browserSession(plugin, req, answer.guac);
      return res.status(r.status).json(r.body);
    }
    const status = Number.isInteger(answer.status) && answer.status >= 200 && answer.status <= 599 ? answer.status : 200;
    const body = complete(op, strip(answer.body && typeof answer.body === 'object' ? answer.body : { ok: status < 400 }));
    if (answer.credential != null && status < 300) {
      const c = credentialsFor(plugin, answer.credential, req.query && req.query.ecdhPublicKey);
      if (c.error) return res.status(c.status).json({ ok: false, error: c.error });
      if (body.connection && typeof body.connection === 'object') body.connection.credentials_e2ee = c.credentials_e2ee;
      else body.credentials_e2ee = c.credentials_e2ee;
    }
    return res.status(status).json(body);
  };
}

module.exports = { middleware, active, complete, connectHost, DATASET_PLUGIN, OPS, ADMIN_OPS, _hookMs: null };
