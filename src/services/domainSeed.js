// src/services/domainSeed.js
'use strict';

function normalizeHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Last-two-labels registrable host. 'a.b.example.com' -> 'example.com', apex -> itself. */
function baseDomain(host) {
  const h = normalizeHost(host).replace(/^\*\./, '');
  if (!h || h.startsWith('*')) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(-2).join('.');
}

function extractBaseDomains(routeDomains) {
  const set = new Set();
  for (const d of routeDomains || []) {
    const b = baseDomain(d);
    if (b) set.add(b);
  }
  return [...set];
}

function shouldFlagServerIp(results) {
  const r = results || [];
  if (r.length < 2) return false;
  return r.every(x => !x.matched);
}

module.exports = { normalizeHost, baseDomain, extractBaseDomains, shouldFlagServerIp };
