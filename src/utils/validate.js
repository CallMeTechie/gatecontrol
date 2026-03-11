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

function sanitize(str) {
  if (!str) return '';
  return String(str).trim();
}

module.exports = {
  validatePeerName,
  validateDomain,
  validateIp,
  validatePort,
  validateDescription,
  validateBasicAuthUser,
  validateBasicAuthPassword,
  sanitize,
};
