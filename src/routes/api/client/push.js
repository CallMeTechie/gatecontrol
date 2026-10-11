'use strict';

/**
 * Push channel of the apps (notification center, docs/feature-notification-center.md
 * "Vertrag Gerät ↔ Server" — binding for the server and both apps):
 *
 *   GET  /api/v1/client/push          SSE stream (mounted in routes/index.js
 *                                     before the apiLimiter, own limiter per token)
 *   POST /api/v1/client/push/ack      { seqs, state, action? } → { ok }
 *   GET  /api/v1/client/push/inbox    ?limit&before → { items, unread }
 *   GET  /api/v1/client/push/prefs    → { ok, enabled, mode, muted_topics, restricted,
 *                                         quiet: { from, to, tz, critical_bypass } | null }
 *   PUT  /api/v1/client/push/prefs    { enabled, mode, muted_topics, restricted } → { ok }
 *   POST /api/v1/client/push/test     → { ok, seq }   (≤ 5/min)
 *
 * Token only (scope `client` or `full-access`), machine binding like the
 * other client routes. Push switched off → 503 { error: 'push_disabled' }.
 * Every device sees only its own deliveries.
 */

const { Router } = require('express');
const ipaddr = require('ipaddr.js');
const appConfig = require('../../../../config/default');
const { verifyMachineBinding } = require('./helpers');
const { pushTestLimiter } = require('../../../middleware/rateLimit');
const config = require('../../../services/notify/config');
const store = require('../../../services/notify/store');
const stream = require('../../../services/notify/stream');
const hub = require('../../../services/notify/hub');
const pushRouter = require('../../../services/notify/router');
const text = require('../../../services/notify/text');
const { ACK_STATES, TOPIC_RE, LIMITS } = require('../../../services/notify/constants');
const eventBus = require('../../../services/eventBus');
const logger = require('../../../utils/logger');

const router = Router();

/** 'tunnel' when the request comes from inside the WireGuard network. */
function viaOf(ip) {
  try {
    let addr = ipaddr.parse(String(ip || ''));
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
    const [net, bits] = ipaddr.parseCIDR(appConfig.wireguard.subnet);
    return addr.kind() === net.kind() && addr.match(net, bits) ? 'tunnel' : 'direct';
  } catch { return 'direct'; }
}

function platformOf(h) {
  const s = String(h || '').trim().toLowerCase();
  if (s === 'win32' || s === 'windows') return 'windows';
  return s === 'android' ? 'android' : null;
}
function clientTypeOf(h) {
  const s = String(h || '').trim().toLowerCase();
  return s === 'pro' || s === 'community' ? s : null;
}
function versionOf(h) {
  const s = String(h || '').trim();
  return /^[0-9A-Za-z.+-]{1,32}$/.test(s) ? s : null;
}

/** Token, scope, machine binding, push on. false = answered. */
function guard(req, res) {
  if (!req.tokenAuth) { res.status(403).json({ ok: false, error: 'token_required' }); return false; }
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    res.status(403).json({ ok: false, error: 'scope_required' });
    return false;
  }
  if (!verifyMachineBinding(req, res)) return false;
  if (!config.value('enabled')) { res.status(503).json({ ok: false, error: 'push_disabled' }); return false; }
  return true;
}

function recordApp(req, via) {
  store.touchDevice(req.tokenId, {
    platform: platformOf(req.headers['x-client-platform']),
    clientType: clientTypeOf(req.headers['x-client-type']),
    appVersion: versionOf(req.headers['x-client-version']),
    via,
  });
}

// ─── GET /api/v1/client/push (SSE) ──────────────────────────────────────

function streamHandler(req, res) {
  if (!guard(req, res)) return;
  const cfg = config.get();
  const via = viaOf(req.ip);
  if (!cfg.allow_direct && via === 'direct') return res.status(403).json({ ok: false, error: 'direct_not_allowed' });
  if (!stream.isConnected(req.tokenId) && stream.count() >= cfg.max_streams) {
    return res.status(503).json({ ok: false, error: 'too_many_streams' });
  }
  const rawSince = req.headers['last-event-id'] != null ? req.headers['last-event-id'] : req.query.since;
  const since = /^\d{1,15}$/.test(String(rawSince == null ? '' : rawSince).trim()) ? Number(String(rawSince).trim()) : null;

  const prev = store.devicePrefs(req.tokenId);
  recordApp(req, via);
  if (req.tokenPeerId != null) {
    require('../../../services/clientUpdates').recordClientVersion(req.tokenPeerId, {
      version: req.headers['x-client-version'], product: req.headers['x-client-type'], platform: req.headers['x-client-platform'],
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const tokenId = req.tokenId;
  const userId = req.tokenUserId == null ? null : req.tokenUserId;
  const conn = stream.add({ tokenId, userId, via, res, connectedAt: store.iso() });

  stream.writeEvent(conn, 'hello', {
    server_time: new Date().toISOString(),
    keepalive_s: cfg.keepalive_s,
    retention_h: cfg.retention_h,
    via,
    unread: store.unreadCount(tokenId),
    topics: hub.topicsForUser(userId, text.userLang(userId)),
    quiet: pushRouter.quietOf(userId),
  });
  for (const row of store.pendingForToken(tokenId, since)) {
    if (!hub.writeDelivery(conn, row.seq)) break;
  }
  const revoked = store.revokedForToken(tokenId, prev && prev.last_seen_at);
  if (revoked.length) stream.writeEvent(conn, 'revoke', { ids: revoked });

  // After backpressure: what is still queued goes out now.
  conn.onDrain = () => {
    for (const row of store.pendingForToken(tokenId, null)) {
      if (row.state !== 'queued') continue;
      if (!hub.writeDelivery(conn, row.seq)) break;
    }
  };
  conn.onClose = () => { try { store.seen(tokenId); } catch { /* db closed */ } };

  let pings = 0;
  conn.keepalive = setInterval(() => {
    if (!pushRouter.tokenAlive(tokenId) || !config.value('enabled')) { stream.close(conn, 'revoked'); return; }
    stream.ping(conn);
    pings += 1;
    if (pings % 10 === 0) { try { store.seen(tokenId); } catch { /* ignore */ } }
  }, module.exports._keepaliveMs || cfg.keepalive_s * 1000);
  if (conn.keepalive.unref) conn.keepalive.unref();

  req.on('close', () => stream.close(conn, 'client_closed'));
  logger.debug({ tokenId, via, since }, 'push stream opened');
}

// ─── POST /api/v1/client/push/ack ───────────────────────────────────────

router.post('/push/ack', (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body || {};
  const seqs = Array.isArray(b.seqs) ? b.seqs : null;
  if (!seqs || !seqs.length || seqs.length > LIMITS.ackSeqs || !seqs.every((s) => Number.isSafeInteger(s) && s > 0)) {
    return res.status(400).json({ ok: false, error: 'invalid_seqs' });
  }
  if (!ACK_STATES.includes(b.state)) return res.status(400).json({ ok: false, error: 'invalid_state' });
  let action = null;
  if (b.action != null) {
    if (typeof b.action !== 'string' || !/^[A-Za-z0-9_.:-]{1,40}$/.test(b.action)) return res.status(400).json({ ok: false, error: 'invalid_action' });
    action = b.action;
  }
  try {
    const changed = store.ack(req.tokenId, [...new Set(seqs)], b.state, action);
    hub.onAck(req.tokenId, req.tokenUserId == null ? null : req.tokenUserId, changed, b.state);
    if (changed.length) eventBus.publish('notify', { id: changed[0].notification_id });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message, tokenId: req.tokenId }, 'push ack failed');
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ─── GET /api/v1/client/push/inbox ──────────────────────────────────────

router.get('/push/inbox', (req, res) => {
  if (!guard(req, res)) return;
  const limit = /^\d{1,3}$/.test(String(req.query.limit || '')) ? Math.min(LIMITS.inbox, Math.max(1, Number(req.query.limit))) : LIMITS.inbox;
  const before = /^\d{1,15}$/.test(String(req.query.before || '')) ? Number(req.query.before) : null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, items: store.inbox(req.tokenId, { limit, before }), unread: store.unreadCount(req.tokenId) });
});

// ─── GET /api/v1/client/push/prefs ──────────────────────────────────────
// What the server holds for this device (as last sent with PUT) plus the
// quiet hours of its person (set in the portal) — read-only, records nothing.

router.get('/push/prefs', (req, res) => {
  if (!guard(req, res)) return;
  const cur = store.devicePrefs(req.tokenId);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    enabled: !cur || cur.enabled !== 0,
    mode: (cur && cur.mode) || null,
    muted_topics: (cur && Array.isArray(cur.muted_topics)) ? cur.muted_topics : [],
    restricted: !!cur && cur.restricted === 1,
    quiet: pushRouter.quietOf(req.tokenUserId == null ? null : req.tokenUserId),
  });
});

// ─── PUT /api/v1/client/push/prefs ──────────────────────────────────────

router.put('/push/prefs', (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body || {};
  const cur = store.devicePrefs(req.tokenId) || { enabled: 1, mode: null, muted_topics: [], restricted: 0 };
  const next = { enabled: cur.enabled !== 0, mode: cur.mode || null, muted_topics: cur.muted_topics || [], restricted: cur.restricted === 1 };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'invalid_enabled' });
    next.enabled = b.enabled;
  }
  if (b.mode !== undefined) {
    if (b.mode !== 'always' && b.mode !== 'vpn_only') return res.status(400).json({ ok: false, error: 'invalid_mode' });
    next.mode = b.mode;
  }
  if (b.muted_topics !== undefined) {
    const m = b.muted_topics;
    if (!Array.isArray(m) || m.length > LIMITS.mutedTopics || !m.every((t) => typeof t === 'string' && TOPIC_RE.test(t))) {
      return res.status(400).json({ ok: false, error: 'invalid_topics' });
    }
    next.muted_topics = [...new Set(m)];
  }
  if (b.restricted !== undefined) {
    if (typeof b.restricted !== 'boolean') return res.status(400).json({ ok: false, error: 'invalid_restricted' });
    next.restricted = b.restricted;
  }
  recordApp(req, viaOf(req.ip));
  store.setDevicePrefs(req.tokenId, next);
  const conn = stream.get(req.tokenId);
  eventBus.publish('push_presence', {
    token_id: req.tokenId,
    state: conn ? (next.restricted ? 'restricted' : 'connected') : 'offline',
    via: conn ? conn.via : null,
  });
  res.json({ ok: true });
});

// ─── POST /api/v1/client/push/test ──────────────────────────────────────

router.post('/push/test', pushTestLimiter, (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!store.devicePrefs(req.tokenId)) recordApp(req, viaOf(req.ip));
    const r = hub.sendTest({ tokenIds: [req.tokenId], userId: req.tokenUserId, lang: text.userLang(req.tokenUserId) });
    const row = store.deliveriesOf(r.id).find((d) => d.token_id === req.tokenId);
    res.json({ ok: true, seq: row ? row.seq : null });
  } catch (err) {
    logger.error({ err: err.message, tokenId: req.tokenId }, 'push test failed');
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
module.exports.stream = streamHandler;
module.exports.viaOf = viaOf;
module.exports._keepaliveMs = null; // tests only
