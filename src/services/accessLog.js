'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const config = require('../../config/default');

const LOG_FILE = path.join(config.caddy.dataDir, 'access.log');

/**
 * Read the last N access log entries from Caddy's JSON log file
 */
async function getRecent(limit = 50, filters = {}) {
  if (!fs.existsSync(LOG_FILE)) return { entries: [], total: 0 };

  const lines = [];
  const stream = fs.createReadStream(LOG_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      lines.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  // Newest first
  lines.reverse();

  // Apply filters
  let filtered = lines;

  if (filters.domain) {
    const d = filters.domain.toLowerCase();
    filtered = filtered.filter(e => e.request && e.request.host && e.request.host.toLowerCase().includes(d));
  }

  if (filters.status) {
    const s = parseInt(filters.status, 10);
    if (s >= 100) {
      // Filter by status class (2xx, 3xx, 4xx, 5xx)
      const cls = Math.floor(s / 100);
      filtered = filtered.filter(e => Math.floor(e.status / 100) === cls);
    }
  }

  if (filters.method) {
    const m = filters.method.toUpperCase();
    filtered = filtered.filter(e => e.request && e.request.method === m);
  }

  const total = filtered.length;
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const offset = (page - 1) * limit;
  const paged = filtered.slice(offset, offset + limit);

  const entries = paged.map(e => ({
    timestamp: e.ts ? new Date(e.ts * 1000).toISOString() : null,
    method: e.request ? e.request.method : '',
    host: e.request ? e.request.host : '',
    uri: e.request ? e.request.uri : '',
    status: e.status || 0,
    duration: e.duration != null ? Math.round(e.duration * 1000) : 0, // ms
    size: e.size || 0,
    remote_ip: e.request ? e.request.remote_ip : '',
    proto: e.request ? e.request.proto : '',
    user_agent: e.request && e.request.headers ? (e.request.headers['User-Agent'] || [''])[0] : '',
  }));

  return {
    entries,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

module.exports = { getRecent };
