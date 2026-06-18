'use strict';
const { getDb } = require('../db/connection');
const config = require('../../config/default');

function badRequest(msg) { const e = new Error(msg); e.status = 400; e.code = 'bad_request'; return e; }

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
function isIpv4(ip){ const m=IPV4.exec(ip||''); return !!m && m.slice(1).every(o=>+o<=255); }
function ipInCidr(ip, cidr){ const [b,p]=cidr.split('/'); const to=x=>x.split('.').reduce((a,o)=>(a<<8)+ +o,0)>>>0; const m=p==0?0:(0xffffffff<<(32-+p))>>>0; return (to(ip)&m)===(to(b)&m); }
function lanSubnetsOf(db, peerId){
  const row = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id=?').get(peerId);
  try { return (JSON.parse(row.last_health).telemetry.lan_subnets||[]).map(s=>s.cidr); } catch { return []; }
}
function lanIpOf(db, peerId){
  const row = db.prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id=?').get(peerId);
  return row?.lan_ip || null;
}

function validate(data, db = getDb()) {
  const r = db.prepare("SELECT route_type, target_kind, external_enabled FROM routes WHERE id=?").get(data.target_route_id);
  if (!r || r.route_type !== 'l4' || r.target_kind !== 'gateway' || r.external_enabled !== 0)
    throw badRequest('target_route_id must be an internal-only L4 gateway route');
  if (!isIpv4(data.vip_ip)) throw badRequest('vip_ip must be IPv4');
  const subnets = lanSubnetsOf(db, data.near_peer_id);
  if (!subnets.some(c => ipInCidr(data.vip_ip, c))) throw badRequest('vip_ip must lie within the near gateway LAN subnets');
  for (const c of (data.allowed_source_ips || [])) if (!CIDR.test(c)) throw badRequest(`bad CIDR: ${c}`);
  const port = data.lan_listen_port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw badRequest('lan_listen_port must be a high port (1024-65535)');
}

/** Resolve enabled egress routes whose near gateway is peerId (or a pool member). */
function resolveForPeer(peerId, db = getDb(), opts = {}) {
  const hubIp = opts.hubIp || config.wireguard.gatewayIp;
  const rows = db.prepare(`
    SELECT e.*, r.l4_listen_port AS target_port
    FROM egress_routes e JOIN routes r ON r.id = e.target_route_id
    WHERE e.enabled = 1
      AND ( e.near_peer_id = ?
            OR e.near_pool_id IN (SELECT pool_id FROM gateway_pool_members WHERE peer_id = ?) )
    ORDER BY e.id
  `).all(peerId, peerId);
  return rows.map(e => {
    // near_peers = LAN IPs of the OTHER pool members of this near gateway.
    const poolId = e.near_pool_id
      || db.prepare('SELECT pool_id FROM gateway_pool_members WHERE peer_id=?').get(e.near_peer_id)?.pool_id;
    let nearPeers = [];
    if (poolId != null) {
      const members = db.prepare('SELECT peer_id FROM gateway_pool_members WHERE pool_id=? AND peer_id<>?').all(poolId, peerId);
      nearPeers = members.map(m => lanIpOf(db, m.peer_id)).filter(Boolean);
    }
    return {
      id: e.id,
      vip_ip: e.vip_ip,
      vip_prefix: e.vip_prefix,
      lan_listen_port: e.lan_listen_port,
      tunnel_target_host: hubIp,
      // l4_listen_port is a SQLite TEXT column; config-hash Port schema requires a number.
      // Mirror the coercion used for l4_routes in gateways.js (~line 168).
      tunnel_target_port: Number.isFinite(Number(e.target_port)) ? Number(e.target_port) : e.target_port,
      allowed_source_ips: JSON.parse(e.allowed_source_ips || '[]'),
      near_peers: nearPeers,
    };
  });
}

// --- CRUD (thin) ---
const list   = (db=getDb()) => db.prepare('SELECT * FROM egress_routes ORDER BY id').all();
const get    = (id, db=getDb()) => db.prepare('SELECT * FROM egress_routes WHERE id=?').get(id);
function create(data, db=getDb()) {
  validate(data, db);
  const info = db.prepare(`INSERT INTO egress_routes (name,device_id,near_peer_id,near_pool_id,vip_ip,vip_prefix,lan_listen_port,target_route_id,allowed_source_ips,enabled)
    VALUES (@name,@device_id,@near_peer_id,@near_pool_id,@vip_ip,@vip_prefix,@lan_listen_port,@target_route_id,@allowed_source_ips,@enabled)`).run({
    device_id:null, near_peer_id:null, near_pool_id:null, vip_prefix:24, enabled:1, ...data,
    allowed_source_ips: JSON.stringify(data.allowed_source_ips || []),
  });
  return get(info.lastInsertRowid, db);
}
function update(id, data, db=getDb()) {
  const cur = get(id, db); if (!cur) throw badRequest('not found');
  const merged = { ...cur, ...data };
  // Review-M2: cur.allowed_source_ips ist ein JSON-String; bei Teil-Update (Body ohne das Feld)
  // bliebe es ein String → validate() würde über Zeichen iterieren → falscher 400. Normalisieren:
  if (typeof merged.allowed_source_ips === 'string') merged.allowed_source_ips = JSON.parse(merged.allowed_source_ips || '[]');
  validate(merged, db);
  db.prepare(`UPDATE egress_routes SET name=@name, vip_ip=@vip_ip, vip_prefix=@vip_prefix, lan_listen_port=@lan_listen_port,
     target_route_id=@target_route_id, allowed_source_ips=@allowed_source_ips, enabled=@enabled, near_peer_id=@near_peer_id,
     near_pool_id=@near_pool_id, updated_at=datetime('now') WHERE id=@id`).run({
    ...merged, id, allowed_source_ips: JSON.stringify(merged.allowed_source_ips || []),
  });
  return get(id, db);
}
const remove = (id, db=getDb()) => db.prepare('DELETE FROM egress_routes WHERE id=?').run(id);

module.exports = { validate, resolveForPeer, list, get, create, update, remove };
