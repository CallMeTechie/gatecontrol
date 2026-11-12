'use strict';

// DNS protection for VPN devices — the server side (plugin API gc.vpnDns,
// permissions.vpnDns; docs/plugins.md "DNS protection").
//
// The filtering itself is done by the filter service, a process of its own
// (vpnDnsFilter/service.js, supervisord program `dnsfilter`). This module is
// everything around it and deliberately small on the event loop:
//
//   settings      one row (vpn_dns): on/off, upstream, own allow/deny
//                 entries, query log, excluded devices and the profiles —
//                 profiles[0] is the default profile (no members: every
//                 other device). Lists, categories and upstream providers
//                 are those of the gateways' DNS filter (homeDnsCatalog.js).
//   who gets what a profile names devices (peers), people (users), peer
//                 groups and person groups. Device beats person beats group
//                 (peer group before person group), then the default
//                 profile. Gateways are never filtered; a device with a DNS
//                 server of its own does not ask the server at all.
//   suspensions   "Unterbrechen" (vpn_dns_pauses): for all VPN devices, one
//                 device or all devices of a person, until a time or until
//                 switched on again. Suspended means unfiltered — never
//                 "no internet".
//   the service   gets ONE file (<dir>/config.json: profiles with client
//                 keys, address → key, suspensions, internal names) and is
//                 asked over its control socket (status, counters, "Domain
//                 prüfen"). It runs only while <dir>/enabled exists.
//   the chain     once the service is ready it becomes dnsmasq's only
//                 upstream through dnsChain.vpnFilter.enable(); a dead
//                 service puts dnsmasq back on the default upstreams within
//                 seconds (dnsChain.js) — activity entry, event, hook.
//
// None of it runs without a plugin that holds permissions.vpnDns and may run
// (installed, enabled, licensed): no service process, no chain entry, no
// timer. A server with Pi-hole only behaves exactly as before.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../config/default');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const catalog = require('./homeDnsCatalog');
const dnsChain = require('./dnsChain');
const { atomicWrite } = require('../utils/fs');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_ID = 'default';
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const LIMITS = Object.freeze({ profiles: 16, schedules: 12, patterns: 200, members: 256, excluded: 512, name: 40, top: 20, topKeep: 50, logPage: 500, pauseMinutes: 7 * 24 * 60, retentionDays: 90 });
const PROVIDERS = Object.freeze([...catalog.PROVIDER_IDS, 'system']);
const STARTING_MAX_MS = 60 * 1000;
const TICK_MS = 5000;
const TICK_STARTING_MS = 1000;
const CONFIG_EVERY_MS = 15 * 1000;
const TAKE_EVERY_MS = 60 * 1000;
const TAKE_LOG_EVERY_MS = 20 * 1000;
const HOOK_MS = 5000;
const LOG_CHUNK = 400;
const RETENTION_STEP = 5000;

class VpnDnsError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; if (extra) Object.assign(this, extra); }
}

function db() { return getDb(); }
function homeDns() { return require('./homeDns'); }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function bool(v, d) { return typeof v === 'boolean' ? v : d; }
function marks(ids) { return ids.map(() => '?').join(','); }
function ints(v, max) { return Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, max).sort((a, b) => a - b) : []; }
function invalid(message, extra) { return new VpnDnsError('ERR_INVALID', message, extra); }
function dayKey(ms) { return homeDns().dayKey(ms); }
function keyOf(peerId) { return `peer:${peerId}`; }

function dir() {
  return process.env.GC_VPNDNS_DIR || path.join(process.env.GC_DATA_PATH || '/data', 'vpn-dns');
}

function filterPort() {
  const p = Number(process.env.GC_VPNDNS_PORT);
  return Number.isInteger(p) && p >= 1 && p <= 65535 && p !== 53 ? p : dnsChain.VPNFILTER_PORT;
}

// ─── The plugin that owns the protection ───────────────────────────────

function hasPermission(p) {
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.vpnDns === true);
}

/** Plugins with permissions.vpnDns that may run (enabled, compatible, signed, licensed). */
function allowedPlugins() {
  try {
    const registry = require('./plugins/registry');
    const plugins = require('./plugins');
    return registry.list().filter(hasPermission).filter((p) => { try { return plugins.evaluate(p).run; } catch { return false; } });
  } catch { return []; }
}

/** Is there a plugin that may use the DNS protection? Without one nothing of it runs. */
function available() {
  return allowedPlugins().length > 0;
}

// ─── Settings ──────────────────────────────────────────────────────────

function defaultProfile() {
  return {
    id: DEFAULT_ID, name: homeDns().normalize(null).profiles[0].name,
    lists: catalog.LISTS.filter((l) => l.defaultOn).map((l) => l.id),
    safeSearch: false, allow: [], deny: [], schedules: [], groups: [], peerGroups: [], users: [], peers: [],
  };
}

function normProfile(p, i) {
  const r = p && typeof p === 'object' ? p : {};
  const hd = homeDns();
  const id = i === 0 ? DEFAULT_ID : (typeof r.id === 'string' && ID_RE.test(r.id) && r.id !== DEFAULT_ID ? r.id : null);
  if (!id) return null;
  const members = (v) => (i === 0 ? [] : ints(v, LIMITS.members));
  return {
    id,
    name: hd.cleanText(r.name, LIMITS.name) || (i === 0 ? defaultProfile().name : id),
    lists: Array.isArray(r.lists) ? catalog.LIST_IDS.filter((l) => r.lists.includes(l)) : [],
    safeSearch: r.safeSearch === true,
    allow: hd.patternsSoft(r.allow),
    deny: hd.patternsSoft(r.deny),
    schedules: Array.isArray(r.schedules) ? r.schedules.slice(0, LIMITS.schedules).map(hd.normSchedule).filter(Boolean) : [],
    groups: members(r.groups),
    peerGroups: members(r.peerGroups),
    users: members(r.users),
    peers: members(r.peers),
  };
}

/** Stored settings (any shape) → the complete, valid settings object. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hd = homeDns();
  const up = r.upstream && typeof r.upstream === 'object' ? r.upstream : {};
  let provider = PROVIDERS.includes(up.provider) ? up.provider : 'quad9';
  const url = typeof up.url === 'string' && hd.validDohUrl(up.url) ? up.url.trim() : null;
  if (provider === 'custom' && !url) provider = 'quad9';
  const list = Array.isArray(r.profiles) && r.profiles.length ? r.profiles : [defaultProfile()];
  const profiles = [];
  for (let i = 0; i < list.length && profiles.length < LIMITS.profiles; i++) {
    const p = normProfile(list[i], profiles.length);
    if (p && !profiles.some((q) => q.id === p.id)) profiles.push(p);
  }
  if (!profiles.length) profiles.push(defaultProfile());
  const log = r.log && typeof r.log === 'object' ? r.log : {};
  const days = Number(log.retentionDays);
  return {
    enabled: bool(r.enabled, false),
    upstream: { provider, url: provider === 'custom' ? url : null, fallbackRouter: bool(up.fallbackRouter, true) },
    blockResponse: r.blockResponse === 'nxdomain' ? 'nxdomain' : 'zero',
    allow: hd.patternsSoft(r.allow),
    deny: hd.patternsSoft(r.deny),
    log: { enabled: bool(log.enabled, false), retentionDays: Number.isInteger(days) && days >= 1 && days <= LIMITS.retentionDays ? days : 7 },
    excluded: ints(r.excluded, LIMITS.excluded),
    profiles,
  };
}

function row() {
  try { return db().prepare('SELECT settings, updated_at FROM vpn_dns WHERE id = 1').get() || null; } catch { return null; }
}

/** The settings (defaults when there never were any). */
function get() {
  const r = row();
  return normalize(r ? json(r.settings) : null);
}

function save(s, at = Date.now()) {
  db().prepare(`INSERT INTO vpn_dns (id, settings, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`).run(JSON.stringify(s), at);
}

function existing(table, ids, where = '') {
  if (!ids.length) return new Set();
  return new Set(db().prepare(`SELECT id FROM ${table} WHERE id IN (${marks(ids)})${where}`).all(...ids).map((r) => r.id));
}

function memberIds(v, what, table, where, label) {
  if (!Array.isArray(v) || v.length > LIMITS.members || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw invalid(`${what}: up to ${LIMITS.members} ids`, { field: what });
  const ids = [...new Set(v)].sort((a, b) => a - b);
  const ok = existing(table, ids, where);
  if (ids.some((x) => !ok.has(x))) throw invalid(`${what}: unknown ${label}`, { field: what });
  return ids;
}

function wrapDns(fn, field) {
  try { return fn(); } catch (e) {
    if (e && e.code && !String(e.code).startsWith('ERR_')) throw invalid(e.message, { field, ...(e.value ? { value: e.value } : {}) });
    throw e;
  }
}

function validateProfile(b, i, cur, taken) {
  const hd = homeDns();
  const what = `profiles[${i}]`;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(`${what}: object`, { field: what });
  const isDefault = i === 0;
  const out = cur ? JSON.parse(JSON.stringify(cur)) : { ...defaultProfile(), id: null, name: null, lists: [] };
  for (const [k, v] of Object.entries(b)) {
    const f = `${what}.${k}`;
    if (k === 'id') continue;
    if (k === 'name') {
      const n = hd.cleanText(v, LIMITS.name);
      if (!n) throw invalid(`${f}: 1…${LIMITS.name} characters`, { field: f });
      out.name = n;
    } else if (k === 'lists') {
      if (!Array.isArray(v) || !v.every((x) => catalog.LIST_IDS.includes(x))) throw invalid(`${f}: ids of the catalogue`, { field: f });
      out.lists = catalog.LIST_IDS.filter((l) => v.includes(l));
    } else if (k === 'safeSearch') {
      if (typeof v !== 'boolean') throw invalid(`${f} must be true or false`, { field: f });
      out.safeSearch = v;
    } else if (k === 'allow' || k === 'deny') {
      out[k] = wrapDns(() => hd.patterns(v, f), f);
    } else if (k === 'schedules') {
      if (!Array.isArray(v) || v.length > LIMITS.schedules) throw invalid(`${f}: up to ${LIMITS.schedules}`, { field: f });
      out.schedules = v.map((x, j) => {
        if (!x || typeof x !== 'object') throw invalid(`${f}[${j}]: object`, { field: `${f}[${j}]` });
        if (x.allowAlways !== undefined) wrapDns(() => hd.patterns(x.allowAlways, `${f}[${j}].allowAlways`), `${f}[${j}].allowAlways`);
        const n = hd.normSchedule(x);
        if (!n) throw invalid(`${f}[${j}]: days 1–7, from/to HH:MM (different, or 00:00–24:00 for the whole day), block all or categories with at least one category`, { field: `${f}[${j}]` });
        return n;
      });
    } else if (['groups', 'peerGroups', 'users', 'peers'].includes(k)) {
      if (isDefault) { if (Array.isArray(v) && !v.length) continue; throw invalid('the default profile has no members', { field: f }); }
      if (k === 'groups') out.groups = memberIds(v, f, 'groups', '', 'group');
      else if (k === 'peerGroups') out.peerGroups = memberIds(v, f, 'peer_groups', '', 'peer group');
      else if (k === 'users') out.users = memberIds(v, f, 'users', ' AND enabled = 1', 'or disabled person');
      else out.peers = memberIds(v, f, 'peers', " AND peer_type != 'gateway'", 'device (gateways are never filtered)');
    } else throw invalid(`${f}: unknown`, { field: f });
  }
  if (!out.name) throw invalid(`${what}.name: 1…${LIMITS.name} characters`, { field: `${what}.name` });
  if (taken.has(out.name.toLowerCase())) throw new VpnDnsError('ERR_INVALID', `${what}.name: a profile with this name exists`, { field: `${what}.name`, reason: 'name_taken' });
  taken.add(out.name.toLowerCase());
  return out;
}

/** A patch of the settings → the complete new settings. Throws ERR_INVALID with `field`. */
function validate(patch, before) {
  const b = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!b) throw invalid('invalid settings');
  const hd = homeDns();
  const out = JSON.parse(JSON.stringify(before));
  let any = false;
  for (const [k, v] of Object.entries(b)) {
    any = true;
    if (k === 'enabled') {
      if (typeof v !== 'boolean') throw invalid('enabled must be true or false', { field: k });
      out.enabled = v;
    } else if (k === 'blockResponse') {
      if (v !== 'zero' && v !== 'nxdomain') throw invalid('blockResponse: zero or nxdomain', { field: k });
      out.blockResponse = v;
    } else if (k === 'allow' || k === 'deny') {
      out[k] = wrapDns(() => hd.patterns(v, k), k);
    } else if (k === 'upstream') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('upstream: object', { field: k });
      for (const [f, val] of Object.entries(v)) {
        if (f === 'provider') {
          if (!PROVIDERS.includes(val)) throw invalid(`upstream.provider: ${PROVIDERS.join(', ')}`, { field: 'upstream.provider' });
          out.upstream.provider = val;
        } else if (f === 'url') {
          if (val !== null && !hd.validDohUrl(val)) throw invalid('upstream.url: an https address', { field: 'upstream.url' });
          out.upstream.url = val === null ? null : val.trim();
        } else if (f === 'fallbackRouter') {
          if (typeof val !== 'boolean') throw invalid('upstream.fallbackRouter must be true or false', { field: 'upstream.fallbackRouter' });
          out.upstream.fallbackRouter = val;
        } else throw invalid(`upstream.${f}: unknown`, { field: `upstream.${f}` });
      }
      if (out.upstream.provider === 'custom' && !out.upstream.url) throw invalid('upstream.url is needed for an own server', { field: 'upstream.url' });
      if (out.upstream.provider !== 'custom') out.upstream.url = null;
    } else if (k === 'log') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('log: object', { field: k });
      for (const [f, val] of Object.entries(v)) {
        if (f === 'enabled') {
          if (typeof val !== 'boolean') throw invalid('log.enabled must be true or false', { field: 'log.enabled' });
          out.log.enabled = val;
        } else if (f === 'retentionDays') {
          if (!Number.isInteger(val) || val < 1 || val > LIMITS.retentionDays) throw invalid(`log.retentionDays: 1…${LIMITS.retentionDays}`, { field: 'log.retentionDays' });
          out.log.retentionDays = val;
        } else throw invalid(`log.${f}: unknown`, { field: `log.${f}` });
      }
    } else if (k === 'excluded') {
      if (!Array.isArray(v) || v.length > LIMITS.excluded || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw invalid(`excluded: up to ${LIMITS.excluded} device ids`, { field: k });
      const ids = [...new Set(v)].sort((a, c) => a - c);
      const ok = existing('peers', ids);
      if (ids.some((x) => !ok.has(x))) throw invalid('excluded: unknown device', { field: k });
      out.excluded = ids;
    } else if (k === 'profiles') {
      if (!Array.isArray(v) || !v.length || v.length > LIMITS.profiles) throw invalid(`profiles: 1…${LIMITS.profiles}`, { field: k });
      if (v[0] && v[0].id !== undefined && v[0].id !== DEFAULT_ID) throw invalid('profiles[0] is the default profile (id "default")', { field: 'profiles[0].id' });
      const taken = new Set();
      const seen = new Set();
      out.profiles = v.map((p, i) => {
        const id = i === 0 ? DEFAULT_ID : (p && typeof p.id === 'string' ? p.id : null);
        if (id !== null && i > 0 && (!ID_RE.test(id) || id === DEFAULT_ID)) throw invalid(`profiles[${i}].id: invalid`, { field: `profiles[${i}].id` });
        if (id !== null && seen.has(id)) throw invalid(`profiles[${i}].id: twice`, { field: `profiles[${i}].id` });
        const cur = id ? before.profiles.find((q) => q.id === id) || null : null;
        const n = validateProfile(p, i, cur, taken);
        n.id = id || ('p' + crypto.randomBytes(4).toString('hex'));
        seen.add(n.id);
        return n;
      });
    } else throw invalid(`${k}: unknown`, { field: k });
  }
  if (!any) throw invalid('nothing to change');
  return normalize(out);
}

function audit(type, message, details, ctx = {}, severity = 'info') {
  try {
    require('./activity').log(type, message, {
      source: ctx.pluginId ? 'plugin' : (ctx.actor ? 'admin' : 'system'), severity,
      details: { ...details, ...(ctx.pluginId ? { plugin: ctx.pluginId } : {}), ...(ctx.actor ? { actor_id: ctx.actor.id, actor: ctx.actor.name } : {}), ...(ctx.automated ? { automated: true } : {}) },
    });
  } catch (e) { logger.debug({ err: e.message }, 'vpn dns activity not written'); }
}

/** gc.vpnDns.set(patch) → the new settings. */
function set(patch, ctx = {}) {
  const before = get();
  const after = validate(patch, before);
  const keys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (!keys.length) return after;
  save(after);
  if (before.log.enabled && !after.log.enabled) clearLog({ silent: true });
  // switched off for good: a suspension "until I switch it on again" must not wait for the next time it is on
  if (before.enabled && !after.enabled) db().prepare('DELETE FROM vpn_dns_pauses').run();
  audit('vpn_dns_changed', `DNS protection settings changed (${keys.join(', ')})`, { changed: keys, enabled: after.enabled }, ctx);
  reconcile();
  refreshSoon();
  publish();
  return after;
}

// ─── Who is filtered how ───────────────────────────────────────────────

function ownDnsOf(peer, customDns) {
  const own = String(peer.dns || customDns || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!own.length) return null;
  const mine = new Set([config.wireguard.gatewayIp, ...(config.wireguard.dns || [])]);
  return own.some((x) => mine.has(x)) ? null : own.join(', ');
}

/**
 * Every peer with what holds for it:
 *   state  'filtered' | 'ownDns' (has a DNS server of its own — does not ask
 *          the server) | 'excluded' | 'gateway' | 'disabled'
 *   profileId / via ('peer' | 'user' | 'peerGroup' | 'group' | 'default') / viaId
 */
function resolve(s = get()) {
  const peers = db().prepare(`SELECT p.id, p.name, p.allowed_ips, p.enabled, p.peer_type, p.user_id, p.group_id, p.dns, p.client_platform,
      u.username, u.display_name, u.role, u.enabled AS user_enabled, g.name AS group_name
    FROM peers p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN peer_groups g ON g.id = p.group_id ORDER BY p.name COLLATE NOCASE, p.id`).all();
  let customDns = null;
  try { customDns = require('./settings').get('custom_dns'); } catch { /* none */ }
  const byPeer = new Map();
  const byUser = new Map();
  const byPeerGroup = new Map();
  const byGroupUser = new Map();
  for (const p of s.profiles.slice(1)) {
    for (const id of p.peers) if (!byPeer.has(id)) byPeer.set(id, p.id);
    for (const id of p.users) if (!byUser.has(id)) byUser.set(id, p.id);
    for (const id of p.peerGroups) if (!byPeerGroup.has(id)) byPeerGroup.set(id, p.id);
    if (p.groups.length) {
      let members = new Set();
      try { members = require('./groups').effectiveUserIds(p.groups); } catch (e) { logger.debug({ err: e.message }, 'vpn dns: group members not read'); }
      for (const uid of members) if (!byGroupUser.has(uid)) byGroupUser.set(uid, { profileId: p.id, groups: p.groups });
    }
  }
  const excluded = new Set(s.excluded);
  const dnsLib = require('./dns');
  return peers.map((p) => {
    const ip = dnsLib.extractPeerIp(p.allowed_ips);
    const dev = {
      peerId: p.id, name: p.name, ip, type: p.peer_type === 'gateway' ? 'gateway' : 'peer', platform: p.client_platform || null,
      user: p.user_id && p.username ? { id: p.user_id, name: p.display_name || p.username, role: p.role } : null,
      peerGroup: p.group_id && p.group_name ? { id: p.group_id, name: p.group_name } : null,
      state: 'filtered', ownDns: null, profileId: null, via: null, viaId: null,
    };
    if (dev.type === 'gateway') { dev.state = 'gateway'; return dev; }
    if (p.enabled !== 1 || !ip) { dev.state = 'disabled'; return dev; }
    if (excluded.has(p.id)) { dev.state = 'excluded'; return dev; }
    dev.ownDns = ownDnsOf(p, customDns);
    if (dev.ownDns) dev.state = 'ownDns';
    const uid = p.user_id && p.user_enabled === 1 ? p.user_id : null;
    if (byPeer.has(p.id)) Object.assign(dev, { profileId: byPeer.get(p.id), via: 'peer', viaId: p.id });
    else if (uid && byUser.has(uid)) Object.assign(dev, { profileId: byUser.get(uid), via: 'user', viaId: uid });
    else if (p.group_id && byPeerGroup.has(p.group_id)) Object.assign(dev, { profileId: byPeerGroup.get(p.group_id), via: 'peerGroup', viaId: p.group_id });
    else if (uid && byGroupUser.has(uid)) Object.assign(dev, { profileId: byGroupUser.get(uid).profileId, via: 'group', viaId: byGroupUser.get(uid).groups[0] });
    else Object.assign(dev, { profileId: DEFAULT_ID, via: 'default', viaId: null });
    return dev;
  });
}

// ─── Suspensions ("Unterbrechen") ──────────────────────────────────────

function pauseRows(now = Date.now()) {
  try {
    return db().prepare('SELECT scope, target_id, until_at, by_user_id, by_name, plugin_id, automated, created_at FROM vpn_dns_pauses WHERE until_at IS NULL OR until_at > ? ORDER BY scope, target_id').all(now);
  } catch { return []; }
}

function pauseView(r) {
  return {
    scope: r.scope, id: r.scope === 'all' ? null : r.target_id, until: iso(r.until_at), openEnd: r.until_at == null,
    since: iso(r.created_at), by: r.by_user_id ? { userId: r.by_user_id, name: r.by_name } : null, automated: r.automated === 1,
  };
}

/** gc.vpnDns.pauses() → the running suspensions. */
function pauses(now = Date.now()) {
  return pauseRows(now).map(pauseView);
}

function targetOf(t) {
  const scope = t && t.scope;
  if (scope === 'all') return { scope, id: 0, owner: null, label: 'all VPN devices' };
  const id = t && t.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw invalid('id: the id of the device or person');
  if (scope === 'peer') {
    const p = db().prepare(`SELECT p.id, p.name, p.peer_type, u.id AS uid, u.role FROM peers p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(id);
    if (!p || p.peer_type === 'gateway') throw new VpnDnsError('ERR_NOT_FOUND', 'unknown device');
    return { scope, id, owner: p.uid ? { id: p.uid, role: p.role } : null, label: `device "${p.name}"` };
  }
  if (scope === 'user') {
    const u = db().prepare('SELECT id, username, display_name, role, enabled FROM users WHERE id = ?').get(id);
    if (!u || u.enabled !== 1) throw new VpnDnsError('ERR_NOT_FOUND', 'unknown or disabled person');
    return { scope, id, owner: { id: u.id, role: u.role }, label: `the devices of "${u.display_name || u.username}"` };
  }
  throw invalid('scope: all, peer or user');
}

/**
 * What holds whatever a plugin decides: only an administrator suspends for
 * all devices, and nobody but an administrator suspends (or switches back on)
 * for an administrator's devices — except that administrator themselves.
 */
function needMay(target, ctx) {
  const a = ctx.actor;
  if (!a) throw new VpnDnsError('ERR_NOT_PERSON', 'no acting person');
  if (a.role === 'admin') return;
  if (target.scope === 'all') throw new VpnDnsError('ERR_FORBIDDEN', 'only an administrator suspends the protection for all devices');
  if (target.owner && target.owner.role === 'admin' && target.owner.id !== a.id) throw new VpnDnsError('ERR_FORBIDDEN', 'not for the devices of an administrator');
}

function untilOf(t, now) {
  if (t.forever === true) return null;
  if (t.minutes !== undefined) {
    if (!Number.isInteger(t.minutes) || t.minutes < 1 || t.minutes > LIMITS.pauseMinutes) throw invalid(`minutes: 1…${LIMITS.pauseMinutes}`);
    return now + t.minutes * MINUTE;
  }
  if (typeof t.until === 'string' && t.until.length <= 64) {
    const ms = Date.parse(t.until);
    if (Number.isFinite(ms) && ms > now && ms <= now + LIMITS.pauseMinutes * MINUTE) return ms;
  }
  throw invalid('minutes, until (ISO, at most 7 days ahead) or forever: true');
}

/** gc.vpnDns.pause({ scope, id?, minutes | until | forever }) → the suspension. A running one is replaced. */
function pause(t, ctx = {}, now = Date.now()) {
  const target = targetOf(t);
  needMay(target, ctx);
  const until = untilOf(t || {}, now);
  db().prepare(`INSERT INTO vpn_dns_pauses (scope, target_id, until_at, by_user_id, by_name, plugin_id, automated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, target_id) DO UPDATE SET until_at = excluded.until_at, by_user_id = excluded.by_user_id, by_name = excluded.by_name,
      plugin_id = excluded.plugin_id, automated = excluded.automated, created_at = excluded.created_at`)
    .run(target.scope, target.id, until, ctx.actor.id, ctx.actor.name, ctx.pluginId || null, ctx.automated ? 1 : 0, now);
  audit('vpn_dns_paused', `DNS protection suspended for ${target.label} ${until ? 'until ' + iso(until) : 'until switched on again'}`,
    { scope: target.scope, target_id: target.id || null, until: iso(until) }, ctx);
  const view = pauseView({ scope: target.scope, target_id: target.id, until_at: until, by_user_id: ctx.actor.id, by_name: ctx.actor.name, automated: ctx.automated ? 1 : 0, created_at: now });
  emit({ type: 'paused', ...view });
  refreshNow();
  return view;
}

/** gc.vpnDns.resume({ scope, id? }) → true when a suspension ended. */
function resume(t, ctx = {}) {
  const target = targetOf(t);
  needMay(target, ctx);
  const n = db().prepare('DELETE FROM vpn_dns_pauses WHERE scope = ? AND target_id = ?').run(target.scope, target.id).changes;
  if (!n) return false;
  audit('vpn_dns_resumed', `DNS protection switched on again for ${target.label}`, { scope: target.scope, target_id: target.id || null }, ctx);
  emit({ type: 'resumed', scope: target.scope, id: target.scope === 'all' ? null : target.id, reason: 'manual', by: { userId: ctx.actor.id, name: ctx.actor.name } });
  refreshNow();
  return true;
}

/** Suspensions that ran out: removed, each with an event (the filter service lets them end by itself). */
function sweepPauses(now = Date.now()) {
  let rows;
  try { rows = db().prepare('SELECT scope, target_id FROM vpn_dns_pauses WHERE until_at IS NOT NULL AND until_at <= ?').all(now); } catch { return 0; }
  if (!rows.length) return 0;
  db().prepare('DELETE FROM vpn_dns_pauses WHERE until_at IS NOT NULL AND until_at <= ?').run(now);
  for (const r of rows) emit({ type: 'resumed', scope: r.scope, id: r.scope === 'all' ? null : r.target_id, reason: 'expired', by: null });
  return rows.length;
}

/** { all: until ms | 0 (open end) | null, keys: { 'peer:<id>': until | 0 } } for the filter service. */
function suspended(devices, now = Date.now()) {
  const out = { all: null, keys: {} };
  const put = (key, until) => {
    const v = until == null ? 0 : until;
    const cur = out.keys[key];
    out.keys[key] = cur === undefined ? v : (cur === 0 || v === 0 ? 0 : Math.max(cur, v));
  };
  for (const r of pauseRows(now)) {
    if (r.scope === 'all') out.all = r.until_at == null ? 0 : r.until_at;
    else if (r.scope === 'peer') put(keyOf(r.target_id), r.until_at);
    else if (r.scope === 'user') for (const d of devices) if (d.user && d.user.id === r.target_id) put(keyOf(d.peerId), r.until_at);
  }
  return out;
}

// ─── The filter service's config ───────────────────────────────────────

function minutes(hhmm, allow24) {
  if (allow24 && hhmm === '24:00') return 1440;
  const m = /^(\d\d):(\d\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** The names dnsmasq answers itself (peers.hosts, API host): never blocked. */
function internalNames() {
  const out = new Set();
  try {
    for (const line of fs.readFileSync(config.dns.hostsFile, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      for (const n of line.split(/\s+/).slice(1)) if (n.includes('.')) out.add(n.toLowerCase());
    }
  } catch { /* no hosts file yet */ }
  for (const u of [process.env.GC_API_HOST, config.app && config.app.baseUrl]) {
    try {
      const h = String(u || '').includes('://') ? new URL(u).hostname : String(u || '');
      if (h && h.includes('.') && !net.isIP(h)) out.add(h.toLowerCase());
    } catch { /* not a host */ }
  }
  return [...out].sort();
}

function filterConfig(s = get(), now = Date.now()) {
  const devices = resolve(s);
  const clients = {};
  const members = new Map(s.profiles.map((p) => [p.id, []]));
  for (const d of devices) {
    if (!d.profileId || !d.ip || (d.state !== 'filtered' && d.state !== 'ownDns')) continue;
    clients[d.ip] = keyOf(d.peerId);
    if (members.has(d.profileId)) members.get(d.profileId).push(keyOf(d.peerId));
  }
  const used = new Set();
  const profiles = s.profiles.map((p) => {
    p.lists.forEach((l) => used.add(l));
    return {
      id: p.id, lists: p.lists.slice(), safeSearch: p.safeSearch,
      allow: [...new Set([...p.allow, ...s.allow])].sort(),
      deny: [...new Set([...p.deny, ...s.deny])].sort(),
      schedules: p.schedules.map((x) => ({ days: x.days.slice(), from: minutes(x.from), to: minutes(x.to, true), block: x.block, categories: x.categories.slice(), allowAlways: x.allowAlways.slice() })),
      clients: members.get(p.id).sort(),
    };
  });
  const lists = {};
  for (const l of catalog.LISTS) if (used.has(l.id)) lists[l.id] = { url: l.url, format: l.format, sha256: null };
  const categories = {};
  for (const c of catalog.CATEGORY_IDS) categories[c] = catalog.CATEGORIES[c].slice();
  let tz = null;
  try { tz = require('./notify/router').serverTz(); } catch { /* process zone */ }
  return {
    v: 1,
    enabled: true,
    port: filterPort(),
    tz,
    logQueries: s.log.enabled,
    blockResponse: s.blockResponse,
    upstream: { provider: s.upstream.provider, url: s.upstream.url, fallbackRouter: s.upstream.fallbackRouter },
    plain: (process.env.GC_DNSMASQ_UPSTREAMS || '1.1.1.1,8.8.8.8').split(',').map((x) => x.trim()).filter(Boolean),
    internal: internalNames(),
    policy: { alwaysAllow: [], lists, categories, profiles, globalAllow: s.allow.slice(), globalDeny: s.deny.slice() },
    clients,
    suspended: suspended(devices, now),
  };
}

// ─── Talking to the filter service ─────────────────────────────────────

/** One request on the control socket → its answer. Rejects ERR_UNAVAILABLE (not running, no answer in time). */
function control(op, args = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const fail = (msg) => reject(new VpnDnsError('ERR_UNAVAILABLE', `the filter service does not answer (${msg})`));
    let buf = '';
    let done = false;
    const c = net.connect(path.join(dir(), 'control.sock'));
    const timer = setTimeout(() => { done = true; c.destroy(); fail('timeout'); }, timeoutMs);
    if (timer.unref) timer.unref();
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ op, ...args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.length > 8 * 1024 * 1024) c.destroy(); });
    c.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); fail(e.code || e.message); });
    c.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const r = json(buf);
      if (!r) fail('no answer'); else resolve(r);
    });
  });
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

const run = {
  wanted: false,        // settings on AND a plugin that may use it
  chainOn: false,       // dnsChain.vpnFilter.enable() called
  everActive: false,    // the chain went through the filter at least once since it was wanted
  down: false,          // an outage was reported (so the recovery is reported too)
  wantedAt: 0,
  svc: null,            // last status of the service
  svcAt: 0,
  lastConfig: null,
  configAt: 0,
  takeAt: 0,
  retentionAt: 0,
  timer: null,
  soon: null,
  ticking: null,
  started: false,
};

function wanted() {
  if (!config.dns.enabled) return false;
  try { return get().enabled && available(); } catch { return false; }
}

/** Write config.json when it differs from what the service has. → true when written. */
function writeConfig(now = Date.now()) {
  const cfg = filterConfig(get(), now);
  const body = JSON.stringify(cfg);
  run.configAt = now;
  if (body === run.lastConfig) return false;
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  atomicWrite(path.join(dir(), 'config.json'), JSON.stringify({ ...cfg, rev: now }), { mode: 0o600 });
  run.lastConfig = body;
  control('reload', {}, 2000).catch(() => { /* the service checks the file every 2 s anyway */ });
  return true;
}

function switchOff() {
  const d = dir();
  try { fs.rmSync(path.join(d, 'enabled'), { force: true }); } catch { /* gone */ }
  try {
    if (fs.existsSync(path.join(d, 'config.json'))) atomicWrite(path.join(d, 'config.json'), JSON.stringify({ v: 1, rev: Date.now(), enabled: false }), { mode: 0o600 });
  } catch (e) { logger.debug({ err: e.message }, 'vpn dns: config not cleared'); }
  run.lastConfig = null;
  if (fs.existsSync(path.join(d, 'control.sock'))) control('exit', {}, 1500).catch(() => { /* not running */ });
}

function enableChain() {
  if (run.chainOn) return;
  run.chainOn = true;
  dnsChain.vpnFilter.enable({ port: filterPort(), onChange: onChainChange });
  dnsChain.start();
}

function onChainChange(state) {
  if (!run.wanted) return;
  if (state === 'vpnfilter') {
    run.everActive = true;
    if (run.down) { run.down = false; outage(false); }
  } else if (state === 'fallback' && run.everActive && !run.down) {
    run.down = true;
    outage(true);
  }
  publish();
}

function outage(down) {
  audit(down ? 'vpn_dns_fallback' : 'vpn_dns_restored',
    down ? 'DNS protection: the filter service does not answer — VPN DNS falls back to the default upstreams (unfiltered)'
      : 'DNS protection: the filter service answers again — VPN DNS is filtered',
    { port: filterPort() }, {}, down ? 'warning' : 'info');
  emit({ type: down ? 'fallback' : 'restored' });
}

/**
 * Bring the service and the chain in line with what is wanted. Called at
 * server start, when the plugins were reconciled and when settings change.
 * `boot`: the server just started — the service may still be running from
 * before (it is not a child of the server), so the chain is claimed at once
 * instead of putting dnsmasq on the default upstreams in between.
 */
function reconcile({ boot = false } = {}) {
  const want = wanted();
  if (want === run.wanted && !boot) { if (want) refreshSoon(); return want; }
  run.wanted = want;
  if (!want) {
    if (run.timer) { clearTimeout(run.timer); run.timer = null; }
    const had = run.chainOn;
    run.chainOn = false;
    run.everActive = false;
    run.down = false;
    run.svc = null;
    // Only touch anything when the protection was on before: a server that
    // never had it gets no directory, no chain call, nothing.
    if (had || fs.existsSync(path.join(dir(), 'enabled'))) {
      switchOff();
      try { dnsChain.vpnFilter.disable(); } catch (e) { logger.debug({ err: e.message }, 'vpn dns: chain not released'); }
    }
    publish();
    return false;
  }
  run.wantedAt = Date.now();
  run.everActive = false;
  run.down = false;
  try {
    writeConfig();
    fs.writeFileSync(path.join(dir(), 'enabled'), '', { mode: 0o600 });
  } catch (e) { logger.warn({ err: e.message }, 'vpn dns: filter service config not written'); }
  if (boot) enableChain();
  schedule(0);
  publish();
  return true;
}

function schedule(ms) {
  if (run.timer) clearTimeout(run.timer);
  if (!run.wanted || !run.started) return;
  run.timer = setTimeout(() => { run.timer = null; tick().finally(() => schedule(run.everActive ? TICK_MS : TICK_STARTING_MS)); }, ms);
  if (run.timer.unref) run.timer.unref();
}

/** One round: service status, chain, suspensions that ran out, config, counters. Never rejects. */
function tick(now = Date.now()) {
  if (run.ticking) return run.ticking;
  const { withTask } = require('../utils/loopStall');
  run.ticking = withTask('vpndns.tick', async () => {
    if (!run.wanted) return;
    try {
      run.svc = await control('status', {}, 1500);
      run.svcAt = now;
    } catch { run.svc = null; }
    if (!run.chainOn && run.svc && run.svc.ready) enableChain();
    const chain = dnsChain.vpnFilter.status().state;
    if (chain === 'vpnfilter') run.everActive = true;
    // A service that never came up is an outage as well, not "starting" for ever.
    if (!run.everActive && now - run.wantedAt > STARTING_MAX_MS) {
      run.everActive = true;
      enableChain();
      if (!run.down) { run.down = true; outage(true); }
    }
    try {
      const ended = sweepPauses(now);
      if (ended || now - run.configAt >= CONFIG_EVERY_MS) writeConfig(now);
    } catch (e) { logger.warn({ err: e.message }, 'vpn dns: config not written'); }
    const every = get().log.enabled ? TAKE_LOG_EVERY_MS : TAKE_EVERY_MS;
    if (run.svc && now - run.takeAt >= every) {
      run.takeAt = now;
      try { await ingest(await control('take', {}, 5000), now); } catch (e) { logger.debug({ err: e.message }, 'vpn dns: counters not read'); }
    }
    if (now - run.retentionAt >= 60 * MINUTE) {
      run.retentionAt = now;
      try { await retention(now); } catch (e) { logger.debug({ err: e.message }, 'vpn dns: retention'); }
    }
  }).catch((e) => { logger.warn({ err: e.message }, 'vpn dns tick failed'); }).finally(() => { run.ticking = null; });
  return run.ticking;
}

/** The plugins were reconciled (installed, enabled, licence, removed): is the protection still wanted? */
function pluginsChanged() {
  if (!run.started) return;
  try { reconcile(); } catch (e) { logger.warn({ err: e.message }, 'vpn dns: not reconciled'); }
}

/** Something the config is made of changed (a peer, a route, a group): rewrite it shortly. */
function refreshSoon() {
  if (!run.wanted || run.soon) return;
  run.soon = setTimeout(() => {
    run.soon = null;
    if (!run.wanted) return;
    try { writeConfig(); } catch (e) { logger.warn({ err: e.message }, 'vpn dns: config not written'); }
  }, 500);
  if (run.soon.unref) run.soon.unref();
}

/** A suspension changed: the service must know at once. */
function refreshNow() {
  if (run.wanted) { try { writeConfig(); } catch (e) { logger.warn({ err: e.message }, 'vpn dns: config not written'); } }
  publish();
}

function start() {
  run.started = true;
  // Pi-hole registers as a provider of the chain when its module loads: it has
  // to be known before the first chain call here, or releasing the chain
  // would put dnsmasq on the default upstreams although Pi-hole wants it.
  try { require('./pihole'); } catch (e) { logger.debug({ err: e.message }, 'vpn dns: pihole not loaded'); }
  try { return reconcile({ boot: true }); } catch (e) { logger.warn({ err: e.message }, 'vpn dns not started'); return false; }
}

/** Server shutdown: the timers go, the filter service keeps running (it is not the server's child). */
function stop() {
  run.started = false;
  if (run.timer) { clearTimeout(run.timer); run.timer = null; }
  if (run.soon) { clearTimeout(run.soon); run.soon = null; }
}

// ─── Counters and the query log ────────────────────────────────────────

function peerIdOf(key) {
  const m = /^peer:(\d{1,15})$/.exec(String(key || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Blocked queries by what blocked them (stored per day, JSON): a list, an own
 * entry "Immer gesperrt" for everybody (denyAll) or of a profile
 * (denyProfile), a time of a profile, anything else (Firefox' DoH canary).
 */
const BLOCK_KINDS = Object.freeze(['list', 'denyAll', 'denyProfile', 'schedule', 'other']);

function blockedByOf(raw) {
  const v = (typeof raw === 'string' ? json(raw) : raw) || {};
  return Object.fromEntries(BLOCK_KINDS.map((k) => [k, Math.max(0, Number(v[k]) || 0)]));
}

/** What the service counted since the last take → the day's row, per device and the log (only with the log on). */
async function ingest(t, now = Date.now()) {
  if (!t || !t.stats) return;
  const b = t.stats;
  const day = dayKey(now);
  const s = get();
  if (b.queries > 0) {
    const cur = db().prepare('SELECT top, by_profile, by_reason FROM vpn_dns_stats_day WHERE day = ?').get(day);
    const top = new Map(Object.entries((cur && json(cur.top)) || {}));
    for (const e of Array.isArray(b.topBlocked) ? b.topBlocked : []) {
      if (e && typeof e.domain === 'string' && Number.isFinite(e.count)) top.set(e.domain, (top.get(e.domain) || 0) + e.count);
    }
    const kept = Object.fromEntries([...top.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, LIMITS.topKeep));
    const byProfile = (cur && json(cur.by_profile)) || {};
    for (const [id, v] of Object.entries(b.byProfile || {})) {
      if (!ID_RE.test(id) || !v) continue;
      const e = byProfile[id] || { queries: 0, blocked: 0 };
      byProfile[id] = { queries: e.queries + (Number(v.queries) || 0), blocked: e.blocked + (Number(v.blocked) || 0) };
    }
    const byReason = blockedByOf(cur && cur.by_reason);
    for (const k of BLOCK_KINDS) byReason[k] += Math.max(0, Number(t.blockedBy && t.blockedBy[k]) || 0);
    db().prepare(`INSERT INTO vpn_dns_stats_day (day, queries, blocked, cached, top, by_profile, by_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET queries = queries + excluded.queries, blocked = blocked + excluded.blocked, cached = cached + excluded.cached,
        top = excluded.top, by_profile = excluded.by_profile, by_reason = excluded.by_reason, updated_at = excluded.updated_at`)
      .run(day, Number(b.queries) || 0, Number(b.blocked) || 0, Number(b.cached) || 0, JSON.stringify(kept), JSON.stringify(byProfile), JSON.stringify(byReason), now);
  }
  if (!s.log.enabled) return; // nothing per device is kept without the query log
  const up = db().prepare(`INSERT INTO vpn_dns_peer_day (day, peer_id, queries, blocked) VALUES (?, ?, ?, ?)
    ON CONFLICT(day, peer_id) DO UPDATE SET queries = queries + excluded.queries, blocked = blocked + excluded.blocked`);
  for (const [key, v] of Object.entries(t.clients || {})) {
    const id = peerIdOf(key);
    if (id && v) up.run(day, id, Number(v.queries) || 0, Number(v.blocked) || 0);
  }
  const rows = Array.isArray(t.log) ? t.log : [];
  const ins = db().prepare('INSERT INTO vpn_dns_log (at, peer_id, name, type, action, reason, profile_id, list, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  for (let i = 0; i < rows.length; i += LOG_CHUNK) {
    db().transaction(() => {
      for (const e of rows.slice(i, i + LOG_CHUNK)) {
        const id = e && peerIdOf(e.key);
        if (!id || typeof e.name !== 'string') continue;
        ins.run(Number(e.at) || now, id, e.name.slice(0, 253), str(e.type, 12), e.action === 'block' ? 'block' : 'allow',
          e.safeSearch && e.action !== 'block' ? 'safe_search' : str(e.reason, 32), str(e.profileId, 32), str(e.list || e.category, 32),
          e.scope === 'all' || e.scope === 'profile' ? e.scope : null);
      }
    })();
    // a busy minute is thousands of rows: give the event loop back between the chunks
    if (i + LOG_CHUNK < rows.length) await new Promise((r) => setImmediate(r));
  }
}

/** What is older than the retention goes — the log in steps, so a long log never holds the event loop. */
async function retention(now = Date.now()) {
  const s = get();
  const step = db().prepare('DELETE FROM vpn_dns_log WHERE id IN (SELECT id FROM vpn_dns_log WHERE at < ? ORDER BY id LIMIT ?)');
  for (let i = 0; i < 2000; i++) {
    if (step.run(now - s.log.retentionDays * DAY, RETENTION_STEP).changes < RETENTION_STEP) break;
    await new Promise((r) => setImmediate(r));
  }
  db().prepare('DELETE FROM vpn_dns_peer_day WHERE day < ?').run(dayKey(now - LIMITS.retentionDays * DAY));
  db().prepare('DELETE FROM vpn_dns_stats_day WHERE day < ?').run(dayKey(now - 400 * DAY));
}

function topOf(rowTop, n = LIMITS.top) {
  return Object.entries(json(rowTop) || {}).map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1)).slice(0, n);
}

function todayRow(now = Date.now()) {
  try { return db().prepare('SELECT queries, blocked, cached, top, by_reason FROM vpn_dns_stats_day WHERE day = ?').get(dayKey(now)) || null; } catch { return null; }
}

/** gc.vpnDns.stats({ days }) → today, the last days, the top blocked domains; per device only with the query log on. */
function stats(opts = {}, now = Date.now()) {
  const days = Number.isInteger(opts && opts.days) ? Math.max(1, Math.min(90, opts.days)) : 7;
  const from = dayKey(now - (days - 1) * DAY);
  const rows = db().prepare('SELECT day, queries, blocked, cached, top, by_reason FROM vpn_dns_stats_day WHERE day >= ? ORDER BY day').all(from);
  const today = dayKey(now);
  const t = rows.find((r) => r.day === today) || { queries: 0, blocked: 0, cached: 0, top: null, by_reason: null };
  const sum = blockedByOf(null);
  for (const r of rows) { const b = blockedByOf(r.by_reason); for (const k of BLOCK_KINDS) sum[k] += b[k]; }
  const all = new Map();
  for (const r of rows) for (const e of topOf(r.top, LIMITS.topKeep)) all.set(e.domain, (all.get(e.domain) || 0) + e.count);
  const s = get();
  return {
    today: { day: today, queries: t.queries, blocked: t.blocked, cached: t.cached, blockedBy: blockedByOf(t.by_reason), top: topOf(t.top) },
    days: rows.map((r) => ({ day: r.day, queries: r.queries, blocked: r.blocked, cached: r.cached, blockedBy: blockedByOf(r.by_reason) })),
    blockedBy: sum,
    top: [...all.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1)).slice(0, LIMITS.top),
    perPeer: s.log.enabled
      ? db().prepare('SELECT peer_id AS peerId, SUM(queries) AS queries, SUM(blocked) AS blocked FROM vpn_dns_peer_day WHERE day >= ? GROUP BY peer_id ORDER BY peer_id').all(from)
      : null,
    perPeerToday: s.log.enabled
      ? db().prepare('SELECT peer_id AS peerId, queries, blocked FROM vpn_dns_peer_day WHERE day = ? ORDER BY peer_id').all(today)
      : null,
  };
}

/** gc.vpnDns.log(query) → { entries, next } — newest first; ERR_LOG_OFF while the query log is off. */
function log(q = {}) {
  if (!get().log.enabled) throw new VpnDnsError('ERR_LOG_OFF', 'the query log is switched off');
  const o = q && typeof q === 'object' ? q : {};
  const limit = Number.isInteger(o.limit) ? Math.max(1, Math.min(LIMITS.logPage, o.limit)) : 100;
  const where = [];
  const args = [];
  if (Number.isSafeInteger(o.before) && o.before > 0) { where.push('l.id < ?'); args.push(o.before); }
  if (Number.isSafeInteger(o.peerId) && o.peerId > 0) { where.push('l.peer_id = ?'); args.push(o.peerId); }
  if (Number.isSafeInteger(o.userId) && o.userId > 0) { where.push('l.peer_id IN (SELECT id FROM peers WHERE user_id = ?)'); args.push(o.userId); }
  if (o.blockedOnly === true) where.push("l.action = 'block'");
  if (typeof o.search === 'string' && o.search.trim()) { where.push("l.name LIKE ? ESCAPE '\\'"); args.push('%' + o.search.trim().toLowerCase().slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%'); }
  if (typeof o.since === 'string' && Number.isFinite(Date.parse(o.since))) { where.push('l.at >= ?'); args.push(Date.parse(o.since)); }
  if (o.scope === 'all' || o.scope === 'profile') { where.push('l.scope = ?'); args.push(o.scope); }
  const rows = db().prepare(`SELECT l.id, l.at, l.peer_id, l.name, l.type, l.action, l.reason, l.profile_id, l.list, l.scope FROM vpn_dns_log l
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`).all(...args, limit + 1);
  const page = rows.slice(0, limit);
  return {
    entries: page.map((r) => ({ id: r.id, at: iso(r.at), peerId: r.peer_id, name: r.name, type: r.type, action: r.action, reason: r.reason, profileId: r.profile_id, list: r.list, scope: r.scope || null })),
    next: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/** gc.vpnDns.clearLog() — the entries and the counters per device. */
function clearLog(ctx = {}) {
  const n = db().prepare('DELETE FROM vpn_dns_log').run().changes;
  db().prepare('DELETE FROM vpn_dns_peer_day').run();
  if (!ctx.silent) audit('vpn_dns_log_cleared', `DNS protection: query log cleared (${n} entries)`, { entries: n }, ctx);
  return { removed: n };
}

// ─── What a plugin reads ───────────────────────────────────────────────

/** 'off' | 'starting' | 'filtering' | 'fallback' */
function stateNow() {
  if (!run.wanted) return 'off';
  const c = dnsChain.vpnFilter.status().state;
  if (c === 'vpnfilter') return 'filtering';
  return run.everActive ? 'fallback' : 'starting';
}

function chainNow() {
  const st = dnsChain.status();
  if (st.state !== 'active') return 'default';
  return st.provider === 'vpnfilter' ? 'filter' : (st.provider === 'pihole' ? 'pihole' : 'default');
}

function piholeInfo() {
  try {
    const cfg = require('./piholeConfig').load();
    const wants = !!(cfg.enabled && cfg.manage_dns_chain && (cfg.instances || []).length);
    const st = dnsChain.statusFor('pihole');
    return {
      configured: !!cfg.enabled, wantsChain: wants, chain: !wants ? 'off' : (st.displacedBy ? 'displaced' : (st.state === 'pihole' ? 'active' : st.state)),
      targets: cfg.enabled ? piholeTargets(cfg) : [],
    };
  } catch { return { configured: false, wantsChain: false, chain: 'off', targets: [] }; }
}

/**
 * Where the VPN devices reach Pi-hole (the text of the first step of moving
 * over: "unter 192.168.178.5 (über das Gateway „Pi Keller“)"): every instance
 * with a DNS address, and the gateway behind it — the address is the
 * gateway's own tunnel address (`via: 'tunnel'`) or lies in a LAN the gateway
 * reported (`via: 'lan'`); null for a Pi-hole that is reached directly.
 */
function piholeTargets(cfg) {
  const out = [];
  let gws = null;
  for (const inst of (cfg.instances || []).slice(0, 16)) {
    const ip = String((inst && inst.dns_ip) || '').trim();
    if (!net.isIP(ip)) continue;
    if (!gws) gws = gatewayNets();
    let gateway = null;
    const own = gws.find((g) => g.ip === ip);
    if (own) gateway = { peerId: own.id, name: own.name, via: 'tunnel' };
    else {
      const lan = net.isIPv4(ip) ? gws.find((g) => g.subnets.some((c) => inCidr4(ip, c))) : null;
      if (lan) gateway = { peerId: lan.id, name: lan.name, via: 'lan' };
    }
    const port = parseInt(inst.dns_port, 10);
    out.push({ name: typeof inst.name === 'string' && inst.name ? inst.name.slice(0, 80) : null, ip, port: port >= 1 && port <= 65535 ? port : 53, gateway });
  }
  return out;
}

function inCidr4(ip, cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || ''));
  if (!m || !net.isIPv4(m[1]) || Number(m[2]) > 32) return false;
  const n = (x) => x.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
  const bits = Number(m[2]);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n(ip) & mask) >>> 0) === ((n(m[1]) & mask) >>> 0);
}

/** The gateways with their tunnel address and the LAN subnets of their last heartbeat. */
function gatewayNets() {
  try {
    const dnsLib = require('./dns');
    return db().prepare(`SELECT p.id, p.name, p.allowed_ips, gm.last_health FROM peers p LEFT JOIN gateway_meta gm ON gm.peer_id = p.id
      WHERE p.peer_type = 'gateway' ORDER BY p.id`).all().map((g) => {
      let subnets = [];
      try {
        const list = JSON.parse(g.last_health || '{}').telemetry.lan_subnets;
        if (Array.isArray(list)) subnets = list.slice(0, 16).map((e) => (e && typeof e.cidr === 'string' ? e.cidr : null)).filter(Boolean);
      } catch { /* never reported */ }
      return { id: g.id, name: g.name, ip: dnsLib.extractPeerIp(g.allowed_ips), subnets };
    });
  } catch { return []; }
}

function listsView() {
  const tel = (run.svc && run.svc.lists) || {};
  const s = get();
  const used = new Set(s.profiles.flatMap((p) => p.lists));
  return catalog.LISTS.map((l) => {
    const t = tel[l.id] || null;
    return {
      id: l.id, source: l.source, home: l.home, license: l.license, defaultOn: l.defaultOn, used: used.has(l.id),
      loaded: !!(t && t.loaded), entries: t && t.loaded ? t.entries : l.entries, estimated: !(t && t.loaded),
      updatedAt: t ? iso(t.updatedAt) : null, checkedAt: t ? iso(t.checkedAt) : null, error: t && t.error ? t.error.code : null,
      profiles: s.profiles.filter((p) => p.lists.includes(l.id)).map((p) => p.id),
    };
  });
}

/** gc.vpnDns.lists() → the catalogue lists with what the service has loaded. */
function lists() {
  return { lists: listsView(), memoryBytes: run.svc ? run.svc.listsBytes : null, entries: run.svc ? run.svc.listsEntries : null, asOf: iso(run.svcAt) };
}

function serviceView() {
  const v = run.svc;
  if (!v) return { running: false };
  return {
    running: true, ready: !!v.ready, pid: v.pid, startedAt: iso(v.startedAt), port: v.listen && v.listen.port, listen: v.listen && v.listen.state,
    upstream: v.upstream ? { provider: v.upstream.provider, lastOkAt: iso(v.upstream.lastOkAt), lastError: v.upstream.lastError ? { at: iso(v.upstream.lastError.at), code: v.upstream.lastError.code } : null, fallbacks: v.upstream.fallbacks, encryptedDown: !!v.upstream.dohDown } : null,
    memory: v.memory ? { rss: v.memory.rss, lists: v.listsBytes } : null,
    cacheEntries: v.cacheEntries, truncated: v.counters ? v.counters.tc : 0, failOpen: v.counters ? v.counters.failOpen : 0, asOf: iso(run.svcAt),
  };
}

/** gc.vpnDns.status() */
function status(now = Date.now()) {
  const s = get();
  const st = stateNow();
  const chain = dnsChain.vpnFilter.status();
  const devices = resolve(s);
  const sus = suspended(devices, now);
  const count = (state) => devices.filter((d) => d.state === state).length;
  const all = pauseRows(now).find((r) => r.scope === 'all');
  const t = todayRow(now) || { queries: 0, blocked: 0, cached: 0, by_reason: null };
  return {
    available: available(),
    enabled: s.enabled,
    // switched on, but the server's internal DNS (dnsmasq) is off: there is nothing to put the filter behind
    blockedBy: s.enabled && !config.dns.enabled ? 'internal_dns_off' : null,
    state: st,
    since: st === 'off' ? null : iso(st === 'starting' ? run.wantedAt : chain.since),
    chain: chainNow(),
    pihole: piholeInfo(),
    pause: all ? pauseView(all) : null,
    pauses: pauseRows(now).filter((r) => r.scope !== 'all').length,
    service: serviceView(),
    peers: {
      filtered: count('filtered'), ownDns: count('ownDns'), excluded: count('excluded'), gateways: count('gateway'),
      suspended: sus.all !== null ? count('filtered') : devices.filter((d) => d.state === 'filtered' && sus.keys[keyOf(d.peerId)] !== undefined).length,
    },
    lists: listsView().filter((l) => l.used),
    today: { queries: t.queries, blocked: t.blocked, cached: t.cached, blockedBy: blockedByOf(t.by_reason) },
    log: { enabled: s.log.enabled, retentionDays: s.log.retentionDays },
  };
}

/** gc.vpnDns.devices() → every peer with its effective profile; counters only with the query log on. */
function devices(now = Date.now()) {
  const s = get();
  const list = resolve(s);
  const sus = suspended(list, now);
  const names = new Map(s.profiles.map((p) => [p.id, p.name]));
  const per = s.log.enabled
    ? new Map(db().prepare('SELECT peer_id, queries, blocked FROM vpn_dns_peer_day WHERE day = ?').all(dayKey(now)).map((r) => [r.peer_id, { queries: r.queries, blocked: r.blocked }]))
    : null;
  const direct = new Set(pauseRows(now).filter((r) => r.scope === 'peer').map((r) => r.target_id));
  return list.map((d) => {
    const own = sus.keys[keyOf(d.peerId)];
    const until = d.profileId ? (sus.all !== null ? sus.all : (own === undefined ? null : own)) : null;
    return {
      ...d,
      profile: d.profileId ? { id: d.profileId, name: names.get(d.profileId) || d.profileId } : null,
      suspended: until !== null,
      suspendedUntil: until ? iso(until) : null,
      suspendedBy: until === null ? null : (sus.all !== null ? 'all' : (direct.has(d.peerId) ? 'peer' : 'user')),
      today: per ? (per.get(d.peerId) || { queries: 0, blocked: 0 }) : null,
    };
  });
}

/** The profile that holds for a person's devices without a profile of their own (person, then group, then default). */
function profileOfUser(userId, s = get()) {
  for (const p of s.profiles.slice(1)) if (p.users.includes(userId)) return { profileId: p.id, via: 'user' };
  for (const p of s.profiles.slice(1)) {
    if (!p.groups.length) continue;
    try { if (require('./groups').effectiveUserIds(p.groups).has(userId)) return { profileId: p.id, via: 'group' }; } catch { /* no groups */ }
  }
  return { profileId: DEFAULT_ID, via: 'default' };
}

/** gc.vpnDns.test(domain, { peerId | userId | profileId }) — asked from the filter service (it has the lists). */
async function test(domain, who = {}) {
  const d = homeDns().normPattern(String(domain || '').trim().replace(/^\*\./, ''));
  if (!d) throw invalid('no domain', { field: 'domain' });
  const s = get();
  const o = who && typeof who === 'object' ? who : {};
  const args = { domain: d };
  let dev = null;
  if (o.peerId !== undefined && o.peerId !== null) {
    dev = resolve(s).find((x) => x.peerId === o.peerId);
    if (!dev) throw new VpnDnsError('ERR_NOT_FOUND', 'unknown device');
    if (dev.profileId) args.key = keyOf(dev.peerId);
  } else if (o.userId !== undefined && o.userId !== null) {
    if (!db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(o.userId)) throw new VpnDnsError('ERR_NOT_FOUND', 'unknown or disabled person');
    args.profileId = profileOfUser(o.userId, s).profileId;
  } else if (o.profileId !== undefined && o.profileId !== null) {
    if (!s.profiles.some((p) => p.id === o.profileId)) throw new VpnDnsError('ERR_NOT_FOUND', 'unknown profile');
    args.profileId = o.profileId;
  } else args.profileId = DEFAULT_ID;
  const r = await control('test', args, 3000);
  if (r.error) throw r.error === 'invalid_domain' ? invalid('no domain', { field: 'domain' }) : new VpnDnsError('ERR_UNAVAILABLE', `the filter service could not check the domain (${r.error})`);
  const prof = r.profileId ? s.profiles.find((p) => p.id === r.profileId) : null;
  return {
    domain: r.domain, action: r.action, reason: r.reason, list: r.list || null, category: r.category || null, safeSearch: r.safeSearch || null,
    // an own entry: for everybody ('all') or only in the profile ('profile'); the entry (of a list, of the own
    // entries, of a category) that hit: { entry: 'tiktok.com', kind: 'domain' | 'subdomains' | 'exact' }
    scope: r.scope || null, match: r.match && typeof r.match.entry === 'string' ? { entry: r.match.entry, kind: r.match.kind } : null,
    profile: prof ? { id: prof.id, name: prof.name } : null,
    device: dev ? { peerId: dev.peerId, name: dev.name, state: dev.state } : null,
    filtered: !dev || dev.state === 'filtered',
  };
}

/** gc.vpnDns.catalog() → what can be picked: lists, categories of the times, upstream providers. */
function catalogView() {
  return {
    lists: catalog.LISTS.map((l) => ({ id: l.id, source: l.source, home: l.home, license: l.license, format: l.format, entries: l.entries, defaultOn: l.defaultOn })),
    categories: catalog.CATEGORY_IDS.map((id) => ({ id, domains: catalog.CATEGORIES[id].slice() })),
    providers: [...catalog.PROVIDERS.map((p) => ({ id: p.id, label: p.label, home: p.home })), { id: 'system', label: null, home: null }],
    limits: { ...LIMITS },
  };
}

/** gc.vpnDns.refreshLists() — "Jetzt aktualisieren". */
async function refreshLists() {
  await control('refreshLists', {}, 3000);
  return { started: true };
}

/** gc.vpnDns.restart() — "Filter-Dienst neu starten": the service leaves, its wrapper starts it again. */
async function restart(ctx = {}) {
  if (!run.wanted) throw new VpnDnsError('ERR_UNAVAILABLE', 'the DNS protection is switched off');
  let how = 'asked';
  try {
    await control('exit', {}, 1500);
  } catch {
    // It does not even answer on its control socket: end the process.
    how = 'killed';
    try {
      const pid = Number(fs.readFileSync(path.join(dir(), 'service.pid'), 'utf8'));
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (Number.isInteger(pid) && pid > 1 && cmd.includes('vpnDnsFilter')) process.kill(pid, 'SIGKILL');
      else how = 'not_running';
    } catch { how = 'not_running'; }
  }
  run.svc = null;
  audit('vpn_dns_service_restart', 'DNS protection: filter service restarted', { how }, ctx);
  schedule(TICK_STARTING_MS);
  return { restarting: true, how };
}

/**
 * gc.vpnDns.releasePihole() — the last step of moving from Pi-hole: Pi-hole
 * no longer asks for the chain. Only while the filter really owns it, so a
 * failed switch never leaves the devices without any filter.
 */
function releasePihole(ctx = {}) {
  if (stateNow() !== 'filtering') throw new VpnDnsError('ERR_NOT_FILTERING', 'the DNS protection does not filter yet — Pi-hole keeps the chain');
  const pc = require('./piholeConfig');
  const cfg = pc.load();
  if (cfg.manage_dns_chain) {
    pc.save({ ...cfg, manage_dns_chain: false });
    dnsChain.refresh();
    audit('vpn_dns_pihole_released', 'DNS protection: the Pi-hole DNS chain was switched off (replaced by the DNS protection)', {}, ctx);
  }
  return piholeInfo();
}

// ─── Events ────────────────────────────────────────────────────────────

/** What the dashboard notice needs (GET /api/v1/vpn-dns/status, event `vpn_dns`): null when there is nothing to say. */
function notice(now = Date.now()) {
  if (!run.wanted) return null;
  const st = stateNow();
  const plugin = allowedPlugins()[0];
  const all = pauseRows(now).find((r) => r.scope === 'all');
  const base = { state: st, plugin: plugin ? plugin.id : null };
  if (st === 'fallback') return { ...base, kind: 'fallback', since: iso(dnsChain.vpnFilter.status().since) };
  if (all && st === 'filtering') return { ...base, kind: 'paused', until: iso(all.until_at), openEnd: all.until_at == null, by: all.by_name || null, since: iso(all.created_at) };
  return { ...base, kind: null };
}

/**
 * What the apps learn with GET /api/v1/client/permissions: null (no DNS
 * protection on this server — the apps keep their Pi-hole view), or the
 * plugin whose client API serves them and the state of the filter.
 */
function clientInfo() {
  if (!run.wanted) return null;
  const p = appPlugin();
  return p ? { plugin: p.id, state: stateNow() } : null;
}

/** The plugin with the permission that may run and serves the apps. */
function appPlugin() {
  let app;
  try { app = require('./plugins/app'); } catch { return null; }
  return allowedPlugins().find((x) => app.usable(x)) || null;
}

/**
 * The same question, answered also while the protection is off — the field
 * `dnsProtection` next to `vpnDns` in GET /api/v1/client/permissions. `vpnDns`
 * keeps its meaning (an object only while the protection is wanted), so an app
 * that does not know the new field behaves as before; one that does can tell
 * "the plugin is there, the protection is switched off" (`enabled: false`,
 * `state: 'off'`) from "no plugin" (null).
 */
function clientPlugin() {
  const p = appPlugin();
  if (!p) return null;
  let enabled = false;
  try { enabled = get().enabled; } catch { /* no settings yet */ }
  return { plugin: p.id, enabled, state: stateNow() };
}

/** The installed plugin with permissions.vpnDns (whether it may run or not) — where "Zum DNS-Schutz umziehen" leads. */
function installedPlugin() {
  try {
    const p = require('./plugins/registry').list().filter(hasPermission);
    const ok = allowedPlugins();
    const pick = ok[0] || p[0] || null;
    return pick ? { id: pick.id, usable: ok.some((x) => x.id === pick.id) } : null;
  } catch { return null; }
}

function publish() {
  try { require('./eventBus').publish('vpn_dns', { notice: notice() }); } catch { /* best-effort */ }
}

/** fallback / restored / paused / resumed → hook `vpnDns` of every running plugin with the permission (never awaited). */
function emit(ev) {
  const payload = { ...ev, at: new Date().toISOString() };
  try {
    const runtime = require('./plugins/runtime');
    for (const p of allowedPlugins()) {
      try {
        if (runtime.info(p.id).state !== 'running') continue;
        runtime.call(p.id, 'vpnDns', payload, module.exports._hookMs || HOOK_MS).catch((e) => {
          try { require('./plugins/registry').addLog(p.id, e && e.stopped ? 'debug' : 'warn', 'vpnDns hook failed: ' + String((e && e.message) || e).slice(0, 200)); } catch { /* db closed */ }
        });
      } catch (e) { logger.debug({ err: e.message }, 'vpnDns hook not delivered'); }
    }
  } catch { /* plugins not loaded */ }
  publish();
}

function _resetForTest() {
  stop();
  Object.assign(run, { wanted: false, chainOn: false, everActive: false, down: false, wantedAt: 0, svc: null, svcAt: 0, lastConfig: null, configAt: 0, takeAt: 0, retentionAt: 0, ticking: null });
}

module.exports = {
  VpnDnsError, LIMITS, DEFAULT_ID, PROVIDERS,
  available, allowedPlugins, hasPermission,
  normalize, validate, get, set,
  resolve, profileOfUser, filterConfig, internalNames,
  pause, resume, pauses, sweepPauses, suspended,
  status, devices, lists, stats, test, log, clearLog, catalog: catalogView, refreshLists, restart, releasePihole, notice, clientInfo, clientPlugin, installedPlugin, piholeTargets, BLOCK_KINDS,
  reconcile, pluginsChanged, refreshSoon, tick, start, stop, ingest, retention, control, dir, filterPort, writeConfig,
  _run: run, _resetForTest, _hookMs: null,
};
