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
//
// History (stage 5): with history allowed, the bridge sends older messages into a room right after it made it
// (mautrix "forward backfill", each with its own time in the past). An event is history when it is from before the
// person linked (opts.linkedAt, noted when a link completes) and older than the room is here (bridge_rooms.created_at),
// each minus a minute — the bridge's own word for it does not exist on a plain Matrix server. What the person chose decides (opts.historyOf: off, a number of days, everything): history they do
// not want is never written here; history they want goes to bridge_backlog (sealed like the inbox, marked
// `history: true`) — the plugin takes it in small portions at night (history.pull / history.ack). Order and no doubles:
// before a live event of a chat is filed, what still waits of that chat's history moves into the inbox ahead of it,
// so a chat is filled in the order the bridge sent it; the plugin keeps the event id unique per chat.
// Files of a room (stage 5): every file a message carries is noted in bridge_media (address and person, never a name);
// once the plugin took it (index.js mediaFetched), or it was history nobody wanted, or nobody fetched it for
// MEDIA_KEEP_MS, index.js deletes it from the homeserver (mediaToClean / mediaCleaned).
//
// Channels, groups, format (gc.bridges version 7, "Chats v2 – Teil A"):
//   kind      mautrix bridgev2 sets com.beeper.room_type.v2 only for a direct chat ("dm") and a space; a group and a
//             WhatsApp channel are RoomTypeDefault, the field is missing (bridgev2/portal.go getBridgeInfo,
//             mautrix-whatsapp pkg/connector/chatinfo.go wrapGroupInfo / wrapNewsletterInfo). So the kind is read from
//             the chat's own id at the bridge (m.bridge → channel.id, per network: WhatsApp …@g.us a group,
//             …@newsletter a channel, …@s.whatsapp.net / …@lid a person) — the id itself never leaves this module.
//   channel   chat.channel: a channel the person follows (kind 'group'). Its posts come from the bridge's own account
//             (pkg/connector/id.go makeEventSender: NewsletterServer → EventSender{}) — the sender is { channel: true,
//             system: true } (system for plugins of version 6) and the post a normal text or file, not a notice.
//   readOnly  chat.readOnly: the person may not write (m.room.power_levels: their level below the one of
//             m.room.message / events_default) — a channel, a group where only admins write.
//   format    `marks` and `preview` of a text (format.js; com.beeper.linkpreviews, MSC4095) — the preview's picture is
//             a file reference like any other (preview.image.ref).
//   history   a channel brings at most CHANNEL_HISTORY posts when it is opened or linked (channelTrim).
//   older     rooms known before this version get kind, channel and readOnly when their next event arrives, or by
//             refreshRooms() (index.js, a few per tick) — bridge_rooms.channel NULL = not looked at yet.

const crypto = require('node:crypto');
const logger = require('../../utils/logger');
const hs = require('./hs');
// never a phone number as a name (names.js)
const { nameOut } = require('./names');
const format = require('./format');

const TEXT_MAX = 16000;
const NAME_MAX = 120;
const INBOX_MAX_ROWS = 50000;
const INBOX_MAX_AGE_MS = 14 * 86400000;
const TXN_KEEP = 2000;
// stage 5: history
const HISTORY_SLACK_MS = 60000;
const HISTORY_TYPES = ['message', 'edit', 'reaction', 'redact'];
const BACKLOG_MAX_ROWS = 100000;
const BACKLOG_MAX_AGE_MS = 30 * 86400000;
// live events that need the chat's history in place first
const FLUSH_TYPES = ['message', 'edit', 'reaction', 'redact', 'status'];
// a file nobody fetched stays this long at the homeserver; one taken over goes after MEDIA_SETTLE_MS (another person's
// copy of the same file may still be on its way)
const MEDIA_KEEP_MS = 30 * 86400000;
const MEDIA_SETTLE_MS = 3600000;
const PULL_MAX = 200;
const DOUBLE_PUPPET = 'fi.mau.double_puppet_source';
// a channel brings at most this many posts when it is opened (or with the history at a new link)
const CHANNEL_HISTORY = 10;
const PREVIEW_TITLE_MAX = 300;
const PREVIEW_TEXT_MAX = 1000;
// what the id of a chat at the bridge (m.bridge channel.id) says about its kind, per network
const CHAT_IDS = {
  whatsapp: [[/@newsletter$/, 'channel'], [/@g\.us$/, 'group'], [/@(s\.whatsapp\.net|lid)$/, 'direct']],
};
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
  const stats = { transactions: 0, events: 0, skipped: 0, lastAt: null, failed: 0, history: 0, historyDropped: 0 };
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
  /** `i` (the room's info, when known): its kind, channel and readOnly are written with it. */
  function saveRoom(roomId, userId, network, state, kind, i = null) {
    const now = Date.now();
    const old = roomRow(roomId);
    const channel = i ? (i.channel ? 1 : 0) : (old ? old.channel : null);
    const readOnly = i ? (i.readOnly ? 1 : 0) : (old ? old.read_only : 0);
    if (old) {
      db().prepare('UPDATE bridge_rooms SET state = ?, kind = ?, channel = ?, read_only = ?, updated_at = ? WHERE room_id = ?').run(state, kind || old.kind, channel, readOnly, now, roomId);
    } else {
      db().prepare('INSERT INTO bridge_rooms (room_id, ref, user_id, network, kind, state, channel, read_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, 'r' + crypto.randomBytes(15).toString('base64url'), userId, network, kind || 'direct', state, channel, readOnly || 0, now, now);
    }
    rooms.delete(roomId);
    return roomRow(roomId);
  }
  /** Does the stored row still say what the room's state says (kind, channel, readOnly)? */
  const rowFits = (row, i) => row.kind === i.kind && row.channel === (i.channel ? 1 : 0) && row.read_only === (i.readOnly ? 1 : 0);

  /** Name and kind of a room and the names of its members, from its state (asked once per room and start). */
  async function roomInfo(row, { fresh = false } = {}) {
    if (!fresh && info.has(row.room_id)) return info.get(row.room_id);
    const target = opts.target();
    if (!target) throw new hs.HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver is not set up', 'not_running');
    const st = await hs.state(target, mxidOf(row.user_id), row.room_id);
    const i = { kind: row.kind, name: null, names: new Map(), avatars: new Map(), avatar: null, network: null, channel: false, readOnly: false, self: mxidOf(row.user_id), power: null };
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
      const n = nameOut(c.name, NAME_MAX);
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
      const t = typeof c['com.beeper.room_type.v2'] === 'string' && c['com.beeper.room_type.v2'] ? c['com.beeper.room_type.v2'] : (c['com.beeper.room_type'] === 'dm' ? 'dm' : null);
      // the chat's id at the bridge (never passed on): a group and a channel carry no room type (see above)
      const id = c.channel && typeof c.channel === 'object' && typeof c.channel.id === 'string' ? c.channel.id : '';
      const byId = ((typeof p === 'string' && CHAT_IDS[p]) || []).find(([re]) => re.test(id));
      const what = t === 'dm' ? 'direct' : (t ? 'group' : (byId ? byId[1] : null));
      const channel = what === 'channel';
      const kind = what === 'direct' ? 'direct' : (what ? 'group' : null);
      if ((!kind || kind === i.kind) && channel === i.channel) return null;
      if (kind) i.kind = kind;
      i.channel = channel;
      return 'kind';
    }
    if (ev.type === 'm.room.power_levels') {
      // may the person write? their level against the one of a message (a channel; a group where only admins write)
      const lvl = (v, d) => (Number.isSafeInteger(Number(v)) && v !== null && v !== '' ? Number(v) : d);
      const users = c.users && typeof c.users === 'object' ? c.users : {};
      const events = c.events && typeof c.events === 'object' ? c.events : {};
      const own = lvl(i.self ? users[i.self] : undefined, lvl(c.users_default, 0));
      const send = lvl(events['m.room.message'], lvl(c.events_default, 0));
      const readOnly = own < send;
      if (readOnly === i.readOnly) return null;
      i.readOnly = readOnly;
      return 'power';
    }
    if (ev.type === 'm.room.member' && typeof ev.state_key === 'string' && ghostOf(ev.state_key)) {
      const n = nameOut(c.displayname, NAME_MAX);
      const a = hs.mxcOf(c.avatar_url, opts.serverName) ? c.avatar_url : null;
      if (c.membership !== 'join' && c.membership !== 'invite') return null;
      if (i.names.has(ev.state_key) && i.names.get(ev.state_key) === n && (i.avatars.get(ev.state_key) || null) === a) return null;
      if (i.names.size < 5000) { i.names.set(ev.state_key, n); if (a) i.avatars.set(ev.state_key, a); else i.avatars.delete(ev.state_key); }
      return 'member';
    }
    return null;
  }

  // version 7: channel and readOnly whenever the room's state is known (with it, every 'chat' event carries them)
  const chatOf = (row, i) => ({ id: row.ref, kind: i ? i.kind : row.kind, name: i ? i.name : null, ...(i ? { avatar: pictureRef(row.user_id, i.avatar), channel: !!i.channel, readOnly: !!i.readOnly } : {}) });
  const contactOf = (row, i, mxid) => ({ id: contactRef(row.network, mxid), name: (i && i.names.get(mxid)) || null, avatar: i ? pictureRef(row.user_id, i.avatars.get(mxid)) : null });

  async function senderOf(row, i, ev) {
    const c = ev.content && typeof ev.content === 'object' ? ev.content : {};
    if (personOf(ev.sender) === row.user_id) return Object.prototype.hasOwnProperty.call(c, DOUBLE_PUPPET) ? { self: true } : null;
    // a channel's post comes from the bridge's own account (version 7): the channel wrote it
    if (botOf(ev.sender) === row.network) return i && i.channel ? { channel: true, system: true } : { system: true };
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
          row = saveRoom(ev.room_id, userId, i.network, 'joined', i.kind, i);
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
    // stage 5: history = from before the person linked AND older than the room is here (what they want of it decides).
    // A message that only arrives late (the bridge or the phone was away) is never history: it is newer than the link.
    const linkedAt = opts.linkedAt ? Number(opts.linkedAt(row.user_id, row.network)) || 0 : 0;
    const hist = !backlog && linkedAt > 0 && at < linkedAt - HISTORY_SLACK_MS && Number.isFinite(Number(row.created_at)) && at < Number(row.created_at) - HISTORY_SLACK_MS;
    const push = (payload, extra) => {
      const mxc = extra && extra.mxc ? extra.mxc : null;
      if (hist && HISTORY_TYPES.includes(payload.type)) {
        if (!keepHistory(row.user_id, at)) {
          stats.historyDropped++;
          if (mxc) out.push({ userId: row.user_id, network: row.network, drop: true, mxc });
          return;
        }
        stats.history++;
        out.push({ userId: row.user_id, network: row.network, payload: { ...payload, at, history: true }, mxc, channel: !!(i && i.channel) });
        return;
      }
      out.push({ userId: row.user_id, network: row.network, payload: { ...payload, at }, mxc });
    };
    let i;
    try { i = await roomInfo(row); }
    catch (err) {
      if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') throw err;
      // the account is not in the room any more
      if (err && (err.reason === 'm_forbidden' || err.reason === 'm_not_found')) { saveRoom(row.room_id, row.user_id, row.network, 'left'); info.delete(row.room_id); }
      stats.skipped++;
      return;
    }
    // a room known from before version 7 (or whose state changed while nobody listened): the plugin learns it now
    if (!backlog && !rowFits(row, i)) {
      row = saveRoom(row.room_id, row.user_id, row.network, 'joined', i.kind, i);
      push({ type: 'chat', chat: chatOf(row, i) });
    }

    // state: the room's name and kind, the contacts' names
    if (typeof ev.state_key === 'string') {
      if (backlog) return;
      const changed = applyState(i, ev);
      if (changed === 'kind' || changed === 'power') row = saveRoom(row.room_id, row.user_id, row.network, 'joined', i.kind, i);
      if (changed === 'name' || changed === 'kind' || changed === 'avatar' || changed === 'power') push({ type: 'chat', chat: chatOf(row, i) });
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
        // version 7: the new text with its format (and a new link preview, when the bridge sends one)
        const r = richOf(nc);
        const pv = previewOf(row, nc);
        push({ type: 'edit', ...base, target: rel.event_id, text: r.text, ...(r.marks ? { marks: r.marks } : {}), ...(pv ? { preview: pv.preview } : {}) }, pv && pv.mxc ? { mxc: pv.mxc } : null);
        return;
      }
      const reply = rel['m.in_reply_to'] && typeof rel['m.in_reply_to'] === 'object' && hs.EVENT_RE.test(String(rel['m.in_reply_to'].event_id || '')) ? rel['m.in_reply_to'].event_id : null;
      const msgtype = ev.type === 'm.sticker' ? 'm.sticker' : c.msgtype;
      if (msgtype === 'm.text' || msgtype === 'm.notice' || msgtype === 'm.emote') {
        // version 7: a channel's post is a text like a contact's; the format as marks, the link preview with its picture
        const r = richOf(c);
        const pv = previewOf(row, c);
        const notice = (sender.system && !sender.channel) || msgtype === 'm.notice';
        push({ type: 'message', ...base, kind: notice ? 'notice' : 'text', text: r.text, ...(r.marks ? { marks: r.marks } : {}), ...(pv ? { preview: pv.preview } : {}), replyTo: reply },
          pv && pv.mxc ? { mxc: pv.mxc } : null);
        return;
      }
      const mk = msgtype === 'm.sticker' ? 'sticker' : MEDIA_TYPES[msgtype];
      if (mk) {
        // the kind, the file's name and a caption; the file itself as a reference the plugin fetches (stage 4)
        const fileName = line(typeof c.filename === 'string' ? c.filename : (mk === 'location' ? '' : c.body), 200) || null;
        const capRich = typeof c.filename === 'string' && c.body !== c.filename ? richOf(c) : null;
        const caption = capRich ? capRich.text : (mk === 'location' ? text(c.body) : '');
        push({ type: 'message', ...base, kind: 'media', media: mediaOf(row, mk, c, fileName), text: caption || null, ...(capRich && capRich.marks && caption ? { marks: capRich.marks } : {}), replyTo: reply },
          { mxc: hs.mxcOf(c.url, opts.serverName) ? c.url : null });
        return;
      }
      push({ type: 'message', ...base, kind: 'unsupported', text: null, replyTo: reply });
      return;
    }
    // anything else a contact sent into the timeline (a poll, a call, …): shown as "not supported", never swallowed
    if ((!sender.system || sender.channel) && !/^m\.room\./.test(ev.type) && !/^(m|org\.matrix)\.call\./.test(ev.type)) {
      push({ type: 'message', ...base, kind: 'unsupported', text: null, replyTo: null });
      return;
    }
    stats.skipped++;
  }

  /** The text of a message with its format (format.js): the parsed HTML, or the plain body without marks. */
  function richOf(c) {
    if (c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string') {
      const r = format.parse(c.formatted_body, { max: TEXT_MAX });
      if (r) return { text: text(r.text), marks: r.marks.length ? r.marks : null };
    }
    return { text: text(c.body), marks: null };
  }

  /**
   * The link preview a bridge sent with a text (com.beeper.linkpreviews, MSC4095 — mautrix-whatsapp
   * pkg/msgconv/urlpreview.go convertURLPreviewToBeeper): the first one, an http(s) address only.
   * → { preview: { url, title, description, site, image: { ref, mime, w, h, size } | null }, mxc } or null
   */
  function previewOf(row, c) {
    const list = Array.isArray(c['com.beeper.linkpreviews']) ? c['com.beeper.linkpreviews'] : [];
    const p = list[0] && typeof list[0] === 'object' && !Array.isArray(list[0]) ? list[0] : null;
    if (!p) return null;
    let raw = typeof p.matched_url === 'string' && p.matched_url ? p.matched_url : (typeof p['og:url'] === 'string' ? p['og:url'] : '');
    raw = raw.trim();
    // WhatsApp names the address as it stood in the text — "www.…" without a scheme
    if (raw && !/^[a-z][a-z0-9+.-]{0,20}:/i.test(raw) && !/\s/.test(raw)) {
      try { if (new URL(`https://${raw}`).hostname.includes('.')) raw = `https://${raw}`; } catch { /* not an address */ }
    }
    const url = format.linkUrl(raw);
    if (!url) return null;
    const title = line(p['og:title'], PREVIEW_TITLE_MAX) || null;
    const description = line(p['og:description'], PREVIEW_TEXT_MAX) || null;
    let site = line(p['og:site_name'], 100) || null;
    if (!site) { try { site = new URL(url).hostname.replace(/^www\./, '') || null; } catch { site = null; } }
    const int = (v, max) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : null; };
    let image = null;
    let mxc = null;
    // an encrypted picture cannot be opened here (the rooms of the bridges are not encrypted, so there is none)
    if (hs.mxcOf(p['og:image'], opts.serverName) && !p['beeper:image:encryption']) {
      mxc = p['og:image'];
      const mime = String(p['og:image:type'] || '').split(';')[0].trim().toLowerCase();
      image = { ref: mediaRef(row.user_id, mxc), mime: MIME_RE.test(mime) ? mime : null, w: int(p['og:image:width'], 100000), h: int(p['og:image:height'], 100000), size: int(p['matrix:image:size'], 1e9) };
    }
    if (!title && !description && !image) return { preview: { url, title: null, description: null, site, image: null }, mxc: null };
    return { preview: { url, title, description, site, image }, mxc };
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

  /**
   * Does the person want this piece of history? opts.historyOf(userId) → days: 0 none, -1 everything, n the last n
   * days (counted from now). Without the option (older callers): everything.
   */
  function keepHistory(userId, at) {
    let days = -1;
    if (opts.historyOf) { try { days = Number(opts.historyOf(userId)); } catch { days = 0; } }
    if (!Number.isFinite(days) || days === 0) return false;
    return days < 0 || at >= Date.now() - days * 86400000;
  }

  /** A room just became the person's: its name and kind, then what was said before the account was in it. */
  async function opened(row, out) {
    const i = await roomInfo(row, { fresh: true });
    if (!rowFits(row, i)) row = saveRoom(row.room_id, row.user_id, row.network, 'joined', i.kind, i);
    out.push({ userId: row.user_id, network: row.network, payload: { type: 'chat', chat: chatOf(row, i), at: Date.now() } });
    let list = [];
    // a channel: only its newest posts
    try { list = await hs.recent(opts.target(), mxidOf(row.user_id), row.room_id, i.channel ? CHANNEL_HISTORY : 30); }
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
    const stored = fileOut(out, now, () => db().prepare('INSERT OR IGNORE INTO bridge_txns (id, at) VALUES (?, ?)').run(id, now));
    stats.transactions++;
    stats.events += stored;
    stats.lastAt = now;
    if (stats.transactions % 200 === 0) prune(now);
    const eph = [];
    for (const ev of edus) { try { eph.push(...ephemeral(ev)); } catch { /* not understood */ } }
    return { stored, ephemeral: eph.map((e) => ({ userId: e.userId, network: e.network, ...e.payload })), duplicate: false };
  }

  /** Neutral events into the inbox (or the backlog), in one database transaction with `also()`. → rows stored */
  function fileOut(out, now, also = null) {
    const d = db();
    const ins = d.prepare('INSERT INTO bridge_inbox (at, user_id, network, payload) VALUES (?, ?, ?, ?)');
    const back = d.prepare('INSERT INTO bridge_backlog (at, user_id, network, chat, payload) VALUES (?, ?, ?, ?, ?)');
    const waits = d.prepare('SELECT 1 FROM bridge_backlog WHERE user_id = ? AND chat = ? LIMIT 1');
    const move = d.prepare('INSERT INTO bridge_inbox (at, user_id, network, payload) SELECT at, user_id, network, payload FROM bridge_backlog WHERE user_id = ? AND chat = ? ORDER BY seq');
    const moved = d.prepare('DELETE FROM bridge_backlog WHERE user_id = ? AND chat = ?');
    const file = d.prepare("INSERT INTO bridge_media (mxc, user_id, at, state) VALUES (?, ?, ?, ?) ON CONFLICT(mxc, user_id) DO NOTHING");
    let stored = 0;
    const trim = new Map(); // `${userId}\n${chat}` → [userId, chat]: a channel whose history grew
    d.transaction(() => {
      for (const o of out) {
        if (o.mxc) file.run(o.mxc, o.userId, now, o.drop ? 'drop' : 'wait');
        if (o.drop) continue;
        const chat = o.payload.chat && typeof o.payload.chat.id === 'string' ? o.payload.chat.id : null;
        if (o.payload.history && chat) {
          back.run(now, o.userId, o.network, chat, seal(o.payload));
          stored++;
          if (o.channel) trim.set(`${o.userId}\n${chat}`, [o.userId, chat]);
          continue;
        }
        // the history of this chat comes first, in the order it arrived
        if (chat && FLUSH_TYPES.includes(o.payload.type) && waits.get(o.userId, chat)) { stored += move.run(o.userId, chat).changes; moved.run(o.userId, chat); }
        ins.run(now, o.userId, o.network, seal(o.payload));
        stored++;
      }
      for (const [userId, chat] of trim.values()) channelTrim(userId, chat);
      if (also) also();
    })();
    return stored;
  }

  /**
   * A channel keeps at most CHANNEL_HISTORY posts of its history (the newest; the bridge brings up to
   * config.HISTORY.messages of every chat at a new link): older ones go — with their edits, reactions and deletions —
   * and their files are not wanted at the homeserver any more. Inside fileOut's transaction. → rows dropped
   */
  function channelTrim(userId, chat) {
    const d = db();
    const rows = d.prepare('SELECT seq, payload FROM bridge_backlog WHERE user_id = ? AND chat = ? ORDER BY seq DESC').all(userId, chat).map((r) => ({ seq: r.seq, p: open(r.payload) }));
    const kept = new Set();
    for (const r of rows) if (r.p && r.p.type === 'message' && kept.size < CHANNEL_HISTORY) kept.add(r.p.id);
    const del = d.prepare('DELETE FROM bridge_backlog WHERE seq = ?');
    const unwanted = d.prepare("UPDATE bridge_media SET state = 'drop' WHERE mxc = ? AND user_id = ? AND state = 'wait'");
    let n = 0;
    for (const r of rows) {
      const p = r.p;
      if (p && (p.type === 'message' ? kept.has(p.id) : kept.has(p.target))) continue;
      del.run(r.seq);
      n++;
      for (const ref of [p && p.media && p.media.ref, p && p.preview && p.preview.image && p.preview.image.ref]) {
        const f = ref ? openMediaRef(ref) : null;
        if (f && f.userId === userId) unwanted.run(f.mxc, userId);
      }
      stats.historyDropped++;
    }
    return n;
  }

  /**
   * Rooms known from before version 7 (bridge_rooms.channel NULL): their kind, channel and readOnly from the room's
   * state, a few at a time (index.js tick) — the plugin gets a 'chat' event for each that changed. → { looked, changed }
   */
  async function refreshRooms({ limit = 20 } = {}) {
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
    const list = db().prepare("SELECT * FROM bridge_rooms WHERE channel IS NULL AND state = 'joined' ORDER BY created_at LIMIT ?").all(n);
    const out = [];
    let looked = 0;
    for (const old of list) {
      let row = roomRow(old.room_id) || old;
      let i;
      try { i = await roomInfo(row, { fresh: true }); }
      catch (err) {
        if (err && err.code === 'ERR_BRIDGE_UNREACHABLE') break;
        // the account is not in the room any more
        if (err && (err.reason === 'm_forbidden' || err.reason === 'm_not_found')) { saveRoom(row.room_id, row.user_id, row.network, 'left'); info.delete(row.room_id); }
        else saveRoom(row.room_id, row.user_id, row.network, row.state, row.kind, { channel: false, readOnly: !!row.read_only });
        looked++;
        continue;
      }
      looked++;
      const changed = row.kind !== i.kind || !!i.channel || !!i.readOnly;
      row = saveRoom(row.room_id, row.user_id, row.network, 'joined', i.kind, i);
      if (changed) out.push({ userId: row.user_id, network: row.network, payload: { type: 'chat', chat: chatOf(row, i), at: Date.now() } });
    }
    const stored = out.length ? fileOut(out, Date.now()) : 0;
    return { looked, changed: out.length, stored };
  }

  /** Old transaction ids and an inbox nobody empties. */
  function prune(now = Date.now()) {
    const d = db();
    d.prepare('DELETE FROM bridge_txns WHERE id NOT IN (SELECT id FROM bridge_txns ORDER BY at DESC, id LIMIT ?)').run(TXN_KEEP);
    const old = d.prepare('DELETE FROM bridge_inbox WHERE at < ?').run(now - INBOX_MAX_AGE_MS).changes;
    const top = d.prepare('SELECT MAX(seq) AS s FROM bridge_inbox').get().s || 0;
    const over = d.prepare('DELETE FROM bridge_inbox WHERE seq <= ?').run(top - INBOX_MAX_ROWS).changes;
    if (old + over) logger.warn({ dropped: old + over }, 'bridges: events nobody fetched were dropped');
    // stage 5: history nobody took in a month, and the notes about files long gone
    const hOld = d.prepare('DELETE FROM bridge_backlog WHERE at < ?').run(now - BACKLOG_MAX_AGE_MS).changes;
    const hTop = d.prepare('SELECT MAX(seq) AS s FROM bridge_backlog').get().s || 0;
    const hOver = d.prepare('DELETE FROM bridge_backlog WHERE seq <= ?').run(hTop - BACKLOG_MAX_ROWS).changes;
    if (hOld + hOver) logger.warn({ dropped: hOld + hOver }, 'bridges: history nobody took was dropped');
    d.prepare('DELETE FROM bridge_media WHERE at < ?').run(now - 2 * MEDIA_KEEP_MS);
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

  // ─── history (stage 5) ─────────────────────────────────

  /** history.pull({ limit, chatId?, userId? }) → { events: [{ seq, userId, network, …payload }], more } — oldest first. */
  function historyPull({ limit = 100, chatId = null, userId = null } = {}) {
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, PULL_MAX) : 100;
    const where = [];
    const args = [];
    if (chatId != null) { if (typeof chatId !== 'string' || !/^r[A-Za-z0-9_-]{20}$/.test(chatId)) throw new hs.HsError('ERR_INVALID', 'chatId: a chat reference'); where.push('chat = ?'); args.push(chatId); }
    if (userId != null) { if (!Number.isSafeInteger(userId) || userId <= 0) throw new hs.HsError('ERR_INVALID', 'userId: a person'); where.push('user_id = ?'); args.push(userId); }
    const rows = db().prepare(`SELECT seq, user_id, network, payload FROM bridge_backlog${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY seq LIMIT ?`).all(...args, n + 1);
    const events = rows.slice(0, n).map((r) => {
      const p = open(r.payload);
      return p && typeof p === 'object' ? { seq: r.seq, userId: r.user_id, network: r.network, ...p, history: true } : { seq: r.seq, userId: r.user_id, network: r.network, type: 'lost', history: true };
    });
    return { events, more: rows.length > n };
  }
  /** history.ack(seqs) → { ok, pending } — these pieces of history are filed (or not wanted any more). */
  function historyAck(seqs) {
    if (!Array.isArray(seqs) || seqs.length > 1000 || seqs.some((x) => !Number.isSafeInteger(x) || x < 0)) throw new hs.HsError('ERR_INVALID', 'seqs: up to 1000 sequence numbers');
    const del = db().prepare('DELETE FROM bridge_backlog WHERE seq = ?');
    db().transaction(() => { for (const x of seqs) del.run(x); })();
    return { ok: true, pending: historyPending() };
  }
  function historyPending(userId) {
    try {
      return userId == null ? db().prepare('SELECT COUNT(*) AS n FROM bridge_backlog').get().n
        : db().prepare('SELECT COUNT(*) AS n FROM bridge_backlog WHERE user_id = ?').get(userId).n;
    } catch { return 0; }
  }
  /** A person changed their mind (fewer days, or none): what waits and is not wanted any more goes now. → rows dropped */
  function historyTrim(userId) {
    let n = 0;
    const del = db().prepare('DELETE FROM bridge_backlog WHERE seq = ?');
    const rows = db().prepare('SELECT seq, payload FROM bridge_backlog WHERE user_id = ?').all(userId);
    db().transaction(() => {
      for (const r of rows) {
        const p = open(r.payload);
        if (!p || !keepHistory(userId, Number(p.at) || 0)) { del.run(r.seq); n++; }
      }
    })();
    return n;
  }

  // ─── files at the homeserver (stage 5) ─────────────────

  /** A plugin took this file of the person over (or it is not wanted): it may go once nobody else waits for it. */
  function mediaFetched(userId, mxc) {
    db().prepare("UPDATE bridge_media SET state = 'done', at = ? WHERE mxc = ? AND user_id = ? AND state = 'wait'").run(Date.now(), mxc, userId);
  }
  /** Files to delete at the homeserver: everybody took theirs (an hour ago), or somebody's waited longer than MEDIA_KEEP_MS. */
  function mediaToClean(now = Date.now(), limit = 50) {
    return db().prepare(`SELECT mxc FROM bridge_media GROUP BY mxc
      HAVING MAX(at) < ? AND (SUM(CASE WHEN state = 'wait' THEN 1 ELSE 0 END) = 0 OR MAX(CASE WHEN state = 'wait' THEN at END) < ?)
      ORDER BY MIN(at) LIMIT ?`).all(now - MEDIA_SETTLE_MS, now - MEDIA_KEEP_MS, limit).map((r) => r.mxc);
  }
  function mediaCleaned(mxc) { db().prepare('DELETE FROM bridge_media WHERE mxc = ?').run(mxc); }
  function mediaWaiting() { try { return db().prepare("SELECT COUNT(DISTINCT mxc) AS n FROM bridge_media WHERE state = 'wait'").get().n; } catch { return 0; } }

  /** The room of a person's chat (joined), or null. */
  function roomOf(userId, network, chatId) {
    if (typeof chatId !== 'string' || !/^r[A-Za-z0-9_-]{20}$/.test(chatId)) return null;
    const r = db().prepare('SELECT * FROM bridge_rooms WHERE ref = ?').get(chatId);
    return r && r.user_id === userId && r.network === network ? r : null;
  }
  /** stage 4c: the chat reference of a room the bridge named for a contact — only when it is this person's. */
  function chatOfRoom(userId, network, roomId) {
    if (!hs.ROOM_RE.test(String(roomId || ''))) return null;
    const r = roomRow(roomId);
    return r && r.user_id === userId && r.network === network && r.state !== 'left' ? r.ref : null;
  }
  /** chats(userId, network) → [{ id, kind, open, channel, readOnly }] */
  function chats(userId, network) {
    return db().prepare('SELECT ref, kind, state, channel, read_only FROM bridge_rooms WHERE user_id = ? AND network = ? ORDER BY created_at').all(userId, network)
      .map((r) => ({ id: r.ref, kind: r.kind, open: r.state === 'joined', channel: r.channel === 1, readOnly: r.read_only === 1 }));
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

  return {
    transaction, pull, ack, pending, roomOf, chatOfRoom, pictureRef, chats, prune, stats, mxidOf, contactRef, mediaRef, openMediaRef, adopt, refreshRooms,
    historyPull, historyAck, historyPending, historyTrim, mediaFetched, mediaToClean, mediaCleaned, mediaWaiting, _handlePdu: handlePdu, _ephemeral: ephemeral, _forget: () => { rooms.clear(); info.clear(); } };
}

module.exports = { create, TEXT_MAX, PULL_MAX, REF_RE, HISTORY_SLACK_MS, MEDIA_KEEP_MS, MEDIA_SETTLE_MS, CHANNEL_HISTORY };
