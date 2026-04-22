'use strict';

const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');

// Tag-name constraints — rejected up-front so bad tokens can never enter
// either the registry table or any peer's CSV through the admin UI.
const MAX_NAME_LEN = 64;
// Disallow characters that break CSV parsing (comma), HTML (< > "), or
// trip newlines into payloads.
const INVALID_CHARS_RE = /[,<>"\n\r\t]/;

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function validateName(name) {
  if (!name) throw new Error('name required');
  if (name.length > MAX_NAME_LEN) throw new Error('name too long');
  if (INVALID_CHARS_RE.test(name)) throw new Error('name contains invalid characters');
  return name;
}

/**
 * Split a peer's CSV tag string into individual trimmed tokens, preserving
 * original casing for display but de-duplicating case-insensitively.
 */
function splitCsv(csv) {
  if (!csv) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(csv).split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * List all known tags with usage counts. Merges two sources of truth:
 *   - the `tags` registry table (admin-curated, may include orphans)
 *   - the union of distinct tokens from every peer's CSV `tags` column
 *
 * Returns entries shaped as
 *   { id: number | null, name: string, peer_count: number, registered: boolean }
 * sorted by name (case-insensitive). `id` is null when a tag appears on
 * peers but isn't in the registry yet.
 */
function list() {
  const db = getDb();

  const registry = db.prepare('SELECT id, name FROM tags').all();
  const peerRows = db.prepare('SELECT tags FROM peers WHERE tags IS NOT NULL AND tags != \'\'').all();

  // Tally peer counts per normalized tag name.
  const peerCounts = new Map(); // key=lowercase → { name (first-seen), count }
  for (const row of peerRows) {
    for (const token of splitCsv(row.tags)) {
      const key = token.toLowerCase();
      const entry = peerCounts.get(key) || { name: token, count: 0 };
      entry.count++;
      peerCounts.set(key, entry);
    }
  }

  const merged = new Map();
  for (const r of registry) {
    const key = r.name.toLowerCase();
    const usage = peerCounts.get(key);
    merged.set(key, {
      id: r.id,
      name: r.name,
      peer_count: usage ? usage.count : 0,
      registered: true,
    });
  }
  for (const [key, entry] of peerCounts) {
    if (merged.has(key)) continue;
    merged.set(key, {
      id: null,
      name: entry.name,
      peer_count: entry.count,
      registered: false,
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

/**
 * Register a tag by name. Idempotent — reusing an existing name (any case)
 * returns the existing row without error. Throws on invalid input.
 */
function create(rawName) {
  const name = validateName(normalizeName(rawName));
  const db = getDb();

  // INSERT OR IGNORE is the simplest path; then fetch (either existing row
  // or the one we just inserted) to return the canonical record.
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
  const row = db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name);

  activity.log('tag_created', `Tag "${name}" created`, {
    source: 'admin',
    severity: 'info',
    details: { tag: row.name },
  });

  const usage = list().find((t) => t.name.toLowerCase() === row.name.toLowerCase());
  return usage || { id: row.id, name: row.name, peer_count: 0, registered: true };
}

/**
 * Remove a tag everywhere: drop from the registry AND strip the token from
 * every peer's CSV. Returns a summary of the work done.
 *
 * The LIKE pre-filter narrows the peer rows we have to parse in JS, but the
 * decisive comparison is token-based (case-insensitive, whole-token) so a
 * peer with tag "production-backup" isn't affected when removing "prod".
 */
function remove(rawName) {
  const name = validateName(normalizeName(rawName));
  const db = getDb();

  const removedRegistry = db.prepare('DELETE FROM tags WHERE name = ? COLLATE NOCASE').run(name).changes > 0;

  const likePattern = '%' + name.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const candidates = db.prepare(
    "SELECT id, tags FROM peers WHERE tags LIKE ? ESCAPE '\\\\'"
  ).all(likePattern);

  const update = db.prepare('UPDATE peers SET tags = ? WHERE id = ?');
  let peersAffected = 0;
  const nameLower = name.toLowerCase();

  const tx = db.transaction(() => {
    for (const p of candidates) {
      const tokens = splitCsv(p.tags);
      const filtered = tokens.filter((t) => t.toLowerCase() !== nameLower);
      if (filtered.length !== tokens.length) {
        update.run(filtered.join(', '), p.id);
        peersAffected++;
      }
    }
  });
  tx();

  if (removedRegistry || peersAffected > 0) {
    activity.log('tag_deleted', `Tag "${name}" deleted (${peersAffected} peer(s) affected)`, {
      source: 'admin',
      severity: 'info',
      details: { tag: name, peers_affected: peersAffected, removed_from_registry: removedRegistry },
    });
  }

  return {
    removed_from_registry: removedRegistry,
    peers_affected: peersAffected,
  };
}

module.exports = {
  list,
  create,
  remove,
  // Exported for tests; not part of the service's normal surface.
  _splitCsv: splitCsv,
  _validateName: validateName,
};
