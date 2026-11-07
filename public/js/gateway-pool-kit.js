'use strict';

// Pure helpers of the gateways page with pools (no DOM): the fleet grouped by
// pool, the role of a member, the status of a pool, the failback presets in
// plain words, "same LAN" for pool suggestions, the "Zustand" checks of a
// gateway and the groups of the tab "Funktionen". public/js/gateways.js,
// gateway-pools-ui.js and gateway-net.js use them in the browser,
// tests/gateway_pool_kit.test.js in node. The data comes from
// GET /api/v1/gateways and GET /api/v1/gateway-pools/state
// (src/services/gatewayPoolState.js), the switches from
// GET /api/v1/gateways/:id/features (src/services/gatewayFeatures.js).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayPoolKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** #pool/<id> → { id } (id a positive integer); null for any other hash. */
  function parsePoolHash(hash) {
    const m = /^#pool\/(\d+)$/.exec(String(hash || ''));
    if (!m) return null;
    const id = parseInt(m[1], 10);
    return id > 0 ? { id } : null;
  }

  function memberIds(pool) { return ((pool && pool.members) || []).map((m) => String(m.peer_id)); }

  /** The pools a gateway is a member of (in the order of the state). */
  function poolsOf(pools, peerId) {
    const id = String(peerId);
    return (pools || []).filter((p) => memberIds(p).indexOf(id) >= 0);
  }

  function memberOf(pool, peerId) {
    const id = String(peerId);
    return ((pool && pool.members) || []).find((m) => String(m.peer_id) === id) || null;
  }

  /**
   * The fleet as groups: one per pool (its gateways in priority order — a
   * gateway in two pools is in both) and the gateways in no pool.
   * Members the fleet does not list (disabled peers) are left out.
   */
  function fleetGroups(gateways, pools) {
    const byId = new Map((gateways || []).map((g) => [String(g.peer_id), g]));
    const inPool = new Set();
    const groups = (pools || []).map((p) => {
      const members = ((p && p.members) || []).slice().sort((a, b) => a.priority - b.priority || a.peer_id - b.peer_id)
        .map((m) => ({ member: m, g: byId.get(String(m.peer_id)) || null }))
        .filter((x) => x.g);
      members.forEach((x) => inPool.add(String(x.g.peer_id)));
      return { pool: p, members };
    });
    const singles = (gateways || []).filter((g) => !inPool.has(String(g.peer_id)));
    return { groups, singles };
  }

  const STATUS_TONE = { protected: 'green', partial: 'amber', on_reserve: 'amber', no_reserve: 'amber', single: 'amber', down: 'red', off: 'grey' };
  function statusTone(status) { return STATUS_TONE[status] || 'grey'; }

  /**
   * What the reserve check of a member found missing: { k, n, missing } —
   * k of the pool's n routes keep their target reachable through it — or
   * null when it reaches every target it reported on or reports nothing
   * (no data: no claim either way).
   */
  function reserveGap(pool, member) {
    const r = member && member.reserve;
    if (!r || !(r.checked > 0) || r.reachable >= r.checked) return null;
    const n = ((pool && pool.routes) || []).length || r.total || r.checked;
    const missing = r.missing || [];
    return { k: Math.max(0, n - (missing.length || (r.checked - r.reachable))), n, missing };
  }
  /** The member that steps in next (failover: the first standby by priority), or null. */
  function nextStandby(pool) { return standbys(pool)[0] || null; }
  /**
   * The status to show: the server's, except a "protected" failover pool
   * whose next reserve does not reach every target of the pool's routes —
   * then 'partial' ("teilweise geschützt"). The server says 'partial' itself
   * (gatewayPoolState.statusOf); this keeps older answers consistent.
   */
  function effectiveStatus(pool) {
    const st = (pool && pool.status) || 'off';
    if (st !== 'protected' || pool.mode === 'load_balancing') return st;
    return reserveGap(pool, nextStandby(pool)) ? 'partial' : st;
  }

  /** Tag of a member in a pool: { tone, key, params } (i18n gwp.role.*). */
  function roleOf(pool, member, now) {
    const n = member.priority_rank || rankOf(pool, member);
    const lb = pool && pool.mode === 'load_balancing';
    if (member.state === 'active') return { tone: 'blue', key: lb ? 'gwp.role.lb_active' : 'gwp.role.active', params: { n } };
    if (member.state === 'standby') {
      return reserveGap(pool, member) ? { tone: 'amber', key: 'gwp.role.standby_partial', params: { n } } : { tone: 'grey', key: 'gwp.role.standby', params: { n } };
    }
    if (member.state === 'recovering') {
      const left = member.failback_at ? Math.max(0, member.failback_at - (now || Date.now())) : null;
      // reachable again; the routes wait for the failback cooldown — it takes
      // them back (or only stands by again) at failback_at (`until`, counted down as {{left}})
      const reserve = member.failback_takes_routes === false;
      if (left == null) return { tone: 'amber', key: reserve ? 'gwp.role.recovering_reserve' : 'gwp.role.recovering', params: { n } };
      return { tone: 'amber', key: reserve ? 'gwp.role.recovering_reserve_in' : 'gwp.role.recovering_in', params: { n, min: Math.max(1, Math.ceil(left / 60000)), left: clock(left) }, until: member.failback_at };
    }
    // away on purpose (live state of the server): an update / a restart under way
    if (member.live_state === 'updating' || member.live_state === 'restarting') return { tone: 'blue', key: 'gwp.role.' + member.live_state, params: { n } };
    return { tone: 'red', key: 'gwp.role.offline', params: { n } };
  }
  /** 1-based place of a member in its pool (by priority). */
  function rankOf(pool, member) {
    const list = ((pool && pool.members) || []).slice().sort((a, b) => a.priority - b.priority || a.peer_id - b.peer_id);
    const i = list.findIndex((m) => String(m.peer_id) === String(member.peer_id));
    return i < 0 ? 1 : i + 1;
  }

  /** The member that serves (failover) — null when none. */
  function activeMember(pool) {
    const ids = (pool && pool.active_peer_ids) || [];
    return ids.length ? memberOf(pool, ids[0]) : null;
  }
  /** Members that stand by (alive, not serving), in priority order. */
  function standbys(pool) {
    return ((pool && pool.members) || []).filter((m) => m.state === 'standby').sort((a, b) => a.priority - b.priority);
  }

  // ─── Durations and the failback presets ───────────────────────────────
  /** seconds → { key, n } for gwp.dur.* ("90 Sekunden", "15 Minuten", "1 Stunde"). */
  function duration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 120) return { key: s === 1 ? 'gwp.dur.s_one' : 'gwp.dur.s', n: s };
    if (s % 3600 === 0) { const h = s / 3600; return { key: h === 1 ? 'gwp.dur.h_one' : 'gwp.dur.h', n: h }; }
    const m = Math.round(s / 60);
    return { key: m === 1 ? 'gwp.dur.min_one' : 'gwp.dur.min', n: m };
  }

  // The presets of the former page /gateway-pools, in plain words (gwp.cool.<key>).
  const COOLDOWN_PRESETS = [
    { key: 'docker', s: 30 },
    { key: 'lxc', s: 60 },
    { key: 'linux', s: 180 },
    { key: 'proxmox', s: 600 },
    { key: 'nas', s: 900 },
    { key: 'windows', s: 1800 },
    { key: 'conservative', s: 3600 },
  ];
  // The device of the first gateway decides the proposal: a NAS reboots
  // several times during a DSM update, a Pi or Linux box is back quickly.
  const PLATFORM_PRESET = { synology: 'nas', proxmox: 'proxmox', rpi: 'linux', linux: 'linux' };
  function proposeCooldown(platform) {
    const key = PLATFORM_PRESET[platform] || 'linux';
    return COOLDOWN_PRESETS.find((p) => p.key === key);
  }
  function presetFor(seconds) { return COOLDOWN_PRESETS.find((p) => p.s === Number(seconds)) || null; }

  // ─── Same LAN (pool suggestions) ──────────────────────────────────────
  function ipv4(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim());
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some((x) => x > 255)) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  }
  function cidr(s) {
    const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const ip = ipv4(m[1]);
    const bits = Number(m[2]);
    if (ip == null || bits > 32) return null;
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    return { net: (ip & mask) >>> 0, mask, bits, text: String(s).trim() };
  }
  function privateNet(c) {
    const a = c.net >>> 24;
    const b = (c.net >>> 16) & 255;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  /** The private IPv4 subnets a gateway reports (telemetry.lan_subnets). */
  function subnetsOf(g) {
    const t = (g && g.health && g.health.telemetry) || {};
    const list = Array.isArray(t.lan_subnets) ? t.lan_subnets : [];
    return list.map((x) => cidr(x && typeof x === 'object' ? x.cidr : x)).filter((c) => c && privateNet(c));
  }
  function overlap(a, b) {
    const mask = a.bits < b.bits ? a.mask : b.mask;
    return ((a.net & mask) >>> 0) === ((b.net & mask) >>> 0);
  }
  /**
   * The subnet two gateways share (text of the wider one) or null. Like the
   * network watch's "Heimnetz" (services/homeNetwork.js) the subnet alone is
   * weak — every FRITZ!Box household has 192.168.178.0/24 — so two gateways
   * that report different routers are not in the same LAN. Only a suggestion.
   */
  function sameLan(a, b) {
    if (!a || !b || String(a.peer_id) === String(b.peer_id)) return null;
    const ta = (a.health && a.health.telemetry) || {};
    const tb = (b.health && b.health.telemetry) || {};
    if (ta.default_gateway_ip && tb.default_gateway_ip && ta.default_gateway_ip !== tb.default_gateway_ip) return null;
    for (const x of subnetsOf(a)) for (const y of subnetsOf(b)) if (overlap(x, y)) return (x.bits <= y.bits ? x : y).text;
    return null;
  }

  /**
   * The dashed hint card of "Einzelne Gateways": which single gateway to
   * protect (the one with the most routes) and a partner in the same LAN
   * that is in no pool either (null when there is none).
   */
  function suggestion(singles) {
    const list = (singles || []).filter((g) => !g.never_connected);
    if (!list.length) return null;
    const ranked = list.slice().sort((a, b) => ((b.routes || []).length - (a.routes || []).length) || String(a.name).localeCompare(String(b.name)));
    for (const g of ranked) {
      const partner = list.find((o) => sameLan(g, o));
      if (partner) return { g, partner, lan: sameLan(g, partner) };
    }
    return { g: ranked[0], partner: null, lan: null };
  }

  // ─── Live state of a gateway (src/services/gatewayLiveState.js) ───────
  /** ms → "m:ss" (a countdown; 0:00 at the end). */
  function clock(ms) {
    const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  const LIVE_TONE = { online: 'green', degraded: 'amber', updating: 'blue', restarting: 'blue', offline: 'grey', pending: 'grey' };
  /**
   * What the page shows for a gateway: { key, tone, hint }.
   *   key   'online' | 'degraded' | 'updating' | 'restarting' | 'offline' | 'pending'
   *         (labels gateways.<key>, gwp.live.updating / gwp.live.restarting)
   *   tone  green | amber | blue | grey (tag-<tone>)
   *   hint  null, or { key, until } — reachable again, the routes wait for
   *         the failback cooldown (gwp.live.failback_in / gwp.live.reserve_in,
   *         {{left}} counts down to `until`), or the end of an expected restart
   *         (gwp.live.expected_by, {{time}}).
   * From the server's live state (GET /api/v1/gateways: state, failback_at,
   * expected_back_by); an older answer without `state` keeps the old rule.
   */
  function liveOf(g, now) {
    const t = now == null ? Date.now() : now;
    const mk = (key, hint) => ({ key, tone: LIVE_TONE[key], hint: hint || null });
    if (!g) return mk('pending');
    if (!g.state) {
      if (g.status === 'offline') return mk('offline');
      if (!g.health || g.status === 'unknown') return mk('pending');
      return mk(g.health.overall_healthy === false ? 'degraded' : 'online');
    }
    if (g.state === 'updating' || g.state === 'restarting') {
      return mk(g.state, g.expected_back_by ? { key: 'gwp.live.expected_by', until: g.expected_back_by } : null);
    }
    if (g.state === 'offline') return mk('offline');
    if (g.state !== 'online') return mk('pending');
    // reachable: the sliding window still says offline only for a heartbeat
    // that reports a failure (listener_failed) — degraded, like overall_healthy false
    const degraded = (g.health && g.health.overall_healthy === false) || g.status === 'offline';
    const hint = g.failback_at && g.failback_at > t
      ? { key: g.failback_takes_routes === false ? 'gwp.live.reserve_in' : 'gwp.live.failback_in', until: g.failback_at } : null;
    return mk(degraded ? 'degraded' : 'online', hint);
  }
  /**
   * How long the gateways page waits for its next poll: 5 s while a gateway
   * is on its way back (update, restart, failback wait) or went away in the
   * last 15 minutes — the SSE events usually come first, this is the safety
   * net —, otherwise 30 s.
   */
  function pollDelay(gateways, now) {
    const t = now == null ? Date.now() : now;
    const busy = (gateways || []).some((g) => g && (g.state === 'updating' || g.state === 'restarting' || g.update_state === 'updating'
      || (g.failback_at && g.failback_at > t)
      || (g.state === 'offline' && g.offline_since && t - g.offline_since < 15 * 60000)));
    return busy ? 5000 : 30000;
  }

  // ─── "Zustand" of a gateway (tab "Übersicht") ─────────────────────────
  /**
   * The checks of the card "Zustand" in order of importance:
   * [{ tone: 'ok'|'warn'|'bad'|'info', key, params, link }] (i18n gwp.state.*).
   * ctx: { status (liveOf().key), latest, fresh (new devices of the network watch, or null), agoText,
   *        untilText (end of an expected restart), failback ({ key, left, until }: the failback wait) }
   */
  function healthChecks(g, ctx) {
    const c = ctx || {};
    const h = (g && g.health) || {};
    const out = [];
    if (g.never_connected) return [{ tone: 'bad', key: 'gwp.state.never' }];
    // away: offline, or on purpose (update / restart) — nothing it reported holds now
    const away = c.status === 'offline' || c.status === 'updating' || c.status === 'restarting';
    if (c.status === 'offline') out.push({ tone: 'bad', key: 'gwp.state.offline', params: { ago: c.agoText || '—' } });
    else if (away) out.push({ tone: 'warn', key: 'gwp.state.' + c.status, params: { ago: c.agoText || '—', time: c.untilText || '—' } });
    else out.push({ tone: 'ok', key: 'gwp.state.tunnel', params: { ago: c.agoText || '—' } });
    if (c.status === 'degraded') out.push({ tone: 'warn', key: 'gwp.state.degraded' });
    if (c.failback) out.push({ tone: 'info', key: c.failback.key, params: { left: c.failback.left || '—' }, until: c.failback.until });
    const rr = Array.isArray(h.route_reachability) ? h.route_reachability : [];
    if (rr.length && !away) {
      const up = rr.filter((r) => r && r.reachable).length;
      out.push({ tone: up === rr.length ? 'ok' : (up === 0 ? 'bad' : 'warn'), key: 'gwp.state.routes', params: { up, n: rr.length } });
    }
    if (!away) out.push(h.config_hash ? { tone: 'ok', key: 'gwp.state.synced' } : { tone: 'warn', key: 'gwp.state.sync_unknown' });
    if (c.fresh) out.push({ tone: 'warn', key: c.fresh === 1 ? 'gwp.state.new_one' : 'gwp.state.new', params: { n: c.fresh }, link: 'net' });
    if (g.update_available && c.latest) out.push({ tone: 'info', key: 'gwp.state.update', params: { version: c.latest } });
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return out.map((x, i) => ({ x, i })).sort((a, b) => order[a.x.tone] - order[b.x.tone] || a.i - b.i).map((y) => y.x);
  }
  function overall(checks) {
    if ((checks || []).some((c) => c.tone === 'bad')) return 'bad';
    if ((checks || []).some((c) => c.tone === 'warn')) return 'warn';
    return 'ok';
  }

  // ─── Tab "Funktionen" ─────────────────────────────────────────────────
  // The cards of the tab and the rows (data-feature of gateway-net.js /
  // gateway-home.js) they hold.
  const FEATURE_GROUPS = [
    { key: 'home', features: ['netwatch', 'presence', 'lan'] },
    // phase 3c: printers and scanners, radio (Zigbee, Bluetooth, Thread; later also cameras)
    // phase 3c, step 3: the local AI between printing and radio (as in the design)
    // phase 3c, step 4: the cameras right after printing (as in the design)
    { key: 'devices', features: ['print', 'cameras', 'ai', 'radio', 'zigbee'] },
    { key: 'wide', features: ['dns', 'cache'] },
    { key: 'power', features: ['inetq', 'ups'] },
    { key: 'ext', features: ['edge'] },
    { key: 'system', features: ['timezone'] },
  ];
  function groupOf(feature) {
    const g = FEATURE_GROUPS.find((x) => x.features.indexOf(feature) >= 0);
    return g ? g.key : null;
  }

  /**
   * Which functions are on: [{ key, on }] for the chips of the card
   * "Funktionen" and the badge "n an" — only functions this gateway has.
   * d: the features overview (GET /api/v1/gateways/:id/features → gateway).
   */
  function featureStates(d) {
    if (!d || !d.features) return [];
    const f = d.features;
    const out = [];
    const add = (key, on) => out.push({ key, on: !!on });
    add('netwatch', f.netwatch && f.netwatch.enabled);
    add('inetq', f.inetq && f.inetq.enabled);
    add('presence', f.netwatch && f.netwatch.enabled && f.presence && f.presence.enabled);
    if (d.dns) add('dns', d.dns.enabled);
    if (d.cache) add('cache', d.cache.enabled);
    if (d.print) add('print', d.print.enabled);
    if (d.cameras) add('cameras', d.cameras.enabled);
    if (d.ai) add('ai', d.ai.enabled);
    if (d.edge) { add('edge', d.edge.enabled); add('mqtt', d.edge.enabled && d.edge.mqtt); }
    if (d.radio) add('radio', d.radio.enabled);
    else if (d.zigbee) add('zigbee', d.zigbee.enabled);
    add('ups', f.ups && f.ups.enabled);
    if (d.lanDiscovery && d.lanDiscovery.available) add('lan', d.lanDiscovery.enabled);
    if (d.timezone) add('timezone', true);
    return out;
  }

  /** A tab whose function is switched off (shown muted, "· aus"). */
  function tabOff(d, tab) {
    if (!d || !d.features) return false;
    const f = d.features;
    if (tab === 'net') return !(f.netwatch && f.netwatch.enabled);
    if (tab === 'inet') return !(f.inetq && f.inetq.enabled);
    if (tab === 'dns') return !!d.dns && !d.dns.enabled;
    if (tab === 'cache') return !!d.cache && !d.cache.enabled;
    if (tab === 'edge') return !!d.edge && !d.edge.enabled;
    if (tab === 'mqtt') return !!d.edge && !(d.edge.enabled && d.edge.mqtt);
    if (tab === 'radio') return !!d.radio && !d.radio.enabled;
    return false;
  }

  /** The memory estimate of one switched-on part (MB) or null — no number without data. */
  function memoryOf(d, feature) {
    const parts = (d && d.memory && d.memory.parts) || [];
    // the row "Funk": deCONZ + the Bluetooth scan
    if (feature === 'radio') {
      const mb = parts.filter((x) => x && (x.key === 'deconz' || x.key === 'ble')).reduce((a, x) => a + (x.mb > 0 ? x.mb : 0), 0);
      return mb > 0 ? mb : null;
    }
    const key = feature === 'zigbee' ? 'deconz' : feature;   // 'ai': the model of the local AI
    const p = parts.find((x) => x && x.key === key);
    if (!p || !(p.mb > 0)) return null;
    const mosq = feature === 'edge' ? parts.find((x) => x && x.key === 'mosquitto') : null;
    return p.mb + (mosq ? mosq.mb : 0);
  }

  return {
    parsePoolHash, poolsOf, memberOf, fleetGroups, statusTone, roleOf, rankOf, activeMember, standbys,
    reserveGap, nextStandby, effectiveStatus,
    duration, COOLDOWN_PRESETS, proposeCooldown, presetFor,
    cidr, subnetsOf, sameLan, suggestion,
    healthChecks, overall,
    clock, liveOf, pollDelay,
    FEATURE_GROUPS, groupOf, featureStates, tabOff, memoryOf,
  };
});
