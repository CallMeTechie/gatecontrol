'use strict';

/**
 * "Wer darf zugreifen?" — the combined picker of the route and RDP dialogs
 * (docs/groups.md "Zugriff per Gruppe", services/groupAccess.js). Admin
 * session only, like /api/v1/groups; CSRF and the API limiter come from the
 * /api/v1 router.
 *
 *   GET  /api/v1/access/principals
 *        → { ok, groups: [{ id, path, name, kind, color, archived, readOnly,
 *              totalMemberCount }], users: [{ id, name, username, enabled,
 *              disabledReason }], peers: [{ id, name, ip, userId, owner,
 *              enabled }] }   (gateways are not offered as devices)
 *   POST /api/v1/access/preview { userIds, groupIds, peerIds, aclPeople? }
 *        → { ok, count, people: [{ userId, name, username, disabled,
 *              disabledReason, reasons: [...], ownDevices, visibleOnly }],
 *              devices: [...], groups: [...], unknownUserIds: [...],
 *              aclPeople, personDevices: [...] }
 *        aclPeople (boolean, route editor with the device ACL): whether the
 *        devices of the persons and group members pass (routes.acl_people).
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const { getDb } = require('../../db/connection');
const groupAccess = require('../../services/groupAccess');
const logger = require('../../utils/logger');

const router = express.Router();
router.use(requireAdminSession);

router.get('/principals', (req, res) => {
  try {
    const db = getDb();
    const groups = require('../../services/groups').list({ includeArchived: true }).map((g) => ({
      id: g.id, path: g.path, name: g.name, kind: g.kind, color: g.color, archived: g.archived,
      readOnly: g.readOnly, totalMemberCount: g.totalMemberCount,
    }));
    const users = db.prepare('SELECT id, username, display_name, enabled, disabled_reason FROM users ORDER BY COALESCE(display_name, username) COLLATE NOCASE')
      .all().map((u) => ({
        id: u.id, name: u.display_name || u.username, username: u.username, enabled: u.enabled === 1,
        disabledReason: u.enabled === 1 ? null : (u.disabled_reason || 'admin'),
      }));
    const names = new Map(users.map((u) => [u.id, u.name]));
    const peers = db.prepare("SELECT id, name, allowed_ips, user_id, enabled FROM peers WHERE peer_type IS NULL OR peer_type = 'regular' ORDER BY name COLLATE NOCASE")
      .all().map((p) => ({
        id: p.id, name: p.name, ip: String(p.allowed_ips || '').split(',')[0].split('/')[0] || null,
        userId: p.user_id || null, owner: p.user_id ? (names.get(p.user_id) || null) : null, enabled: p.enabled === 1,
      }));
    res.json({ ok: true, groups, users, peers });
  } catch (err) {
    logger.error({ err: err.message }, 'access principals failed');
    res.status(500).json({ ok: false, error: req.t('error.access.generic') });
  }
});

router.post('/preview', (req, res) => {
  try {
    const body = req.body || {};
    const out = groupAccess.preview({ userIds: body.userIds, groupIds: body.groupIds, peerIds: body.peerIds, aclPeople: typeof body.aclPeople === 'boolean' ? body.aclPeople : undefined });
    res.json({ ok: true, ...out });
  } catch (err) {
    if (/_INVALID$/.test(err.code || '')) {
      return res.status(400).json({ ok: false, code: err.code, error: req.t('error.access.invalid') });
    }
    logger.error({ err: err.message }, 'access preview failed');
    res.status(500).json({ ok: false, error: req.t('error.access.generic') });
  }
});

module.exports = router;
