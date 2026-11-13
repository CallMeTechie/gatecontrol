'use strict';

const { Router } = require('express');
const peers = require('../../services/peers');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');
const resolveError = require('../../utils/resolveError');
const stripFields = require('../../utils/stripFields');
const { validatePeerName, validateDescription } = require('../../utils/validate');
const { requireLimit, requireFeature } = require('../../middleware/license');
const { getDb } = require('../../db/connection');
const clientUpdates = require('../../services/clientUpdates');
const clientPolicy = require('../../services/clientPolicy');
const activity = require('../../services/activity');

const router = Router();

const peerCountFn = () => getDb().prepare('SELECT COUNT(*) as count FROM peers').get().count;

function validateOwner(req, res, userId) {
  if (userId == null) return true;
  const uid = Number(userId);
  if (!Number.isInteger(uid) || !require('../../services/users').getById(uid)) {
    res.status(400).json({ ok: false, error: req.t('error.peers.owner_invalid') }); return false;
  }
  return true;
}

const stripPeer = (p) => stripFields(p, ['private_key_encrypted', 'preshared_key_encrypted']);

/** All peers by type ({ clients, gateways, total }); disabled ones included, like the licence count. */
function peerTypeCounts() {
  const row = getDb().prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN peer_type = 'gateway' THEN 1 ELSE 0 END) AS gateways FROM peers").get();
  const total = row.total || 0;
  const gateways = row.gateways || 0;
  return { clients: total - gateways, gateways, total };
}

/** Map service-layer error messages to i18n keys */
const VALIDATION_ERROR_MAP = {
  'already exists': 'error.peers.name_exists',
  'No available': 'error.peers.no_ips',
  'not found': 'error.peers.not_found',
};

/**
 * POST /api/peers/batch — Batch enable/disable/delete peers
 */
router.post('/batch', async (req, res) => {
  try {
    const { action, ids } = req.body;

    if (!action || !['enable', 'disable', 'delete', 'group', 'tag'].includes(action)) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.invalid_action') });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.no_ids') });
    }
    if (ids.length > 500 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      return res.status(400).json({ ok: false, error: req.t('error.peers.bulk_invalid_ids') });
    }

    // group: { group_id } (null = no group) · tag: { tag } added to every peer
    if (action === 'group' || action === 'tag') {
      let affected;
      try {
        affected = action === 'group'
          ? peers.batchGroup(ids, req.body.group_id == null || req.body.group_id === '' ? null : Number(req.body.group_id))
          : peers.batchAddTag(ids, req.body.tag);
      } catch (err) {
        if (/group not found/.test(err.message)) return res.status(400).json({ ok: false, error: req.t('error.batch.group_invalid') });
        if (/^tag /.test(err.message)) return res.status(400).json({ ok: false, error: req.t('error.batch.tag_invalid') });
        throw err;
      }
      return res.json({ ok: true, affected });
    }

    const affected = await peers.batch(action, ids);
    res.json({ ok: true, affected });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to batch operate on peers');
    if (/gateway_is_failover_home/.test(err.message || '')) {
      return res.status(409).json({ ok: false, error: req.t('error.peers.failover_home_blocked') });
    }
    if (err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: req.t('error.batch.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.batch.failed') });
  }
});

// Bulk owner assignment. Registered BEFORE '/:id' so the literal path isn't
// captured as id="batch-owner". Inherits the same admin auth + CSRF (mount point).
router.post('/batch-owner', (req, res) => {
  try {
    const { peer_ids, user_id } = req.body;
    const MAX = 500;
    if (!Array.isArray(peer_ids) || peer_ids.length === 0 || peer_ids.length > MAX
        || !peer_ids.every(n => Number.isInteger(n))) {
      return res.status(400).json({ ok: false, error: req.t('error.peers.bulk_invalid_ids') });
    }
    if (user_id != null && (!Number.isInteger(Number(user_id)) || !require('../../services/users').getById(Number(user_id)))) {
      return res.status(400).json({ ok: false, error: req.t('error.peers.owner_invalid') });
    }
    const db = getDb();
    const ph = peer_ids.map(() => '?').join(',');
    const info = db.prepare(`UPDATE peers SET user_id = ?, updated_at = datetime('now') WHERE id IN (${ph})`)
      .run(user_id == null ? null : Number(user_id), ...peer_ids);
    res.json({ ok: true, affected: info.changes });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/peers — List all peers with live status
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // ?type=client (Peers page: no gateways, they have their own page) or
    // ?type=gateway; without it every peer, as before (API tokens, scripts).
    const type = req.query.type === 'client' || req.query.type === 'gateway' ? req.query.type : null;
    const list = await peers.getAll({ limit, offset, type });
    const uMap = new Map(getDb().prepare('SELECT id, username FROM users').all().map(u => [u.id, u.username]));
    const policy = clientUpdates.getPolicy();
    const enriched = list.map(p => clientPolicy.decoratePeer(clientUpdates.decoratePeer({ ...p, owner_name: p.user_id != null ? (uMap.get(p.user_id) || null) : null }, policy)));
    // Support bundles per device (admin session only — API tokens never see
    // anything about them): count and not yet opened ones for the list badge.
    if (!req.tokenAuth) {
      const sb = require('../../services/supportBundles').countsByPeer();
      for (const p of enriched) {
        const c = sb.get(p.id);
        p.support_bundles_total = c ? c.total : 0;
        p.support_bundles_unviewed = c ? c.unviewed : 0;
      }
    }
    res.json({
      ok: true,
      peers: enriched.map(stripPeer),
      limit,
      offset,
      // licence line of the Peers page: the vpn_peers limit counts every peer, gateways included
      counts: peerTypeCounts(),
      update_policy: { default_channel: policy.defaultChannel, min_versions: policy.minVersions },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list peers');
    res.status(500).json({ ok: false, error: req.t('error.peers.list') });
  }
});

/**
 * GET /api/peers/:id/client-policy — override, inherited and effective policy
 * (for the peer edit dialog; "inherited" = what applies without the peer's
 * own override).
 */
router.get('/:id/client-policy', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });
    const inherited = clientPolicy.resolveEffective({ ...peer, client_policy: null });
    const effective = clientPolicy.resolveEffective(peer);
    res.json({
      ok: true,
      data: {
        override: clientPolicy.parseOverride(peer.client_policy),
        inherited: inherited.policy,
        inherited_sources: inherited.sources,
        effective: effective.policy,
        sources: effective.sources,
        version: clientPolicy.forClient(peer).version,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer client policy');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/peers/:id — Get single peer
 */
router.get('/:id', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });
    res.json({ ok: true, peer: stripPeer(clientPolicy.decoratePeer(clientUpdates.decoratePeer(peer))) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer');
    res.status(500).json({ ok: false, error: req.t('error.peers.get') });
  }
});

/**
 * POST /api/peers — Create new peer
 */
router.post('/', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
  try {
    const { name, description, tags, expires_at, group_id, dns, is_gateway, api_port, proxy_port, user_id, platform, location_id } = req.body;

    // Field-level validation
    const fields = {};
    const nameErr = validatePeerName(name);
    if (nameErr) fields.name = req.t('error.peers.name_invalid') || nameErr;
    const descErr = validateDescription(description);
    if (descErr) fields.description = req.t('error.peers.description_invalid') || descErr;
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    if (is_gateway) {
      // Gateway path: create peer + meta + tokens in one go. Return plaintext
      // tokens ONCE + full env-file content so the admin can copy or download.
      const gateways = require('../../services/gateways');
      const parsedApiPort = api_port != null && api_port !== ''
        ? parseInt(api_port, 10)
        : gateways.DEFAULT_API_PORT;
      if (!Number.isInteger(parsedApiPort) || parsedApiPort < 1 || parsedApiPort > 65535) {
        return res.status(400).json({ ok: false, error: 'api_port must be 1..65535' });
      }
      const parsedProxyPort = proxy_port != null && proxy_port !== ''
        ? parseInt(proxy_port, 10)
        : 8080;
      if (!Number.isInteger(parsedProxyPort) || parsedProxyPort < 1 || parsedProxyPort > 65535) {
        return res.status(400).json({ ok: false, error: 'proxy_port must be 1..65535' });
      }
      // Gateway assistant (docs/feature-gateway-wizard.md): where it runs
      // (rpi | synology | proxmox | linux, optional) and its location
      // (gateway_locations, optional — docs/feature-gateway-locations.md).
      // group_id (a peer group) is still taken from API callers; the
      // assistant no longer sends it.
      if (platform != null && platform !== '' && !gateways.normalizePlatform(platform)) {
        return res.status(400).json({ ok: false, error: req.t('error.peers.gateway_platform_invalid'), fields: { platform: req.t('error.peers.gateway_platform_invalid') } });
      }
      let groupId = null;
      if (group_id != null && group_id !== '') {
        groupId = Number(group_id);
        if (!Number.isInteger(groupId) || !getDb().prepare('SELECT 1 FROM peer_groups WHERE id = ?').get(groupId)) {
          return res.status(400).json({ ok: false, error: req.t('error.peers.group_invalid'), fields: { group_id: req.t('error.peers.group_invalid') } });
        }
      }
      let locationId = null;
      try {
        locationId = require('../../services/gatewayLocations').resolveId(location_id);
      } catch {
        return res.status(400).json({ ok: false, error: req.t('error.gateway_locations.not_found'), fields: { location_id: req.t('error.gateway_locations.not_found') } });
      }
      let result;
      try {
        result = await gateways.createGateway({
          name,
          apiPort: parsedApiPort,
          proxyPort: parsedProxyPort,
          platform: platform || null,
          groupId,
          locationId,
        });
      } catch (err) {
        if (/^License limit reached: gateway_peers/.test(err.message || '')) {
          const license = require('../../services/license');
          return res.status(403).json({
            ok: false,
            error: req.t('error.license.limit_reached'),
            feature: 'gateway_peers',
            limit: license.getFeatureLimit('gateway_peers'),
            upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
          });
        }
        throw err;
      }
      const envContent = gateways.buildEnvForPeer(result.peer.id, result.apiToken, result.pushToken);
      return res.status(201).json({
        ok: true,
        peer: stripPeer(result.peer),
        gateway: {
          apiToken: result.apiToken,
          pushToken: result.pushToken,
          envContent,
        },
      });
    }

    if (!validateOwner(req, res, user_id)) return;
    const peer = await peers.create({ name, description, tags, expiresAt: expires_at || null, groupId: group_id !== undefined ? group_id : null, dns, userId: user_id });
    res.status(201).json({ ok: true, peer: stripPeer(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.create');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/peers/:id — Update peer
 */
router.put('/:id', async (req, res) => {
  try {
    const { name, description, dns, persistentKeepalive, enabled, tags, expires_at, group_id, user_id, update_channel, client_policy } = req.body;

    // Client policy override: admin session only, like the update channel.
    let policyResult = null;
    if (client_policy !== undefined) {
      if (req.tokenAuth) {
        return res.status(403).json({ ok: false, error: req.t('error.client_policy.session_required') });
      }
      const existing = peers.getById(req.params.id);
      if (!existing) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });
      policyResult = clientPolicy.validateInput(client_policy, { mode: 'override', current: clientPolicy.parseOverride(existing.client_policy) });
      if (policyResult.error) {
        return res.status(400).json({ ok: false, error: req.t(policyResult.error === 'unknown_field' ? 'error.client_policy.unknown_field' : 'error.client_policy.invalid_value', { field: policyResult.field || '' }), field: policyResult.field || null });
      }
    }

    // Update channel: admin session only (an API token — even one with the
    // peers scope — must not move a client to beta builds).
    if (update_channel !== undefined) {
      if (req.tokenAuth) {
        return res.status(403).json({ ok: false, error: req.t('error.client_updates.session_required') });
      }
      if (update_channel !== null && update_channel !== '' && !clientUpdates.isValidChannel(update_channel)) {
        return res.status(400).json({ ok: false, error: req.t('error.client_updates.invalid_channel') });
      }
    }

    // Field-level validation
    const fields = {};
    if (name !== undefined) {
      const nameErr = validatePeerName(name);
      if (nameErr) fields.name = req.t('error.peers.name_invalid') || nameErr;
    }
    if (description !== undefined) {
      const descErr = validateDescription(description);
      if (descErr) fields.description = req.t('error.peers.description_invalid') || descErr;
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    // Pass expires_at: explicit null clears it, undefined means don't change
    const updateData = { name, description, dns, persistentKeepalive, enabled, tags };
    if (expires_at !== undefined) {
      updateData.expiresAt = expires_at || null;
    }
    if (group_id !== undefined) {
      updateData.groupId = group_id || null;
    }
    if (user_id !== undefined && !validateOwner(req, res, user_id)) return;
    if (user_id !== undefined) {
      updateData.userId = user_id;
    }

    let peer = await peers.update(req.params.id, updateData);
    if (update_channel !== undefined && peer) {
      const result = clientUpdates.setPeerChannel(peer.id, update_channel);
      if (result.changed) {
        activity.log('peer_update_channel_changed', `Update channel of peer "${peer.name}" changed`, {
          source: 'admin', ipAddress: req.ip, severity: 'info',
          details: { peerId: peer.id, from: result.from, to: result.to },
        });
        peer = peers.getById(peer.id);
      }
    }
    if (policyResult && peer && Object.keys(policyResult.changes).length > 0) {
      clientPolicy.setPeerOverride(peer.id, policyResult.next);
      activity.log('peer_client_policy_changed', `Client policy of peer "${peer.name}" changed`, {
        source: 'admin', ipAddress: req.ip, severity: 'info',
        details: { peerId: peer.id, changes: policyResult.changes },
      });
      peer = peers.getById(peer.id);
    }
    res.json({ ok: true, peer: stripPeer(clientPolicy.decoratePeer(clientUpdates.decoratePeer(peer))) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.update');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * GET /api/peers/:id/delete-impact — Preview which routes would be
 * disabled if this peer were deleted. Used by the gateway-delete modal
 * to show the user what they're about to break before they confirm.
 */
router.get('/:id/delete-impact', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const peer = peers.getById(id);
    if (!peer) return res.status(404).json({ ok: false, error: 'not_found' });

    const db = getDb();
    let httpRoutes = [];
    let rdpRoutes = [];

    if (peer.peer_type === 'gateway') {
      httpRoutes = db.prepare(`
        SELECT id, domain, route_type, target_lan_host, target_lan_port
        FROM routes
        WHERE target_peer_id = ? AND target_kind = 'gateway'
        ORDER BY domain
      `).all(id);
      rdpRoutes = db.prepare(`
        SELECT id, name, host, port
        FROM rdp_routes
        WHERE gateway_peer_id = ?
        ORDER BY name
      `).all(id);
    } else {
      // Regular peer — legacy peer_id link on http routes
      httpRoutes = db.prepare(`
        SELECT id, domain, route_type
        FROM routes
        WHERE peer_id = ?
        ORDER BY domain
      `).all(id);
    }

    res.json({
      ok: true,
      peer: {
        id: peer.id,
        name: peer.name,
        ip: (peer.allowed_ips || '').split(',')[0].split('/')[0].trim(),
        peer_type: peer.peer_type,
        enabled: !!peer.enabled,
      },
      httpRoutes,
      rdpRoutes,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to compute delete impact');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * DELETE /api/peers/:id — Delete peer
 */
router.delete('/:id', async (req, res) => {
  try {
    await peers.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete peer');
    if (/gateway_is_failover_home/.test(err.message || '')) {
      return res.status(409).json({ ok: false, error: req.t('error.peers.failover_home_blocked') });
    }
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.delete');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/peers/:id/toggle — Toggle peer enabled/disabled
 */
router.put('/:id/toggle', async (req, res) => {
  try {
    // Check if trying to enable and limit would be exceeded
    const existing = peers.getById(req.params.id);
    if (existing && !existing.enabled) {
      const { isWithinLimit, getFeatureLimit } = require('../../services/license');
      const count = getDb().prepare('SELECT COUNT(*) as count FROM peers WHERE enabled = 1').get().count;
      if (!isWithinLimit('vpn_peers', count)) {
        const limit = getFeatureLimit('vpn_peers');
        return res.status(403).json({
          ok: false,
          error: req.t ? req.t('error.license.limit_reached') : 'Peer limit reached',
          feature: 'vpn_peers',
          current: count,
          limit,
          upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
        });
      }
    }
    const peer = await peers.toggle(req.params.id);
    res.json({ ok: true, peer: stripPeer(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.toggle');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * GET /api/peers/:id/config — Download client WireGuard config
 */
router.get('/:id/config', async (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const conf = await peers.getClientConfig(req.params.id);

    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'application/octet-stream');
      const safeName = peer.name.replace(/[^\w.\-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.conf"`);
      return res.send(conf);
    }

    res.json({ ok: true, config: conf, name: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer config');
    res.status(500).json({ ok: false, error: req.t('error.peers.config') });
  }
});

/**
 * GET /api/peers/:id/qr — Get QR code for peer config
 */
router.get('/:id/qr', async (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const conf = await peers.getClientConfig(req.params.id);
    const dataUrl = await qrcode.toDataUrl(conf);

    res.json({ ok: true, qr: dataUrl, config: conf, name: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to generate QR code');
    res.status(500).json({ ok: false, error: req.t('error.peers.qr') });
  }
});

/**
 * Why a device name was refused, in the admin's words, with a suggestion
 * where there is one. → { status, body } | null (not a refusal: a real error)
 *   code: reserved | taken | route | invalid — the dialogs show `error`, the
 *   suggestion is also in `suggestion` so it can be taken over with a click.
 */
function hostnameRefusal(err, raw, t) {
  const dnsService = require('../../services/dns');
  const msg = (err && err.message) || '';
  const name = String(raw == null ? '' : raw).trim();
  const body = (code, error, suggestion) => ({ status: code === 'taken' || code === 'route' ? 409 : 400,
    body: { ok: false, code, error, suggestion: suggestion || null, fields: { hostname: error } } });
  if (err instanceof dnsService.HostnameUnavailableError) {
    const params = { name: err.hostname, owner: err.owner || '', fqdn: err.fqdn || '', suggestion: err.suggestion || '' };
    if (err.code === 'ERR_HOSTNAME_ROUTE') {
      return body('route', t(err.suggestion ? 'error.dns.hostname_route_suggest' : 'error.dns.hostname_route', params), err.suggestion);
    }
    return body('taken', t(err.suggestion ? 'error.dns.hostname_taken_suggest' : 'error.dns.hostname_taken', params), err.suggestion);
  }
  if (msg.includes('reserved')) {
    const suggestion = dnsService.suggestHostname(name);
    return body('reserved', t(suggestion ? 'error.dns.hostname_reserved_suggest' : 'error.dns.hostname_reserved', { name: name.toLowerCase(), suggestion: suggestion || '' }), suggestion);
  }
  if (msg.includes('invalid characters') || msg.includes('empty') || msg.includes('too long') || msg.includes('exceeds') || msg.includes('disallowed byte') || msg.includes('must be a string')) {
    const suggestion = dnsService.suggestHostname(name);
    return body('invalid', t(suggestion ? 'error.dns.hostname_invalid_suggest' : 'error.dns.hostname_invalid', { suggestion: suggestion || '' }), suggestion);
  }
  return null;
}

/**
 * PATCH /api/peers/:id/hostname — Admin-set internal DNS hostname.
 * License-gated via 'internal_dns'. Empty/null clears the hostname.
 */
router.patch('/:id/hostname', requireFeature('internal_dns'), (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const raw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'hostname')
      ? req.body.hostname
      : undefined;
    if (raw === undefined) {
      return res.status(400).json({ ok: false, error: req.t('error.dns.hostname_required') });
    }

    const result = peers.setHostname(peer.id, raw || null, 'admin');
    res.json({ ok: true, peer: stripPeer(peers.getById(peer.id)), assigned: result.assigned, changed: result.changed });
  } catch (err) {
    const refused = hostnameRefusal(err, req.body && req.body.hostname, req.t);
    if (refused) return res.status(refused.status).json(refused.body);
    logger.error({ error: err.message }, 'Failed to set peer hostname');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/peers/:id/gateway-info — telemetry snapshot for a gateway peer.
 * Returns the parsed last_health JSON (written by gateways.handleHeartbeat)
 * alongside metadata: last_seen_at, health-state-machine status, api_port.
 * Non-gateway peers get a 404.
 */
router.get('/:id/gateway-info', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });
    if (peer.peer_type !== 'gateway') {
      return res.status(404).json({ ok: false, error: 'Not a gateway peer' });
    }

    const meta = getDb().prepare(
      'SELECT last_seen_at, last_health, api_port, proxy_port FROM gateway_meta WHERE peer_id = ?'
    ).get(peer.id);
    if (!meta) return res.status(404).json({ ok: false, error: 'Gateway meta missing' });

    let health = {};
    if (meta.last_health) {
      try { health = JSON.parse(meta.last_health); } catch (_) { health = {}; }
    }

    const gateways = require('../../services/gateways');
    const liveState = require('../../services/gatewayLiveState');
    const healthStatus = gateways.getHealthStatus(peer.id);
    const live = liveState.forPeer(peer.id) || liveState.derive({}, {});
    const status = liveState.legacyStatus(live, healthStatus, gateways._isHeartbeatHealthy(health));

    res.json({
      ok: true,
      gateway: {
        peer_id: peer.id,
        status,
        state: live.state,
        reachable: live.reachable,
        offline_since: live.offline_since,
        failback_at: live.failback_at,
        expected_back_by: live.expected_back_by,
        health_status: healthStatus,
        api_port: meta.api_port,
        proxy_port: meta.proxy_port || 8080,
        last_seen_at: meta.last_seen_at,
        health,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get gateway info');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/peers/:id/traffic — Get per-peer traffic chart data
 */
router.get('/:id/traffic', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const { getPeerChartData } = require('../../services/traffic');
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '24h';
    const data = getPeerChartData(peer.id, period);

    res.json({
      ok: true,
      peer: { id: peer.id, name: peer.name, total_rx: peer.total_rx, total_tx: peer.total_tx },
      data,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer traffic');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * POST /api/v1/peers/:id/gateway-env/rotate — regenerate tokens and return
 * fresh gateway.env file for a gateway peer. Uses POST (not GET) to prevent
 * accidental browser-prefetch from invalidating live tokens.
 */
router.post('/:id/gateway-env/rotate', (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  try {
    const { apiToken, pushToken, envContent } = require('../../services/gateways').rotateGatewayTokens(peerId);
    res.json({ ok: true, apiToken, pushToken, envContent });
  } catch (err) {
    if (err.message === 'not_a_gateway') {
      return res.status(404).json({ ok: false, error: 'not_a_gateway' });
    }
    logger.error({ error: err.message, peerId }, 'Failed to rotate gateway tokens');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * POST /api/v1/peers/:id/gateway-pairing-code — generate a one-shot
 * pairing code that the install-pve.sh installer can redeem to bootstrap
 * the gateway without manual gateway.env transfer. Single-active per
 * peer, 10-min TTL, hashed at rest. The cleartext token is returned ONCE.
 */
router.post('/:id/gateway-pairing-code', (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  try {
    // `token` (CODE@host) for the Proxmox one-liner; `code` and `server` apart for the setup page of the gateway
    const { token, code, server, expiresAt } = require('../../services/gateways').createPairingCode(peerId);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, token, code, server, expiresAt });
  } catch (err) {
    if (err.message === 'not_a_gateway') {
      return res.status(404).json({ ok: false, error: 'not_a_gateway' });
    }
    logger.error({ error: err.message, peerId }, 'Failed to create gateway pairing code');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PATCH /api/peers/:id/proxy-port — update gateway_meta.proxy_port for an
 * existing gateway. Triggers a Caddy re-render so backend dial strings
 * pick up the new port immediately. Companion-side change (in
 * /config/gateway.env on the gateway host) must be done separately by
 * the admin — re-download the env file after saving here.
 */
router.patch('/:id/proxy-port', async (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  const { proxy_port } = req.body || {};
  const port = parseInt(proxy_port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, error: 'proxy_port must be 1..65535' });
  }
  try {
    const { getDb } = require('../../db/connection');
    const result = getDb()
      .prepare('UPDATE gateway_meta SET proxy_port = ? WHERE peer_id = ?')
      .run(port, peerId);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'not_a_gateway' });
    }
    // Trigger caddy re-render so the new port is picked up in dial strings
    try {
      await require('../../services/caddyConfig').syncToCaddy();
    } catch (err) {
      logger.warn({ err: err.message, peerId }, 'caddy re-render after proxy_port update failed');
    }
    res.json({ ok: true, proxy_port: port });
  } catch (err) {
    logger.error({ error: err.message, peerId }, 'Failed to update gateway proxy_port');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
