'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

function hashToken(token) {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Express middleware: validates Bearer token against gateway_meta.api_token_hash.
 * Uses crypto.timingSafeEqual on the stored vs computed hash (defense-in-depth
 * even though DB index-lookup already filters the candidate row).
 *
 * On success: req.gateway = { peer_id, peer_name, api_port, ip_address }.
 */
function requireGateway(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  const token = header.slice(7).trim();
  if (!token.startsWith('gc_gw_')) {
    return res.status(401).json({ error: 'invalid_token_format' });
  }
  const tokenHash = hashToken(token);
  const db = getDb();
  const match = db.prepare(`
    SELECT gm.peer_id, gm.api_port, gm.api_token_hash AS stored_hash,
           p.name AS peer_name, p.allowed_ips, p.enabled
    FROM gateway_meta gm
    JOIN peers p ON p.id = gm.peer_id
    WHERE gm.api_token_hash = ? AND p.peer_type = 'gateway' AND p.enabled = 1
  `).get(tokenHash);

  if (!match) {
    logger.warn({ ip: req.ip }, 'Invalid gateway token');
    return res.status(403).json({ error: 'invalid_token' });
  }

  // Defense-in-depth: explicit timingSafeEqual on the stored vs computed hash
  // to prevent any theoretical timing side-channel from b-tree-index comparison.
  const storedBuf = Buffer.from(match.stored_hash, 'utf8');
  const computedBuf = Buffer.from(tokenHash, 'utf8');
  if (storedBuf.length !== computedBuf.length || !crypto.timingSafeEqual(storedBuf, computedBuf)) {
    logger.warn({ ip: req.ip }, 'Timing-safe compare failed — token mismatch');
    return res.status(403).json({ error: 'invalid_token' });
  }

  // Extract peer's IP from allowed_ips ("10.8.0.5/32" → "10.8.0.5")
  const ipAddress = (match.allowed_ips || '').split('/')[0];

  req.gateway = {
    peer_id: match.peer_id,
    api_port: match.api_port,
    peer_name: match.peer_name,
    ip_address: ipAddress,
  };
  next();
}

module.exports = { requireGateway, hashToken };
