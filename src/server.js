'use strict';

const config = require('../config/default');
const logger = require('./utils/logger');
const { runMigrations } = require('./db/migrations');
const { seedAdminUser } = require('./db/seed');
const { createApp } = require('./app');
const { startCollector, stopCollector } = require('./services/traffic');
const { startPoller, stopPoller } = require('./services/peerStatus');
const activity = require('./services/activity');

async function start() {
  logger.info({ name: config.app.name, version: require('../package.json').version }, 'Starting application');

  // Initialize database
  runMigrations();
  await seedAdminUser();

  // Create and start Express app
  const app = createApp();

  app.listen(config.app.port, config.app.host, () => {
    logger.info({
      host: config.app.host,
      port: config.app.port,
      url: config.app.baseUrl,
    }, 'Server listening');

    // Sync routes to Caddy on startup (with delay to let Caddy start)
    setTimeout(async () => {
      try {
        const { syncToCaddy, getAll: getAllRoutes } = require('./services/routes');
        const routes = getAllRoutes();
        if (routes.length > 0) {
          await syncToCaddy();
          logger.info({ routeCount: routes.length }, 'Routes synced to Caddy on startup');
        }
      } catch (err) {
        logger.warn({ error: err.message }, 'Could not sync routes to Caddy on startup (will retry on next change)');
      }
    }, 5000);

    // Start background tasks
    startCollector(60000);  // Traffic snapshots every 60s
    startPoller(30000);     // Peer status every 30s

    // Periodic cleanup (every 6 hours)
    setInterval(() => {
      try {
        const { cleanup: cleanTraffic } = require('./services/traffic');
        cleanTraffic(30);  // Keep 30 days of traffic data
        activity.cleanup(30);  // Keep 30 days of activity logs
      } catch (err) {
        logger.error({ error: err.message }, 'Cleanup task failed');
      }
    }, 6 * 60 * 60 * 1000);

    // Log startup
    activity.log('system_start', `${config.app.name} started`, {
      source: 'system',
      severity: 'info',
    });
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  stopCollector();
  stopPoller();
  const { closeDb } = require('./db/connection');
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
