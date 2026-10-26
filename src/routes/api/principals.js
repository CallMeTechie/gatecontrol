'use strict';

/**
 * GET /api/v1/principals — what GateControl's picker for groups and people
 * offers on the ADMIN pages (GC.pickPrincipals of plugin frames,
 * public/js/principal-picker.js, docs/plugins.md "Groups"). Admin session
 * only (like /api/v1/groups): every non-archived group (label = its path,
 * sub = its kind) and every enabled account (label = display name, sub = user
 * name, avatarUrl / color — the look of the person, docs/feature-avatars.md). The portal has its own, narrower list (/api/v1/portal/groups/principals).
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const groups = require('../../services/groups');
const avatars = require('../../services/avatars');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');

const router = express.Router();
router.use(requireAdminSession);

router.get('/', (req, res) => {
  try {
    const t = (k) => (typeof req.t === 'function' ? req.t(k) : k);
    const list = groups.list({}).map((g) => ({ id: g.id, label: g.path, sub: t(`grp.kind.${g.kind}`), kind: g.kind }));
    const rows = getDb().prepare('SELECT id, username, display_name, avatar_color FROM users WHERE enabled = 1 ORDER BY lower(COALESCE(NULLIF(display_name, \'\'), username)) LIMIT 5000').all();
    const looks = avatars.infoMany(rows);
    const users = rows.map((u) => ({
      id: u.id, label: u.display_name || u.username, sub: u.display_name ? u.username : '', self: u.id === req.session.userId,
      avatarUrl: looks.get(u.id).avatarUrl, color: looks.get(u.id).color,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, groups: list, users });
  } catch (err) {
    logger.error({ err: err.message }, 'principals API failed');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.groups.generic') : 'failed' });
  }
});

module.exports = router;
