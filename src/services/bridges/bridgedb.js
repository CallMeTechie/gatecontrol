'use strict';

// stage 7b: what a bridge knows about a chat but never writes into the homeserver (docs/feature-messenger-bridges.md,
// "Telegram"). mautrix bridgev2 keeps a chat's member count (Telegram: PortalMetadata.member_count) and whether a contact
// is a bot (ghost.is_bot) only in its own SQLite database; the homeserver sees at most 100 members of a group
// (member_list.max_initial_sync) and no bot flag (that would need ghost_extra_profile_info, which writes the contacts'
// numbers into the homeserver's profiles). So the server looks into that database — read-only, one row per question:
//
//   facts(dir, network, roomId) → { members, bot, broadcast } | null
//     members    the chat's member count as Telegram reported it (a group, a channel), else null
//     bot        a direct chat with a Telegram bot
//     broadcast  a Telegram channel (peer "channel", not a supergroup): only its admins post
//
// The file is the bridge's (<dir>/<network>/data/<network>.db, config.js database.uri), opened read-only for each
// question and closed again: the bridge writes it in WAL mode, a reader never blocks it. Nothing is written, nothing of
// it is logged or passed on beyond these three values; ids and names stay in the file. Only Telegram is asked —
// WhatsApp and Signal have nothing here the homeserver lacks. Never throws: no file, an older schema or a busy file is
// "not known" (null).

const fs = require('node:fs');
const path = require('node:path');

const NETWORKS = Object.freeze(['telegram']);
const KEEP_MS = 10 * 60000;
const ROOM_RE = /^![A-Za-z0-9._=/+-]{1,128}(:[a-z0-9.-]{1,64})?$/;
const cache = new Map(); // `${network}\n${roomId}` → { at, facts }

function fileOf(dir, network) { return path.join(dir, network, 'data', `${network}.db`); }

/** One look at the bridge's own row of this room (bridgev2 tables portal and ghost). */
function read(dir, network, roomId) {
  const file = fileOf(dir, network);
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  let d = null;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const r = d.prepare(`SELECT p.id AS id, p.metadata AS metadata, g.is_bot AS is_bot
      FROM portal p LEFT JOIN ghost g ON g.bridge_id = p.bridge_id AND g.id = p.other_user_id
      WHERE p.bridge_id = ? AND p.mxid = ? LIMIT 1`).get(network, roomId);
    if (!r) return null;
    let meta = null;
    try { meta = JSON.parse(String(r.metadata || 'null')); } catch { meta = null; }
    const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
    const n = Number(m.member_count);
    const id = String(r.id || '');
    return {
      members: Number.isSafeInteger(n) && n > 0 && n <= 10000000 ? n : null,
      bot: /^user:\d{1,20}$/.test(id) && (r.is_bot === 1 || r.is_bot === true),
      broadcast: /^channel:\d{1,20}$/.test(id) && m.is_supergroup !== true && m.is_community !== true,
    };
  } catch { return null; }
  finally { try { if (d) d.close(); } catch { /* closed */ } }
}

/** The facts of a room (kept KEEP_MS; `fresh` asks again) — null when the bridge does not know it (yet). */
function facts(dir, network, roomId, { fresh = false, now = Date.now() } = {}) {
  if (!NETWORKS.includes(network) || !ROOM_RE.test(String(roomId || ''))) return null;
  const k = `${network}\n${roomId}`;
  const c = cache.get(k);
  if (!fresh && c && now - c.at < KEEP_MS) return c.facts;
  const f = read(dir, network, roomId);
  if (cache.size > 5000) cache.clear();
  cache.set(k, { at: now, facts: f });
  return f;
}

function _reset() { cache.clear(); }

module.exports = { facts, fileOf, NETWORKS, _reset };
