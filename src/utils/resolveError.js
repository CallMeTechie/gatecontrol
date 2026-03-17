'use strict';

function resolveError(req, err, errorMap, fallbackKey) {
  const msg = err.message || '';
  for (const [pattern, key] of Object.entries(errorMap)) {
    if (msg.includes(pattern)) {
      return { status: pattern === 'not found' ? 404 : 400, error: req.t(key) };
    }
  }
  return { status: 500, error: req.t(fallbackKey) };
}

module.exports = resolveError;
