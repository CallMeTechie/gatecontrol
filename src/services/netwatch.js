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
// device, collected, at most every 10 minutes per gateway.

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
  const known = db().prepare('SELECT COUNT(*) AS n FROM netwatch_devices WHERE peer_id = ?').get(peerId).n;
  const baseline = known === 0;
  const sel = db().prepare('SELECT id, first_seen, last_seen FROM netwatch_devices WHERE peer_id = ? AND mac = ?');
  const ins = db().prepare(`INSERT INTO netwatch_devices (peer_id, mac, ip, vendor, hostname, random_mac, online, first_seen, last_seen, ports, ports_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db().prepare(`UPDATE netwatch_devices SET ip = COALESCE(?, ip), vendor = COALESCE(?, vendor), hostname = COALESCE(?, hostname),
      random_mac = ?, online = ?, first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?`);
  const updPorts = db().prepare('UPDATE netwatch_devices SET ports = ?, ports_at = ? WHERE id = ?');
  let fresh = 0;
  db().transaction(() => {
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
        id = ins.run(peerId, d.mac, d.ip, d.vendor, d.hostname, d.randomMac ? 1 : 0, d.online ? 1 : 0, d.firstSeen, d.lastSeen,
          null, null, baseline ? 'known' : 'new', now, now).lastInsertRowid;
        if (!baseline) fresh++;
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
  try { require('./eventBus').publish('gateway_netwatch', { peer_id: peerId, fresh }); } catch { /* best-effort */ }
  return { devices: devices.length, fresh, baseline };
}

// ─── Notice about new devices ──────────────────────────────────────────

const timers = new Map(); // peerId → timeout

function pendingOf(peerId) {
  return db().prepare("SELECT id, mac, ip, vendor, hostname, name FROM netwatch_devices WHERE peer_id = ? AND status = 'new' AND notified_at IS NULL ORDER BY first_seen, id").all(peerId);
}

/** Send the collected notice now or when the 10 minutes since the last one are over. */
function scheduleNotice(peerId) {
  if (timers.has(peerId)) return;
  const last = db().prepare('SELECT MAX(notified_at) AS t FROM netwatch_devices WHERE peer_id = ?').get(peerId).t || 0;
  const wait = last + (module.exports._gapMs || NOTICE_GAP_MS) - Date.now();
  if (wait <= 0) { sendNotice(peerId); return; }
  const t = setTimeout(() => { timers.delete(peerId); try { sendNotice(peerId); } catch (e) { logger.warn({ err: e.message, peerId }, 'netwatch notice failed'); } }, wait);
  if (t.unref) t.unref();
  timers.set(peerId, t);
}

function sendNotice(peerId) {
  const list = pendingOf(peerId);
  if (!list.length) return null;
  const g = db().prepare('SELECT name FROM peers WHERE id = ?').get(peerId);
  const now = Date.now();
  const mark = db().prepare('UPDATE netwatch_devices SET notified_at = ? WHERE id = ?');
  db().transaction(() => { for (const d of list) mark.run(now, d.id); })();
  const text0 = require('./notify/text');
  const lang = text0.serverLang();
  const label = (d) => {
    const n = kit.displayName(d) || d.vendor || text0.t(lang, 'push.netwatch.unknown_device');
    const extra = [d.vendor && n !== d.vendor ? d.vendor : null, d.ip].filter(Boolean).join(', ');
    return extra ? `${n} (${extra})` : n;
  };
  const shown = list.slice(0, 5).map(label);
  const more = list.length > 5 ? ' ' + text0.t(lang, 'push.netwatch.more', { n: list.length - 5 }) : '';
  const message = text0.t(lang, list.length === 1 ? 'push.netwatch.one' : 'push.netwatch.many', { n: list.length, gateway: g ? g.name : '#' + peerId })
    + ' ' + shown.join(', ') + more;
  try {
    require('./activity').log('netwatch_new_device', message.slice(0, 900), {
      source: 'system', severity: 'warning',
      details: { peer_id: peerId, peer_name: g ? g.name : null, count: list.length, devices: list.slice(0, 20).map((d) => ({ id: d.id, label: kit.displayName(d) || d.vendor || null, ip: d.ip })) },
    });
  } catch (e) { logger.warn({ err: e.message, peerId }, 'netwatch notice not written'); }
  return { count: list.length };
}

/** After a restart: pending notices of every gateway (called by the ticker). */
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

/** The tab "Netzwerk": devices (optionally searched / filtered), KPIs, last scan. */
function list(peerId, { q = '', filter = 'all' } = {}) {
  const rows = db().prepare('SELECT * FROM netwatch_devices WHERE peer_id = ?').all(peerId);
  const names = ownerNames(rows.map((r) => r.owner_user_id));
  const all = rows.map((r) => view(r, names));
  const st = db().prepare('SELECT netwatch_scan_at, netwatch_full_at FROM gateway_features WHERE peer_id = ?').get(peerId) || {};
  const consent = new Set(db().prepare('SELECT user_id FROM presence_consent WHERE enabled = 1').all().map((r) => r.user_id));
  all.forEach((d) => { d.ownerConsent = d.ownerUserId != null && consent.has(d.ownerUserId); });
  const shown = kit.sortDevices(kit.filterDevices(all, typeof q === 'string' ? q.slice(0, 100) : '', filter));
  return { devices: shown, total: all.length, kpis: kit.kpis(all), lastScanAt: iso(st.netwatch_scan_at), lastFullAt: iso(st.netwatch_full_at) };
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
  db().prepare(`UPDATE netwatch_devices SET name = ?, owner_user_id = ?, status = ?, presence = ?,
      presence_online = CASE WHEN ? THEN NULL ELSE presence_online END, presence_at = CASE WHEN ? THEN NULL ELSE presence_at END,
      notified_at = COALESCE(notified_at, CASE WHEN ? <> 'new' THEN ? ELSE NULL END), updated_at = ? WHERE id = ?`)
    .run(next.name, next.owner, next.status, next.presence ? 1 : 0, presenceChanged ? 1 : 0, presenceChanged ? 1 : 0, next.status, Date.now(), Date.now(), cur.id);
  const changes = [];
  if (next.name !== cur.name) changes.push('name');
  if (next.owner !== cur.owner_user_id) changes.push('owner');
  if (next.status !== cur.status) changes.push('status');
  if (next.presence !== (cur.presence === 1)) changes.push('presence');
  if (changes.length) {
    try {
      require('./activity').log('netwatch_device_changed', `Network device ${cur.mac} changed (${changes.join(', ')})`, {
        source: 'admin', ipAddress: ip, severity: 'info',
        details: { peer_id: peerId, device_id: cur.id, ...(user ? { user } : {}), changes, status: next.status, owner_user_id: next.owner, presence: next.presence },
      });
    } catch { /* best-effort */ }
  }
  if (presenceChanged) {
    try { require('./homePresence').onDeviceChanged(peerId, [cur.owner_user_id, next.owner]); } catch (e) { logger.warn({ err: e.message }, 'presence update failed'); }
  }
  const row = db().prepare('SELECT * FROM netwatch_devices WHERE id = ?').get(cur.id);
  return view(row, ownerNames([row.owner_user_id]));
}

/** Forget a device (it comes back as new when the gateway sees it again). */
function remove(peerId, deviceId) {
  const id = Number(deviceId);
  const cur = Number.isSafeInteger(id) ? db().prepare('SELECT id, owner_user_id, presence FROM netwatch_devices WHERE id = ? AND peer_id = ?').get(id, peerId) : null;
  if (!cur) throw new NetwatchError('not_found', 'device not found');
  db().prepare('DELETE FROM netwatch_devices WHERE id = ?').run(cur.id);
  if (cur.presence === 1) { try { require('./homePresence').onDeviceChanged(peerId, [cur.owner_user_id]); } catch { /* best-effort */ } }
  return { removed: true };
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
  NetwatchError, MAX_DEVICES, NOTICE_GAP_MS, ingest, list, update, remove, scan, scheduleNotice, sendNotice, flushPending, stopTimers: _resetForTest, _resetForTest, _gapMs: null,
};
