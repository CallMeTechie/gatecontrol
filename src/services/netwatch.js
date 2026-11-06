'use strict';

// Network watch of a home gateway (phase 3a, contract §2): every device the
// gateway sees in its LAN (netwatch_devices, gateway × MAC), what an
// administrator made of it (name, owner, status new|known|watch, counts for
// presence) and the notification about new devices.
//
//   ingest(peerId, body)       POST /api/v1/gateway/netwatch
//   list(peerId, { q, filter }) admin API, tab "Netzwerk"
//   update(peerId, id, patch)   admin API: name, owner, status, presence
//   scan(peerId)                admin API "Jetzt scannen" → gateway POST /api/netwatch/scan
//
// The very first report of a gateway is its inventory: those devices are
// taken as known (no flood of "new device" notices when the watch is switched
// on); every MAC that shows up later is `new` until an administrator decides.
// New devices are notified to the admins (topic "Netzwerk"): at most once per
// device, collected, at most every 10 minutes per home network.
//
// Heimnetz (homeNetwork.gatewayHomes(): gateways in one failover pool, or in
// the same LAN behind the same router): the rows stay per gateway (address,
// online, ports, presence state are what THAT gateway sees), but what an
// administrator decides — name, owner, status known|watch, presence — is the
// same on every gateway of the home network:
//   - update() / remove() change every row of the MAC in the home network;
//   - a gateway seeing a MAC for the first time takes over the decisions of
//     a row of that MAC on another gateway of the home network (then it is
//     neither 'new' nor notified again);
//   - the notice "new device" goes out once per MAC and home network, even
//     when both gateways report it at the same moment (read and mark in one
//     transaction);
//   - reconcileHomes() (server start and every few minutes, gatewayOps)
//     merges rows that are already doubled — e.g. after a pool was created:
//     the row decided last (decided_at) wins; empty name / owner are taken
//     from the next row that has one; open "new" notices of a MAC that is
//     known on another gateway of the home network are done.

const { getDb } = require('../db/connection');
const kit = require('../../public/js/gateway-net-kit');
const { normMac, normTime } = require('./homePresence');
const logger = require('../utils/logger');

const MAX_DEVICES = 1024;
const MAX_PORTS = 64;
const NOTICE_GAP_MS = 10 * 60 * 1000;
const STATUSES = ['new', 'known', 'watch'];
const NAME_MAX = 80;
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i;

class NetwatchError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** Printable text without control characters, trimmed and cut — or null. */
function text(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
  return s || null;
}

// ─── Heimnetz ──────────────────────────────────────────────────────────

/** The peer ids of the home network of `peerId` (itself included; alone when the lookup fails). */
function homeIds(peerId) {
  try { return require('./homeNetwork').homeOf(peerId); } catch (e) {
    logger.warn({ err: e.message, peerId }, 'home network of the gateway unknown — treated alone');
    return [Number(peerId)];
  }
}

function marks(ids) { return ids.map(() => '?').join(','); }

/** Rows of one MAC on the gateways `ids`. */
function rowsOfMac(ids, mac) {
  return db().prepare(`SELECT * FROM netwatch_devices WHERE mac = ? AND peer_id IN (${marks(ids)}) ORDER BY id`).all(mac, ...ids);
}

/** Did an administrator (or the very first inventory) make something of this row? */
function decidedRow(r) {
  return r.decided_at != null || r.status !== 'new' || r.name != null || r.owner_user_id != null;
}

/**
 * The rows of one MAC, the one whose decisions count first: decided last
 * (decided_at) first; then rows that are not 'new' (e.g. taken over as known
 * with the inventory), with an owner, with a name; then the oldest row.
 */
function ranked(rows) {
  const score = (r) => [r.decided_at || 0, r.status !== 'new' ? 1 : 0, r.owner_user_id != null ? 1 : 0, r.name != null ? 1 : 0];
  return rows.slice().sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return a.id - b.id;
  });
}

/**
 * What the rows of one MAC in a home network should all carry: the decisions
 * of the best row; an empty name / owner from the next row that has one
 * (with that row's presence). null when no row holds a decision.
 */
function mergedState(rows) {
  const order = ranked(rows);
  const w = order[0];
  if (!w || !decidedRow(w)) return null;
  const nameRow = order.find((r) => r.name != null);
  const ownerRow = w.owner_user_id != null ? w : order.find((r) => r.owner_user_id != null);
  return {
    name: w.name != null ? w.name : (nameRow ? nameRow.name : null),
    owner: ownerRow ? ownerRow.owner_user_id : null,
    presence: ownerRow && ownerRow.presence === 1 ? 1 : 0,
    status: STATUSES.includes(w.status) ? w.status : 'known',
    decidedAt: rows.reduce((m, r) => Math.max(m, r.decided_at || 0), 0) || null,
  };
}

function gatewayNames(ids) {
  if (!ids.length) return new Map();
  return new Map(db().prepare(`SELECT id, name FROM peers WHERE id IN (${marks(ids)})`).all(...ids).map((r) => [r.id, r.name]));
}

function ensureFeaturesRow(peerId) {
  db().prepare("INSERT OR IGNORE INTO gateway_features (peer_id, settings, updated_at) VALUES (?, '{}', ?)").run(peerId, Date.now());
}

function parsePorts(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.length > MAX_PORTS) throw new NetwatchError('invalid', `ports: null or up to ${MAX_PORTS} entries`);
  const seen = new Set();
  const out = [];
  for (const p of v) {
    const port = p && typeof p === 'object' ? p.port : null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NetwatchError('invalid', 'ports[].port: 1…65535');
    if (seen.has(port)) continue;
    seen.add(port);
    const svc = text(p.service, 32);
    out.push({ port, service: svc && /^[A-Za-z0-9._/+ -]+$/.test(svc) ? svc : null });
  }
  return out.sort((a, b) => a.port - b.port);
}

function parseDevice(d, now) {
  if (!d || typeof d !== 'object') throw new NetwatchError('invalid', 'device: object expected');
  const mac = normMac(d.mac);
  if (!mac) throw new NetwatchError('invalid', 'device.mac: aa:bb:cc:dd:ee:ff');
  const ip = typeof d.ip === 'string' && IP_RE.test(d.ip.trim()) ? d.ip.trim() : null;
  const lastSeen = normTime(d.lastSeen, now) || now;
  const firstSeen = Math.min(normTime(d.firstSeen, now) || lastSeen, lastSeen);
  return {
    mac, ip,
    vendor: text(d.vendor, 80),
    hostname: text(d.hostname, 128),
    randomMac: d.randomMac === true || (parseInt(mac.slice(0, 2), 16) & 2) === 2,
    online: d.online === true,
    firstSeen, lastSeen,
    ports: parsePorts(d.ports),
  };
}

/** POST /api/v1/gateway/netwatch — { scanAt, full, devices: [...] } → { devices: n } */
function ingest(peerId, body) {
  const b = body && typeof body === 'object' ? body : null;
  if (!b || !Array.isArray(b.devices)) throw new NetwatchError('invalid', 'devices must be an array');
  if (b.devices.length > MAX_DEVICES) throw new NetwatchError('invalid', `at most ${MAX_DEVICES} devices`);
  const now = Date.now();
  const scanAt = normTime(b.scanAt, now) || now;
  const full = b.full === true;
  const devices = b.devices.map((d) => parseDevice(d, now));
  const others = homeIds(peerId).filter((id) => id !== Number(peerId));
  const sel = db().prepare('SELECT id, first_seen, last_seen FROM netwatch_devices WHERE peer_id = ? AND mac = ?');
  const selHome = others.length ? db().prepare(`SELECT * FROM netwatch_devices WHERE mac = ? AND peer_id IN (${marks(others)})`) : null;
  const ins = db().prepare(`INSERT INTO netwatch_devices (peer_id, mac, ip, vendor, hostname, random_mac, online, first_seen, last_seen, ports, ports_at, status,
      name, owner_user_id, presence, decided_at, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db().prepare(`UPDATE netwatch_devices SET ip = COALESCE(?, ip), vendor = COALESCE(?, vendor), hostname = COALESCE(?, hostname),
      random_mac = ?, online = ?, first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?`);
  const updPorts = db().prepare('UPDATE netwatch_devices SET ports = ?, ports_at = ? WHERE id = ?');
  let fresh = 0;
  let baseline = false;
  let inherited = false;
  db().transaction(() => {
    // in the transaction: two gateways of one home network reporting at the same moment see each other's rows
    baseline = db().prepare('SELECT COUNT(*) AS n FROM netwatch_devices WHERE peer_id = ?').get(peerId).n === 0;
    const seen = new Set();
    for (const d of devices) {
      if (seen.has(d.mac)) continue;
      seen.add(d.mac);
      const cur = sel.get(peerId, d.mac);
      let id;
      if (cur) {
        upd.run(d.ip, d.vendor, d.hostname, d.randomMac ? 1 : 0, d.online ? 1 : 0, d.firstSeen, d.lastSeen, now, cur.id);
        id = cur.id;
      } else {
        // another gateway of the home network knows the MAC: its decisions (and its notice) count here too
        const home = selHome ? selHome.all(d.mac, ...others) : [];
        const m = home.length ? mergedState(home) : null;
        // still 'new' there: new here as well, but notified (or pending) only once for the home network
        const notified = home.map((r) => r.notified_at).filter((x) => x != null);
        const notifiedAt = notified.length ? Math.min(...notified) : null;
        let st;
        // (a known device needs no notified_at — and a fresh one would hold back the next real notice by 10 minutes)
        if (m) st = { status: m.status, name: m.name, owner: m.owner, presence: m.presence, decidedAt: m.decidedAt, notifiedAt: m.status !== 'new' ? null : notifiedAt };
        else if (home.length) st = { status: 'new', name: null, owner: null, presence: 0, decidedAt: null, notifiedAt };
        else st = { status: baseline ? 'known' : 'new', name: null, owner: null, presence: 0, decidedAt: null, notifiedAt: null };
        id = ins.run(peerId, d.mac, d.ip, d.vendor, d.hostname, d.randomMac ? 1 : 0, d.online ? 1 : 0, d.firstSeen, d.lastSeen,
          null, null, st.status, st.name, st.owner, st.presence, st.decidedAt, st.notifiedAt, now, now).lastInsertRowid;
        if (st.status === 'new' && st.notifiedAt == null) fresh++;
        if (st.presence) inherited = true;
      }
      if (d.ports !== null) updPorts.run(JSON.stringify(d.ports), scanAt, id);
    }
    if (full && seen.size) {
      // a complete list: everything not in it is offline now
      const macs = [...seen];
      const all = db().prepare('SELECT id, mac FROM netwatch_devices WHERE peer_id = ? AND online = 1').all(peerId);
      const off = db().prepare('UPDATE netwatch_devices SET online = 0 WHERE id = ?');
      const set = new Set(macs);
      for (const r of all) if (!set.has(r.mac)) off.run(r.id);
    } else if (full) {
      db().prepare('UPDATE netwatch_devices SET online = 0 WHERE peer_id = ?').run(peerId);
    }
    ensureFeaturesRow(peerId);
    db().prepare(`UPDATE gateway_features SET netwatch_scan_at = MAX(COALESCE(netwatch_scan_at, 0), ?)${full ? ', netwatch_full_at = MAX(COALESCE(netwatch_full_at, 0), ?)' : ''} WHERE peer_id = ?`)
      .run(...(full ? [scanAt, scanAt, peerId] : [scanAt, peerId]));
  })();
  if (fresh) scheduleNotice(peerId);
  if (inherited) {
    // a device counting for presence arrived on this gateway: it watches the MAC from its next config pull
    try { require('./homePresence').onDeviceChanged([peerId], []); } catch (e) { logger.debug({ err: e.message }, 'presence push failed'); }
  }
  try { require('./eventBus').publish('gateway_netwatch', { peer_id: peerId, fresh }); } catch { /* best-effort */ }
  return { devices: devices.length, fresh, baseline };
}

// ─── Notice about new devices ──────────────────────────────────────────

const timers = new Map(); // smallest peer id of the home network → timeout

/** Devices still to notify on the gateways `ids`: one entry per MAC (the oldest row), with the gateways that saw it. */
function pendingOf(ids) {
  const rows = db().prepare(`SELECT id, peer_id, mac, ip, vendor, hostname, name FROM netwatch_devices
    WHERE peer_id IN (${marks(ids)}) AND status = 'new' AND notified_at IS NULL ORDER BY first_seen, id`).all(...ids);
  const byMac = new Map();
  for (const r of rows) {
    if (byMac.has(r.mac)) byMac.get(r.mac).peers.add(r.peer_id);
    else byMac.set(r.mac, { ...r, peers: new Set([r.peer_id]) });
  }
  return [...byMac.values()];
}

/** Send the collected notice now or when the 10 minutes since the last one (in the home network) are over. */
function scheduleNotice(peerId) {
  const ids = homeIds(peerId);
  const key = ids[0];
  if (timers.has(key)) return;
  const last = db().prepare(`SELECT MAX(notified_at) AS t FROM netwatch_devices WHERE peer_id IN (${marks(ids)})`).get(...ids).t || 0;
  const wait = last + (module.exports._gapMs || NOTICE_GAP_MS) - Date.now();
  if (wait <= 0) { sendNotice(peerId); return; }
  const t = setTimeout(() => { timers.delete(key); try { sendNotice(key); } catch (e) { logger.warn({ err: e.message, peerId: key }, 'netwatch notice failed'); } }, wait);
  if (t.unref) t.unref();
  timers.set(key, t);
}

/**
 * The notice for the home network of `peerId`: every MAC once, whichever
 * gateway saw it. Reading the pending rows and marking every row of their
 * MACs happen in one transaction — a second gateway's report (or a second
 * timer) finds nothing left to send.
 */
function sendNotice(peerId) {
  const ids = homeIds(peerId);
  const now = Date.now();
  let list = [];
  db().transaction(() => {
    list = pendingOf(ids);
    const mark = db().prepare(`UPDATE netwatch_devices SET notified_at = ? WHERE mac = ? AND notified_at IS NULL AND peer_id IN (${marks(ids)})`);
    for (const d of list) mark.run(now, d.mac, ...ids);
  })();
  if (!list.length) return null;
  const seenBy = [...new Set(list.flatMap((d) => [...d.peers]))].sort((a, b) => a - b);
  const names = gatewayNames(seenBy);
  const gwName = seenBy.map((id) => names.get(id) || '#' + id).join(' / ');
  const text0 = require('./notify/text');
  const lang = text0.serverLang();
  const label = (d) => {
    const n = kit.displayName(d) || d.vendor || text0.t(lang, 'push.netwatch.unknown_device');
    const extra = [d.vendor && n !== d.vendor ? d.vendor : null, d.ip].filter(Boolean).join(', ');
    return extra ? `${n} (${extra})` : n;
  };
  const shown = list.slice(0, 5).map(label);
  const more = list.length > 5 ? ' ' + text0.t(lang, 'push.netwatch.more', { n: list.length - 5 }) : '';
  const message = text0.t(lang, list.length === 1 ? 'push.netwatch.one' : 'push.netwatch.many', { n: list.length, gateway: gwName })
    + ' ' + shown.join(', ') + more;
  try {
    require('./activity').log('netwatch_new_device', message.slice(0, 900), {
      source: 'system', severity: 'warning',
      details: {
        peer_id: seenBy[0], peer_name: names.get(seenBy[0]) || null, ...(seenBy.length > 1 ? { peer_ids: seenBy } : {}), count: list.length,
        devices: list.slice(0, 20).map((d) => ({ id: d.id, label: kit.displayName(d) || d.vendor || null, ip: d.ip })),
      },
    });
  } catch (e) { logger.warn({ err: e.message, peerId }, 'netwatch notice not written'); }
  return { count: list.length };
}

/** After a restart: pending notices of every home network (called by the ticker). */
function flushPending() {
  const rows = db().prepare("SELECT DISTINCT peer_id FROM netwatch_devices WHERE status = 'new' AND notified_at IS NULL").all();
  for (const r of rows) scheduleNotice(r.peer_id);
}

// ─── Admin API ─────────────────────────────────────────────────────────

function ownerNames(ids) {
  const list = [...new Set(ids.filter((x) => x != null))];
  if (!list.length) return new Map();
  return new Map(db().prepare(`SELECT id, display_name, username FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list)
    .map((u) => [u.id, u.display_name || u.username]));
}

function view(r, names) {
  const ports = json(r.ports);
  const d = {
    id: r.id, mac: r.mac, ip: r.ip, vendor: r.vendor, hostname: r.hostname, randomMac: r.random_mac === 1,
    online: r.online === 1, firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen),
    ports: Array.isArray(ports) ? ports : null, portsAt: iso(r.ports_at),
    name: r.name, ownerUserId: r.owner_user_id, ownerName: r.owner_user_id != null ? (names.get(r.owner_user_id) || null) : null,
    status: STATUSES.includes(r.status) ? r.status : 'new', presence: r.presence === 1,
    presenceOnline: r.presence_online == null ? null : r.presence_online === 1, presenceAt: iso(r.presence_at),
  };
  d.risks = kit.risksOf(d);
  return d;
}

/**
 * The tab "Netzwerk": devices (optionally searched / filtered), KPIs, last
 * scan — of this gateway. With other gateways in the home network: `home`
 * lists them, and every device says which of them see it too (alsoSeenBy).
 */
function list(peerId, { q = '', filter = 'all' } = {}) {
  const rows = db().prepare('SELECT * FROM netwatch_devices WHERE peer_id = ?').all(peerId);
  const names = ownerNames(rows.map((r) => r.owner_user_id));
  const all = rows.map((r) => view(r, names));
  const st = db().prepare('SELECT netwatch_scan_at, netwatch_full_at FROM gateway_features WHERE peer_id = ?').get(peerId) || {};
  const consent = new Set(db().prepare('SELECT user_id FROM presence_consent WHERE enabled = 1').all().map((r) => r.user_id));
  all.forEach((d) => { d.ownerConsent = d.ownerUserId != null && consent.has(d.ownerUserId); });
  const others = homeIds(peerId).filter((id) => id !== Number(peerId));
  const gwNames = gatewayNames(others);
  const seen = new Map(); // mac → [{ id, name }]
  if (others.length) {
    for (const r of db().prepare(`SELECT peer_id, mac FROM netwatch_devices WHERE peer_id IN (${marks(others)}) ORDER BY peer_id`).all(...others)) {
      if (!seen.has(r.mac)) seen.set(r.mac, []);
      seen.get(r.mac).push({ id: r.peer_id, name: gwNames.get(r.peer_id) || '#' + r.peer_id });
    }
  }
  all.forEach((d) => { d.alsoSeenBy = seen.get(d.mac) || []; });
  const shown = kit.sortDevices(kit.filterDevices(all, typeof q === 'string' ? q.slice(0, 100) : '', filter));
  return {
    devices: shown, total: all.length, kpis: kit.kpis(all), lastScanAt: iso(st.netwatch_scan_at), lastFullAt: iso(st.netwatch_full_at),
    home: { gateways: others.map((id) => ({ id, name: gwNames.get(id) || '#' + id })) },
  };
}

/** Change name, owner, status, presence of one device. */
function update(peerId, deviceId, patch, { ip, user } = {}) {
  const id = Number(deviceId);
  const cur = Number.isSafeInteger(id) ? db().prepare('SELECT * FROM netwatch_devices WHERE id = ? AND peer_id = ?').get(id, peerId) : null;
  if (!cur) throw new NetwatchError('not_found', 'device not found');
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw new NetwatchError('invalid', 'invalid body');
  const next = { name: cur.name, owner: cur.owner_user_id, status: cur.status, presence: cur.presence === 1 };
  let any = false;
  if (p.name !== undefined) {
    if (p.name !== null && typeof p.name !== 'string') throw new NetwatchError('invalid', 'name: text or null');
    next.name = p.name === null ? null : text(p.name, NAME_MAX);
    any = true;
  }
  if (p.ownerUserId !== undefined) {
    if (p.ownerUserId !== null) {
      if (!Number.isSafeInteger(p.ownerUserId) || p.ownerUserId <= 0 || !db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(p.ownerUserId)) {
        throw new NetwatchError('invalid_owner', 'unknown or disabled user');
      }
    }
    next.owner = p.ownerUserId;
    any = true;
  }
  if (p.status !== undefined) {
    if (!STATUSES.includes(p.status) || p.status === 'new') throw new NetwatchError('invalid', 'status: known or watch');
    next.status = p.status;
    any = true;
  }
  if (p.presence !== undefined) {
    if (typeof p.presence !== 'boolean') throw new NetwatchError('invalid', 'presence: true or false');
    next.presence = p.presence;
    any = true;
  }
  if (!any) throw new NetwatchError('invalid', 'nothing to change');
  // counting for presence only makes sense with an owner
  if (next.owner == null) next.presence = false;
  const presenceChanged = next.presence !== (cur.presence === 1) || next.owner !== cur.owner_user_id;
  // the decision holds for the MAC on every gateway of the home network
  const now = Date.now();
  const ids = homeIds(peerId);
  const touched = []; // [{ peer_id, owner_user_id }] whose presence MACs / owners change
  const set = db().prepare(`UPDATE netwatch_devices SET name = ?, owner_user_id = ?, status = ?, presence = ?,
      presence_online = CASE WHEN ? THEN NULL ELSE presence_online END, presence_at = CASE WHEN ? THEN NULL ELSE presence_at END,
      notified_at = COALESCE(notified_at, CASE WHEN ? <> 'new' THEN ? ELSE NULL END), decided_at = ?, updated_at = ? WHERE id = ?`);
  db().transaction(() => {
    const rows = rowsOfMac(ids, cur.mac);
    if (!rows.some((r) => r.id === cur.id)) rows.push(cur);
    for (const r of rows) {
      const pc = next.presence !== (r.presence === 1) || next.owner !== r.owner_user_id;
      set.run(next.name, next.owner, next.status, next.presence ? 1 : 0, pc ? 1 : 0, pc ? 1 : 0, next.status, now, now, now, r.id);
      if (pc) touched.push(r);
    }
  })();
  const changes = [];
  if (next.name !== cur.name) changes.push('name');
  if (next.owner !== cur.owner_user_id) changes.push('owner');
  if (next.status !== cur.status) changes.push('status');
  if (next.presence !== (cur.presence === 1)) changes.push('presence');
  if (changes.length) {
    try {
      require('./activity').log('netwatch_device_changed', `Network device ${cur.mac} changed (${changes.join(', ')})`, {
        source: 'admin', ipAddress: ip, severity: 'info',
        details: {
          peer_id: peerId, device_id: cur.id, ...(user ? { user } : {}), changes, status: next.status, owner_user_id: next.owner, presence: next.presence,
          ...(ids.length > 1 ? { home_peer_ids: ids } : {}),
        },
      });
    } catch { /* best-effort */ }
  }
  if (presenceChanged || touched.length) {
    try {
      // every gateway of the home network: presence MACs, and the DNS filter / pauses follow the owner (homeDns, homeInternet)
      require('./homePresence').onDeviceChanged(ids, [cur.owner_user_id, next.owner, ...touched.map((r) => r.owner_user_id)]);
    } catch (e) { logger.warn({ err: e.message }, 'presence update failed'); }
  }
  const row = db().prepare('SELECT * FROM netwatch_devices WHERE id = ?').get(cur.id);
  return view(row, ownerNames([row.owner_user_id]));
}

/**
 * Forget a device — on every gateway of the home network (a row left on the
 * other gateway would hand its decisions straight back). It comes back as
 * new when a gateway sees it again.
 */
function remove(peerId, deviceId) {
  const id = Number(deviceId);
  const cur = Number.isSafeInteger(id) ? db().prepare('SELECT id, mac FROM netwatch_devices WHERE id = ? AND peer_id = ?').get(id, peerId) : null;
  if (!cur) throw new NetwatchError('not_found', 'device not found');
  const ids = homeIds(peerId);
  let rows = [];
  db().transaction(() => {
    rows = rowsOfMac(ids, cur.mac);
    if (!rows.some((r) => r.id === cur.id)) rows.push(cur);
    const del = db().prepare('DELETE FROM netwatch_devices WHERE id = ?');
    for (const r of rows) del.run(r.id);
  })();
  const counting = rows.filter((r) => r.presence === 1);
  if (counting.length) {
    try { require('./homePresence').onDeviceChanged(counting.map((r) => r.peer_id), counting.map((r) => r.owner_user_id)); } catch { /* best-effort */ }
  }
  return { removed: true, gateways: rows.length };
}

// ─── Rows already doubled (server start, ticker) ──────────────────────

/**
 * Bring the rows of one MAC on several gateways of a home network to the
 * same decisions (mergedState: the row decided last wins, an empty name /
 * owner is taken from the next row that has one); a MAC that is known
 * there is no open "new" notice any more, and a MAC already notified on one
 * gateway is not notified again on the other. Idempotent; logs one activity
 * when something changed. → { devices, rows }
 */
function reconcileHomes() {
  let homes;
  try { homes = require('./homeNetwork').gatewayHomes().filter((ids) => ids.length > 1); } catch (e) {
    logger.warn({ err: e.message }, 'home networks of the gateways unknown — nothing merged');
    return { devices: 0, rows: 0 };
  }
  let devices = 0;
  let changedRows = 0;
  const peers = new Set();
  const users = new Set();
  const set = db().prepare(`UPDATE netwatch_devices SET name = ?, owner_user_id = ?, status = ?, presence = ?, decided_at = ?, notified_at = ?,
      presence_online = CASE WHEN ? THEN NULL ELSE presence_online END, presence_at = CASE WHEN ? THEN NULL ELSE presence_at END WHERE id = ?`);
  for (const ids of homes) {
    db().transaction(() => {
      const rows = db().prepare(`SELECT * FROM netwatch_devices WHERE peer_id IN (${marks(ids)}) AND mac IN (
          SELECT mac FROM netwatch_devices WHERE peer_id IN (${marks(ids)}) GROUP BY mac HAVING COUNT(*) > 1) ORDER BY mac, id`).all(...ids, ...ids);
      const byMac = new Map();
      for (const r of rows) { if (!byMac.has(r.mac)) byMac.set(r.mac, []); byMac.get(r.mac).push(r); }
      for (const group of byMac.values()) {
        const m = mergedState(group);
        const notified = group.map((r) => r.notified_at).filter((x) => x != null);
        let any = false;
        for (const r of group) {
          const status = m ? m.status : r.status;
          // known there → no open notice here (status); still new everywhere → notified once for the home network
          const notifiedAt = r.notified_at == null && status === 'new' && notified.length ? Math.min(...notified) : r.notified_at;
          const want = m
            ? { name: m.name, owner: m.owner, status, presence: m.presence, decidedAt: m.decidedAt, notifiedAt }
            : { name: r.name, owner: r.owner_user_id, status, presence: r.presence, decidedAt: r.decided_at, notifiedAt };
          if (want.name === r.name && want.owner === r.owner_user_id && want.status === r.status && want.presence === r.presence
            && want.decidedAt === r.decided_at && want.notifiedAt === r.notified_at) continue;
          const pc = want.owner !== r.owner_user_id || want.presence !== r.presence;
          set.run(want.name, want.owner, want.status, want.presence, want.decidedAt, want.notifiedAt, pc ? 1 : 0, pc ? 1 : 0, r.id);
          changedRows++;
          any = true;
          if (pc) {
            peers.add(r.peer_id);
            for (const u of [r.owner_user_id, want.owner]) if (u != null) users.add(u);
          }
        }
        if (any) devices++;
      }
    })();
  }
  if (changedRows) {
    try {
      require('./activity').log('netwatch_home_merged', `Network devices of gateways in one home network merged (${devices} device${devices === 1 ? '' : 's'})`, {
        source: 'system', severity: 'info', details: { devices, rows: changedRows, homes: homes.filter((ids) => ids.length > 1) },
      });
    } catch { /* best-effort */ }
  }
  if (peers.size) {
    try { require('./homePresence').onDeviceChanged([...peers], [...users]); } catch (e) { logger.warn({ err: e.message }, 'presence update after merge failed'); }
  }
  return { devices, rows: changedRows };
}

/** "Jetzt scannen": ask the gateway (management API) → { ok, busy } */
async function scan(peerId) {
  const r = await require('./gateways').mgmtCall(peerId, '/api/netwatch/scan', {});
  if (!r) throw new NetwatchError('gateway_unreachable', 'gateway not reachable');
  if (r.status === 409) return { ok: true, busy: true };
  if (r.status === 404) throw new NetwatchError('gateway_unsupported', 'the gateway does not know this command yet');
  if (r.status === 503) throw new NetwatchError('unavailable', 'the network watch is not running on the gateway yet');
  if (r.status < 200 || r.status >= 300) throw new NetwatchError('gateway_error', 'gateway answered ' + r.status);
  return { ok: true, busy: false };
}

function _resetForTest() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

module.exports = {
  NetwatchError, MAX_DEVICES, NOTICE_GAP_MS, ingest, list, update, remove, scan, scheduleNotice, sendNotice, flushPending, reconcileHomes,
  homeIds, stopTimers: _resetForTest, _resetForTest, _gapMs: null,
};
