'use strict';

const { Router } = require('express');
const tags = require('../../services/tags');
const logger = require('../../utils/logger');

const router = Router();

/**
 * GET /api/tags — list all tags (registry + in-use) with peer counts.
 */
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, tags: tags.list() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list tags');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.tags.list') : 'Failed to list tags' });
  }
});

/**
 * POST /api/tags — register a new tag (idempotent).
 * Body: { name: string }
 */
router.post('/', (req, res) => {
  try {
    const name = req.body && req.body.name;
    const tag = tags.create(name);
    res.status(201).json({ ok: true, tag });
  } catch (err) {
    const msg = err.message || '';
    if (/required|too long|invalid characters/i.test(msg)) {
      return res.status(400).json({ ok: false, error: msg });
    }
    logger.error({ error: err.message }, 'Failed to create tag');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.tags.create') : 'Failed to create tag' });
  }
});

/**
 * DELETE /api/tags/:name — remove a tag from the registry AND strip it
 * from every peer's CSV. Path parameter is URL-decoded before processing;
 * the service validates characters so malformed names are rejected here.
 */
router.delete('/:name', (req, res) => {
  try {
    let raw = req.params.name;
    try { raw = decodeURIComponent(raw); } catch (_) { /* keep as-is */ }
    const result = tags.remove(raw);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err.message || '';
    if (/required|too long|invalid characters/i.test(msg)) {
      return res.status(400).json({ ok: false, error: msg });
    }
    logger.error({ error: err.message }, 'Failed to delete tag');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.tags.delete') : 'Failed to delete tag' });
  }
});

module.exports = router;
