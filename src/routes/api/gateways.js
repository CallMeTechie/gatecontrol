'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const gatewaySetup = require('../../services/gatewaySetup');
const liveState = require('../../services/gatewayLiveState');

const router = Router();

/**
 * GET /api/v1/gateways — consolidated list of every enabled gateway peer
 * with its last-health snapshot (telemetry), state-machine status, api
 * port, and the routes that target it. One call renders the whole
 * "Home Gateways" section on the /peers page so the client doesn't have
 * to fan out N+1 /gateway-info fetches.
 *
 * Shape per gateway:
 *   {
 *     peer_id, name, hostname, ip, api_port,
 *     status,                       // "online" | "offline" | "unknown" (from the live state, see below)
 *     state,                        // live state (services/gatewayLiveState.js):
 *                                   //   "online" | "updating" | "restarting" | "offline" | "unknown"
 *     reachable,                    // heartbeat within gateway_down_threshold_s (not the routing flag)
 *     alive,                        // routing flag of gatewayHealth (false during the failback cooldown)
 *     offline_since,                // epoch ms, last sign of life when not reachable
 *     failback_at,                  // epoch ms, reachable again but routes wait for the failback cooldown
 *     failback_takes_routes,        // it serves routes again after that (else: reserve again)
 *     expected_back_by,             // epoch ms, end of the expected restart (updating / restarting)
 *     health_status,                // the sliding window of gateways.js (diagnostics; the old `status`)
 *     last_seen_at,                 // epoch ms
 *     health: { … full last_health body, includes telemetry },
 *     routes: [{ id, domain, route_type, target_lan_host, target_lan_port,
 *                l4_listen_port, l4_protocol, wol_enabled, wol_mac }],
 *     location: { id, name, city, country } | null,   // Gateway-Standort (services/gatewayLocations.js)
 *   }
 *
 * `?peek=1` is a side-effect-free read (the dashboard polls it): the
 * terminal update states (done/failed) are reported but NOT cleared — that
 * stays with the gateways page, which shows them once and then lets go.
 */
router.get('/', (req, res) => {
  try {
    const peek = req.query.peek === '1' || req.query.peek === 'true';
    const db = getDb();
    const rows = db.prepare(`
      SELECT p.id, p.name, p.hostname, p.allowed_ips, p.latest_handshake,
             gm.api_port, gm.last_seen_at, gm.last_health,
             gm.update_request_id, gm.update_requested_at, gm.update_target_version,
             gm.platform, gm.created_at, gm.first_seen_at
      FROM peers p
      JOIN gateway_meta gm ON gm.peer_id = p.id
      WHERE p.peer_type = 'gateway' AND p.enabled = 1
      ORDER BY p.name COLLATE NOCASE
    `).all();

    const gatewaysSvc = require('../../services/gateways');
    const routeStmt = db.prepare(`
      SELECT id, domain, route_type, target_lan_host, target_lan_port,
             l4_listen_port, l4_protocol, wol_enabled, wol_mac
      FROM routes
      WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      ORDER BY domain
    `);

    const liveStates = liveState.all();
    const gateways = rows.map((row) => {
      let health = {};
      if (row.last_health) {
        try { health = JSON.parse(row.last_health); } catch (_) { /* ignore */ }
      }
      const healthStatus = gatewaysSvc.getHealthStatus(row.id);
      const live = liveStates.get(row.id) || liveState.derive({}, {});
      const status = liveState.legacyStatus(live, healthStatus, gatewaysSvc._isHeartbeatHealthy(health));

      // When the gateway is offline, the last cached `route_reachability`
      // is stale by definition — anything behind a down gateway can't be
      // reachable. Force-mark it so UI dots don't lie. Also expose the
      // `stale` flag so clients can distinguish "freshly observed offline"
      // from "we have no idea anymore".
      if (status === 'offline' && Array.isArray(health.route_reachability) && health.route_reachability.length > 0) {
        health = {
          ...health,
          stale: true,
          route_reachability: health.route_reachability.map((r) => ({ ...r, reachable: false })),
        };
      }

      const _ust = gatewaysSvc._deriveUpdateState(row, health.telemetry || {});

      return {
        peer_id: row.id,
        name: row.name,
        hostname: row.hostname,
        ip: row.allowed_ips ? row.allowed_ips.split('/')[0] : null,
        api_port: row.api_port,
        status,
        state: live.state,
        reachable: live.reachable,
        alive: live.alive,
        offline_since: live.offline_since,
        failback_at: live.failback_at,
        failback_takes_routes: live.failback_takes_routes,
        expected_back_by: live.expected_back_by,
        restart_reason: live.restart_reason,
        health_status: healthStatus,
        last_seen_at: row.last_seen_at,
        latest_handshake: row.latest_handshake || null,
        health,
        routes: routeStmt.all(row.id),
        update_state: _ust.state,
        update_target_version: row.update_target_version || null,
        update_requested_at: row.update_requested_at || null,
        // Gateway assistant: platform + "wartet auf ersten Start" until the
        // first heartbeat / WireGuard handshake.
        platform: row.platform || null,
        created_at: row.created_at || null,
        first_seen_at: row.first_seen_at || row.last_seen_at || null,
        never_connected: !(row.first_seen_at || row.last_seen_at || Number(row.latest_handshake) > 0),
      };
    });

    const latestVersion = require('../../services/gatewayRelease').getLatestVersion();
    const { compareVersions } = require('../../utils/version');
    // Gateway-Standorte: { id, name, city, country } | null
    const locations = require('../../services/gatewayLocations').byGateway();
    for (const g of gateways) {
      g.location = locations.get(g.peer_id) || null;
      g.discovery = require('../../services/gateways').getDiscoverySettings(g.peer_id) || { enabled: 0, active_scan: 0 };
      const cur = g.health && g.health.telemetry ? g.health.telemetry.gateway_version : null;
      g.update_available = !!(latestVersion && cur && compareVersions(latestVersion, cur) > 0);
      // Terminal lifecycle states are surfaced once, then cleared so the
      // tracking columns don't pin a stale done/failed forever.
      if (!peek && (g.update_state === 'done' || g.update_state === 'failed')) {
        gatewaysSvc._clearUpdateTracking(g.peer_id);
      }
    }
    res.json({ ok: true, gateways, latest_version: latestVersion });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list gateways');
    res.status(500).json({ ok: false, error: req.t ? req.t('common.error') : 'Error' });
  }
});

// ─── Versionen und Handbuch of the Gateways page (public/js/gateway-docs.js) ──

/**
 * GET /api/v1/gateways/releases[?from=X.Y.Z][&to=X.Y.Z][&refresh=1] — what
 * changed in each gateway release (services/gatewayReleaseNotes.js: the GitHub
 * releases of the gateway repository, cached, offline-safe).
 * → { available, stale, fetched_at, latest_version, releases_url, versions[], since[] }
 *   since: the versions after `from` up to `to` (default: the latest) — "Was ist neu?"
 */
router.get('/releases', async (req, res) => {
  try {
    const notes = require('../../services/gatewayReleaseNotes');
    const latest = require('../../services/gatewayRelease').getLatestVersion() || null;
    const r = await notes.list({ refresh: req.query.refresh === '1' });
    const from = notes.VERSION_RE.test(String(req.query.from || '')) ? String(req.query.from) : null;
    const to = notes.VERSION_RE.test(String(req.query.to || '')) ? String(req.query.to) : latest;
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      available: r.available,
      stale: r.stale,
      fetched_at: r.fetched_at,
      latest_version: latest || (r.versions[0] ? r.versions[0].version : null),
      releases_url: notes.RELEASES_URL,
      versions: r.versions,
      from,
      to,
      since: from ? notes.between(r.versions, from, to) : [],
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list gateway releases');
    res.status(500).json({ ok: false, error: req.t ? req.t('common.error') : 'Error' });
  }
});

/**
 * GET /api/v1/gateways/handbook?lang=de|en — the gateway chapters of the user
 * guide as one document (services/gatewayHandbook.js, the safe renderer of the
 * plugin handbooks) → { lang, version, html, toc[], anchors{}, chapters[], source_url }
 */
router.get('/handbook', (req, res) => {
  const want = req.query.lang === 'en' || req.query.lang === 'de' ? req.query.lang : (req.language || 'de');
  try {
    const out = require('../../services/gatewayHandbook').get(want);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, version: require('../../../package.json').version, ...out });
  } catch (err) {
    if (err && err.code === 'handbook_missing') {
      return res.status(404).json({ ok: false, code: err.code, error: req.t ? req.t('gwd.hb.missing') : 'No handbook' });
    }
    logger.error({ error: err.message }, 'Failed to render the gateway handbook');
    res.status(500).json({ ok: false, error: req.t ? req.t('common.error') : 'Error' });
  }
});

// On-demand fresh-health re-check (session-authed; /api/v1 CSRF middleware guards
// this POST for session callers; token-auth exempt). Update action = 2b, not here.
router.post('/:id/probe', async (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  const result = await require('../../services/gateways').refreshHealth(peerId);
  if (result === null) return res.status(404).json({ ok: false, error: 'not a gateway' });
  res.json({ ok: true, reachable: result.reachable });
});

// Trigger a gateway self-update (#2b). Session-authed; CSRF-guarded by the
// /api/v1 middleware. Pushes a request_id-tagged self-update notification to
// the gateway's local API; only marks the request as pending in gateway_meta
// once the gateway accepts it (so a cooldown/unreachable push leaves the
// tracking columns NULL and the action remains retryable).
router.post('/:id/update', async (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT p.id, p.peer_type, p.enabled, gm.last_health
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const license = require('../../services/license');
  if (!license.hasFeature('gateway_fleet')) {
    return res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' });
  }
  let health = {}; try { health = row.last_health ? JSON.parse(row.last_health) : {}; } catch { /* ignore */ }
  const tel = health.telemetry || {};
  if (!tel.state_dir_writable) {
    return res.status(409).json({ ok: false, error: 'not_migrated' });
  }
  const gateways = require('../../services/gateways');
  const requestId = crypto.randomUUID();
  const target = gateways._normalizeTargetVersion(require('../../services/gatewayRelease').getLatestVersion());
  const r = await gateways.notifySelfUpdate(id, { request_id: requestId, target_version: target });
  if (r && r.skipped === 'cooldown') {
    return res.json({ ok: true, queued: false, reason: 'cooldown' });
  }
  if (!r || r.ok === false) {
    // The push failed synchronously — we KNOW it didn't reach the gateway, so do
    // NOT set tracking columns (that would show a misleading "updating" banner for
    // the full timeout). Surface unreachable immediately; the admin retries.
    return res.json({ ok: true, queued: false, reason: 'unreachable' });
  }
  gateways.markUpdateRequested(id, requestId, target);
  try { liveState.publishChanges([id]); } catch (err) { logger.debug({ err: err.message, peerId: id }, 'live state publish failed'); }
  require('../../services/activity').log('gateway_update_requested',
    `Gateway ${id} update requested (target ${target || 'latest'})`,
    { source: 'admin', severity: 'info', details: { peer_id: id, target, request_id: requestId } });
  res.json({ ok: true, queued: true });
});

// Read a gateway's reported LAN subnets + capability flag from last_health.
function _gatewayTelemetry(id) {
  const db = getDb();
  const row = db.prepare(`SELECT p.peer_type, p.enabled, gm.last_health FROM peers p JOIN gateway_meta gm ON gm.peer_id=p.id WHERE p.id=?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) return null;
  let tel = {};
  try { tel = (JSON.parse(row.last_health || '{}').telemetry) || {}; } catch { tel = {}; }
  return tel;
}

router.put('/:id/discovery-settings', require('../../middleware/license').requireFeature('gateway_lan_discovery'), (req, res) => {
  const id = Number(req.params.id);
  const tel = _gatewayTelemetry(id);
  if (!tel) return res.status(404).json({ ok: false, error: 'not_found' });
  const reported = Array.isArray(tel.lan_subnets) ? tel.lan_subnets : [];
  const reportedCidrs = new Set(reported.map(s => s.cidr));
  const primaryCidr = (reported.find(s => s.primary) || reported[0] || {}).cidr;
  const reportedCats = new Set((tel.lan_discovery_categories || []).map(c => c.key));

  const { enabled, active_scan, subnets, category_mode, categories } = req.body || {};
  const subs = Array.isArray(subnets) ? subnets : [];
  for (const c of subs) if (!reportedCidrs.has(c)) return res.status(400).json({ ok: false, error: 'subnet_not_reported', cidr: c });
  const license = require('../../services/license');
  const isMulti = subs.length > 1 || (subs.length === 1 && subs[0] !== primaryCidr);
  if (isMulti && !license.hasFeature('gateway_lan_discovery_multi_subnet')) {
    return res.status(403).json({ ok: false, error: 'gateway_lan_discovery_multi_subnet not licensed' });
  }
  if (category_mode !== undefined && !['include', 'exclude'].includes(category_mode)) return res.status(400).json({ ok: false, error: 'bad_category_mode' });
  const cats = Array.isArray(categories) ? categories.filter(k => reportedCats.has(k)) : [];

  require('../../services/gateways').setDiscoverySettings(id, {
    enabled: enabled === true || enabled === 1, active_scan: active_scan === true || active_scan === 1,
    subnets: subs, category_mode, categories: cats,
  });
  res.json({ ok: true });
});

router.post('/:id/discover', require('../../middleware/license').requireFeature('gateway_lan_discovery'), async (req, res) => {
  const id = Number(req.params.id);
  const tel = _gatewayTelemetry(id);
  if (!tel) return res.status(404).json({ ok: false, error: 'not_found' });
  if (tel.lan_discovery !== true) return res.status(409).json({ ok: false, error: 'capability_unavailable' }); // gateway too old / Phase 1-only

  const gateways = require('../../services/gateways');
  const settings = gateways.getDiscoverySettings(id);
  if (!settings || !settings.enabled) return res.status(409).json({ ok: false, error: 'discovery_disabled' });

  const discoveryCache = require('../../services/discoveryCache');
  const force = req.body && req.body.force === true;
  if (discoveryCache.inFlight(id) && !force) return res.status(409).json({ ok: false, error: 'scan_in_progress' });
  if (force) discoveryCache.cancel(id);

  // Resolve subnets: clamp to the primary unless multi-subnet is licensed.
  const license = require('../../services/license');
  const reported = Array.isArray(tel.lan_subnets) ? tel.lan_subnets : [];
  const primaryCidr = (reported.find(s => s.primary) || reported[0] || {}).cidr;
  let subnets = (settings.subnets && settings.subnets.length) ? settings.subnets : (primaryCidr ? [primaryCidr] : []);
  if (!license.hasFeature('gateway_lan_discovery_multi_subnet')) subnets = primaryCidr ? [primaryCidr] : [];
  if (subnets.length === 0) return res.status(409).json({ ok: false, error: 'no_subnet' });

  const SCAN_TIMEOUT_MS = 45000;            // sent to the gateway (matches its default GC_DISCOVERY_TIMEOUT_MS)
  const graceMs = SCAN_TIMEOUT_MS + 15000;  // §5.4: declare orphaned after timeout + 15s
  const requestId = require('node:crypto').randomUUID();
  discoveryCache.begin(id, requestId, graceMs);
  // Per-request active_scan override (printer wizard): does NOT change the stored
  // gateway setting; audit-logged below. Only a real boolean overrides.
  const activeScan = (req.body && typeof req.body.active_scan === 'boolean')
    ? req.body.active_scan : !!settings.active_scan;
  const r = await gateways.notifyLanScan(id, {
    request_id: requestId, subnets, category_mode: settings.category_mode, categories: settings.categories,
    active_scan: activeScan, timeout_ms: SCAN_TIMEOUT_MS,
  });
  if (!r || r.accepted !== true) { discoveryCache.cancel(id); return res.status(502).json({ ok: false, error: 'gateway_unreachable' }); }

  // §10 audit log.
  require('../../services/activity').log('gateway_scan_triggered',
    `Gateway ${id} LAN scan requested (${subnets.join(', ')})`,
    { source: 'admin', severity: 'info', details: { peer_id: id, request_id: requestId, subnets, active_scan: activeScan } });

  // §5.4 terminal SSE event if the gateway never reports `done` within the grace —
  // so the admin UI spinner never hangs. get() lazily marks done+timed_out once past grace.
  setTimeout(() => {
    const snap = discoveryCache.get(id);
    if (snap && snap.request_id === requestId && snap.timed_out) {
      require('../../services/eventBus').publish('gateway_discovery',
        { peer_id: id, request_id: requestId, devices: snap.devices, done: true, timed_out: true });
    }
  }, graceMs + 250).unref();

  res.status(202).json({ ok: true, request_id: requestId, subnets_scanned: subnets });
});

router.get('/:id/discovered', require('../../middleware/license').requireFeature('gateway_lan_discovery'), (req, res) => {
  const id = Number(req.params.id);
  if (!_gatewayTelemetry(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  const snap = require('../../services/discoveryCache').get(id);
  res.json({ ok: true, devices: snap ? snap.devices : [], in_flight: snap ? snap.in_flight : false, done: snap ? snap.done : false, timed_out: snap ? snap.timed_out : false, updated_at: snap ? snap.updated_at : null });
});

// ─── Gateway assistant "Gateway hinzufügen" (docs/feature-gateway-wizard.md) ──
// Creation itself is POST /api/v1/peers { is_gateway, platform } (same rights,
// CSRF and licence checks as before); these endpoints serve the steps after it.

/** Static facts for the assistant: Pi image of the latest release, Imager list, Smart Home plugin. */
router.get('/setup-info', (req, res) => {
  const kit = require('../../../public/js/gateway-kit');
  const rel = require('../../services/gatewayRelease');
  const wizard = require('../../services/gatewayWizard');
  let plugin = null;
  try { plugin = require('../../services/plugins/registry').get(wizard.SMARTHOME_PLUGIN); } catch { plugin = null; }
  const config = require('../../../config/default');
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    latest_version: rel.getLatestVersion() || null,
    rpi_image: rel.getRpiImage(),
    releases_url: kit.RELEASES_URL,
    imager_repo_url: kit.IMAGER_REPO_URL,
    dns_domain: (config.dns && config.dns.domain) || null,
    smarthome: { installed: !!plugin, plugin_url: plugin ? `/plugins/${wizard.SMARTHOME_PLUGIN}` : null },
  });
});

function _gatewayIdOr404(req, res) {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? require('../../services/gatewayWizard').gatewayRow(id) : null;
  if (!row || row.enabled !== 1) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  return row;
}

/** Live status of step 4 (polled with back-off and on gc:gateway events). */
router.get('/:id/setup-status', (req, res) => {
  const row = _gatewayIdOr404(req, res);
  if (!row) return;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, gateway: require('../../services/gatewayWizard').setupStatus(row.id) });
});

/** Platform of a gateway created before the assistant ("Einrichtung fortsetzen"). */
router.put('/:id/platform', (req, res) => {
  const row = _gatewayIdOr404(req, res);
  if (!row) return;
  const gateways = require('../../services/gateways');
  const platform = req.body && req.body.platform;
  if (!gateways.normalizePlatform(platform)) {
    return res.status(400).json({ ok: false, error: req.t('error.peers.gateway_platform_invalid') });
  }
  gateways.setPlatform(row.id, platform);
  res.json({ ok: true, platform });
});

/**
 * Synology set-up package gatecontrol-gateway-nas.zip (compose, config/gateway.env,
 * update.sh). The env needs plaintext tokens, which the server only has at
 * creation — so this rotates them, like "gateway.env herunterladen"
 * (POST: no prefetch can invalidate tokens; the client asks first when the
 * gateway has ever connected). Session only: a script has no use for it.
 */
router.post('/:id/setup-bundle', (req, res) => {
  if (req.tokenAuth) return res.status(403).json({ ok: false, error: 'session_required' });
  const row = _gatewayIdOr404(req, res);
  if (!row) return;
  const gatewaySvc = require('../../services/gateways');
  const { envContent } = gatewaySvc.rotateGatewayTokens(row.id);
  const zip = gatewaySetup.buildNasBundle(envContent);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${gatewaySetup.NAS_BUNDLE_NAME}"`);
  res.set('Cache-Control', 'no-store');
  res.send(zip);
});

/**
 * "Nur docker-compose.yml herunterladen": the current compose of the assistant for this gateway
 * (gateway-kit.js buildCompose, the same text as the NAS package) — renews an old compose without
 * edge/mqtt/cache (edge reason edge_missing). No gateway.env and no token rotation, so the running
 * gateway keeps its connection; nothing is stored. Body { platform: synology|linux (default: the
 * platform the assistant stored; rpi/unknown must choose), network: host|bridge (default host) }.
 * Admin (router), POST + CSRF and session only like the NAS package.
 */
router.post('/:id/compose', (req, res) => {
  if (req.tokenAuth) return res.status(403).json({ ok: false, error: 'session_required' });
  const row = _gatewayIdOr404(req, res);
  if (!row) return;
  const b = req.body || {};
  const pick = (v) => (v === undefined || v === null || v === '' ? null : v); // non-strings fail the check below
  const platform = pick(b.platform) || gatewaySetup.composePlatformOf(row.platform);
  const network = pick(b.network) || 'host';
  if (!platform) return res.status(400).json({ ok: false, error: 'platform_required' });
  // the deconz service (phase 3c, step 2) when the gateway reports a deCONZ stick or Zigbee is switched on;
  // { zigbee: true|false } decides by hand
  const hr = require('../../services/homeRadio');
  const zigbee = typeof b.zigbee === 'boolean' ? b.zigbee : hr.composeWantsZigbee(row.id);
  // zigbee2mqtt / the Thread border router (Funk, follow-ups) when chosen for this gateway; { zigbee2mqtt, thread } decide by hand
  const zigbee2mqtt = typeof b.zigbee2mqtt === 'boolean' ? b.zigbee2mqtt : hr.composeWantsZ2m(row.id);
  const thread = typeof b.thread === 'boolean' ? b.thread : hr.composeWantsThread(row.id);
  // the service ki (phase 3c, step 3) when the local AI runs on this gateway; { ai: true|false } decides by hand,
  // with the graphics card chosen there ("Grafikkarte nutzen": nvidia | amd | intel)
  const ai = typeof b.ai === 'boolean' ? b.ai : require('../../services/ai/local').composeWantsAi(row.id);
  const aiGpu = ai ? require('../../services/ai/local').composeGpu(row.id) : null;
  // the service kameras (phase 3c, step 4) when cameras are switched on for this gateway; { cameras: true|false } decides by hand
  const cameras = typeof b.cameras === 'boolean' ? b.cameras : require('../../services/homeCameras').composeWantsCameras(row.id);
  // the folder for the clips chosen on the gateway page (Funktionen › Kameras), else the Docker volume
  const cameraDir = require('../../services/homeCameras').composeStoragePath(row.id);
  // the service office (Drucken & Scannen) when „Office-Dateien drucken“ is on for this gateway; { office: true|false } by hand
  const office = typeof b.office === 'boolean' ? b.office : require('../../services/homePrint').composeWantsOffice(row.id);
  const text = gatewaySetup.buildCompose(platform, network, { zigbee, zigbee2mqtt, thread, ai, aiGpu, cameras, cameraDir, office });
  if (!text) return res.status(400).json({ ok: false, error: 'invalid_option' });
  logger.info({ peerId: row.id, platform, network, zigbee, zigbee2mqtt, thread, ai, aiGpu, cameras, office }, 'Gateway docker-compose.yml downloaded');
  res.set('Content-Type', 'application/yaml; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="docker-compose.yml"');
  res.set('Cache-Control', 'no-store');
  res.send(text);
});

/** "Im Smart Home einbinden": internal route 127.0.0.1:8090 + Smart Home access target (idempotent). */
router.post('/:id/smarthome', async (req, res) => {
  if (req.tokenAuth) return res.status(403).json({ ok: false, error: 'session_required' });
  const row = _gatewayIdOr404(req, res);
  if (!row) return;
  const wizard = require('../../services/gatewayWizard');
  try {
    const domain = req.body && typeof req.body.domain === 'string' ? req.body.domain : undefined;
    const out = await wizard.connectSmarthome(row.id, { domain, ip: req.ip });
    // phase 3c, step 2: deCONZ takes new API keys for 60 s, so the Smart Home plugin gets its own
    // without the link button in Phoscon (a gateway without the function: nothing happens)
    let unlocked = false;
    try { unlocked = !!(await require('../../services/homeRadio').unlock(row.id)).accepted; } catch { unlocked = false; }
    res.json({ ok: true, ...out, unlocked });
  } catch (err) {
    if (err instanceof wizard.WizardError) {
      const key = 'gwiz.err.' + err.code;
      const msg = req.t(key);
      return res.status(err.status).json({ ok: false, code: err.code, error: msg && msg !== key ? msg : req.t('common.error'), ...(err.feature ? { feature: err.feature } : {}) });
    }
    logger.error({ error: err.message, peerId: row.id }, 'Smart Home link of gateway failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

function _setupGatewayOr4xx(req, res) {
  const id = Number(req.params.id);
  const row = getDb().prepare(`SELECT p.id, p.peer_type, p.enabled
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!require('../../services/license').hasFeature('gateway_fleet')) { res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' }); return null; }
  return { id: row.id };
}

// Serve the generic gateway update.sh for the "set up auto-update" guide (the host drops it next
// to its compose and runs it via a 1-minute trigger). No tailoring — the script is generic.
router.get('/:id/update-sh', (req, res) => {
  if (!_setupGatewayOr4xx(req, res)) return;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="update.sh"');
  res.set('Cache-Control', 'no-store');
  res.send(gatewaySetup.readUpdateSh());
});

module.exports = router;
