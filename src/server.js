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
const { startMonitor: startRdpMonitor, stopMonitor: stopRdpMonitor } = require('./services/rdpMonitor');
const { cleanupStaleSessions: cleanupStaleRdpSessions } = require('./services/rdpSessions');
const { startScheduler: startAutoBackup, stopScheduler: stopAutoBackup } = require('./services/autobackup');
const activity = require('./services/activity');
const { validateLicense, startLicenseRefresh, stopLicenseRefresh } = require('./services/license');

let server;

async function start() {
  // Validate configuration
  validateConfig();

  logger.info({ name: config.app.name, version: require('../package.json').version }, 'Starting application');

  // Initialize database
  runMigrations();
  await seedAdminUser();

  // Validate license (never throws — falls back to Community mode internally)
  const licenseInfo = await validateLicense();
  logger.info(`License: ${licenseInfo.plan} plan`);

  // Create and start Express app
  const app = createApp();

  server = app.listen(config.app.port, config.app.host, () => {
    logger.info({
      host: config.app.host,
      port: config.app.port,
      url: config.app.baseUrl,
    }, 'Server listening');

    // Sync WireGuard config from DB on startup (ensures peers survive manual config edits)
    setTimeout(async () => {
      try {
        const { rewriteWgConfig } = require('./services/peers');
        await rewriteWgConfig();
        logger.info('WireGuard config synced from database on startup');
      } catch (err) {
        logger.warn({ error: err.message }, 'Could not sync WireGuard config on startup');
      }
    }, 2000);

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
    }, config.intervals.caddySyncDelay);

    // Start background tasks
    startCollector(config.intervals.trafficCollector);
    startPoller(config.intervals.peerPoller);
    startSessionCleanup();  // Route auth session cleanup every 15 min
    startMonitor();         // Uptime monitoring checks
    startAutoBackup();      // Automatic backup scheduler
    startLicenseRefresh();
    startRdpMonitor();     // RDP health check monitor

    // Peer expiry check (every 60 seconds)
    const { checkExpiredPeers } = require('./services/peers');
    setInterval(async () => {
      try {
        await checkExpiredPeers();
      } catch (err) {
        logger.error({ error: err.message }, 'Peer expiry check failed');
      }
    }, 60 * 1000);

    // RDP stale session cleanup (every 2 minutes)
    setInterval(() => {
      try {
        cleanupStaleRdpSessions();
      } catch (err) {
        logger.warn({ error: err.message }, 'RDP session cleanup failed');
      }
    }, 120000);

    // Periodic cleanup (every 6 hours)
    setInterval(() => {
      try {
        const settingsSvc = require('./services/settings');
        const trafficDays = parseInt(settingsSvc.get('data.retention_traffic_days', '30'), 10) || 30;
        const activityDays = parseInt(settingsSvc.get('data.retention_activity_days', '30'), 10) || 30;
        const { cleanup: cleanTraffic } = require('./services/traffic');
        cleanTraffic(trafficDays);
        activity.cleanup(activityDays);
        const { cleanup: cleanLoginAttempts } = require('./services/lockout');
        cleanLoginAttempts(1);
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

    // ─── Bot blocker counter (every 60s) ──────────────
    let lastBotCountTs = 0;
    setInterval(() => {
      try {
        const fs = require('fs');
        const logPath = '/data/caddy/access.log';
        if (!fs.existsSync(logPath)) return;

        const { getDb } = require('./db/connection');
        const db = getDb();
        const enabledRoutes = db.prepare(
          'SELECT id, domain FROM routes WHERE bot_blocker_enabled = 1'
        ).all();
        if (enabledRoutes.length === 0) return;

        const domainMap = new Map();
        for (const r of enabledRoutes) {
          domainMap.set(r.domain.toLowerCase(), r.id);
        }

        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
        const counts = new Map();

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.status !== 403) continue;
            const ts = entry.ts || 0;
            if (ts <= lastBotCountTs) continue;
            if (ts > lastBotCountTs) lastBotCountTs = ts;

            const host = (entry.request?.host || '').split(':')[0].toLowerCase();
            const routeId = domainMap.get(host);
            if (!routeId) continue;
            counts.set(routeId, (counts.get(routeId) || 0) + 1);
          } catch { /* skip */ }
        }

        const update = db.prepare(
          'UPDATE routes SET bot_blocker_count = bot_blocker_count + ? WHERE id = ?'
        );
        for (const [routeId, count] of counts) {
          update.run(count, routeId);
        }
      } catch (err) {
        require('./utils/logger').warn('Bot counter error: ' + err.message);
      }
    }, 60000);

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
  stopRdpMonitor();
  stopAutoBackup();
  stopLicenseRefresh();

  const closeAndExit = () => {
    const { closeDb } = require('./db/connection');
    closeDb();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  if (server) {
    server.close(closeAndExit);
    // Force exit if connections don't close
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      closeAndExit();
    }, config.intervals.shutdownTimeout);
  } else {
    closeAndExit();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
