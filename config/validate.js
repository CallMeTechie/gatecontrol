'use strict';

const config = require('./default');

const CIDR_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIp(ip) {
  const m = ip.match(IPV4_REGEX);
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every(o => Number(o) <= 255);
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function isValidCidr(str) {
  if (!CIDR_REGEX.test(str)) return false;
  const [ip, prefix] = str.split('/');
  return isValidIp(ip) && Number(prefix) >= 0 && Number(prefix) <= 32;
}

/**
 * Validate configuration on startup. Throws on first error.
 */
function validateConfig() {
  const errors = [];

  // App
  if (!isValidPort(config.app.port)) {
    errors.push(`GC_PORT: "${config.app.port}" is not a valid port (1-65535)`);
  }
  if (config.app.baseUrl && !isValidUrl(config.app.baseUrl)) {
    errors.push(`GC_BASE_URL: "${config.app.baseUrl}" is not a valid URL`);
  }
  if (!['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(config.app.logLevel)) {
    errors.push(`GC_LOG_LEVEL: "${config.app.logLevel}" is not valid (silent|fatal|error|warn|info|debug|trace)`);
  }

  // WireGuard
  if (!isValidCidr(config.wireguard.subnet)) {
    errors.push(`GC_WG_SUBNET: "${config.wireguard.subnet}" is not a valid CIDR (e.g. 10.8.0.0/24)`);
  }
  if (!isValidIp(config.wireguard.gatewayIp)) {
    errors.push(`GC_WG_GATEWAY_IP: "${config.wireguard.gatewayIp}" is not a valid IP address`);
  }
  if (!isValidPort(config.wireguard.port)) {
    errors.push(`GC_WG_PORT: "${config.wireguard.port}" is not a valid port (1-65535)`);
  }
  for (const dns of config.wireguard.dns) {
    if (!isValidIp(dns)) {
      errors.push(`GC_WG_DNS: "${dns}" is not a valid IP address`);
    }
  }
  if (config.wireguard.persistentKeepalive < 0 || config.wireguard.persistentKeepalive > 65535) {
    errors.push(`GC_WG_PERSISTENT_KEEPALIVE: "${config.wireguard.persistentKeepalive}" must be 0-65535`);
  }
  if (config.wireguard.mtu && (isNaN(Number(config.wireguard.mtu)) || Number(config.wireguard.mtu) < 576 || Number(config.wireguard.mtu) > 9000)) {
    errors.push(`GC_WG_MTU: "${config.wireguard.mtu}" must be 576-9000 or empty`);
  }

  // Caddy
  if (!isValidUrl(config.caddy.adminUrl)) {
    errors.push(`GC_CADDY_ADMIN_URL: "${config.caddy.adminUrl}" is not a valid URL`);
  }
  if (config.caddy.email && !config.caddy.email.includes('@')) {
    errors.push(`GC_CADDY_EMAIL: "${config.caddy.email}" is not a valid email`);
  }

  // Auth
  if (config.auth.rateLimitLogin < 1) {
    errors.push(`GC_RATE_LIMIT_LOGIN: must be at least 1`);
  }
  if (config.auth.rateLimitApi < 1) {
    errors.push(`GC_RATE_LIMIT_API: must be at least 1`);
  }
  if (config.auth.sessionMaxAge < 60000) {
    errors.push(`GC_SESSION_MAX_AGE: must be at least 60000 (1 minute)`);
  }

  // i18n
  if (!config.i18n.availableLanguages.includes(config.i18n.defaultLanguage)) {
    errors.push(`GC_DEFAULT_LANGUAGE: "${config.i18n.defaultLanguage}" is not in available languages (${config.i18n.availableLanguages.join(', ')})`);
  }

  if (errors.length > 0) {
    throw new Error('Configuration errors:\n  - ' + errors.join('\n  - '));
  }
}

module.exports = { validateConfig };
