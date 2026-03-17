'use strict';

const logger = require('./logger');

function asyncHandler(fn, errorKey) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      logger.error({ error: err.message, path: req.path }, `Failed: ${errorKey}`);
      if (req.path.startsWith('/api/')) {
        return res.status(500).json({ ok: false, error: req.t(errorKey) });
      }
      next(err);
    }
  };
}

module.exports = asyncHandler;
