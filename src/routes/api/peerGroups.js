'use strict';

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const { sanitize } = require('../../utils/validate');

const router = Router();

/**
 * GET /api/peer-groups — List all groups with peer count
 */
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const groups = db.prepare(`
      SELECT pg.*, COUNT(p.id) AS peer_count
      FROM peer_groups pg
      LEFT JOIN peers p ON p.group_id = pg.id
      GROUP BY pg.id
      ORDER BY pg.name ASC
    `).all();
    res.json({ ok: true, groups });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list peer groups');
    res.status(500).json({ ok: false, error: req.t('error.peer_groups.list') });
  }
});

/**
 * POST /api/peer-groups — Create group
 */
router.post('/', (req, res) => {
  try {
    const { name, color, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: req.t('error.peer_groups.name_required') });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM peer_groups WHERE name = ?').get(sanitize(name.trim()));
    if (existing) {
      return res.status(409).json({ ok: false, error: req.t('error.peer_groups.name_exists') });
    }

    const result = db.prepare(
      'INSERT INTO peer_groups (name, color, description) VALUES (?, ?, ?)'
    ).run(sanitize(name.trim()), sanitize(color) || '#6b7280', sanitize(description) || null);

    const group = db.prepare('SELECT * FROM peer_groups WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ok: true, group });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create peer group');
    res.status(500).json({ ok: false, error: req.t('error.peer_groups.create') });
  }
});

/**
 * PUT /api/peer-groups/:id — Update group
 */
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const group = db.prepare('SELECT * FROM peer_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ ok: false, error: req.t('error.peer_groups.not_found') });
    }

    const { name, color, description } = req.body;
    if (name !== undefined && (!name || !name.trim())) {
      return res.status(400).json({ ok: false, error: req.t('error.peer_groups.name_required') });
    }

    if (name && name.trim() !== group.name) {
      const dup = db.prepare('SELECT id FROM peer_groups WHERE name = ? AND id != ?').get(sanitize(name.trim()), req.params.id);
      if (dup) {
        return res.status(409).json({ ok: false, error: req.t('error.peer_groups.name_exists') });
      }
    }

    db.prepare(`
      UPDATE peer_groups SET
        name = COALESCE(?, name),
        color = COALESCE(?, color),
        description = COALESCE(?, description)
      WHERE id = ?
    `).run(
      name !== undefined ? sanitize(name.trim()) : null,
      color !== undefined ? sanitize(color) : null,
      description !== undefined ? sanitize(description) : null,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM peer_groups WHERE id = ?').get(req.params.id);
    res.json({ ok: true, group: updated });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update peer group');
    res.status(500).json({ ok: false, error: req.t('error.peer_groups.update') });
  }
});

/**
 * DELETE /api/peer-groups/:id — Delete group (set peers' group_id to null)
 */
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const group = db.prepare('SELECT * FROM peer_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ ok: false, error: req.t('error.peer_groups.not_found') });
    }

    db.prepare('UPDATE peers SET group_id = NULL WHERE group_id = ?').run(req.params.id);
    db.prepare('DELETE FROM peer_groups WHERE id = ?').run(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete peer group');
    res.status(500).json({ ok: false, error: req.t('error.peer_groups.delete') });
  }
});

module.exports = router;
