'use strict';

const config = require('../config/default');
const { validateConfig } = require('../config/validate');
const logger = require('./utils/logger');
const { runMigrations } = require('./db/migrations');
const { seedAdminUser } = require('./db/seed');
const { createApp } = require('./app');
const { startCollector, stopCollector } = require('./services/traffic');
const { startPoller, stopPoller } = require('./services/peerStatus');
const { startSessionCleanup, stopSessionCleanup } = require('./services/routeAuth');
const { startMonitor, stopMonitor } = require('./services/monitor');
const activity = require('./services/activity');

let server;

async function start() {
  // Validate configuration
  validateConfig();

  logger.info({ name: config.app.name, version: require('../package.json').version }, 'Starting application');

  // Initialize database
  runMigrations();
  await seedAdminUser();

  // Create and start Express app
  const app = createApp();

  server = app.listen(config.app.port, config.app.host, () => {
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
    startSessionCleanup();  // Route auth session cleanup every 15 min
    startMonitor();         // Uptime monitoring checks

    // Periodic cleanup (every 6 hours)
    setInterval(() => {
      try {
        const { cleanup: cleanTraffic } = require('./services/traffic');
        cleanTraffic(30);  // Keep 30 days of traffic data
        activity.cleanup(30);  // Keep 30 days of activity logs
        const { cleanup: cleanLoginAttempts } = require('./services/lockout');
        cleanLoginAttempts(1);  // Keep 1 day of login attempts
      } catch (err) {
        logger.error({ error: err.message }, 'Cleanup task failed');
      }
    }, 6 * 60 * 60 * 1000);

    // Periodic alert checks (every hour)
    setInterval(async () => {
      try {
        const settingsSvc = require('./services/settings');

        // Backup reminder
        const backupDays = parseInt(settingsSvc.get('alerts.backup_reminder_days', '0'), 10);
        if (backupDays > 0) {
          const { getDb } = require('./db/connection');
          const db = getDb();
          const lastBackup = db.prepare("SELECT created_at FROM activity_log WHERE event_type = 'backup_created' ORDER BY created_at DESC LIMIT 1").get();
          const daysSince = lastBackup
            ? Math.floor((Date.now() - new Date(lastBackup.created_at + 'Z').getTime()) / 86400000)
            : 999;
          if (daysSince >= backupDays) {
            activity.log('backup_reminder', `No backup in ${daysSince} days (threshold: ${backupDays})`, {
              source: 'system', severity: 'warning',
            });
          }
        }

        // Resource alerts
        const cpuThreshold = parseInt(settingsSvc.get('alerts.resource_cpu_threshold', '0'), 10);
        const ramThreshold = parseInt(settingsSvc.get('alerts.resource_ram_threshold', '0'), 10);
        if (cpuThreshold > 0 || ramThreshold > 0) {
          const system = require('./services/system');
          const res = await system.getResources();
          if (cpuThreshold > 0 && res.cpu.percent > cpuThreshold) {
            activity.log('resource_alert', `CPU usage ${res.cpu.percent}% exceeds threshold ${cpuThreshold}%`, {
              source: 'system', severity: 'warning', details: { cpu: res.cpu.percent, threshold: cpuThreshold },
            });
          }
          if (ramThreshold > 0 && res.memory.percent > ramThreshold) {
            activity.log('resource_alert', `RAM usage ${res.memory.percent}% exceeds threshold ${ramThreshold}%`, {
              source: 'system', severity: 'warning', details: { ram: res.memory.percent, threshold: ramThreshold },
            });
          }
        }
      } catch (err) {
        logger.error({ error: err.message }, 'Periodic alert check failed');
      }
    }, 60 * 60 * 1000); // Every hour

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
  logger.info(`${signal} received, shutting down gracefully`);
  stopCollector();
  stopPoller();
  stopSessionCleanup();
  stopMonitor();

  const closeAndExit = () => {
    const { closeDb } = require('./db/connection');
    closeDb();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  if (server) {
    server.close(closeAndExit);
    // Force exit after 10s if connections don't close
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      closeAndExit();
    }, 10000);
  } else {
    closeAndExit();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
