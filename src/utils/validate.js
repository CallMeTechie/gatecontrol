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

// True only for RFC1918 private IPv4 (10/8, 172.16–31/12, 192.168/16).
// Deliberately excludes loopback (127/8) and 0.0.0.0 — those are not valid
// LAN forwarding targets and must not be trusted from a heartbeat.
function isPrivateIpv4(ip) {
  // validateIp returns an error STRING for invalid input, null when valid.
  // A truthy return therefore means "invalid format" → not a private IP.
  if (validateIp(ip)) return false;
  const [a, b] = ip.trim().split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// A loopback target_lan_host is host-relative — only meaningful on the gateway
// that actually serves the request. Covers 127.0.0.0/8 + the textual names.
const _LOOPBACK_NAMES = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);
function isLoopbackHost(h) {
  if (!h) return false;
  const s = String(h).trim().toLowerCase();
  if (_LOOPBACK_NAMES.has(s)) return true;
  // 127.0.0.0/8 — require a well-formed IPv4 (valid octets), like isPrivateIpv4.
  return s.startsWith('127.') && !validateIp(s);
}

function validatePort(port) {
  const num = typeof port === 'string' ? parseInt(port, 10) : port;
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return 'Port must be between 1 and 65535';
  }
  return null;
}

// A gateway route's LAN forwarding host must be a plain hostname or IP. It is
// interpolated into the X-Gateway-Target proxy header, and Caddy expands any
// {…} placeholder token (e.g. {env.GC_ENCRYPTION_KEY}) in header values at
// request time — so a placeholder here would exfiltrate server state to the
// gateway companion. Reject braces (and anything outside a host/IP charset)
// outright. Optional field: empty/undefined is allowed.
function validateLanHost(host) {
  if (host == null || host === '') return null;
  if (typeof host !== 'string') return 'LAN host must be a string';
  const trimmed = host.trim();
  if (trimmed.length > 253) return 'LAN host too long (max 253 chars)';
  // Allowlist: letters, digits, dot, hyphen, underscore (NetBIOS names) and
  // colon (IPv6). Excludes braces, spaces, slashes and every other metachar.
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return 'Invalid LAN host format';
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
  validateLanHost,
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
  isPrivateIpv4,
  isLoopbackHost,
};
