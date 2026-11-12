'use strict';

// Filter service of the DNS protection for VPN devices — its OWN process
// (supervisord program `dnsfilter`, scripts/dnsfilter-wrapper.sh), never part
// of the server's event loop. dnsmasq stays in front and forwards to it
// (services/dnsChain.js, provider 'vpnfilter'); it answers on
// 127.0.0.1#<port> over UDP and TCP with the filter engine of the gateways
// (dnsfilter-core/, a mirrored copy — VENDORED.md).
//
// What the server tells it: ONE file, <state dir>/config.json, written
// atomically by services/vpnDns.js (shape: see apply()). The service reads it
// at start, when told over the control socket and whenever the file changed
// (checked every 2 s) — settings change without a restart.
// What it tells the server: answers on the control socket
// <state dir>/control.sock, one JSON line per request (status, take, test …).
//
// The six duties of a provider of the DNS chain (measured with dnsmasq 2.91):
//   1. UDP and TCP on 127.0.0.1; the asking device comes as EDNS Client
//      Subnet /32 from dnsmasq (`add-subnet`) — taken only from loopback.
//   2. The chain's probe (`. NS` from loopback, no ECS) is answered here,
//      without the upstream: the probe asks "does the filter live".
//   3. An answer cache of its own (with add-subnet dnsmasq caches nothing).
//   4. TC rule: dnsmasq merges identical UDP queries of different devices
//      that are under way at the same time and hands ONE answer to all of
//      them. Whenever the answer depends on who asks — the asker is allowed,
//      but another profile (or an unfiltered device) would get something
//      else — the UDP answer is only "truncated" (TC=1): every device repeats
//      over TCP, which dnsmasq forwards one by one with the right address.
//   5. Names dnsmasq answers itself (peers.hosts: route domains, portal, API
//      host — `internal` in the config) are never blocked: their other record
//      types (AAAA, HTTPS, MX) do reach the filter.
//   6. No ECS or a loopback address = the server itself → never filtered.
//
// Fail-open: whatever goes wrong inside (decision, lists, config) ends in
// "forward unfiltered", never in "no answer". The process dying is the
// chain's business: the server falls back to the default upstreams within
// seconds.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const core = require('./dnsfilter-core');

const { wire, Policy, Resolver, ResponseCache, Upstream, DnsListener, DnsStats, ListManager, cleanDomain, routerQuery, fetchList, isLoopback } = core;
const { hasHash } = require('./dnsfilter-core/domainSet');
const { TYPE, RCODE } = wire;
const { hash53, suffixes, PatternSet } = core;

const DEFAULT_PORT = 5354;
const CONFIG_FILE = 'config.json';
const SOCKET_FILE = 'control.sock';
const PID_FILE = 'service.pid';
const WATCH_MS = 2000;
const LISTS_MS = 10 * 60_000;
const LISTEN_RETRY_MS = 5000;
const READY_MAX_MS = 45_000;
const MAX_LOG_QUEUE = 5000;
const MAX_CLIENT_COUNTERS = 2048;
const MAX_REQUEST = 64 * 1024;
const USER_AGENT = 'GateControl-Server';
// Stands for "any device of this profile" when the TC rule and "Domain
// prüfen" ask how a profile would decide.
const REP = '#profile:';

const EMPTY_POLICY = Object.freeze({ alwaysAllow: [], lists: {}, categories: {}, profiles: [], defaultProfile: null, pauses: [], extensions: [] });

/** The engine's policy plus the names dnsmasq answers itself (exact names, never blocked). */
class VpnPolicy extends Policy {
  constructor(cfg, opts, internal) {
    super(cfg, opts);
    this.internal = internal;
  }

  decide(name, key, now) {
    if (this.internal.has(name)) {
      const p = this.profileFor(key);
      return { profileId: p ? p.id : null, action: 'allow', reason: 'internal' };
    }
    return super.decide(name, key, now);
  }
}

function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function strings(v, max) { return arr(v).filter((x) => typeof x === 'string' && x.length <= 253).slice(0, max); }

/**
 * The entry of a small pattern set that matches `name`:
 * { entry: 'tiktok.com', kind: 'domain' } (the domain and everything below it),
 * { entry: '*.tiktok.com', kind: 'subdomains' } (only what is below it) or null.
 */
function patternHit(set, name) {
  if (!set || !set.size) return null;
  if (set.incl.has(name)) return { entry: name, kind: 'domain' };
  for (const s of suffixes(name).slice(1)) {
    if (set.incl.has(s)) return { entry: s, kind: 'domain' };
    if (set.sub.has(s)) return { entry: '*.' + s, kind: 'subdomains' };
  }
  return null;
}

/**
 * The entry of a loaded list that blocks `name`. The lists are kept as hashes,
 * but the name asked for is known — so the entry is the end of the name whose
 * hash is in the list: { entry, kind: 'exact' } (hosts lists: this name only)
 * or { entry, kind: 'domain' } (the domain and everything below it).
 */
function listHit(list, name) {
  if (!list) return null;
  const parts = suffixes(name);
  if (list.exact.length && hasHash(list.exact, hash53(name))) return { entry: name, kind: 'exact' };
  for (const s of parts) if (hasHash(list.suffix, hash53(s))) return { entry: s, kind: 'domain' };
  return null;
}

/** How blocked queries are counted: by what blocked them. */
function blockKind(d, scope) {
  if (d.reason === 'list') return 'list';
  if (d.reason === 'profile_deny') return scope === 'all' ? 'denyAll' : 'denyProfile';
  if (d.reason === 'schedule' || d.reason === 'schedule_category') return 'schedule';
  if (d.reason === 'paused') return 'pause';
  return 'other';
}

/** '1.1.1.1' | '1.1.1.1#5300' → { ip, port } or null. */
function plainTarget(v) {
  const m = typeof v === 'string' ? /^([0-9a-fA-F.:]+?)(?:#(\d{1,5}))?$/.exec(v.trim()) : null;
  if (!m || !net.isIP(m[1])) return null;
  const port = m[2] ? Number(m[2]) : 53;
  return port >= 1 && port <= 65535 ? { ip: m[1], port } : null;
}

/**
 * The config file → what the service works with. The server writes it
 * normalised (services/vpnDns.js); this only makes sure that a damaged file
 * cannot take the service down: everything the engine reads without checking
 * is an array / object afterwards.
 */
function sanitize(raw) {
  const r = obj(raw);
  const pol = obj(r.policy);
  const profiles = [];
  for (const p of arr(pol.profiles).slice(0, 64)) {
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    profiles.push({
      id: p.id,
      lists: strings(p.lists, 32),
      allow: strings(p.allow, 2000),
      deny: strings(p.deny, 2000),
      safeSearch: p.safeSearch === true,
      clients: strings(p.clients, 100000),
      schedules: arr(p.schedules).slice(0, 32).filter((s) => s && Array.isArray(s.days) && Number.isInteger(s.from) && Number.isInteger(s.to))
        .map((s) => ({ days: s.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7), from: s.from, to: s.to, block: s.block === 'all' ? 'all' : 'categories', categories: strings(s.categories, 32), allowAlways: strings(s.allowAlways, 2000) })),
    });
  }
  const lists = {};
  for (const [id, l] of Object.entries(obj(pol.lists))) {
    if (l && typeof l.url === 'string' && ['domains', 'hosts', 'adblock'].includes(l.format)) lists[id] = { url: l.url, format: l.format, sha256: typeof l.sha256 === 'string' ? l.sha256 : null };
  }
  const categories = {};
  for (const [id, v] of Object.entries(obj(pol.categories))) categories[id] = strings(v, 2000);
  const clients = new Map();
  for (const [ip, key] of Object.entries(obj(r.clients))) if (net.isIP(ip) && typeof key === 'string' && key) clients.set(ip, key);
  const sus = obj(r.suspended);
  const until = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const keys = new Map();
  for (const [k, v] of Object.entries(obj(sus.keys))) if (until(v) !== null) keys.set(k, v);
  const up = obj(r.upstream);
  const port = Number(r.port);
  return {
    rev: Number.isFinite(r.rev) ? r.rev : 0,
    enabled: r.enabled === true,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 && port !== 53 ? port : DEFAULT_PORT,
    tz: typeof r.tz === 'string' && r.tz.length <= 64 ? r.tz : null,
    logQueries: r.logQueries === true,
    blockResponse: r.blockResponse === 'nxdomain' ? 'nxdomain' : 'zero',
    upstream: {
      provider: typeof up.provider === 'string' ? up.provider : 'quad9',
      url: typeof up.url === 'string' ? up.url : null,
      fallbackRouter: up.fallbackRouter !== false,
    },
    plain: arr(r.plain).map(plainTarget).filter(Boolean).slice(0, 4),
    internal: new Set(strings(r.internal, 20000)),
    // pauses / extensions: "Internet aus bis" / "Zeiten ausgesetzt bis" of a person (homeInternet.js), as device keys
    policy: { alwaysAllow: strings(pol.alwaysAllow, 2000), lists, categories, profiles, defaultProfile: null, pauses: untilEntries(pol.pauses), extensions: untilEntries(pol.extensions) },
    // "Immer erlaubt" / "Immer gesperrt" of the whole protection. They are part
    // of every profile's allow/deny already; kept apart as well so an answer
    // can say whether an entry holds for everybody or only in the profile.
    globalAllow: new PatternSet(strings(pol.globalAllow, 2000)),
    globalDeny: new PatternSet(strings(pol.globalDeny, 2000)),
    clients,
    suspended: { all: until(sus.all), keys },
  };
}

/** [{ clients: [key], until: ms }] — only entries the engine can read. */
function untilEntries(v) {
  return arr(v).slice(0, 4096).filter((e) => e && Number.isFinite(e.until) && e.until > 0)
    .map((e) => ({ clients: strings(e.clients, 4096), until: e.until })).filter((e) => e.clients.length);
}

/** Is a suspension (until ms, 0 = until somebody switches the protection on again) running? */
function running(until, now) { return until === 0 || (until !== null && until !== undefined && until > now); }

class FilterService {
  /**
   * @param stateDir  where config.json, the control socket and the lists live
   * @param logger    pino style ({ info, warn, debug })
   * @param fetch     list download (tests)
   * @param onExit    called for the control command `exit`
   */
  constructor({ stateDir, logger = null, now = Date.now, fetch = null, onExit = () => {}, watchMs = WATCH_MS, listsMs = LISTS_MS, readyMaxMs = READY_MAX_MS }) {
    Object.assign(this, { stateDir, now, onExit, watchMs, listsMs, readyMaxMs });
    this.logger = logger || { info() {}, warn() {}, debug() {} };
    this.cfg = sanitize(null);
    this.cfgStamp = null;
    this.startedAt = now();
    this.ready = false;
    this.readyAt = null;
    this.counters = { tc: 0, failOpen: 0, probes: 0, logDropped: 0, reloads: 0, configErrors: 0 };
    this.clientCounters = new Map();
    this.blockedBy = {};
    this.logQueue = [];
    this.cache = new ResponseCache({ now });
    this.realStats = new DnsStats({ now });
    this.lists = new ListManager({
      stateDir, now, logger: this.logger,
      fetch: fetch || ((u, d, o) => fetchList(u, d, { ...o, userAgent: USER_AGENT })),
      onChange: () => this._rebuildPolicy(),
    });
    this.upstream = null;
    this.upstreamKey = null;
    this.policy = new VpnPolicy(EMPTY_POLICY, {}, new Set());
    this.profileIds = [];
    this.resolver = new Resolver({
      getPolicy: () => this.policy,
      // No `fromIp`: the sender is always dnsmasq on loopback, and a plain
      // resolver on loopback (tests, a local unbound) is a legitimate target.
      upstream: { query: (w) => this._up().query(w, {}), local: (w) => this._up().local(w, {}) },
      // While the protection is suspended for everybody nothing is counted.
      stats: { record: (r) => { if (!running(this.cfg.suspended.all, this.now())) this.realStats.record(r); } },
      now,
      cache: this.cache,
      blockResponse: () => this.cfg.blockResponse,
      ecsClient: true,
      clientFor: (ip) => this._effectiveKey(ip, this.now()),
    });
    this.listener = new DnsListener({
      handle: (msg, o) => this.handle(msg, o),
      port: DEFAULT_PORT,
      addresses: () => [{ address: '127.0.0.1', family: 4 }],
    });
    this.listen = { state: 'off', listen: [], busy: [], failed: {}, port: DEFAULT_PORT };
    this.timers = [];
    this.control = null;
    this.applying = Promise.resolve();
  }

  _up() {
    if (!this.upstream) throw new Error('no upstream');
    return this.upstream;
  }

  // ─── Upstream ────────────────────────────────────────────────────────

  /** The plain resolvers of the server (GC_DNSMASQ_UPSTREAMS), one after the other. */
  async _plainQuery(msg) {
    let last = new Error('no plain resolver');
    for (const t of this.cfg.plain) {
      try { return await routerQuery(t.ip, msg, { port: t.port }); } catch (err) { last = err; }
    }
    throw last;
  }

  _makeUpstream(up) {
    // 'system': no DoH at all, the plain resolvers of the server.
    if (up.provider === 'system') {
      const state = { provider: 'system', lastOkAt: null, lastError: null, lastFallbackAt: null, dohFailures: 0, fallbacks: 0, dohDownUntil: 0 };
      const ask = async (w) => {
        try {
          const r = await this._plainQuery(w);
          state.lastOkAt = this.now();
          return { wire: r, via: 'router' };
        } catch (err) {
          state.lastError = { at: this.now(), code: err.code || 'error' };
          throw err;
        }
      };
      return { state, query: ask, local: ask, close() {} };
    }
    const first = () => (this.cfg.plain[0] ? this.cfg.plain[0].ip : null);
    return new Upstream({
      upstream: core.PROVIDERS[up.provider] ? { provider: up.provider, fallbackRouter: up.fallbackRouter } : { provider: 'custom', url: up.url, fallbackRouter: up.fallbackRouter },
      routerIp: first,
      routerQueryFn: (_ip, w) => this._plainQuery(w),
      now: this.now,
    });
  }

  // ─── Settings ────────────────────────────────────────────────────────

  _rebuildPolicy() {
    const pol = this.cfg.policy;
    try {
      this.policy = new VpnPolicy(
        { ...pol, profiles: pol.profiles.map((p) => ({ ...p, clients: [...p.clients, REP + p.id] })) },
        { lists: this.lists.lists },
        this.cfg.internal,
      );
      // Only profiles somebody is in can make an answer depend on the asker.
      this.profileIds = pol.profiles.filter((p) => p.clients.length).map((p) => p.id);
    } catch (err) {
      // A profile the engine cannot read must not stop name resolution.
      this.logger.warn({ err: err.message }, 'dnsfilter: policy not built — nothing is filtered');
      this.policy = new VpnPolicy(EMPTY_POLICY, {}, this.cfg.internal);
      this.profileIds = [];
    }
  }

  /** Take over a config (already sanitised). One at a time. */
  apply(cfg) {
    const run = async () => {
      const prev = this.cfg;
      this.cfg = cfg;
      this.counters.reloads++;
      if (cfg.tz && process.env.TZ !== cfg.tz) process.env.TZ = cfg.tz; // the times of a profile are local times
      if (!cfg.logQueries && prev.logQueries) { this.logQueue = []; this.clientCounters.clear(); }
      const key = JSON.stringify([cfg.upstream, cfg.plain]);
      if (key !== this.upstreamKey) {
        if (this.upstream) this.upstream.close();
        this.upstream = this._makeUpstream(cfg.upstream);
        this.upstreamKey = key;
        this.cache.clear();
      }
      this._rebuildPolicy();
      const used = new Set(cfg.policy.profiles.flatMap((p) => p.lists));
      try { await this.lists.setWanted(cfg.policy.lists, used); } catch (err) { this.logger.warn({ err: err.message }, 'dnsfilter: lists'); }
      this._rebuildPolicy();
      if (this.listener.port !== cfg.port) {
        this.listener.close();
        this.listener.port = cfg.port;
      }
      if (cfg.enabled) {
        this.listen = await this.listener.reconcile();
        void this._refreshLists();
      } else {
        this.listener.close();
        this.listen = { ...this.listener.status(), state: 'off' };
      }
    };
    this.applying = this.applying.then(run, run);
    return this.applying;
  }

  /** Read config.json when it changed (or `force`). A file that cannot be read keeps the settings in force. */
  async loadConfig(force = false) {
    const file = path.join(this.stateDir, CONFIG_FILE);
    // One open file for the check and the read: the server replaces the file
    // by renaming a new one over it, and what was checked must be what is read.
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return false; }
    let stamp;
    let raw;
    try {
      const st = fs.fstatSync(fd);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (!force && stamp === this.cfgStamp) return false;
      this.cfgStamp = stamp;
      raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (err) {
      this.counters.configErrors++;
      this.logger.warn({ err: err.message }, 'dnsfilter: config.json not readable — keeping the settings in force');
      return false;
    } finally {
      fs.closeSync(fd);
    }
    await this.apply(sanitize(raw));
    return true;
  }

  async _refreshLists() {
    // A list switched on while another one was being loaded is not part of
    // that round: go again until nothing is left that was never tried.
    for (let round = 0; round < 4; round++) {
      try { await this.lists.refreshDue(); } catch (err) { this.logger.warn({ err: err.message }, 'dnsfilter: list refresh'); }
      const untried = [...this.lists.used].some((id) => { const m = this.lists.meta[id]; return m && !m.checkedAt && !this.lists.lists.has(id); });
      if (!untried) break;
    }
    if (!this.ready) { this.ready = true; this.readyAt = this.now(); }
  }

  // ─── One query ───────────────────────────────────────────────────────

  /** The address dnsmasq names as the asking device (ECS /32 from loopback), else the sender. */
  _clientIp(q, ip) {
    const ecs = q.edns && q.edns.ecs;
    if (!ecs || ecs.sourcePrefix !== (ecs.family === 4 ? 32 : 128)) return ip;
    return ip && isLoopback(ip) ? ecs.address : ip;
  }

  /** The device behind an address, whether filtered right now or not. */
  _realKey(ip) {
    return (ip && !isLoopback(ip) && this.cfg.clients.get(ip)) || null;
  }

  /** The key the policy decides with: null (= unfiltered) while the protection is suspended for the device. */
  _effectiveKey(ip, now) {
    const key = this._realKey(ip);
    if (!key) return null;
    // "Internet aus" of a person (a parent paused it) is not undone by suspending the protection
    if (this.policy.pausedUntil(key, now)) return key;
    const sus = this.cfg.suspended;
    if (running(sus.all, now) || running(sus.keys.get(key), now)) return null;
    return key;
  }

  /**
   * Would somebody else get a different answer for this name right now?
   * "Somebody else" is every profile with devices and the unfiltered ones
   * (the server itself, gateways, suspended and excluded devices).
   */
  _dependsOnAsker(name, d, now) {
    if (d.reason === 'local' || d.reason === 'canary' || d.reason === 'always_allow' || d.reason === 'internal') return false;
    const mine = d.safeSearch || '';
    if (d.profileId !== null && mine) return true; // the unfiltered get the search engine itself
    for (const id of this.profileIds) {
      if (id === d.profileId) continue;
      const o = this.policy.decide(name, REP + id, now);
      if (o.action !== 'allow' || (o.safeSearch || '') !== mine) return true;
    }
    return false;
  }

  /**
   * What a decision was made of, for "Domain prüfen", the query log and the
   * counters: `scope` — an own entry holds for everybody ('all') or only in
   * the profile ('profile') — and `match`, the entry that hit.
   */
  _explain(name, d) {
    try {
      if (d.reason === 'profile_deny' || d.reason === 'profile_allow') {
        const allow = d.reason === 'profile_allow';
        const all = patternHit(allow ? this.cfg.globalAllow : this.cfg.globalDeny, name);
        if (all) return { scope: 'all', match: all };
        const p = this.policy.profiles.get(d.profileId);
        return { scope: 'profile', match: p ? patternHit(allow ? p.allowSet : p.denySet, name) : null };
      }
      if (d.reason === 'list') return { scope: null, match: listHit(this.lists.lists.get(d.list), name) };
      if (d.reason === 'schedule_category') return { scope: null, match: patternHit(this.policy.categories.get(d.category), name) };
    } catch { /* an explanation never stands in the way of an answer */ }
    return { scope: null, match: null };
  }

  _note(key, suspended, q, d, now) {
    const scope = d.reason === 'profile_deny' || d.reason === 'profile_allow' ? this._explain(q.name, d).scope : null;
    // counted like the totals: not while the protection is suspended for everybody
    if (d.action === 'block' && !running(this.cfg.suspended.all, now)) {
      const kind = blockKind(d, scope);
      this.blockedBy[kind] = (this.blockedBy[kind] || 0) + 1;
    }
    if (!this.cfg.logQueries || !key) return;
    if (!suspended) {
      let c = this.clientCounters.get(key);
      if (!c && this.clientCounters.size < MAX_CLIENT_COUNTERS) { c = { queries: 0, blocked: 0 }; this.clientCounters.set(key, c); }
      if (c) { c.queries++; if (d.action === 'block') c.blocked++; }
    }
    if (this.logQueue.length >= MAX_LOG_QUEUE) { this.logQueue.shift(); this.counters.logDropped++; }
    this.logQueue.push({
      at: now, key, name: q.name, type: wire.typeName(q.qtype),
      action: d.action, reason: suspended ? 'suspended' : d.reason, profileId: d.profileId,
      list: d.list || null, category: d.category || null, safeSearch: d.safeSearch || null, scope: suspended ? null : scope,
    });
  }

  /** Forward without any decision — the way out when something inside failed. */
  async _failOpen(msg) {
    this.counters.failOpen++;
    const q = wire.parseQuery(msg);
    if (!q || !q.question || q.name === null) return null;
    try {
      const r = await this._up().query(wire.buildQuery({ name: q.name, qtype: q.qtype, qclass: q.qclass, edns: q.edns ? { do: q.edns.do } : null, cd: q.cd }), {});
      return wire.adaptResponse(r.wire, { id: q.id, question: q.question, ttlOffsets: [], ageSec: 0 });
    } catch {
      return wire.buildResponse(q, { rcode: RCODE.SERVFAIL });
    }
  }

  async handle(msg, { ip = null, udp = false } = {}) {
    try {
      const q = wire.parseQuery(msg);
      if (q && q.question && q.opcode === 0 && q.nameOk && q.name !== null && q.qclass === wire.CLASS_IN) {
        // the chain's probe: answered here, whatever the upstream does
        if (q.name === '' && q.qtype === TYPE.NS && !(q.edns && q.edns.ecs) && ip && isLoopback(ip)) {
          this.counters.probes++;
          return wire.buildResponse(q, {});
        }
        const now = this.now();
        const clientIp = this._clientIp(q, ip);
        const real = this._realKey(clientIp);
        const key = this._effectiveKey(clientIp, now);
        const d = this.policy.decide(q.name, key, now);
        if (udp && d.action === 'allow' && this._dependsOnAsker(q.name, d, now)) {
          this.counters.tc++;
          return wire.buildResponse(q, { tc: true });
        }
        this._note(real, real !== null && key === null, q, d, now);
      }
      return await this.resolver.handle(msg, { ip, udp });
    } catch (err) {
      this.logger.warn({ err: err.message }, 'dnsfilter: query failed inside — forwarded unfiltered');
      return this._failOpen(msg);
    }
  }

  // ─── Control socket ──────────────────────────────────────────────────

  status() {
    const up = this.upstream ? this.upstream.state : null;
    const mem = process.memoryUsage();
    const now = this.now();
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      rev: this.cfg.rev,
      enabled: this.cfg.enabled,
      ready: this.ready && this.listen.state === 'running',
      listen: this.listen,
      upstream: up ? {
        provider: up.provider, lastOkAt: up.lastOkAt, lastError: up.lastError, lastFallbackAt: up.lastFallbackAt,
        fallbacks: up.fallbacks, dohDown: up.dohDownUntil > now,
      } : null,
      lists: this.lists.telemetry(),
      listsBytes: this.lists.memoryBytes(),
      listsEntries: this.lists.totalEntries(),
      cacheEntries: this.cache.size,
      cacheBytes: this.cache.bytes,
      totals: { ...this.realStats.total },
      counters: { ...this.counters, udpDropped: this.listener.dropped },
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external },
      profiles: this.cfg.policy.profiles.length,
      clients: this.cfg.clients.size,
      logQueries: this.cfg.logQueries,
      logQueued: this.logQueue.length,
    };
  }

  /** "Domain prüfen": how would the name be decided for a device (key), a profile or an unfiltered device? */
  test({ domain, key = null, profileId = null }) {
    const name = cleanDomain(String(domain || ''), { allowSingleLabel: true });
    if (!name) return { error: 'invalid_domain' };
    const now = this.now();
    let k = null;
    let suspended = false;
    if (typeof profileId === 'string' && profileId) {
      if (!this.policy.profiles.has(profileId)) return { error: 'unknown_profile' };
      k = REP + profileId;
    } else if (typeof key === 'string' && key) {
      const sus = this.cfg.suspended;
      suspended = !this.policy.pausedUntil(key, now) && (running(sus.all, now) || running(sus.keys.get(key), now));
      k = suspended ? null : key;
    }
    const r = this.policy.decide(name, k, now);
    const out = { domain: name, profileId: r.profileId, action: r.action, reason: suspended ? 'suspended' : r.reason };
    if (r.list) out.list = r.list;
    if (r.category) out.category = r.category;
    if (r.safeSearch) out.safeSearch = r.safeSearch;
    if (!suspended) Object.assign(out, this._explain(name, r));
    return out;
  }

  /** Counters since the last take (and, with the query log on, per device and the entries). */
  take() {
    const { body } = this.realStats.take();
    const clients = Object.fromEntries(this.clientCounters);
    this.clientCounters = new Map();
    const blockedBy = this.blockedBy;
    this.blockedBy = {};
    const log = this.logQueue;
    this.logQueue = [];
    const dropped = this.counters.logDropped;
    this.counters.logDropped = 0;
    return { stats: body, blockedBy, clients, log, logDropped: dropped };
  }

  refreshLists() {
    for (const m of Object.values(this.lists.meta)) if (m) m.nextAt = 0;
    void this._refreshLists();
    return { started: true };
  }

  async command(req) {
    switch (req && req.op) {
      case 'status': return this.status();
      case 'reload': await this.loadConfig(true); return this.status();
      case 'take': return this.take();
      case 'test': return this.test(req);
      case 'refreshLists': return this.refreshLists();
      case 'exit': setImmediate(() => this.onExit(0)); return { exiting: true };
      default: return { error: 'unknown_op' };
    }
  }

  _serveControl() {
    const file = path.join(this.stateDir, SOCKET_FILE);
    try { fs.rmSync(file, { force: true }); } catch { /* not there */ }
    this.control = net.createServer((c) => {
      let buf = '';
      let done = false;
      c.setEncoding('utf8');
      c.setTimeout(10_000, () => c.destroy());
      c.on('error', () => {});
      c.on('data', (chunk) => {
        if (done) return;
        buf += chunk;
        if (buf.length > MAX_REQUEST) { c.destroy(); return; }
        const i = buf.indexOf('\n');
        if (i === -1) return;
        done = true;
        let req = null;
        try { req = JSON.parse(buf.slice(0, i)); } catch { /* answered below */ }
        Promise.resolve()
          .then(() => (req ? this.command(req) : { error: 'bad_request' }))
          .then((res) => ({ ok: !res.error, ...res }), (err) => ({ ok: false, error: 'failed', message: err.message }))
          .then((res) => { if (!c.destroyed) c.end(JSON.stringify(res) + '\n'); });
      });
    });
    this.control.on('error', (err) => this.logger.warn({ err: err.message }, 'dnsfilter: control socket'));
    return new Promise((resolve) => {
      this.control.listen(file, () => {
        try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
        resolve();
      });
      this.control.once('error', () => resolve());
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  _every(ms, fn) {
    const t = setInterval(() => { Promise.resolve().then(fn).catch((err) => this.logger.warn({ err: err.message }, 'dnsfilter: timer')); }, ms);
    this.timers.push(t);
  }

  async start() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(path.join(this.stateDir, PID_FILE), String(process.pid), { mode: 0o600 }); } catch { /* best effort */ }
    await this._serveControl();
    await this.loadConfig(true);
    this._every(this.watchMs, () => this.loadConfig(false));
    this._every(this.listsMs, () => (this.cfg.enabled ? this._refreshLists() : null));
    this._every(LISTEN_RETRY_MS, async () => {
      if (this.cfg.enabled && this.listen.state !== 'running') this.listen = await this.listener.reconcile();
    });
    // A list server that does not answer must not keep the filter out of the chain for ever.
    const t = setTimeout(() => { if (!this.ready) { this.ready = true; this.readyAt = this.now(); } }, this.readyMaxMs);
    this.timers.push(t);
    return this.status();
  }

  stop() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
    this.listener.close();
    if (this.upstream) this.upstream.close();
    if (this.control) { try { this.control.close(); } catch { /* closed */ } }
    try { fs.rmSync(path.join(this.stateDir, SOCKET_FILE), { force: true }); } catch { /* gone */ }
    try { fs.rmSync(path.join(this.stateDir, PID_FILE), { force: true }); } catch { /* gone */ }
  }
}

/* c8 ignore start */
function main() {
  const stateDir = process.env.GC_VPNDNS_DIR || '/data/vpn-dns';
  const line = (level) => (o, msg) => {
    const rec = typeof o === 'string' ? { msg: o } : { ...o, msg };
    process.stdout.write(JSON.stringify({ level, time: Date.now(), name: 'dnsfilter', ...rec }) + '\n');
  };
  const logger = { info: line(30), warn: line(40), debug() {} };
  const svc = new FilterService({
    stateDir, logger,
    onExit: (code) => { svc.stop(); process.exit(code); },
  });
  process.on('SIGTERM', () => { svc.stop(); process.exit(0); });
  process.on('SIGINT', () => { svc.stop(); process.exit(0); });
  // Nothing inside may end name resolution: log and go on. The chain notices a
  // service that really hangs and falls back.
  process.on('uncaughtException', (err) => logger.warn({ err: err && err.message }, 'uncaught exception'));
  process.on('unhandledRejection', (err) => logger.warn({ err: err && err.message }, 'unhandled rejection'));
  svc.start().then((st) => {
    logger.info({ port: st.listen.port, state: st.listen.state, enabled: st.enabled }, 'filter service started');
    // Switched off (the wrapper only starts the service while it is wanted): nothing to do, leave.
    setInterval(() => { if (!svc.cfg.enabled) { logger.info({}, 'filter service not wanted — leaving'); svc.stop(); process.exit(0); } }, 5000).unref();
  }, (err) => { logger.warn({ err: err.message }, 'filter service did not start'); process.exit(1); });
}

if (require.main === module) main();
/* c8 ignore stop */

module.exports = { FilterService, VpnPolicy, sanitize, untilEntries, plainTarget, running, patternHit, listHit, blockKind, DEFAULT_PORT, CONFIG_FILE, SOCKET_FILE, PID_FILE, REP, MAX_LOG_QUEUE };
