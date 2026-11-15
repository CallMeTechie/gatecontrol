'use strict';

// What the internal homeserver tells the server (docs/feature-messenger-bridges.md,
// "Messages"): the events of the rooms a bridge made for a GateControl person,
// turned into the neutral form a plugin gets — no Matrix address, no token, no
// phone number in an id.
//
//   in     appservice.js hands over one transaction (PUT /_matrix/app/v1/transactions/{txnId}):
//          `events` (timeline and state) and the ephemeral ones (typing, read receipts)
//   rooms  bridge_rooms: room id ↔ chat reference (random), the person it belongs to, the
//          network. A room belongs to exactly one person (the bridge runs with
//          split_portals); an invite for a second person into the same room is refused.
//   out    bridge_inbox: one row per neutral event, sealed with a key derived from the
//          bridges' master key (texts of other people do not lie readable in the server's
//          database or its backups). A plugin pulls and acknowledges (index.js events.pull /
//          events.ack); acknowledged rows are deleted. Typing and read receipts are never
//          written: they go out with the wake-up call and are gone when nobody listens.
//   twice  a transaction is taken once (bridge_txns keeps the last ids — the homeserver
//          sends the same id again until it got a 200); every event carries the
//          homeserver's event id, the plugin keeps it unique per chat.
//
// Whose message is it?
//   @<network>_<id>      a contact of the person (a "ghost" of the bridge) → sender.id is an HMAC of
//                        the address, sender.name the name the bridge gave it
//   @<network>bot        the bridge itself → a notice
//   @gc_<id> with fi.mau.double_puppet_source   written by the person in the messenger's own app
//                        (the bridge acts for the account, "double puppeting") → sender.self
//   @gc_<id> without it  sent by GateControl itself — the plugin has it already, skipped
//
// Files (stage 4): a picture, video, voice message, file or sticker carries `media.ref` — the file's mxc:// address
// and the person it was delivered for, sealed (the same address always gives the same ref, so a plugin can tell
// "unchanged"). The plugin hands the ref back to gc.bridges.media.fetch; the address itself never leaves this module.
// The pictures of a chat (m.room.avatar) and of a contact (avatar_url of its membership) travel the same way, as
// chat.avatar and sender.avatar / contact.avatar (null: no picture; missing: not known in this event).

const crypto = require('node:crypto');
const logger = require('../../utils/logger');
const hs = require('./hs');

const TEXT_MAX = 16000;
const NAME_MAX = 120;
const INBOX_MAX_ROWS = 50000;
const INBOX_MAX_AGE_MS = 14 * 86400000;
const TXN_KEEP = 2000;
const PULL_MAX = 200;
const DOUBLE_PUPPET = 'fi.mau.double_puppet_source';
const MEDIA_TYPES = { 'm.image': 'image', 'm.video': 'video', 'm.audio': 'audio', 'm.file': 'file', 'm.location': 'location' };
const MIME_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/;
const REF_RE = /^m[A-Za-z0-9_-]{40,700}$/;
const WAVE_MAX = 64;
const STATUS_REASONS = {
  'm.event_not_handled': 'not_handled', 'com.beeper.unsupported_event': 'unsupported', 'com.beeper.undecryptable_event': 'undecryptable',
  'm.event_too_old': 'too_old', 'm.foreign_network_error': 'network_error', 'm.no_permission': 'no_permission', 'm.bridge_unavailable': 'bridge_unavailable',
};

function db() { return require('../../db/connection').getDb(); }

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const line = (v, max) => str(v, max * 4).replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v) => str(v, TEXT_MAX).replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ serverName:string, networks:string[], key:Buffer, target:()=>({socket,token}|null), selfIds?:(userId:number, network:string)=>Promise<string[]> }} opts
 *   key      32 bytes derived from the bridges' master key: seals the inbox, makes the contact references
 *   target   the homeserver as hs.js needs it (null: not set up)
 */
function create(opts) {
  const server = reEsc(opts.serverName);
  const nets = opts.networks.map(reEsc).join('|');
  const RE_PERSON = new RegExp(`^@gc_([0-9]{1,16}):${server}$`);
  const RE_GHOST = new RegExp(`^@(${nets})_([A-Za-z0-9._=/+-]{1,200}):${server}$`);
  const RE_BOT = new RegExp(`^@(${nets})bot:${server}$`);
  const sealKey = crypto.createHmac('sha256', opts.key).update('inbox').digest();
  const refKey = crypto.createHmac('sha256', opts.key).update('refs').digest();
  const mediaKey = crypto.createHmac('sha256', opts.key).update('media').digest();

  const rooms = new Map();  // room id → row (or null: looked up, not ours)
  const info = new Map();   // room id → { kind, name, names: Map(mxid → name) } — from the room's state, memory only
  const stats = { transactions: 0, events: 0, skipped: 0, lastAt: null, failed: 0 };
  const failing = new Map(); // txn id → tries (a transaction that keeps failing is dropped after a few)

  // ─── small things ──────────────────────────────────────

  function seal(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  function open(s) {
    try {
      const b = Buffer.from(String(s), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', sealKey, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
    } catch { return null; }
  }
  /** The reference of a contact: stable per network and address, says nothing about the address. */
  function contactRef(network, mxid) {
    return 'c' + crypto.createHmac('sha256', refKey).update(`${network}\0${mxid}`).digest('base64url').slice(0, 21);
  }
  /**
   * The reference of a file for one person: sealed (AES-256-GCM) with a nonce derived from its content — the same
   * file for the same person gives the same reference, nothing else can be read from it.
   */
  function mediaRef(userId, mxc) {
    const plain = Buffer.from(`${userId}\n${mxc}`, 'utf8');
    const iv = crypto.createHmac('sha256', mediaKey).update(plain).digest().subarray(0, 12);
    const c = crypto.createCipheriv('aes-256-gcm', mediaKey, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return 'm' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }
  /** → { userId, mxc } of a reference made here, or null. */
  function openMediaRef(ref) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return null;
    try {
      const b = Buffer.from(ref.slice(1), 'base64url');
      const d = crypto.createDecipheriv('aes-256-gcm', mediaKey, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      const [uid, mxc] = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8').split('\n');
      const userId = Number(uid);
      return Number.isSafeInteger(userId) && userId > 0 && hs.mxcOf(mxc, opts.serverName) ? { userId, mxc } : null;
    } catch { return null; }
  }
  /** A picture's mxc:// address → its reference for the person; null for none (or one of another server). */
  const pictureRef = (userId, url) => (hs.mxcOf(url, opts.serverName) ? mediaRef(userId, url) : null);
  const personOf = (mxid) => { const m = RE_PERSON.exec(String(mxid || '')); const n = m ? Number(m[1]) : 0; return Number.isSafeInteger(n) && n > 0 ? n : null; };
  const ghostOf = (mxid) => { const m = RE_GHOST.exec(String(mxid || '')); return m ? { network: m[1], id: m[2] } : null; };
  const botOf = (mxid) => { const m = RE_BOT.exec(String(mxid || '')); return m ? m[1] : null; };
  const mxidOf = (userId) => `@gc_${userId}:${opts.serverName}`;

  function roomRow(roomId) {
    if (rooms.has(roomId)) return rooms.get(roomId);
    const r = db().prepare('SELECT * FROM bridge_rooms WHERE room_id = ?').get(roomId) || null;
    if (rooms.size > 5000) rooms.clear();
    rooms.set(roomId, r);
    return r;
  }
  function saveRoom(roomId, userId, network, state, kind) {
    const now = Date.now();
    const old = roomRow(roomId);
    if (old) {
      db().prepare('UPDATE bridge_rooms SET state = ?, kind = ?, updated_at = ? WHERE room_id = ?').run(state, kind || old.kind, now, roomId);
    } else {
      db().prepare('INSERT INTO bridge_rooms (room_id, ref, user_id, network, kind, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, 'r' + crypto.randomBytes(15).toString('base64url'), userId, network, kind || 'direct', state, now, now);
    }
    rooms.delete(roomId);
    return roomRow(roomId);
  }

  /** Name and kind of a room and the names of its members, from its state (asked once per room and start). */
  async function roomInfo(row, { fresh = false } = {}) {
    if (!fresh && info.has(row.room_id)) return info.get(row.room_id);
    const target = opts.target();
    if (!target) throw new hs.HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver is not set up', 'not_running');
    const st = await hs.state(target, mxidOf(row.user_id), row.room_id);
    const i = { kind: row.kind, name: null, names: new Map(), avatars: new Map(), avatar: null, network: null };
    for (const ev of st) applyState(i, ev);
    if (info.size > 2000) info.clear();
    info.set(row.room_id, i);
    return i;
  }
  /** One state event into a room's info → what changed ('name' | 'kind' | 'avatar' | 'member' | null). */
  function applyState(i, ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
    const c = ev.content && typeof ev.content === 'object' ? ev.content : {};
    if (ev.type === 'm.room.name') {
      const n = line(c.name, NAME_MAX) || null;
      if (n === i.name) return null;
      i.name = n;
      return 'name';
    }
    if (ev.type === 'm.room.avatar') {
      const u = hs.mxcOf(c.url, opts.serverName) ? c.url : null;
      if (u === i.avatar) return null;
      i.avatar = u;
      return 'avatar';
    }
    if (ev.type === 'm.bridge' || ev.type === 'uk.half-shot.bridge') {
      const p = c.protocol && typeof c.protocol === 'object' ? c.protocol.id : null;
      if (typeof p === 'string' && opts.networks.includes(p)) i.network = p;
      const t = typeof c['com.beeper.room_type.v2'] === 'string' ? c['com.beeper.room_type.v2'] : (c['com.beeper.room_type'] === 'dm' ? 'dm' : null);
      const kind = t === 'dm' ? 'direct' : (t ? 'group' : null);
      if (!kind || kind === i.kind) return null;
      i.kind = kind;
      return 'kind';
    }
    if (ev.type === 'm.room.member' && typeof ev.state_key === 'string' && ghostOf(ev.state_key)) {
      const n = line(c.displayname, NAME_MAX) || null;
      const a = hs.mxcOf(c.avatar_url, opts.serverName) ? c.avatar_url : null;
      if (c.membership !== 'join' && c.membership !== 'invite') return null;
      if (i.names.has(ev.state_key) && i.names.get(ev.state_key) === n && (i.avatars.get(ev.state_key) || null) === a) return null;
      if (i.names.size < 5000) { i.names.set(ev.state_key, n); if (a) i.avatars.set(ev.state_key, a); else i.avatars.delete(ev.state_key); }
      return 'member';
    }
    return null;
  }

  const chatOf = (row, i) => ({ id: row.ref, kind: i ? i.kind : row.kind, name: i ? i.name : null, ...(i ? { avatar: pictureRef(row.user_id, i.avatar) } : {}) });
  const contactOf = (row, i, mxid) => ({ id: contactRef(row.network, mxid), name: (i && i.names.get(mxid)) || null, avatar: i ? pictureRef(row.user_id, i.avatars.get(mxid)) : null });

  async function senderOf(row, i, ev) {
    const c = ev.content && typeof ev.content === 'object' ? ev.content : {};
    if (personOf(ev.sender) === row.user_id) return Object.prototype.hasOwnProperty.call(c, DOUBLE_PUPPET) ? { self: true } : null;
    if (botOf(ev.sender) === row.network) return { system: true };
    const g = ghostOf(ev.sender);
    if (!g || g.network !== row.network) return null;
    // without double puppeting the bridge writes the person's own messages through the ghost of their own number
    let self = false;
    if (opts.selfIds) { try { self = (await opts.selfIds(row.user_id, row.network)).includes(g.id); } catch { self = false; } }
    if (self) return { self: true };
    return contactOf(row, i, ev.sender);
  }

  // ─── one event ─────────────────────────────────────────

  /** A timeline or state event → neutral events pushed to `out` ({ userId, network, payload }). */
  async function handlePdu(ev, out, { backlog = false } = {}) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || !hs.ROOM_RE.test(String(ev.room_id || '')) || !hs.EVENT_RE.test(String(ev.event_id || ''))) { stats.skipped++; return; }
    const c = ev.content && typeof ev.content === 'object' && !Array.isArray(ev.content) ? ev.content : {};
    const at = Number.isFinite(Number(ev.origin_server_ts)) && Number(ev.origin_server_ts) > 0 ? Math.round(Number(ev.origin_server_ts)) : Date.now();
    let row = roomRow(ev.room_id);

    // the person's own membership: an invite of a bridge is accepted, a join makes the chat known, a leave closes it
    if (ev.type === 'm.room.member' && typeof ev.state_key === 'string' && personOf(ev.state_key)) {
      if (backlog) return;
      const userId = personOf(ev.state_key);
      if (row && row.user_id !== userId) {
        // one room, one person (split_portals): a second account is not let in
        logger.warn({ userId }, 'bridges: invite into a room of another person — ignored');
        stats.skipped++;
        return;
      }
      const m = c.membership;
      if (m === 'invite') {
        const network = botOf(ev.sender) || (ghostOf(ev.sender) || {}).network || null;
        if (!network) { logger.warn({ userId }, 'bridges: invite from an account that is no bridge — ignored'); stats.skipped++; return; }
        if (row && row.state === 'joined') return;
        const target = opts.target();
        if (!target) throw new hs.HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver is not set up', 'not_running');
        try { await hs.join(target, mxidOf(userId), ev.room_id); }
        catch (err) {
          if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') throw err;
          logger.warn({ userId, reason: err && err.reason }, 'bridges: invite not accepted');
          stats.skipped++;
          return;
        }
        row = saveRoom(ev.room_id, userId, network, 'joined');
        await opened(row, out);
        return;
      }
      if (m === 'join') {
        if (row && row.state === 'joined') return;
        if (!row) {
          // joined by the bridge itself (double puppeting): which network it is stands in the room's state
          const probe = { room_id: ev.room_id, user_id: userId, kind: 'direct', network: null };
          let i;
          try { i = await roomInfo(probe, { fresh: true }); }
          catch (err) { if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') throw err; stats.skipped++; return; }
          info.delete(ev.room_id);
          if (!i.network) { stats.skipped++; return; } // not a room of a bridge
          row = saveRoom(ev.room_id, userId, i.network, 'joined', i.kind);
        } else {
          row = saveRoom(ev.room_id, userId, row.network, 'joined');
        }
        await opened(row, out);
        return;
      }
      if ((m === 'leave' || m === 'ban') && row && row.state !== 'left') {
        row = saveRoom(ev.room_id, userId, row.network, 'left');
        info.delete(ev.room_id);
        out.push({ userId: row.user_id, network: row.network, payload: { type: 'chat', chat: chatOf(row, null), closed: true, at } });
      }
      return;
    }

    if (!row || row.state !== 'joined') { stats.skipped++; return; }
    const push = (payload) => out.push({ userId: row.user_id, network: row.network, payload: { ...payload, at } });
    let i;
    try { i = await roomInfo(row); }
    catch (err) {
      if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') throw err;
      // the account is not in the room any more
      if (err && (err.reason === 'm_forbidden' || err.reason === 'm_not_found')) { saveRoom(row.room_id, row.user_id, row.network, 'left'); info.delete(row.room_id); }
      stats.skipped++;
      return;
    }

    // state: the room's name and kind, the contacts' names
    if (typeof ev.state_key === 'string') {
      if (backlog) return;
      const changed = applyState(i, ev);
      if (changed === 'kind') row = saveRoom(row.room_id, row.user_id, row.network, 'joined', i.kind);
      if (changed === 'name' || changed === 'kind' || changed === 'avatar') push({ type: 'chat', chat: chatOf(row, i) });
      if (changed === 'member') push({ type: 'contact', chat: chatOf(row, i), contact: contactOf(row, i, ev.state_key) });
      return;
    }

    // what the bridge says about a message GateControl sent: bridged, delivered, failed (with its reason)
    if (ev.type === 'com.beeper.message_send_status') {
      if (botOf(ev.sender) !== row.network) { stats.skipped++; return; }
      const rel = c['m.relates_to'] && typeof c['m.relates_to'] === 'object' ? c['m.relates_to'] : {};
      if (!hs.EVENT_RE.test(String(rel.event_id || ''))) { stats.skipped++; return; }
      if (c.status === 'SUCCESS') push({ type: 'status', chat: chatOf(row, i), target: rel.event_id, status: Array.isArray(c.delivered_to_users) && c.delivered_to_users.length ? 'delivered' : 'sent' });
      else if (c.status === 'FAIL_RETRIABLE' || c.status === 'FAIL_PERMANENT') {
        push({ type: 'status', chat: chatOf(row, i), target: rel.event_id, status: 'failed', retriable: c.status === 'FAIL_RETRIABLE', reason: STATUS_REASONS[c.reason] || 'bridge_error' });
      }
      return;
    }

    const sender = await senderOf(row, i, ev);
    if (!sender) { stats.skipped++; return; }
    const base = { chat: chatOf(row, i), id: ev.event_id, sender };

    if (ev.type === 'm.room.redaction') {
      const target = hs.EVENT_RE.test(String(ev.redacts || '')) ? ev.redacts : (hs.EVENT_RE.test(String(c.redacts || '')) ? c.redacts : null);
      if (!target) { stats.skipped++; return; }
      push({ type: 'redact', ...base, target });
      return;
    }
    if (ev.type === 'm.reaction') {
      const rel = c['m.relates_to'] && typeof c['m.relates_to'] === 'object' ? c['m.relates_to'] : {};
      const key = str(rel.key, 64);
      if (rel.rel_type !== 'm.annotation' || !hs.EVENT_RE.test(String(rel.event_id || '')) || !key) { stats.skipped++; return; }
      push({ type: 'reaction', ...base, target: rel.event_id, emoji: key });
      return;
    }
    if (ev.type === 'm.room.message' || ev.type === 'm.sticker') {
      // redacted in the meantime (backlog): nothing left to show
      if (!Object.keys(c).length) { stats.skipped++; return; }
      const rel = c['m.relates_to'] && typeof c['m.relates_to'] === 'object' ? c['m.relates_to'] : {};
      if (rel.rel_type === 'm.replace' && hs.EVENT_RE.test(String(rel.event_id || ''))) {
        const nc = c['m.new_content'] && typeof c['m.new_content'] === 'object' ? c['m.new_content'] : c;
        push({ type: 'edit', ...base, target: rel.event_id, text: text(nc.body) });
        return;
      }
      const reply = rel['m.in_reply_to'] && typeof rel['m.in_reply_to'] === 'object' && hs.EVENT_RE.test(String(rel['m.in_reply_to'].event_id || '')) ? rel['m.in_reply_to'].event_id : null;
      const msgtype = ev.type === 'm.sticker' ? 'm.sticker' : c.msgtype;
      if (msgtype === 'm.text' || msgtype === 'm.notice' || msgtype === 'm.emote') {
        push({ type: 'message', ...base, kind: sender.system || msgtype === 'm.notice' ? 'notice' : 'text', text: text(c.body), replyTo: reply });
        return;
      }
      const mk = msgtype === 'm.sticker' ? 'sticker' : MEDIA_TYPES[msgtype];
      if (mk) {
        // the kind, the file's name and a caption; the file itself as a reference the plugin fetches (stage 4)
        const fileName = line(typeof c.filename === 'string' ? c.filename : (mk === 'location' ? '' : c.body), 200) || null;
        const caption = typeof c.filename === 'string' && c.body !== c.filename ? text(c.body) : (mk === 'location' ? text(c.body) : '');
        push({ type: 'message', ...base, kind: 'media', media: mediaOf(row, mk, c, fileName), text: caption || null, replyTo: reply });
        return;
      }
      push({ type: 'message', ...base, kind: 'unsupported', text: null, replyTo: reply });
      return;
    }
    // anything else a contact sent into the timeline (a poll, a call, …): shown as "not supported", never swallowed
    if (!sender.system && !/^m\.room\./.test(ev.type) && !/^(m|org\.matrix)\.call\./.test(ev.type)) {
      push({ type: 'message', ...base, kind: 'unsupported', text: null, replyTo: null });
      return;
    }
    stats.skipped++;
  }

  /** What a plugin learns about a file: kind, name, type, size, the picture's sides, the length; the reference to fetch it. */
  function mediaOf(row, mk, c, name) {
    const info = c.info && typeof c.info === 'object' && !Array.isArray(c.info) ? c.info : {};
    const int = (v, max) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : null; };
    const media = { kind: mk === 'audio' && c['org.matrix.msc3245.voice'] ? 'voice' : mk, name };
    if (mk === 'location') {
      // geo:<lat>,<lon>[;…] — shown as a link; there is no file
      const g = /^geo:(-?\d{1,3}(?:\.\d{1,12})?),(-?\d{1,3}(?:\.\d{1,12})?)/.exec(String(c.geo_uri || ''));
      const lat = g ? Number(g[1]) : NaN;
      const lon = g ? Number(g[2]) : NaN;
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) media.geo = { lat, lon };
      return media;
    }
    // an encrypted file (`file` instead of `url`) cannot be opened here: the rooms of the bridges are not encrypted
    if (!hs.mxcOf(c.url, opts.serverName)) return media;
    media.ref = mediaRef(row.user_id, c.url);
    const mime = String(info.mimetype || '').split(';')[0].trim().toLowerCase();
    media.mime = MIME_RE.test(mime) ? mime : null;
    media.size = int(info.size, 1e13);
    media.w = int(info.w, 100000);
    media.h = int(info.h, 100000);
    const audio = c['org.matrix.msc1767.audio'] && typeof c['org.matrix.msc1767.audio'] === 'object' ? c['org.matrix.msc1767.audio'] : {};
    media.durationMs = int(info.duration, 864e5) || int(audio.duration, 864e5);
    if (Array.isArray(audio.waveform) && audio.waveform.length) {
      // at most WAVE_MAX values 0…1024 (MSC1767), evenly picked
      const w = audio.waveform;
      const n = Math.min(WAVE_MAX, w.length);
      media.waveform = Array.from({ length: n }, (_, k) => { const v = Number(w[Math.floor((k * w.length) / n)]); return Number.isFinite(v) ? Math.max(0, Math.min(1024, Math.round(v))) : 0; });
    }
    return media;
  }

  /** A room just became the person's: its name and kind, then what was said before the account was in it. */
  async function opened(row, out) {
    const i = await roomInfo(row, { fresh: true });
    if (i.kind !== row.kind) row = saveRoom(row.room_id, row.user_id, row.network, 'joined', i.kind);
    out.push({ userId: row.user_id, network: row.network, payload: { type: 'chat', chat: chatOf(row, i), at: Date.now() } });
    let list = [];
    try { list = await hs.recent(opts.target(), mxidOf(row.user_id), row.room_id, 30); }
    catch (err) { if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') throw err; list = []; }
    for (const ev of list) {
      if (!ev || typeof ev !== 'object') continue;
      await handlePdu({ ...ev, room_id: row.room_id }, out, { backlog: true });
    }
  }

  /** Typing and read receipts → neutral, never stored. */
  function ephemeral(ev) {
    if (!ev || typeof ev !== 'object' || !hs.ROOM_RE.test(String(ev.room_id || ''))) return [];
    const row = roomRow(ev.room_id);
    if (!row || row.state !== 'joined') return [];
    const c = ev.content && typeof ev.content === 'object' ? ev.content : {};
    const out = [];
    const who = (mxid) => {
      if (personOf(mxid) === row.user_id) return { self: true };
      const g = ghostOf(mxid);
      return g && g.network === row.network ? { id: contactRef(row.network, mxid) } : null;
    };
    if (ev.type === 'm.typing') {
      const contacts = (Array.isArray(c.user_ids) ? c.user_ids : []).slice(0, 50).map(who).filter((w) => w && w.id).map((w) => w.id);
      out.push({ userId: row.user_id, network: row.network, payload: { type: 'typing', chat: { id: row.ref, kind: row.kind }, contacts } });
    } else if (ev.type === 'm.receipt') {
      for (const [eventId, kinds] of Object.entries(c).slice(0, 50)) {
        if (!hs.EVENT_RE.test(eventId) || !kinds || typeof kinds !== 'object') continue;
        const readers = kinds['m.read'] && typeof kinds['m.read'] === 'object' ? Object.keys(kinds['m.read']).slice(0, 50) : [];
        for (const mxid of readers) {
          const w = who(mxid);
          if (w) out.push({ userId: row.user_id, network: row.network, payload: { type: 'receipt', chat: { id: row.ref, kind: row.kind }, upTo: eventId, reader: w } });
        }
      }
    }
    return out;
  }

  // ─── one transaction ───────────────────────────────────

  let chain = Promise.resolve();
  /**
   * Take a transaction of the homeserver. → { stored, ephemeral: [neutral], duplicate }
   * Throws when it has to be sent again (the homeserver did not answer a question about one of its rooms).
   */
  function transaction(txnId, body) {
    const run = chain.then(() => take(txnId, body));
    chain = run.catch(() => {});
    return run;
  }
  async function take(txnId, body) {
    const id = String(txnId || '').slice(0, 200);
    if (!id) throw new hs.HsError('ERR_INVALID', 'transaction without id');
    if (db().prepare('SELECT 1 FROM bridge_txns WHERE id = ?').get(id)) return { stored: 0, ephemeral: [], duplicate: true };
    const b = body && typeof body === 'object' ? body : {};
    const pdus = Array.isArray(b.events) ? b.events.slice(0, 1000) : [];
    const edus = [...(Array.isArray(b.ephemeral) ? b.ephemeral : []), ...(Array.isArray(b['de.sorunome.msc2409.ephemeral']) ? b['de.sorunome.msc2409.ephemeral'] : [])].slice(0, 1000);
    const out = [];
    try {
      for (const ev of pdus) {
        try { await handlePdu(ev, out); }
        catch (err) {
          if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') throw err;
          stats.skipped++;
          logger.warn({ err: err && err.message }, 'bridges: an event was not understood');
        }
      }
    } catch (err) {
      // asked again by the homeserver — but not for ever: one transaction must not hold up everything behind it
      const n = (failing.get(id) || 0) + 1;
      if (failing.size > 200) failing.clear();
      failing.set(id, n);
      stats.failed++;
      if (n < 6) throw err;
      logger.error({ tries: n }, 'bridges: a transaction failed repeatedly and is dropped');
    }
    failing.delete(id);
    const now = Date.now();
    const ins = db().prepare('INSERT INTO bridge_inbox (at, user_id, network, payload) VALUES (?, ?, ?, ?)');
    db().transaction(() => {
      for (const o of out) ins.run(now, o.userId, o.network, seal(o.payload));
      db().prepare('INSERT OR IGNORE INTO bridge_txns (id, at) VALUES (?, ?)').run(id, now);
    })();
    stats.transactions++;
    stats.events += out.length;
    stats.lastAt = now;
    if (stats.transactions % 200 === 0) prune(now);
    const eph = [];
    for (const ev of edus) { try { eph.push(...ephemeral(ev)); } catch { /* not understood */ } }
    return { stored: out.length, ephemeral: eph.map((e) => ({ userId: e.userId, network: e.network, ...e.payload })), duplicate: false };
  }

  /** Old transaction ids and an inbox nobody empties. */
  function prune(now = Date.now()) {
    const d = db();
    d.prepare('DELETE FROM bridge_txns WHERE id NOT IN (SELECT id FROM bridge_txns ORDER BY at DESC, id LIMIT ?)').run(TXN_KEEP);
    const old = d.prepare('DELETE FROM bridge_inbox WHERE at < ?').run(now - INBOX_MAX_AGE_MS).changes;
    const top = d.prepare('SELECT MAX(seq) AS s FROM bridge_inbox').get().s || 0;
    const over = d.prepare('DELETE FROM bridge_inbox WHERE seq <= ?').run(top - INBOX_MAX_ROWS).changes;
    if (old + over) logger.warn({ dropped: old + over }, 'bridges: events nobody fetched were dropped');
  }

  // ─── what a plugin reads ───────────────────────────────

  /** events.pull({ after, limit }) → { events: [{ seq, userId, network, …payload }], more } */
  function pull({ after = 0, limit = 100 } = {}) {
    const a = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, PULL_MAX) : 100;
    const rows = db().prepare('SELECT seq, user_id, network, payload FROM bridge_inbox WHERE seq > ? ORDER BY seq LIMIT ?').all(a, n + 1);
    const events = [];
    for (const r of rows.slice(0, n)) {
      const p = open(r.payload);
      // a row sealed with another key (the bridges' folder was replaced): handed out as a gap, so the plugin can acknowledge it
      events.push(p && typeof p === 'object' ? { seq: r.seq, userId: r.user_id, network: r.network, ...p } : { seq: r.seq, userId: r.user_id, network: r.network, type: 'lost' });
    }
    return { events, more: rows.length > n };
  }
  /** events.ack(upTo) → { ok, pending } */
  function ack(upTo) {
    if (!Number.isSafeInteger(upTo) || upTo < 0) throw new hs.HsError('ERR_INVALID', 'upTo: a sequence number');
    db().prepare('DELETE FROM bridge_inbox WHERE seq <= ?').run(upTo);
    return { ok: true, pending: db().prepare('SELECT COUNT(*) AS n FROM bridge_inbox').get().n };
  }
  function pending() { try { return db().prepare('SELECT COUNT(*) AS n FROM bridge_inbox').get().n; } catch { return 0; } }

  /** The room of a person's chat (joined), or null. */
  function roomOf(userId, network, chatId) {
    if (typeof chatId !== 'string' || !/^r[A-Za-z0-9_-]{20}$/.test(chatId)) return null;
    const r = db().prepare('SELECT * FROM bridge_rooms WHERE ref = ?').get(chatId);
    return r && r.user_id === userId && r.network === network ? r : null;
  }
  /** chats(userId, network) → [{ id, kind, open }] */
  function chats(userId, network) {
    return db().prepare('SELECT ref, kind, state FROM bridge_rooms WHERE user_id = ? AND network = ? ORDER BY created_at').all(userId, network)
      .map((r) => ({ id: r.ref, kind: r.kind, open: r.state === 'joined' }));
  }

  /**
   * A room the bridge made for the person right now (a new chat by number, createDm): known before its invite or
   * join arrives, so the plugin has the chat at once; the join fills in name and kind. → the row
   */
  function adopt(userId, network, roomId) {
    if (!hs.ROOM_RE.test(String(roomId || ''))) throw new hs.HsError('ERR_BRIDGE', 'the bridge named no room', 'bad_answer');
    const row = roomRow(roomId);
    if (row) {
      if (row.user_id !== userId || row.network !== network) throw new hs.HsError('ERR_BRIDGE', 'the room belongs to another person', 'bad_answer');
      return row;
    }
    return saveRoom(roomId, userId, network, 'invited', 'direct');
  }

  return { transaction, pull, ack, pending, roomOf, chats, prune, stats, mxidOf, contactRef, mediaRef, openMediaRef, adopt, _handlePdu: handlePdu, _ephemeral: ephemeral, _forget: () => { rooms.clear(); info.clear(); } };
}

module.exports = { create, TEXT_MAX, PULL_MAX, REF_RE };
