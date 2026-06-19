'use strict';

const { getDb } = require('../db/connection');
const routes = require('./routes');
const activity = require('./activity');
const logger = require('../utils/logger');
const { withCaddySync } = require('./routesSync');
const { syncToCaddy } = require('./caddyConfig');
const dns = require('./dns');
const { findListenPortConflict, suggestFreeListenPort } = require('./l4');
const {
  validateDomain,
  validateDescription,
  validatePort,
  validateL4Protocol,
  validateL4ListenPort,
  validateL4TlsMode,
  isPortBlocked,
  parsePortRange,
  sanitize,
} = require('../utils/validate');

// A service bundle creates and permanently links several routes that expose
// one host under one domain — typically an optional HTTP route plus one or
// more L4 port-forwards (the "web UI + SSH" case). The target is chosen once
// and mapped onto every member. Generalises the RDP→linked-L4 pattern
// (rdp.js _syncLinkedL4Route) to n members.

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function portConflict(listenPort, conflictRouteId, suggestedPort) {
  const err = new Error(
    `Listen port ${listenPort} is already in use by another route`
    + (suggestedPort ? ` — next free port: ${suggestedPort}` : '')
  );
  err.code = 'BUNDLE_PORT_CONFLICT';
  err.statusCode = 409;
  err.conflict = { port: parseInt(listenPort, 10), conflictRouteId, suggestedPort };
  return err;
}

// ─── Validation ─────────────────────────────────────────

function normalizeInput({ name, domain, description, target, http, l4 }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw badRequest('Bundle name is required');
  }
  if (name.trim().length > 120) throw badRequest('Bundle name too long (max 120)');

  if (description) {
    const descErr = validateDescription(description);
    if (descErr) throw badRequest(descErr);
  }

  const l4List = Array.isArray(l4) ? l4 : [];
  const httpExp = http && typeof http === 'object' ? http : null;
  if (!httpExp && l4List.length === 0) {
    throw badRequest('A bundle needs at least one exposure (http or l4)');
  }
  if (l4List.length > 20) throw badRequest('Too many L4 exposures (max 20)');

  const needsDomain = !!httpExp
    || l4List.some((e) => e.l4_tls_mode && e.l4_tls_mode !== 'none');
  let cleanDomain = null;
  if (domain) {
    const domainErr = validateDomain(domain);
    if (domainErr) throw badRequest(domainErr);
    cleanDomain = sanitize(domain).toLowerCase();
  } else if (needsDomain) {
    throw badRequest('Domain is required for HTTP or TLS-SNI exposures');
  }

  if (!target || typeof target !== 'object') throw badRequest('Target is required');
  const targetKind = target.target_kind || 'peer';
  if (!['peer', 'gateway'].includes(targetKind)) {
    throw badRequest('target_kind must be peer or gateway');
  }
  if (targetKind === 'peer' && !target.peer_id && !target.target_ip) {
    throw badRequest('Peer target needs peer_id or target_ip');
  }
  if (targetKind === 'gateway') {
    if (!target.target_peer_id && !target.target_pool_id) {
      throw badRequest('Gateway target needs target_peer_id or target_pool_id');
    }
    if (!target.target_lan_host) throw badRequest('Gateway target needs target_lan_host');
  }

  if (httpExp) {
    const portErr = validatePort(httpExp.target_port);
    if (portErr) throw badRequest(portErr);
  }

  const seenNoTlsPorts = {};
  for (const exp of l4List) {
    exp.l4_listen_port = exp.l4_listen_port != null ? String(exp.l4_listen_port) : exp.l4_listen_port;
    const protoErr = validateL4Protocol(exp.l4_protocol);
    if (protoErr) throw badRequest(protoErr);
    const listenErr = validateL4ListenPort(exp.l4_listen_port);
    if (listenErr) throw badRequest(listenErr);
    const tlsMode = exp.l4_tls_mode || 'none';
    const tlsErr = validateL4TlsMode(tlsMode);
    if (tlsErr) throw badRequest(tlsErr);
    if (tlsMode !== 'none' && exp.l4_protocol !== 'tcp') {
      throw badRequest('TLS requires TCP protocol');
    }
    const portErr = validatePort(exp.target_port);
    if (portErr) throw badRequest(portErr);

    const range = parsePortRange(exp.l4_listen_port);
    for (let p = range.start; p <= range.end; p++) {
      if (isPortBlocked(p)) throw badRequest('Port ' + p + ' is reserved');
    }

    // Exposure↔exposure conflicts inside the payload: no-TLS listeners of
    // the same protocol must not overlap (TLS listeners multiplex via SNI,
    // but two members of ONE bundle share the domain, so same-port TLS
    // pairs are ambiguous too — reject them alike).
    const key = exp.l4_protocol + '|' + String(exp.l4_listen_port);
    if (seenNoTlsPorts[key]) {
      throw badRequest('Duplicate listen port ' + exp.l4_listen_port + ' in bundle');
    }
    seenNoTlsPorts[key] = true;
  }

  return {
    name: sanitize(name.trim()),
    domain: cleanDomain,
    description: description ? sanitize(description) : null,
    target: { ...target, target_kind: targetKind },
    http: httpExp,
    l4: l4List,
  };
}

// Exposure↔existing conflicts. Single ports get a free-port suggestion;
// ranges only get the error (suggestFreeListenPort is single-port only).
function assertNoExistingConflicts(l4List) {
  for (const exp of l4List) {
    const tlsMode = exp.l4_tls_mode || 'none';
    if (tlsMode !== 'none') continue;
    const conflictRouteId = findListenPortConflict(exp.l4_listen_port, { protocol: exp.l4_protocol });
    if (conflictRouteId != null) {
      const isRange = String(exp.l4_listen_port).includes('-');
      const suggestedPort = isRange
        ? null
        : suggestFreeListenPort(exp.l4_listen_port, { protocol: exp.l4_protocol });
      throw portConflict(exp.l4_listen_port, conflictRouteId, suggestedPort);
    }
  }
}

// Map the once-chosen bundle target onto a member row payload.
function memberTargetFields(target, exposureTargetPort) {
  if (target.target_kind === 'gateway') {
    return {
      target_kind: 'gateway',
      target_peer_id: target.target_peer_id || null,
      target_pool_id: target.target_pool_id != null ? target.target_pool_id : null,
      target_lan_host: target.target_lan_host,
      target_lan_port: exposureTargetPort,
      target_port: exposureTargetPort,
      wol_enabled: !!target.wol_enabled,
      wol_mac: target.wol_mac || null,
    };
  }
  return {
    target_kind: 'peer',
    peer_id: target.peer_id || null,
    target_ip: target.peer_id ? undefined : target.target_ip,
    target_port: exposureTargetPort,
  };
}

// ─── CRUD ───────────────────────────────────────────────

async function createBundle(input) {
  const db = getDb();
  const { name, domain, description, target, http, l4 } = normalizeInput(input || {});

  assertNoExistingConflicts(l4);

  const bundleResult = db.prepare(
    'INSERT INTO service_bundles (name, domain, description) VALUES (?, ?, ?)'
  ).run(name, domain, description);
  const bundleId = bundleResult.lastInsertRowid;

  const createdIds = [];
  const removeCreated = () => {
    db.transaction(() => {
      for (const rid of createdIds) {
        db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(rid);
        db.prepare('DELETE FROM routes WHERE id = ?').run(rid);
      }
      db.prepare('DELETE FROM service_bundles WHERE id = ?').run(bundleId);
    })();
  };

  const linkMember = db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?');

  try {
    if (http) {
      const member = await routes.create({
        domain,
        route_type: 'http',
        description,
        https_enabled: http.https_enabled !== undefined ? http.https_enabled : true,
        backend_https: !!http.backend_https,
        ...memberTargetFields(target, parseInt(http.target_port, 10)),
      }, { skipSync: true });
      createdIds.push(member.id);
      linkMember.run(bundleId, member.id);
    }

    for (const exp of l4) {
      const tlsMode = exp.l4_tls_mode || 'none';
      const member = await routes.create({
        // tls_mode='none' members keep domain=NULL — the domain lives on
        // the bundle as a label (and on the HTTP member, if any).
        domain: tlsMode !== 'none' ? domain : null,
        route_type: 'l4',
        description,
        l4_protocol: exp.l4_protocol,
        l4_listen_port: String(exp.l4_listen_port),
        l4_tls_mode: tlsMode,
        ...memberTargetFields(target, parseInt(exp.target_port, 10)),
      }, { skipSync: true });
      createdIds.push(member.id);
      linkMember.run(bundleId, member.id);
    }
  } catch (err) {
    // Compensating cleanup — no Caddy sync has happened yet (skipSync).
    try { removeCreated(); } catch (cleanupErr) {
      logger.error({ err: cleanupErr.message, bundleId }, 'Bundle cleanup after member-create failure failed');
    }
    throw err;
  }

  await withCaddySync(syncToCaddy, removeCreated, 'service bundle create');

  // Member routes were created with skipSync; refresh internal DNS once for
  // the whole bundle now that the Caddy sync succeeded. Best-effort.
  try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after bundle create failed'); }

  activity.log('service_bundle_created', `Service "${name}" created (${createdIds.length} routes)`, {
    source: 'admin',
    severity: 'success',
    details: { bundleId, domain, routeIds: createdIds },
  });
  logger.info({ bundleId, name, routeIds: createdIds }, 'Service bundle created');

  if (target.target_kind === 'gateway' && target.target_peer_id) {
    try {
      const gateways = require('./gateways');
      gateways.notifyConfigChanged(target.target_peer_id).catch(() => {});
    } catch { /* module load guard */ }
  }

  return getBundle(bundleId);
}

function getBundle(id) {
  const db = getDb();
  const bundle = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(id);
  if (!bundle) return null;
  bundle.routes = db.prepare(
    "SELECT * FROM routes WHERE bundle_id = ? ORDER BY (route_type = 'l4'), l4_listen_port"
  ).all(id);
  return bundle;
}

function listBundles() {
  const db = getDb();
  return db.prepare(`
    SELECT sb.*, COUNT(r.id) AS route_count,
           SUM(CASE WHEN r.enabled = 1 THEN 1 ELSE 0 END) AS enabled_count
    FROM service_bundles sb
    LEFT JOIN routes r ON r.bundle_id = sb.id
    GROUP BY sb.id
    ORDER BY sb.name COLLATE NOCASE
  `).all();
}

function updateBundle(id, { name, description }) {
  const db = getDb();
  const bundle = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(id);
  if (!bundle) throw badRequest('Bundle not found');
  if (name !== undefined) {
    if (!name || !String(name).trim()) throw badRequest('Bundle name is required');
    if (String(name).trim().length > 120) throw badRequest('Bundle name too long (max 120)');
  }
  if (description) {
    const descErr = validateDescription(description);
    if (descErr) throw badRequest(descErr);
  }
  db.prepare(`
    UPDATE service_bundles
       SET name = COALESCE(?, name),
           description = CASE WHEN ? IS NULL THEN description ELSE ? END,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    name !== undefined ? sanitize(String(name).trim()) : null,
    description !== undefined ? sanitize(description) : null,
    description !== undefined ? sanitize(description) : null,
    id
  );
  return getBundle(id);
}

// Hard-set every member to the requested state (idempotent — no per-route
// flip). Reuses routes.batch for atomic multi-row mutation + snapshot
// rollback + single Caddy sync.
async function toggleBundle(id, enabled) {
  const bundle = getBundle(id);
  if (!bundle) throw badRequest('Bundle not found');
  const ids = bundle.routes.map((r) => r.id);
  if (ids.length === 0) return bundle;

  await routes.batch(enabled ? 'enable' : 'disable', ids);

  activity.log(
    enabled ? 'service_bundle_enabled' : 'service_bundle_disabled',
    `Service "${bundle.name}" ${enabled ? 'enabled' : 'disabled'} (${ids.length} routes)`,
    { source: 'admin', severity: 'info', details: { bundleId: id, routeIds: ids } }
  );
  return getBundle(id);
}

// deleteRoutes=true removes the member routes (atomic batch delete with
// rollback; the empty bundle row is then garbage-collected by
// routes.cleanupEmptyBundles). deleteRoutes=false just ungroups — no
// Caddy config changes, the routes live on individually.
async function removeBundle(id, { deleteRoutes = true } = {}) {
  const db = getDb();
  const bundle = getBundle(id);
  if (!bundle) throw badRequest('Bundle not found');
  const ids = bundle.routes.map((r) => r.id);

  if (deleteRoutes && ids.length > 0) {
    await routes.batch('delete', ids);
  } else {
    db.transaction(() => {
      if (ids.length > 0) {
        db.prepare('UPDATE routes SET bundle_id = NULL WHERE bundle_id = ?').run(id);
      }
      db.prepare('DELETE FROM service_bundles WHERE id = ?').run(id);
    })();
  }
  // Batch delete leaves the bundle row when it raced a rollback — make
  // sure it is gone either way.
  db.prepare('DELETE FROM service_bundles WHERE id = ?').run(id);

  activity.log(
    'service_bundle_deleted',
    `Service "${bundle.name}" ${deleteRoutes ? 'deleted with routes' : 'ungrouped'}`,
    {
      source: 'admin',
      severity: deleteRoutes ? 'warning' : 'info',
      details: { bundleId: id, routeIds: ids, deleteRoutes },
    }
  );
}

// Group already-existing routes into a new bundle. Pure metadata — no
// Caddy sync. Guards keep two orchestrators off one row: RDP-linked L4
// routes are owned by rdp.js and stay out of bundles.
function groupExisting({ name, route_ids }) {
  const db = getDb();
  if (!name || !String(name).trim()) throw badRequest('Bundle name is required');
  if (!Array.isArray(route_ids) || route_ids.length === 0) {
    throw badRequest('route_ids required');
  }
  const ids = route_ids.map((n) => parseInt(n, 10));
  if (ids.some((n) => !Number.isInteger(n))) throw badRequest('Invalid route id');

  const placeholders = ids.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM routes WHERE id IN (${placeholders})`).all(...ids);
  if (members.length !== ids.length) throw badRequest('One or more routes not found');

  const bundled = members.find((r) => r.bundle_id != null);
  if (bundled) throw badRequest(`Route ${bundled.id} is already part of a service`);

  const httpMembers = members.filter((r) => r.route_type !== 'l4');
  if (httpMembers.length > 1) throw badRequest('A service can contain at most one HTTP route');

  const rdpLinked = db.prepare(
    `SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IN (${placeholders})`
  ).all(...ids);
  if (rdpLinked.length > 0) {
    throw badRequest('RDP-linked L4 routes cannot be grouped into a service');
  }

  const domain = (httpMembers[0] && httpMembers[0].domain)
    || (members.find((r) => r.domain) || {}).domain
    || null;

  let bundleId;
  db.transaction(() => {
    const res = db.prepare(
      'INSERT INTO service_bundles (name, domain) VALUES (?, ?)'
    ).run(sanitize(String(name).trim()), domain);
    bundleId = res.lastInsertRowid;
    db.prepare(`UPDATE routes SET bundle_id = ? WHERE id IN (${placeholders})`).run(bundleId, ...ids);
  })();

  activity.log('service_bundle_grouped', `Service "${name}" grouped from ${ids.length} existing routes`, {
    source: 'admin',
    severity: 'info',
    details: { bundleId, routeIds: ids },
  });

  return getBundle(bundleId);
}

// Attach one or more existing, currently-unbundled routes to an EXISTING
// bundle. Same membership rules as groupExisting, but the HTTP-route cap is
// evaluated COMBINED against the bundle's current members (a bundle may hold
// at most one HTTP route in total). Does not touch the bundle's domain or the
// routes' enabled state, and needs no Caddy sync — only bundle_id changes.
function addRoutesToBundle({ bundle_id, route_ids }) {
  const db = getDb();
  const bundleId = parseInt(bundle_id, 10);
  if (!Number.isInteger(bundleId)) throw badRequest('Invalid bundle id');
  const bundle = getBundle(bundleId);
  if (!bundle) throw badRequest('Bundle not found');

  if (!Array.isArray(route_ids) || route_ids.length === 0) {
    throw badRequest('route_ids required');
  }
  const ids = route_ids.map((n) => parseInt(n, 10));
  if (ids.some((n) => !Number.isInteger(n))) throw badRequest('Invalid route id');

  const placeholders = ids.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM routes WHERE id IN (${placeholders})`).all(...ids);
  if (members.length !== ids.length) throw badRequest('One or more routes not found');

  const bundled = members.find((r) => r.bundle_id != null);
  if (bundled) throw badRequest(`Route ${bundled.id} is already part of a service`);

  const existingHttp = (bundle.routes || []).filter((r) => r.route_type !== 'l4').length;
  const newHttp = members.filter((r) => r.route_type !== 'l4').length;
  if (existingHttp + newHttp > 1) throw badRequest('A service can contain at most one HTTP route');

  const rdpLinked = db.prepare(
    `SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IN (${placeholders})`
  ).all(...ids);
  if (rdpLinked.length > 0) {
    throw badRequest('RDP-linked L4 routes cannot be grouped into a service');
  }

  db.prepare(`UPDATE routes SET bundle_id = ? WHERE id IN (${placeholders})`).run(bundleId, ...ids);

  activity.log('service_bundle_routes_added', `${ids.length} route(s) added to service "${bundle.name}"`, {
    source: 'admin',
    severity: 'info',
    details: { bundleId, routeIds: ids },
  });

  return getBundle(bundleId);
}

module.exports = {
  createBundle,
  getBundle,
  listBundles,
  updateBundle,
  toggleBundle,
  removeBundle,
  groupExisting,
  addRoutesToBundle,
};
