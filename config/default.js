'use strict';

const path = require('node:path');

function env(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  return val;
}

function envInt(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envList(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

const config = {
  app: {
    name: env('GC_APP_NAME', 'GateControl'),
    host: env('GC_HOST', '0.0.0.0'),
    port: envInt('GC_PORT', 3000),
    baseUrl: env('GC_BASE_URL', 'http://localhost:3000'),
    secret: env('GC_SECRET', ''),
    dbPath: env('GC_DB_PATH', path.join(__dirname, '..', 'data', 'gatecontrol.db')),
    logLevel: env('GC_LOG_LEVEL', 'info'),
  },

  auth: {
    adminUser: env('GC_ADMIN_USER', 'admin'),
    adminPassword: env('GC_ADMIN_PASSWORD', ''),
    sessionMaxAge: envInt('GC_SESSION_MAX_AGE', 86400000),
    rateLimitLogin: envInt('GC_RATE_LIMIT_LOGIN', 5),
    rateLimitApi: envInt('GC_RATE_LIMIT_API', 100),
  },

  wireguard: {
    interface: env('GC_WG_INTERFACE', 'wg0'),
    configPath: env('GC_WG_CONFIG_PATH', '/etc/wireguard/wg0.conf'),
    host: env('GC_WG_HOST', 'gate.example.com'),
    port: envInt('GC_WG_PORT', 51820),
    subnet: env('GC_WG_SUBNET', '10.8.0.0/24'),
    gatewayIp: env('GC_WG_GATEWAY_IP', '10.8.0.1'),
    dns: envList('GC_WG_DNS', ['1.1.1.1', '8.8.8.8']),
    allowedIps: env('GC_WG_ALLOWED_IPS', '0.0.0.0/0'),
    persistentKeepalive: envInt('GC_WG_PERSISTENT_KEEPALIVE', 25),
    postUp: env('GC_WG_POST_UP', ''),
    postDown: env('GC_WG_POST_DOWN', ''),
    mtu: env('GC_WG_MTU', ''),
  },

  caddy: {
    adminUrl: env('GC_CADDY_ADMIN_URL', 'http://127.0.0.1:2019'),
    dataDir: env('GC_CADDY_DATA_DIR', '/data/caddy'),
    email: env('GC_CADDY_EMAIL', ''),
    acmeCa: env('GC_CADDY_ACME_CA', ''),
  },

  l4: {
    blockedPorts: (process.env.GC_L4_BLOCKED_PORTS || '80,443,2019,3000,51820')
      .split(',').map(p => parseInt(p.trim(), 10)).filter(Boolean),
    maxPortRange: parseInt(process.env.GC_L4_MAX_PORT_RANGE, 10) || 100,
  },

  i18n: {
    defaultLanguage: env('GC_DEFAULT_LANGUAGE', 'en'),
    availableLanguages: envList('GC_AVAILABLE_LANGUAGES', ['en', 'de']),
  },

  theme: {
    defaultTheme: env('GC_DEFAULT_THEME', 'default'),
  },

  network: {
    interface: env('GC_NET_INTERFACE', 'eth0'),
  },

  encryption: {
    key: env('GC_ENCRYPTION_KEY', ''),
  },
};

// Fail loudly if session secret is missing — entrypoint.sh must set GC_SECRET
if (!config.app.secret) {
  throw new Error('GC_SECRET is not set. The entrypoint must generate and export a session secret.');
}

module.exports = config;
