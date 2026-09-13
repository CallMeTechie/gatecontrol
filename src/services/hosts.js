'use strict';

// Hosts of a domain zone (rows of service_bundles). Every route belongs to a
// host (except RDP-owned L4 routes); all entries of a host share one LAN
// address and, unless gateway_override = 1, the zone's target.
//
// Every write path brings its own snapshot + withCaddySync pair (routes are
// created with skipSync). NO license checks here — only the API endpoints in
// routes/api/domainZones.js check licenses; nothing else may call the
// mutating functions from outside.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const { withCaddySync } = require('./routesSync');
const { restoreRouteRow } = require('./routesRollback');
const domainZones = require('./domainZones');
const hostTemplates = require('./hostTemplates');
const {
  validateDomain,
  validateDescription,
  validateLanHost,
  validatePort,
  validateL4Protocol,
  validateL4TlsMode,
  sanitize,
} = require('../utils/validate');

const { httpError, resolveZone, fqdnOf, routeTarget, zoneTarget, sameTarget, parseAliases, aliasFqdns, aliasModeOf, ALIAS_MODES, ALIAS_MAX } = domainZones;

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const isIpv4 = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(s || '')) && String(s).split('.').every((o) => +o >= 0 && +o <= 255);

function syncToCaddy() {
  return require('./caddyConfig').syncToCaddy();
}

function normalizeHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

// ─── Lookups ────────────────────────────────────────────

function bundleOr404(db, hostId) {
  const id = parseInt(hostId, 10);
  const row = Number.isInteger(id) ? db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(id) : null;
  if (!row) throw httpError(404, 'Host not found', 'NOT_FOUND');
  return row;
}

function zoneRowOf(db, host) {
  return host.domain_id != null ? db.prepare('SELECT * FROM domains WHERE id = ?').get(host.domain_id) || null : null;
}

function membersOf(db, hostId) {
  return db.prepare('SELECT * FROM routes WHERE bundle_id = ? ORDER BY id').all(hostId);
}

function hostFqdn(host, zone) {
  return zone && host.subdomain ? fqdnOf(host.subdomain, zone.domain) : (host.domain || null);
}

function lanHostOf(members) {
  const m = members.find((r) => r.target_kind === 'gateway' && r.target_lan_host);
  return m ? m.target_lan_host : null;
}

function isRdpOwned(db, r) {
  if (db.prepare('SELECT 1 FROM rdp_routes WHERE gateway_l4_route_id = ?').get(r.id)) return true;
  // rdp._syncLinkedL4Route creates the linked L4 route through routes.create()
  // and only links it afterwards — catch that window: an unlinked gateway-mode
  // RDP route whose host/listen port is exactly this route's.
  if (r.route_type === 'l4' && !r.domain && r.target_kind === 'gateway' && r.target_lan_host) {
    const pending = db.prepare(`SELECT 1 FROM rdp_routes
      WHERE access_mode = 'gateway' AND gateway_l4_route_id IS NULL
        AND host = ? AND COALESCE(gateway_listen_port, port, 3389) = ?`)
      .get(r.target_lan_host, parseInt(r.l4_listen_port, 10));
    if (pending) return true;
  }
  return false;
}

// gateway_override for a host in `zone` with these members. A zone without a
// gateway adopts the first member's target (the first host defines the zone).
function computeOverride(db, zone, members) {
  if (!zone || members.length === 0) return 0;
  let zt = zoneTarget(zone);
  if (!zt) {
    const first = members[0];
    zt = routeTarget(first);
    db.prepare(`UPDATE domains SET gateway_kind = ?, gateway_peer_id = ?, gateway_pool_id = ?,
      default_external_enabled = ? WHERE id = ? AND gateway_kind IS NULL`)
      .run(zt.kind, zt.peer_id, zt.pool_id, first.external_enabled ? 1 : 0, zone.id);
  }
  return members.some((m) => !sameTarget(routeTarget(m), zt)) ? 1 : 0;
}

function findHostForFqdn(db, fqdn, excludeId) {
  const ex = excludeId == null ? -1 : excludeId;
  const z = resolveZone(fqdn, db);
  if (z) {
    const row = db.prepare('SELECT id FROM service_bundles WHERE domain_id = ? AND subdomain = ? AND id != ? ORDER BY id LIMIT 1')
      .get(z.domain_id, z.subdomain, ex);
    if (row) return row.id;
    const legacy = db.prepare(`SELECT id FROM service_bundles WHERE lower(domain) = ? AND id != ?
      AND (domain_id IS NULL OR domain_id = ?) ORDER BY id LIMIT 1`).get(fqdn, ex, z.domain_id);
    return legacy ? legacy.id : null;
  }
  const row = db.prepare('SELECT id FROM service_bundles WHERE lower(domain) = ? AND domain_id IS NULL AND id != ? ORDER BY id LIMIT 1')
    .get(fqdn, ex);
  return row ? row.id : null;
}

// A host holds at most one HTTP entry (one virtual host per fqdn).
function canJoin(db, hostId, route) {
  if (route.route_type === 'l4') return true;
  return !db.prepare("SELECT 1 FROM routes WHERE bundle_id = ? AND route_type != 'l4' AND id != ?").get(hostId, route.id);
}

// ─── Host bookkeeping (metadata only, no Caddy impact) ──

/**
 * Link a host to the zone of its domain (longest suffix) and derive
 * gateway_override. Used for hosts created by legacy paths (service-bundle
 * API, printer preset, grouping) and by the boot reconcile.
 */
function attachZone(hostId) {
  const db = getDb();
  const host = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(hostId);
  if (!host) return null;
  const z = host.domain ? resolveZone(host.domain, db) : null;
  if (!z) return null;
  const zone = db.prepare('SELECT * FROM domains WHERE id = ?').get(z.domain_id);
  db.transaction(() => {
    const members = membersOf(db, host.id).filter((r) => !isRdpOwned(db, r));
    const override = computeOverride(db, zone, members);
    db.prepare('UPDATE service_bundles SET domain_id = ?, subdomain = ?, gateway_override = ? WHERE id = ?')
      .run(z.domain_id, z.subdomain, override, host.id);
  })();
  return z;
}

function createHostRow(db, route, fqdn) {
  const z = fqdn ? resolveZone(fqdn, db) : null;
  const zone = z ? db.prepare('SELECT * FROM domains WHERE id = ?').get(z.domain_id) : null;
  const name = ((route.description && route.description.trim())
    || fqdn
    || (route.l4_listen_port ? 'Port ' + route.l4_listen_port : 'Route ' + route.id)).slice(0, 120);
  let hostId;
  db.transaction(() => {
    const res = db.prepare('INSERT INTO service_bundles (name, domain, domain_id, subdomain) VALUES (?, ?, ?, ?)')
      .run(name, fqdn, z ? z.domain_id : null, z ? z.subdomain : null);
    hostId = res.lastInsertRowid;
    db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?').run(hostId, route.id);
    if (zone && computeOverride(db, zone, [route])) {
      db.prepare('UPDATE service_bundles SET gateway_override = 1 WHERE id = ?').run(hostId);
    }
  })();
  return hostId;
}

// The route's domain changed while it already had a host.
function followDomainChange(db, route, fqdn) {
  const hostId = route.bundle_id;
  const count = db.prepare('SELECT COUNT(*) AS n FROM routes WHERE bundle_id = ?').get(hostId).n;
  const isHttp = route.route_type !== 'l4';
  const other = fqdn ? findHostForFqdn(db, fqdn, hostId) : null;
  if (other != null && (count === 1 || !isHttp) && canJoin(db, other, route)) {
    // Join the host of the new fqdn; an emptied host is dropped.
    db.transaction(() => {
      db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?').run(other, route.id);
      require('./routes').cleanupEmptyBundles(db, [hostId]);
    })();
    return other;
  }
  if (count === 1 || isHttp) {
    // The host follows its HTTP (or only) entry — the bundle domain was always
    // kept in step with the HTTP member.
    db.prepare("UPDATE service_bundles SET domain = ?, domain_id = NULL, subdomain = NULL, gateway_override = 0, updated_at = datetime('now') WHERE id = ?")
      .run(fqdn, hostId);
    if (fqdn) attachZone(hostId);
  }
  return hostId;
}

/**
 * Give a route its host: join the host of its fqdn in its zone, else create
 * one (an L4 route without domain gets its own host without zone). With
 * opts.previousDomain (a domain change) an already hosted route follows its
 * new fqdn. RDP-owned L4 routes are never hosted. Returns the host id or null.
 */
function assignRoute(routeId, opts = {}) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
  if (!route || isRdpOwned(db, route)) return null;
  const fqdn = route.domain ? normalizeHost(route.domain) : null;
  if (route.bundle_id != null) {
    if (opts.previousDomain === undefined) return route.bundle_id;
    return followDomainChange(db, route, fqdn);
  }
  const existing = fqdn ? findHostForFqdn(db, fqdn, null) : null;
  if (existing != null && canJoin(db, existing, route)) {
    db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?').run(existing, route.id);
    return existing;
  }
  return createHostRow(db, route, fqdn);
}

// ─── Input normalization ────────────────────────────────

function normalizeSubdomain(raw, zoneDomain) {
  if (raw == null || String(raw).trim() === '') throw httpError(400, 'subdomain required');
  let s = normalizeHost(raw);
  // Tolerate a pasted fqdn of this zone.
  if (zoneDomain && s === zoneDomain) s = '@';
  else if (zoneDomain && s.endsWith('.' + zoneDomain)) s = s.slice(0, -(zoneDomain.length + 1));
  if (s === '@') return s;
  if (!s.split('.').every((l) => LABEL_RE.test(l))) {
    throw httpError(400, 'Invalid subdomain (DNS labels a-z, 0-9, "-", or "@" for the domain itself)');
  }
  return s;
}

// validateDomain + routeDomainPolicy for a host fqdn. The policy's
// "verified base" check uses the last two labels only; a host inside a
// VERIFIED zone with a multi-label base (example.co.uk) is accepted.
function checkFqdn(fqdn, currentFqdn, zone) {
  const err = validateDomain(fqdn);
  if (err) throw httpError(400, err);
  const { checkDomainPolicy } = require('./routeDomainPolicy');
  const pol = checkDomainPolicy(fqdn, { currentDomain: currentFqdn, routeType: 'http' });
  if (pol.error === 'domain_collision') {
    throw httpError(400, 'Domain collides with the management or portal host', 'DOMAIN_COLLISION');
  }
  if (pol.error === 'public_domain_use_verified' && !(zone && zone.status === 'verified')) {
    throw httpError(400, 'The domain ' + (zone ? zone.domain : fqdn) + ' is not verified yet', 'DOMAIN_UNVERIFIED');
  }
}

// ─── Host aliases (docs/feature-security-options.md §A) ──

// aliases input (array of labels relative to the host fqdn) → normalised
// unique labels. Same label rules as `subdomain`, but never '@'.
function normalizeAliases(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw httpError(400, 'aliases must be an array of labels', 'ALIAS_INVALID');
  const out = [];
  for (const item of raw) {
    const label = normalizeHost(item);
    if (!label) continue;
    if (label === '@' || !label.split('.').every((l) => LABEL_RE.test(l))) {
      throw httpError(400, `Invalid alias "${item}" (DNS labels a-z, 0-9, "-")`, 'ALIAS_INVALID');
    }
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > ALIAS_MAX) throw httpError(400, `At most ${ALIAS_MAX} aliases per host`, 'ALIAS_LIMIT');
  return out;
}

function normalizeAliasMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  if (!ALIAS_MODES.includes(mode)) throw httpError(400, "alias_mode must be 'redirect' or 'serve'", 'ALIAS_INVALID');
  return mode;
}

// Every alias FQDN must be a valid, policy-clean hostname that is neither a
// host nor an alias of another host in the zone, nor the domain of any HTTP
// route (legacy host-less rows), nor inside another zone (a nested zone
// `app.example.com` owns `www.app.example.com`).
function assertAliasesFree(db, zone, host, hostFqdn, labels) {
  if (labels.length === 0) return;
  const zoneDomain = normalizeHost(zone.domain);
  const others = db.prepare('SELECT id, subdomain, domain, aliases FROM service_bundles WHERE domain_id = ? AND id != ?').all(zone.id, host.id);
  const taken = new Map(); // fqdn → reason
  for (const o of others) {
    const ofqdn = o.subdomain ? fqdnOf(o.subdomain, zoneDomain) : normalizeHost(o.domain);
    if (ofqdn) taken.set(ofqdn, 'host');
    for (const a of aliasFqdns(ofqdn, parseAliases(o.aliases))) taken.set(a, 'alias');
  }
  for (const fqdn of aliasFqdns(hostFqdn, labels)) {
    const err = validateDomain(fqdn);
    if (err) throw httpError(400, `Alias ${fqdn}: ${err}`, 'ALIAS_INVALID');
    checkFqdn(fqdn, null, zone);
    const z = resolveZone(fqdn, db);
    if (!z || z.domain_id !== zone.id) {
      throw httpError(409, `Alias ${fqdn} belongs to another domain zone`, 'ALIAS_CONFLICT');
    }
    if (fqdn === hostFqdn || taken.has(fqdn)) {
      throw httpError(409, `Alias ${fqdn} is already a ${taken.get(fqdn) || 'host'} in this domain`, 'ALIAS_CONFLICT');
    }
    const route = db.prepare("SELECT id FROM routes WHERE lower(domain) = ? AND route_type != 'l4' LIMIT 1").get(fqdn);
    if (route) throw httpError(409, `Alias ${fqdn} is already used by a route`, 'ALIAS_CONFLICT');
  }
}

// Preflight every new alias FQDN (its own tls_status row; a failed check
// pauses the alias only). Returns the compact result of the first paused
// alias, else of the last one — null without any new alias.
async function guardAliases(fqdns) {
  let out = null;
  for (const fqdn of fqdns) {
    const r = await guardTls(fqdn);
    if (!out || out.state !== 'paused') out = { ...r, host: fqdn };
  }
  return out;
}

function forgetTlsRows(fqdns) {
  if (!fqdns.length) return;
  try { require('./tlsGuard').forgetHosts(fqdns); }
  catch (err) { logger.warn({ err: err.message, hosts: fqdns }, 'tls: alias rows not removed'); }
}

function assertUniqueHost(db, domainId, subdomain, excludeId) {
  const dup = db.prepare('SELECT id FROM service_bundles WHERE domain_id = ? AND subdomain = ? AND id != ?')
    .get(domainId, subdomain, excludeId == null ? -1 : excludeId);
  if (dup) throw httpError(409, 'A host with this name already exists in the domain', 'HOST_EXISTS');
  // The reverse of assertAliasesFree: a host name must not be an alias of
  // another host in the zone (§A).
  const zone = db.prepare('SELECT domain FROM domains WHERE id = ?').get(domainId);
  const fqdn = zone ? fqdnOf(subdomain, normalizeHost(zone.domain)) : null;
  if (!fqdn) return;
  const others = db.prepare("SELECT id, subdomain, domain, aliases FROM service_bundles WHERE domain_id = ? AND id != ? AND aliases IS NOT NULL")
    .all(domainId, excludeId == null ? -1 : excludeId);
  for (const o of others) {
    const ofqdn = o.subdomain ? fqdnOf(o.subdomain, normalizeHost(zone.domain)) : normalizeHost(o.domain);
    if (aliasFqdns(ofqdn, parseAliases(o.aliases)).includes(fqdn)) {
      throw httpError(409, `${fqdn} is already an alias of another host in the domain`, 'HOST_EXISTS');
    }
  }
}

function assertDomainFree(db, args) {
  try {
    require('./routes').assertDomainAvailable(db, args);
  } catch (err) {
    throw httpError(409, err.message, 'DOMAIN_CONFLICT');
  }
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') throw httpError(400, 'Invalid entry');
  const type = e.type;
  if (!['http', 'tcp', 'udp'].includes(type)) throw httpError(400, 'Entry type must be http, tcp or udp');
  const portErr = validatePort(e.target_port);
  if (portErr) throw httpError(400, portErr);
  const targetPort = parseInt(e.target_port, 10);
  let description = null;
  if (e.description != null && String(e.description).trim() !== '') {
    const descErr = validateDescription(e.description);
    if (descErr) throw httpError(400, descErr);
    description = sanitize(e.description);
  }
  if (type === 'http') return { type, target_port: targetPort, backend_https: !!e.backend_https, description };
  const protoErr = validateL4Protocol(type);
  if (protoErr) throw httpError(400, protoErr);
  if (e.listen_port == null || String(e.listen_port).trim() === '') throw httpError(400, 'listen_port required for tcp/udp entries');
  const tlsMode = e.tls_mode || 'none';
  const tlsErr = validateL4TlsMode(tlsMode);
  if (tlsErr) throw httpError(400, tlsErr);
  if (tlsMode !== 'none' && type !== 'tcp') throw httpError(400, 'TLS requires TCP protocol');
  return { type, target_port: targetPort, listen_port: String(e.listen_port).trim(), tls_mode: tlsMode, description };
}

/** EntryInput[] → serviceBundle exposures { http, l4 } (validated). */
function toBundleExposures(entries) {
  const list = entries.map(normalizeEntry);
  const http = list.filter((e) => e.type === 'http');
  if (http.length > 1) throw httpError(400, 'A host can have only one HTTP entry', 'HOST_HAS_HTTP');
  const withDesc = (o, e) => (e.description ? { ...o, description: e.description } : o);
  return {
    http: http[0] ? withDesc({ target_port: http[0].target_port, backend_https: http[0].backend_https }, http[0]) : null,
    l4: list.filter((e) => e.type !== 'http').map((e) => withDesc({
      l4_protocol: e.type,
      l4_listen_port: e.listen_port,
      l4_tls_mode: e.tls_mode,
      target_port: e.target_port,
    }, e)),
  };
}

// Zone target triple → serviceBundle target object.
function bundleTarget(t, lanHost, extra = {}) {
  if (t.kind === 'peer') return { target_kind: 'peer', peer_id: t.peer_id };
  return {
    target_kind: 'gateway',
    target_peer_id: t.kind === 'gateway' ? t.peer_id : null,
    target_pool_id: t.kind === 'pool' ? t.pool_id : null,
    target_lan_host: lanHost,
    wol_enabled: !!extra.wol_enabled,
    wol_mac: extra.wol_mac || null,
  };
}

function usableZoneTarget(zone) {
  const t = zoneTarget(zone);
  if (!t) throw httpError(400, 'Choose a gateway for the domain first', 'ZONE_NO_GATEWAY');
  if (t.kind === 'peer' && t.peer_id == null) {
    throw httpError(400, 'The domain has no gateway or peer target yet', 'ZONE_NO_GATEWAY');
  }
  return t;
}

function resolveEntries(input) {
  if (Array.isArray(input.entries) && input.entries.length > 0) return input.entries;
  if (input.template) return hostTemplates.expand(input.template);
  throw httpError(400, 'entries or template required');
}

function publish(domainId, hostId) {
  domainZones.publish(domainId, hostId);
}

function activityLog(type, message, details) {
  try {
    require('./activity').log(type, message, { source: 'admin', severity: 'info', details });
  } catch { /* best-effort */ }
}

// TLS guard: DNS/CAA preflight of a hostname that is about to get HTTPS (an
// HTTP entry or an SNI L4 entry). Runs BEFORE the transactional write and the
// Caddy sync so a paused host is in automatic_https.skip from the first sync
// on. Never blocks the write; the API answer carries { state, code, detail }.
async function guardTls(fqdn) {
  const r = await require('./tlsGuard').guardHost(fqdn);
  return { state: r.state, code: r.code, detail: r.detail };
}
function withTls(view, tls) {
  if (view && tls) view.tls = tls;
  return view;
}

// ─── Public API ─────────────────────────────────────────

/** POST /domains/:id/hosts — host with its entries (or from a template). */
async function create(domainId, input = {}) {
  const db = getDb();
  const id = parseInt(domainId, 10);
  const zone = Number.isInteger(id) ? db.prepare('SELECT * FROM domains WHERE id = ?').get(id) : null;
  if (!zone) throw httpError(404, 'Domain not found', 'NOT_FOUND');
  const target = usableZoneTarget(zone);
  domainZones.validateTarget(target, db);

  const subdomain = normalizeSubdomain(input.subdomain, zone.domain);
  const fqdn = fqdnOf(subdomain, zone.domain);
  checkFqdn(fqdn, null, zone);
  assertUniqueHost(db, zone.id, subdomain, null);

  if (input.template && !hostTemplates.has(input.template)) throw httpError(400, 'Unknown template');
  let description = null;
  if (input.description != null && String(input.description).trim() !== '') {
    const descErr = validateDescription(input.description);
    if (descErr) throw httpError(400, descErr);
    description = sanitize(input.description);
  }

  let lanHost = null;
  if (target.kind !== 'peer') {
    const lanErr = validateLanHost(input.lan_host);
    if (lanErr) throw httpError(400, lanErr);
    lanHost = input.lan_host ? String(input.lan_host).trim() : '';
    if (!lanHost) throw httpError(400, 'lan_host required for gateway targets', 'LAN_HOST_REQUIRED');
  }

  const { http, l4 } = toBundleExposures(resolveEntries(input));
  if (http) assertDomainFree(db, { domain: fqdn, routeType: 'http' });
  for (const e of l4) {
    if (e.l4_tls_mode !== 'none') {
      assertDomainFree(db, { domain: fqdn, routeType: 'l4', tlsMode: e.l4_tls_mode, listenPort: e.l4_listen_port });
    }
  }

  // Aliases (§A) may come along with the host (the dialog's "www alias" box);
  // validated here so a conflict fails BEFORE the host exists, applied via
  // update() afterwards (its own sync).
  const aliasPatch = (input.aliases !== undefined || input.alias_mode !== undefined)
    ? { aliases: normalizeAliases(input.aliases), alias_mode: input.alias_mode !== undefined ? normalizeAliasMode(input.alias_mode) : 'redirect' }
    : null;
  if (aliasPatch && aliasPatch.aliases.length > 0) {
    if (!http) throw httpError(400, 'Aliases need a host with an HTTP entry', 'ALIAS_REQUIRES_HTTP');
    assertAliasesFree(db, zone, { id: -1 }, fqdn, aliasPatch.aliases);
  }

  const tls = (http || l4.some((e) => e.l4_tls_mode !== 'none')) ? await guardTls(fqdn) : null;

  const serviceBundle = require('./serviceBundle');
  const bundle = await serviceBundle.createBundle({
    name: description || fqdn,
    domain: fqdn,
    description,
    target: bundleTarget(target, lanHost),
    http,
    l4,
  }, {
    zone: { domain_id: zone.id, subdomain },
    template: input.template || null,
    external_enabled: !!zone.default_external_enabled,
  });
  if (target.kind === 'pool') {
    domainZones.notifyGateways(domainZones.peersForTargets(db, [target]));
  }
  if (aliasPatch && (aliasPatch.aliases.length > 0 || aliasPatch.alias_mode !== 'redirect')) {
    // update() attaches an alias verdict when one was preflighted; the
    // primary's verdict wins in the answer (aliases are listed per name in
    // GET /tls/status).
    const view = await update(bundle.id, aliasPatch);
    return withTls(view, tls);
  }
  publish(zone.id, bundle.id);
  return withTls(domainZones.getHost(bundle.id), tls);
}

/** PUT /hosts/:id — description, rename (subdomain), LAN address and/or aliases. */
async function update(hostId, patch = {}) {
  const db = getDb();
  const host = bundleOr404(db, hostId);
  const zone = zoneRowOf(db, host);
  const members = membersOf(db, host.id);
  const oldFqdn = hostFqdn(host, zone);
  const oldAliases = parseAliases(host.aliases);

  const next = {
    name: host.name, description: host.description, subdomain: host.subdomain, domain: host.domain,
    aliases: oldAliases, alias_mode: aliasModeOf(host),
  };
  let changed = false;

  if (patch.description !== undefined) {
    const desc = patch.description == null ? '' : String(patch.description).trim();
    if (desc) {
      const descErr = validateDescription(desc);
      if (descErr) throw httpError(400, descErr);
    }
    next.description = desc ? sanitize(desc) : null;
    // The card title follows the description; an empty one falls back to the fqdn.
    next.name = (next.description || oldFqdn || host.name).slice(0, 120);
    changed = true;
  }

  let renameRows = [];
  let newFqdn = oldFqdn;
  if (patch.subdomain !== undefined) {
    if (!zone) throw httpError(400, 'Host has no domain zone');
    const subdomain = normalizeSubdomain(patch.subdomain, zone.domain);
    if (subdomain !== host.subdomain) {
      newFqdn = fqdnOf(subdomain, zone.domain);
      checkFqdn(newFqdn, oldFqdn, zone);
      assertUniqueHost(db, zone.id, subdomain, host.id);
      renameRows = members.filter((r) => r.route_type !== 'l4'
        || (r.l4_tls_mode && r.l4_tls_mode !== 'none')
        || (r.domain && normalizeHost(r.domain) === oldFqdn));
      for (const r of renameRows) {
        assertDomainFree(db, {
          domain: newFqdn,
          routeType: r.route_type === 'l4' ? 'l4' : 'http',
          tlsMode: r.l4_tls_mode,
          listenPort: r.l4_listen_port,
          excludeId: r.id,
        });
      }
      next.subdomain = subdomain;
      next.domain = newFqdn;
      if (host.name === oldFqdn && patch.description === undefined) next.name = newFqdn;
      changed = true;
    }
  }

  let lanRows = [];
  let newLan = null;
  if (patch.lan_host !== undefined) {
    const gwRows = members.filter((r) => r.target_kind === 'gateway');
    if (gwRows.length === 0) throw httpError(400, 'A LAN address only applies to gateway targets');
    const lanErr = validateLanHost(patch.lan_host);
    if (lanErr) throw httpError(400, lanErr);
    newLan = patch.lan_host ? String(patch.lan_host).trim() : '';
    if (!newLan) throw httpError(400, 'lan_host required for gateway targets', 'LAN_HOST_REQUIRED');
    lanRows = gwRows.filter((r) => r.target_lan_host !== newLan);
    if (lanRows.length > 0) changed = true;
  }

  // Aliases (§A): labels and mode; validated against the FINAL fqdn so a
  // rename in the same patch is honoured. Only hosts with an HTTP entry.
  let aliasChanged = false;
  if (patch.aliases !== undefined || patch.alias_mode !== undefined) {
    if (!zone) throw httpError(400, 'Host has no domain zone');
    if (patch.aliases !== undefined) next.aliases = normalizeAliases(patch.aliases);
    if (patch.alias_mode !== undefined) next.alias_mode = normalizeAliasMode(patch.alias_mode);
    aliasChanged = JSON.stringify(next.aliases) !== JSON.stringify(oldAliases) || next.alias_mode !== aliasModeOf(host);
    if (aliasChanged) changed = true;
  }
  if (next.aliases.length > 0 && (aliasChanged || newFqdn !== oldFqdn)) {
    if (!members.some((r) => r.route_type !== 'l4')) throw httpError(400, 'Aliases need a host with an HTTP entry', 'ALIAS_REQUIRES_HTTP');
    assertAliasesFree(db, zone, host, newFqdn, next.aliases);
  }

  if (!changed) return domainZones.getHost(host.id);

  // Renaming an HTTPS or SNI entry: preflight the new name before the write.
  const httpsHost = members.some((r) => r.route_type !== 'l4' && !!r.https_enabled);
  let tls = renameRows.some((r) => r.route_type !== 'l4' ? !!r.https_enabled : (r.l4_tls_mode && r.l4_tls_mode !== 'none'))
    ? await guardTls(newFqdn) : null;
  // Alias FQDNs are hostnames of their own: new ones are preflighted (each
  // gets its own tls_status row; a paused alias never blocks the primary),
  // dropped ones — removed aliases, or every old one after a rename — lose
  // their row after the sync.
  const oldAliasFqdns = aliasFqdns(oldFqdn, oldAliases);
  const newAliasFqdns = aliasFqdns(newFqdn, next.aliases);
  const addedAliasFqdns = newAliasFqdns.filter((f) => !oldAliasFqdns.includes(f));
  const droppedAliasFqdns = oldAliasFqdns.filter((f) => !newAliasFqdns.includes(f));
  const aliasTls = httpsHost && addedAliasFqdns.length ? await guardAliases(addedAliasFqdns) : null;
  if (!tls && aliasTls) tls = aliasTls;

  const touched = [...new Map([...renameRows, ...lanRows].map((r) => [r.id, r])).values()];
  const hostSnapshot = { ...host };
  const writeHost = db.prepare(`UPDATE service_bundles SET name = ?, description = ?, subdomain = ?, domain = ?,
    aliases = ?, alias_mode = ?, updated_at = datetime('now') WHERE id = ?`);
  const aliasesJson = next.aliases.length ? JSON.stringify(next.aliases) : null;
  db.transaction(() => {
    writeHost.run(next.name, next.description, next.subdomain, next.domain, aliasesJson, next.alias_mode, host.id);
    if (renameRows.length) {
      db.prepare(`UPDATE routes SET domain = ?, updated_at = datetime('now') WHERE id IN (${renameRows.map(() => '?').join(',')})`)
        .run(newFqdn, ...renameRows.map((r) => r.id));
    }
    if (lanRows.length) {
      db.prepare(`UPDATE routes SET target_lan_host = ?, updated_at = datetime('now') WHERE id IN (${lanRows.map(() => '?').join(',')})`)
        .run(newLan, ...lanRows.map((r) => r.id));
    }
  })();

  // Aliases live in the Caddy config too (alias routes, host matcher, ACME
  // subjects) → a pure alias change syncs as well.
  if (touched.length > 0 || aliasChanged || droppedAliasFqdns.length > 0) {
    await withCaddySync(syncToCaddy, () => {
      db.transaction(() => {
        for (const row of touched) restoreRouteRow(db, row.id, row);
        writeHost.run(hostSnapshot.name, hostSnapshot.description, hostSnapshot.subdomain, hostSnapshot.domain,
          hostSnapshot.aliases, hostSnapshot.alias_mode, host.id);
        db.prepare('UPDATE service_bundles SET updated_at = ? WHERE id = ?').run(hostSnapshot.updated_at, host.id);
      })();
    }, 'host update');
    forgetTlsRows(droppedAliasFqdns);
    if (touched.length > 0) {
      domainZones.notifyGateways(domainZones.peersForTargets(db, touched.map(routeTarget)));
      domainZones.rebuildDns('host update');
    }
    activityLog('host_updated', `Host "${next.name}" updated`, {
      hostId: host.id, routeIds: touched.map((r) => r.id), ...(aliasChanged ? { aliases: next.aliases, alias_mode: next.alias_mode } : {}),
    });
  }
  publish(host.domain_id, host.id);
  return withTls(domainZones.getHost(host.id), tls);
}

/** DELETE /hosts/:id — deletes the host with all its entries. */
async function remove(hostId) {
  const db = getDb();
  const host = bundleOr404(db, hostId);
  await require('./serviceBundle').removeBundle(host.id, { deleteRoutes: true });
  publish(host.domain_id, host.id);
}

/** PUT /hosts/:id/toggle — hard-set every entry. */
async function toggle(hostId, enabled) {
  const db = getDb();
  const host = bundleOr404(db, hostId);
  await require('./serviceBundle').toggleBundle(host.id, !!enabled);
  publish(host.domain_id, host.id);
  return domainZones.getHost(host.id);
}

// Target a new entry of this host gets: the zone's target, unless the host
// deliberately deviates (legacy override) or has no zone — then the host's
// own current target. null when neither exists.
function entryTarget(db, host, zone, members) {
  if (zone && !host.gateway_override && zoneTarget(zone)) return zoneTarget(zone);
  if (members.length > 0) return routeTarget(members[0]);
  return null;
}

/** Effective target of new entries of a host (API license pre-checks). */
function effectiveTarget(hostId) {
  const db = getDb();
  const host = bundleOr404(db, hostId);
  const members = membersOf(db, host.id).filter((r) => !isRdpOwned(db, r));
  return entryTarget(db, host, zoneRowOf(db, host), members);
}

/** POST /hosts/:id/entries — one more entry with the host's target. */
async function addEntry(hostId, input) {
  const db = getDb();
  const host = bundleOr404(db, hostId);
  const zone = zoneRowOf(db, host);
  const members = membersOf(db, host.id).filter((r) => !isRdpOwned(db, r));
  const entry = normalizeEntry(input);

  const target = entryTarget(db, host, zone, members);
  if (!target) throw httpError(400, 'Choose a gateway for the domain first', 'ZONE_NO_GATEWAY');
  if (target.kind === 'peer' && target.peer_id == null) {
    throw httpError(400, 'The host has no peer or gateway target', 'ZONE_NO_GATEWAY');
  }
  domainZones.validateTarget(target, db);

  const lead = members.find((r) => r.target_kind === 'gateway' && r.target_lan_host) || null;
  const lanHost = lead ? lead.target_lan_host : null;
  if (target.kind !== 'peer' && !lanHost) throw httpError(400, 'The host has no LAN address', 'LAN_HOST_REQUIRED');

  const fqdn = hostFqdn(host, zone);
  const isHttp = entry.type === 'http';
  const sni = !isHttp && entry.tls_mode !== 'none';
  if ((isHttp || sni) && !fqdn) throw httpError(400, 'HTTP and TLS entries need a host with a domain');
  if (isHttp && members.some((r) => r.route_type !== 'l4')) {
    throw httpError(409, 'The host already has an HTTP entry', 'HOST_HAS_HTTP');
  }
  if (isHttp || sni) {
    checkFqdn(fqdn, null, zone);
    assertDomainFree(db, {
      domain: fqdn, routeType: isHttp ? 'http' : 'l4', tlsMode: entry.tls_mode, listenPort: entry.listen_port,
    });
  }

  const serviceBundle = require('./serviceBundle');
  const { http, l4 } = toBundleExposures([input]);
  if (!isHttp) {
    serviceBundle.normalizeInput({ name: host.name, domain: fqdn, target: bundleTarget(target, lanHost), l4 });
    serviceBundle.assertNoExistingConflicts(l4);
  }

  const tls = (isHttp || sni) ? await guardTls(fqdn) : null;

  const routes = require('./routes');
  const tgt = serviceBundle.memberTargetFields(
    bundleTarget(target, lanHost, lead ? { wol_enabled: lead.wol_enabled, wol_mac: lead.wol_mac } : {}),
    entry.target_port,
  );
  const common = {
    description: entry.description || host.description || null,
    external_enabled: zone ? (zone.default_external_enabled ? 1 : 0) : (members[0] ? members[0].external_enabled : 0),
    ...tgt,
  };
  const data = isHttp
    ? { ...common, domain: fqdn, route_type: 'http', https_enabled: true, backend_https: !!http.backend_https }
    : {
      ...common,
      domain: sni ? fqdn : null,
      route_type: 'l4',
      l4_protocol: l4[0].l4_protocol,
      l4_listen_port: l4[0].l4_listen_port,
      l4_tls_mode: l4[0].l4_tls_mode,
    };

  const route = await routes.create(data, { skipSync: true });
  db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?').run(host.id, route.id);
  await withCaddySync(syncToCaddy, () => {
    db.transaction(() => {
      db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(route.id);
      db.prepare('DELETE FROM routes WHERE id = ?').run(route.id);
    })();
  }, 'host entry add');

  domainZones.notifyGateways(domainZones.peersForTargets(db, [target]));
  domainZones.rebuildDns('host entry add');
  activityLog('host_entry_added', `Entry added to host "${host.name}"`, { hostId: host.id, routeId: route.id });
  publish(host.domain_id, host.id);
  return withTls(domainZones.getEntry(route.id), tls);
}

/** PUT /hosts/:id/gateway-override {override:false} — back to the zone gateway. */
async function clearOverride(hostId) {
  const db = getDb();
  const host = bundleOr404(db, hostId);
  if (!host.gateway_override) return domainZones.getHost(host.id);
  const zone = zoneRowOf(db, host);
  if (!zone) throw httpError(400, 'Host has no domain zone');
  const target = usableZoneTarget(zone);
  domainZones.validateTarget(target, db);

  const rows = membersOf(db, host.id).filter((r) => !isRdpOwned(db, r));
  domainZones.assertLanHosts(rows, target);
  const oldTargets = rows.map(routeTarget);
  const setOverride = db.prepare('UPDATE service_bundles SET gateway_override = ? WHERE id = ?');
  await domainZones.retarget(db, rows.map((r) => r.id), target, {
    beforeRows: rows,
    extraWrite: () => setOverride.run(0, host.id),
    extraRollback: () => setOverride.run(1, host.id),
    label: 'host gateway override clear',
  });
  domainZones.notifyGateways(domainZones.peersForTargets(db, [target, ...oldTargets]));
  domainZones.rebuildDns('host gateway override clear');
  activityLog('host_gateway_reset', `Host "${host.name}" moved to the domain gateway`, { hostId: host.id });
  publish(host.domain_id, host.id);
  return domainZones.getHost(host.id);
}

/**
 * POST /hosts/:id/scan-to-folder — the printer preset's scan step for an
 * existing (printer) host: egress route (+ optional NAS route). The host must
 * sit behind ONE gateway with an IPv4 LAN address (the printer).
 * input: { vip_ip, vip_prefix?, target: { mode:'existing', route_id } |
 *          { mode:'new', nas_ip, nas_gateway_peer_id } }
 */
async function setupScanToFolder(hostId, input = {}) {
  const db = getDb();
  const printerPreset = require('./printerPreset');
  const host = bundleOr404(db, hostId);
  const members = membersOf(db, host.id).filter((r) => !isRdpOwned(db, r));
  const t = members.length ? routeTarget(members[0]) : null;
  if (!t || t.kind !== 'gateway' || t.peer_id == null) {
    throw httpError(400, 'Scan to folder needs a host behind a single gateway');
  }
  const printerIp = lanHostOf(members);
  if (!isIpv4(printerIp)) throw httpError(400, 'The host LAN address must be an IPv4 address');

  const tin = input.target || {};
  const toInt = (v) => (v == null || v === '' ? v : Number(v));
  const scan = {
    enabled: true,
    vip_ip: input.vip_ip,
    vip_prefix: input.vip_prefix,
    target: tin.mode === 'new'
      ? { mode: 'new', nas_ip: tin.nas_ip, nas_peer_id: toInt(tin.nas_gateway_peer_id != null ? tin.nas_gateway_peer_id : tin.nas_peer_id) }
      : { mode: tin.mode, route_id: toInt(tin.route_id) },
  };
  printerPreset.assertNearGateway(t.peer_id, db);
  printerPreset.validateScan(t.peer_id, scan, db);
  if (scan.target.mode === 'new') {
    const nas = db.prepare('SELECT peer_type, enabled FROM peers WHERE id = ?').get(scan.target.nas_peer_id);
    if (!nas || nas.peer_type !== 'gateway' || !nas.enabled) throw httpError(400, 'nas_gateway_peer_id must be an enabled gateway');
  }

  const res = await printerPreset.createScanToFolder({ name: host.name, near_peer_id: t.peer_id, printer_ip: printerIp, scan }, db);
  // The step is DB-only; this is its Caddy sync (picks up the NAS route).
  await withCaddySync(syncToCaddy, () => res.rollback(), 'host scan-to-folder');

  if (res.nasRouteId) {
    try { assignRoute(res.nasRouteId); } catch (err) { logger.warn({ err: err.message }, 'NAS route host assignment failed'); }
  }
  const peers = new Set([t.peer_id]);
  if (scan.target.mode === 'new') peers.add(scan.target.nas_peer_id);
  domainZones.notifyGateways(peers);
  domainZones.rebuildDns('host scan-to-folder');
  activityLog('host_scan_to_folder', `Scan to folder set up for host "${host.name}"`, {
    hostId: host.id, egressId: res.egressId, nasRouteId: res.nasRouteId,
  });
  publish(host.domain_id, host.id);
  return { egress_id: res.egressId, nas_route_id: res.nasRouteId };
}

module.exports = {
  // bookkeeping (routes service, serviceBundle, reconcile)
  assignRoute,
  attachZone,
  isRdpOwned,
  // input helpers (API license pre-checks, templates)
  normalizeEntry,
  toBundleExposures,
  resolveEntries,
  effectiveTarget,
  membersOf: (hostId) => membersOf(getDb(), hostId),
  // mutations
  create,
  update,
  remove,
  toggle,
  addEntry,
  clearOverride,
  setupScanToFolder,
};
