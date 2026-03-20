'use strict';

const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

// In-memory cache for geo lookups: ip → { countryCode, expiresAt }
const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const GEO_CACHE_MAX = 10000;

/**
 * Parse an IPv4 address to a 32-bit number
 */
function ipToNum(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Check if an IP matches a CIDR range (e.g. 10.0.0.0/24)
 */
function matchesCidr(ip, cidr) {
  const [rangeIp, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipToNum(ip) & mask) === (ipToNum(rangeIp) & mask);
}

/**
 * Lookup country code for an IP using ip2location.io API
 */
async function lookupCountry(ip) {
  // Check cache first
  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.countryCode;
  }

  const apiKey = settings.get('ip2location.api_key', '');
  if (!apiKey) {
    logger.warn('ip2location API key not configured, skipping country lookup');
    return null;
  }

  try {
    const url = `https://api.ip2location.io/?key=${encodeURIComponent(apiKey)}&ip=${encodeURIComponent(ip)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      logger.warn({ status: res.status, ip }, 'ip2location API error');
      return null;
    }
    const data = await res.json();
    const countryCode = data.country_code || null;

    // Cache the result
    if (countryCode) {
      // Evict oldest entries if cache is full
      if (geoCache.size >= GEO_CACHE_MAX) {
        const firstKey = geoCache.keys().next().value;
        geoCache.delete(firstKey);
      }
      geoCache.set(ip, { countryCode, expiresAt: Date.now() + GEO_CACHE_TTL });
    }

    return countryCode;
  } catch (err) {
    logger.warn({ err: err.message, ip }, 'ip2location lookup failed');
    return null;
  }
}

/**
 * Check if a client IP is allowed to access a route based on its IP filter rules
 * @returns {{ allowed: boolean, reason: string }}
 */
async function checkAccess(routeId, clientIp) {
  const db = getDb();
  const route = db.prepare('SELECT ip_filter_enabled, ip_filter_mode, ip_filter_rules FROM routes WHERE id = ?').get(routeId);

  if (!route || !route.ip_filter_enabled) {
    return { allowed: true, reason: 'no_filter' };
  }

  const mode = route.ip_filter_mode; // 'whitelist' or 'blacklist'
  let rules;
  try {
    rules = JSON.parse(route.ip_filter_rules || '[]');
  } catch {
    return { allowed: true, reason: 'invalid_rules' };
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    return { allowed: true, reason: 'no_rules' };
  }

  // Strip IPv6-mapped IPv4 prefix
  let ip = clientIp;
  if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);

  let matchFound = false;

  for (const rule of rules) {
    let matches = false;

    if (rule.type === 'ip') {
      matches = ip === rule.value;
    } else if (rule.type === 'cidr') {
      matches = matchesCidr(ip, rule.value);
    } else if (rule.type === 'country') {
      const country = await lookupCountry(ip);
      matches = country && country.toUpperCase() === rule.value.toUpperCase();
    }

    if (matches) {
      matchFound = true;
      break;
    }
  }

  if (mode === 'whitelist') {
    return matchFound
      ? { allowed: true, reason: 'whitelisted' }
      : { allowed: false, reason: 'not_whitelisted' };
  } else {
    // blacklist
    return matchFound
      ? { allowed: false, reason: 'blacklisted' }
      : { allowed: true, reason: 'not_blacklisted' };
  }
}

/**
 * Test ip2location API with a given IP
 */
async function testLookup(ip) {
  const apiKey = settings.get('ip2location.api_key', '');
  if (!apiKey) throw new Error('API key not configured');

  const url = `https://api.ip2location.io/?key=${encodeURIComponent(apiKey)}&ip=${encodeURIComponent(ip)}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

module.exports = {
  checkAccess,
  lookupCountry,
  testLookup,
  matchesCidr,
};
