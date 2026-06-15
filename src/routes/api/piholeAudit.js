'use strict';

/** Derive the audit "source" for a Pi-hole blocking change, preserving device identity. */
function blockingSource(req) {
  return req.session?.userId
    || (req.tokenPeerId ? `peer:${req.tokenPeerId}` : (req.tokenId ? `token:${req.tokenId}` : 'api'));
}

module.exports = { blockingSource };
