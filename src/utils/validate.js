'use strict';

const PEER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/;
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validatePeerName(name) {
  if (!name || typeof name !== 'string') return 'Peer name is required';
  const trimmed = name.trim();
  if (!PEER_NAME_RE.test(trimmed)) {
    return 'Peer name must be alphanumeric (spaces, dots, hyphens, underscores allowed), 1-63 chars';
  }
  return null;
}

function validateDomain(domain) {
  if (!domain || typeof domain !== 'string') return 'Domain is required';
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.length > 253) return 'Domain too long (max 253 chars)';
  if (!DOMAIN_RE.test(trimmed)) return 'Invalid domain format';
  return null;
}

function validateIp(ip) {
  if (!ip || typeof ip !== 'string') return 'IP address is required';
  const trimmed = ip.trim();
  if (!IP_RE.test(trimmed)) return 'Invalid IP address format';
  const parts = trimmed.split('.').map(Number);
  if (parts.some(p => p > 255)) return 'Invalid IP address (octets must be 0-255)';
  return null;
}

function validatePort(port) {
  const num = typeof port === 'string' ? parseInt(port, 10) : port;
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return 'Port must be between 1 and 65535';
  }
  return null;
}

function validateDescription(desc) {
  if (!desc) return null; // Optional field
  if (typeof desc !== 'string') return 'Description must be a string';
  if (desc.length > 255) return 'Description too long (max 255 chars)';
  return null;
}

function validateBasicAuthUser(user) {
  if (!user || typeof user !== 'string') return 'Basic auth username is required';
  const trimmed = user.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return 'Username must be 1-64 characters';
  if (!/^[a-zA-Z0-9._@-]+$/.test(trimmed)) return 'Username contains invalid characters';
  return null;
}

function validateBasicAuthPassword(password) {
  if (!password || typeof password !== 'string') return 'Basic auth password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  return null;
}

function validateL4Protocol(protocol) {
  if (!protocol || !['tcp', 'udp'].includes(protocol)) {
    return 'L4 protocol must be tcp or udp';
  }
  return null;
}

function parsePortRange(portStr) {
  if (!portStr || typeof portStr !== 'string') return null;
  const trimmed = portStr.trim();
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start >= 1 && end <= 65535 && start <= end) return { start, end };
    return null;
  }
  const single = parseInt(trimmed, 10);
  if (!isNaN(single) && single >= 1 && single <= 65535 && String(single) === trimmed) {
    return { start: single, end: single };
  }
  return null;
}

function validateL4ListenPort(portStr) {
  const range = parsePortRange(portStr);
  if (!range) return 'Invalid port or port range';
  const config = require('../../config/default');
  const maxRange = (config.l4 && config.l4.maxPortRange) || 100;
  if (range.end - range.start + 1 > maxRange) {
    return 'Port range exceeds maximum of ' + maxRange + ' ports';
  }
  return null;
}

function validateL4TlsMode(mode) {
  if (!mode || !['none', 'passthrough', 'terminate'].includes(mode)) {
    return 'TLS mode must be none, passthrough, or terminate';
  }
  return null;
}

function isPortBlocked(port) {
  const config = require('../../config/default');
  const blocked = (config.l4 && config.l4.blockedPorts) || [80, 443, 2019, 3000, 51820];
  return blocked.includes(port);
}

const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(rgb|hsl)a?\(\s*[\d.,\s%]+\))$/;
const CSS_GRADIENT_RE = /^(linear|radial|conic)-gradient\(\s*[a-zA-Z0-9#.,\s%()deg]+\)$/;

function validateCssColor(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 120) return 'CSS color value too long (max 120 chars)';
  if (!CSS_COLOR_RE.test(trimmed)) return 'Invalid CSS color (hex, named, rgb/hsl allowed)';
  return null;
}

function validateCssBg(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 200) return 'CSS background value too long (max 200 chars)';
  if (!CSS_COLOR_RE.test(trimmed) && !CSS_GRADIENT_RE.test(trimmed)) {
    return 'Invalid CSS background (hex, named, rgb/hsl, gradient allowed)';
  }
  return null;
}

function sanitize(str) {
  if (!str) return '';
  return String(str).trim();
}

/**
 * Validate password complexity against configurable rules.
 * Reads settings from DB. Returns null if valid, or an array of error message keys.
 */
function validatePasswordComplexity(password) {
  const settings = require('../services/settings');
  const enabled = settings.get('security.password.complexity_enabled', 'false') === 'true';
  if (!enabled) return null;

  const minLength = parseInt(settings.get('security.password.min_length', '8'), 10) || 8;
  const requireUppercase = settings.get('security.password.require_uppercase', 'true') === 'true';
  const requireNumber = settings.get('security.password.require_number', 'true') === 'true';
  const requireSpecial = settings.get('security.password.require_special', 'true') === 'true';

  const errors = [];

  if (!password || password.length < minLength) {
    errors.push({ key: 'error.security.password_min_length', params: { min: minLength } });
  }
  if (requireUppercase && !/[A-Z]/.test(password)) {
    errors.push({ key: 'error.security.password_no_uppercase' });
  }
  if (requireNumber && !/[0-9]/.test(password)) {
    errors.push({ key: 'error.security.password_no_number' });
  }
  if (requireSpecial && !/[^a-zA-Z0-9]/.test(password)) {
    errors.push({ key: 'error.security.password_no_special' });
  }

  return errors.length > 0 ? errors : null;
}

module.exports = {
  validatePeerName,
  validateDomain,
  validateIp,
  validatePort,
  validateDescription,
  validateBasicAuthUser,
  validateBasicAuthPassword,
  validatePasswordComplexity,
  validateCssColor,
  validateCssBg,
  sanitize,
  validateL4Protocol,
  validateL4ListenPort,
  validateL4TlsMode,
  isPortBlocked,
  parsePortRange,
};
