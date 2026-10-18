'use strict';

/**
 * /api/v1/client/* router — orchestrator.
 *
 * Routes are grouped into sub-router modules under ./client/ and mounted
 * here. Paths and module.exports shape stay identical to what
 * src/routes/index.js expects, so the public API (router + updateRouter)
 * is unchanged.
 *
 * Mount order matters: the description-auto-update middleware must run
 * before any sub-router handler, and sub-routers are mounted in the
 * order the original file registered them.
 */

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const { clientLabel } = require('./client/helpers');
const logger = require('../../utils/logger');
const clientUpdates = require('../../services/clientUpdates');

const router = Router();

// Remember the client version / product / platform per peer (peers list,
// version overview). Throttled inside recordClientVersion: a write only when
// something changed or the last one is older than 5 minutes.
router.use((req, res, next) => {
  if (req.tokenAuth && req.tokenPeerId) {
    clientUpdates.recordClientVersion(req.tokenPeerId, {
      version: req.headers['x-client-version'],
      product: req.headers['x-client-type'],
      platform: req.headers['x-client-platform'],
    });
  }
  next();
});

// Update peer description with current client version on every
// authenticated request. Runs at most once per 5 minutes per peer to
// avoid DB churn.
const _descriptionUpdated = new Map(); // peerId → timestamp
router.use((req, res, next) => {
  if (req.tokenAuth && req.tokenPeerId) {
    const now = Date.now();
    const lastUpdate = _descriptionUpdated.get(req.tokenPeerId) || 0;
    if (now - lastUpdate > 5 * 60 * 1000) {
      const platform = req.headers['x-client-platform'] || '';
      const version = req.headers['x-client-version'] || '';
      if (version) {
        try {
          const db = getDb();
          db.prepare('UPDATE peers SET description = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(`${clientLabel(platform)} (${platform || 'unknown'}, v${version})`, req.tokenPeerId);
          _descriptionUpdated.set(req.tokenPeerId, now);
        } catch (err) { logger.debug({ err: err.message, peerId: req.tokenPeerId }, 'updating peer description from client headers failed'); }
      }
    }
  }
  next();
});

// Sub-router mount order — preserves route-precedence from the
// pre-split monolith.
router.use(require('./client/ping'));
router.use(require('./client/peers'));
router.use(require('./client/status'));
router.use(require('./client/traffic'));
// Open a service from the apps (optional one-time auto-login on the route).
router.use(require('./client/serviceOpen'));
router.use(require('./client/rdp'));
router.use(require('./client/splitTunnel'));
router.use(require('./client/policy'));
router.use(require('./client/supportBundle'));
// One-time portal login link after connecting (routes/portal.js GET /auto).
router.use(require('./client/portalLink'));
// Trusted-network detection of the apps: is the device in the server's LAN?
router.use(require('./client/homeNetwork'));
// Notification center: ack, inbox, prefs, test (the stream itself is mounted
// in routes/index.js before the apiLimiter).
router.use(require('./client/push'));
router.use(require('./client/actions')); // plugin quick actions of the apps (shortcuts, tiles, widget)
router.use(require('./client/tiles')); // plugin Start tiles in the apps' start card
// Order of the Start / Familie tabs shared by the account (docs/feature-client-layout.md).
router.use(require('./client/layout'));
// Location sharing on tap (satellite button of the Android app).
router.use(require('./client/location'));
// Speed test of the apps' diagnosis screen (docs/feature-client-diagnosis.md).
router.use(require('./client/speedtest'));
// Own profile picture and favourite colour (docs/feature-avatars.md).
router.use(require('./client/profile'));

module.exports = router;
module.exports.updateRouter = require('./client/update');
