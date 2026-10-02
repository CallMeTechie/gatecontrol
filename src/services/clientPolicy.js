'use strict';

/**
 * Client policies ("Client-Richtlinien vom Server").
 *
 * The admin defines what the GateControl clients (Windows Pro/Community,
 * Android) enforce locally:
 *
 *   kill_switch         'user' | 'required'
 *   auto_connect        'user' | 'required' | 'always_on'
 *                       required  = connect automatically on start, the
 *                                   user cannot switch auto-connect off
 *                       always_on = like required, and the user cannot
 *                                   disconnect manually either
 *   autostart           'user' | 'required' | 'forbidden'
 *   split_tunnel_modes  non-empty subset of ['off', 'exclude', 'include']
 *                       ('off' = full tunnel). A LOCKED split-tunnel preset
 *                       (settings → split tunnel / token override) wins:
 *                       its mode becomes the only allowed one.
 *   lock_settings       true = the user cannot change client settings
 *                       (display preferences like language/theme stay free)
 *   lock_server         true = server change / re-setup is hidden
 *
 * Levels: built-in defaults ← global (settings key `client_policy`) ←
 * peer group (peer_groups.client_policy) ← peer (peers.client_policy).
 * Group and peer store only the fields they override; a missing field / null
 * inherits. Built-in defaults impose no restriction, so a server that never
 * configured anything delivers an unrestricted policy.
 *
 * Trust model: the clients apply the policy themselves. It is a management
 * convenience against accidental changes, NOT a security boundary against a
 * user with local administrator rights (who can stop the client, edit its
 * store or bring up WireGuard by hand). Only an admin session can change
 * policies; API tokens get 403.
 */

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

const SETTINGS_KEY = 'client_policy';

const SPLIT_MODES = Object.freeze(['off', 'exclude', 'include']);

// Field definitions: allowed values per enum field, boolean flags.
const ENUM_FIELDS = Object.freeze({
  kill_switch: Object.freeze(['user', 'required']),
  auto_connect: Object.freeze(['user', 'required', 'always_on']),
  autostart: Object.freeze(['user', 'required', 'forbidden']),
});
const BOOL_FIELDS = Object.freeze(['lock_settings', 'lock_server']);
const FIELDS = Object.freeze([...Object.keys(ENUM_FIELDS), 'split_tunnel_modes', ...BOOL_FIELDS]);

const DEFAULTS = Object.freeze({
  kill_switch: 'user',
  auto_connect: 'user',
  autostart: 'user',
  split_tunnel_modes: Object.freeze([...SPLIT_MODES]),
  lock_settings: false,
  lock_server: false,
});

// snake_case (admin API / storage) → camelCase (client API)
const CLIENT_KEYS = Object.freeze({
  kill_switch: 'killSwitch',
  auto_connect: 'autoConnect',
  autostart: 'autostart',
  split_tunnel_modes: 'splitTunnelModes',
  lock_settings: 'lockSettings',
  lock_server: 'lockServer',
});

function cloneDefaults() {
  return { ...DEFAULTS, split_tunnel_modes: [...DEFAULTS.split_tunnel_modes] };
}

/** Normalised split-mode list (canonical order, deduplicated) or null when invalid/empty. */
function normalizeModes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > SPLIT_MODES.length * 2) return null;
  if (!value.every(m => typeof m === 'string' && SPLIT_MODES.includes(m))) return null;
  return SPLIT_MODES.filter(m => value.includes(m));
}

/**
 * Validate one field value. Returns { ok: true, value } or { ok: false }.
 * `null` is only valid when allowNull (overrides: null = inherit).
 */
function validateField(field, value, { allowNull }) {
  if (value === null) return allowNull ? { ok: true, value: null } : { ok: false };
  if (ENUM_FIELDS[field]) {
    return typeof value === 'string' && ENUM_FIELDS[field].includes(value) ? { ok: true, value } : { ok: false };
  }
  if (field === 'split_tunnel_modes') {
    const modes = normalizeModes(value);
    return modes ? { ok: true, value: modes } : { ok: false };
  }
  if (BOOL_FIELDS.includes(field)) {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
  }
  return { ok: false };
}

/**
 * Parse a stored override (JSON text). Unknown fields and invalid values are
 * dropped (fail-open to "inherit" — a damaged row must not lock clients into
 * something nobody configured). Returns a plain object with only set fields.
 */
function parseOverride(raw) {
  if (raw == null || raw === '') return {};
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (err) {
      logger.warn({ err: err.message }, 'malformed client_policy JSON — ignoring');
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const field of FIELDS) {
    if (obj[field] === undefined || obj[field] === null) continue;
    const r = validateField(field, obj[field], { allowNull: false });
    if (r.ok) out[field] = r.value;
  }
  return out;
}

/** Global policy (all fields set). Never throws. */
function getGlobal() {
  const policy = cloneDefaults();
  try {
    Object.assign(policy, parseOverride(settings.get(SETTINGS_KEY, '')));
  } catch (err) {
    logger.debug({ err: err.message }, 'client policy unavailable, using defaults');
  }
  return policy;
}

function saveGlobal(policy) {
  const out = {};
  for (const f of FIELDS) out[f] = policy[f];
  settings.set(SETTINGS_KEY, JSON.stringify(out));
}

/**
 * Validate an admin change.
 *
 *   mode 'global'   — partial update of the global policy; every given field
 *                     must be a valid value (null not allowed).
 *   mode 'override' — full replacement of a group/peer override; a field that
 *                     is missing or null inherits. `null`/{} as body clears.
 *
 * Returns { error, field } or { next, changes }.
 */
function validateInput(input, { mode, current }) {
  if (mode === 'override' && (input === null || input === undefined)) {
    input = {};
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid_policy' };
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key)) return { error: 'unknown_field', field: key };
  }

  const next = mode === 'global' ? { ...current, split_tunnel_modes: [...current.split_tunnel_modes] } : {};
  for (const field of FIELDS) {
    if (input[field] === undefined) continue;
    const r = validateField(field, input[field], { allowNull: mode === 'override' });
    if (!r.ok) return { error: 'invalid_value', field };
    if (mode === 'override' && r.value === null) continue;
    next[field] = r.value;
  }

  const changes = {};
  for (const field of FIELDS) {
    const from = current[field] === undefined ? null : current[field];
    const to = next[field] === undefined ? null : next[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return { next, changes };
}

function getGroupOverride(groupId) {
  if (groupId == null) return {};
  try {
    const row = getDb().prepare('SELECT client_policy FROM peer_groups WHERE id = ?').get(groupId);
    return row ? parseOverride(row.client_policy) : {};
  } catch (err) {
    logger.debug({ err: err.message }, 'reading group client policy failed');
    return {};
  }
}

function setGroupOverride(groupId, override) {
  const value = override && Object.keys(override).length ? JSON.stringify(override) : null;
  const info = getDb().prepare('UPDATE peer_groups SET client_policy = ? WHERE id = ?').run(value, groupId);
  if (info.changes === 0) throw new Error('Group not found');
}

function setPeerOverride(peerId, override) {
  const value = override && Object.keys(override).length ? JSON.stringify(override) : null;
  const info = getDb().prepare('UPDATE peers SET client_policy = ? WHERE id = ?').run(value, peerId);
  if (info.changes === 0) throw new Error('Peer not found');
}

function listGroups() {
  return getDb().prepare('SELECT id, name, color, client_policy FROM peer_groups ORDER BY name ASC').all()
    .map(g => ({ id: g.id, name: g.name, color: g.color, policy: parseOverride(g.client_policy) }));
}

/**
 * Split-tunnel preset for a token: token override > global preset > none.
 * Same resolution as GET /api/v1/client/split-tunnel (which uses it).
 * Returns { mode, networks, locked, source }.
 */
function resolveSplitTunnelPreset(tokenId) {
  let preset = null;
  let source = 'none';
  if (tokenId) {
    try {
      const token = require('./tokens').getById(tokenId);
      if (token && token.split_tunnel_override) {
        try {
          preset = JSON.parse(token.split_tunnel_override);
          source = 'token';
        } catch (err) { logger.warn({ err: err.message, tokenId }, 'malformed split_tunnel_override JSON — ignoring token override'); }
      }
    } catch (err) { logger.debug({ err: err.message }, 'token lookup for split-tunnel preset failed'); }
  }
  if (!preset) {
    const raw = settings.get('split_tunnel_preset', '');
    if (raw) {
      try {
        preset = JSON.parse(raw);
        source = 'global';
      } catch (err) { logger.warn({ err: err.message }, 'malformed split_tunnel_preset JSON — ignoring global preset'); }
    }
  }
  if (!preset || typeof preset !== 'object' || preset.mode === 'off') {
    return { mode: 'off', networks: [], locked: false, source: 'none' };
  }
  return {
    // Unchanged from the original endpoint: a preset without mode is 'exclude'.
    mode: SPLIT_MODES.includes(preset.mode) ? preset.mode : 'exclude',
    networks: Array.isArray(preset.networks) ? preset.networks : [],
    locked: !!preset.locked,
    source,
  };
}

/**
 * Effective policy for a peer (or the global one when peer is null).
 *   opts.tokenId  — for the token's split-tunnel preset override
 * Returns { policy (snake_case, all fields), sources, splitTunnelLocked }.
 */
function resolveEffective(peer, { tokenId = null } = {}) {
  const policy = cloneDefaults();
  const sources = {};
  for (const f of FIELDS) sources[f] = 'default';

  let stored = {};
  try { stored = parseOverride(settings.get(SETTINGS_KEY, '')); } catch (err) {
    logger.debug({ err: err.message }, 'client policy unavailable, using defaults');
  }
  const layers = [
    ['global', stored],
    ['group', peer && peer.group_id != null ? getGroupOverride(peer.group_id) : {}],
    ['peer', peer ? parseOverride(peer.client_policy) : {}],
  ];
  for (const [name, layer] of layers) {
    for (const f of FIELDS) {
      if (layer[f] === undefined) continue;
      policy[f] = Array.isArray(layer[f]) ? [...layer[f]] : layer[f];
      // A global value equal to the built-in default restricts nothing —
      // still report 'global' so the admin sees where it came from.
      sources[f] = name;
    }
  }

  let splitTunnelLocked = false;
  let preset = { mode: 'off', locked: false, source: 'none' };
  try { preset = resolveSplitTunnelPreset(tokenId); } catch (err) {
    logger.debug({ err: err.message }, 'split-tunnel preset unavailable');
  }
  if (preset.locked) {
    policy.split_tunnel_modes = [preset.mode];
    sources.split_tunnel_modes = 'preset';
    splitTunnelLocked = true;
  }

  return { policy, sources, splitTunnelLocked, preset: { mode: preset.mode, locked: preset.locked, source: preset.source } };
}

/** true when the policy restricts anything compared to the built-in defaults. */
function isManaged(policy, splitTunnelLocked = false) {
  if (splitTunnelLocked) return true;
  for (const f of FIELDS) {
    if (JSON.stringify(policy[f]) !== JSON.stringify(DEFAULTS[f])) return true;
  }
  return false;
}

/** Client API shape (camelCase, fixed key order → stable version hash). */
function toClientPayload({ policy, splitTunnelLocked }) {
  const out = {};
  for (const f of FIELDS) {
    out[CLIENT_KEYS[f]] = Array.isArray(policy[f]) ? [...policy[f]] : policy[f];
  }
  out.splitTunnelLocked = !!splitTunnelLocked;
  return out;
}

/** Short content hash of the client payload — the policy "version" / ETag. */
function versionOf(clientPolicy) {
  return crypto.createHash('sha256').update(JSON.stringify(clientPolicy)).digest('hex').slice(0, 16);
}

/**
 * Everything a client needs: { version, managed, policy, sources }.
 * Never throws — on any failure the unrestricted default policy is returned
 * (a broken policy must not lock clients out of their settings).
 */
function forClient(peer, opts = {}) {
  let resolved;
  try {
    resolved = resolveEffective(peer, opts);
  } catch (err) {
    logger.warn({ err: err.message }, 'resolving client policy failed — delivering defaults');
    resolved = { policy: cloneDefaults(), sources: {}, splitTunnelLocked: false };
  }
  const policy = toClientPayload(resolved);
  const sources = {};
  for (const f of FIELDS) sources[CLIENT_KEYS[f]] = (resolved.sources && resolved.sources[f]) || 'default';
  return {
    version: versionOf(policy),
    managed: isManaged(resolved.policy, resolved.splitTunnelLocked),
    policy,
    sources,
  };
}

/** Policy version for the heartbeat / permissions response. Never throws. */
function versionFor(peer, opts = {}) {
  try {
    return forClient(peer, opts).version;
  } catch {
    return null;
  }
}

/** Peer row → admin API fields (parsed override instead of raw JSON). */
function decoratePeer(peer) {
  if (!peer || typeof peer !== 'object') return peer;
  const override = parseOverride(peer.client_policy);
  return { ...peer, client_policy: Object.keys(override).length ? override : null };
}

/**
 * Warnings for the admin UI (not errors — the policy is still saved):
 *   split_tunnel_preset_conflict — the global preset uses a mode the global
 *   policy does not allow (and is not locked, so it does not win).
 */
function warningsFor(globalPolicy) {
  const warnings = [];
  try {
    const preset = resolveSplitTunnelPreset(null);
    if (preset.source === 'global' && !preset.locked && !globalPolicy.split_tunnel_modes.includes(preset.mode)) {
      warnings.push('split_tunnel_preset_conflict');
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'split-tunnel preset check failed');
  }
  return warnings;
}

module.exports = {
  SETTINGS_KEY,
  SPLIT_MODES,
  ENUM_FIELDS,
  BOOL_FIELDS,
  FIELDS,
  DEFAULTS,
  CLIENT_KEYS,
  normalizeModes,
  parseOverride,
  getGlobal,
  saveGlobal,
  validateInput,
  getGroupOverride,
  setGroupOverride,
  setPeerOverride,
  listGroups,
  resolveSplitTunnelPreset,
  resolveEffective,
  isManaged,
  toClientPayload,
  versionOf,
  forClient,
  versionFor,
  decoratePeer,
  warningsFor,
};
