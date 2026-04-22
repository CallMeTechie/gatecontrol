'use strict';

const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const activity = require('./activity');
const logger = require('../utils/logger');

// --- Validation ------------------------------------------------

// 'gateway' routes the RDP session through a Home Gateway peer — the
// service layer auto-creates a linked L4 TCP route on the server and
// tracks its id in rdp_routes.gateway_l4_route_id. Licensed via the
// rdp_via_gateway feature flag.
const VALID_ACCESS_MODES = ['internal', 'external', 'both', 'gateway'];
const VALID_CREDENTIAL_MODES = ['none', 'user_only', 'full'];
const VALID_RESOLUTION_MODES = ['fullscreen', 'fixed', 'dynamic'];
const VALID_AUDIO_MODES = ['local', 'remote', 'off'];
const VALID_NETWORK_PROFILES = ['lan', 'broadband', 'modem', 'auto'];
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

function validateRdpRoute(data, isUpdate = false) {
  const errors = {};

  if (!isUpdate || data.name !== undefined) {
    if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
      errors.name = 'Name is required';
    } else if (data.name.trim().length > 100) {
      errors.name = 'Name must not exceed 100 characters';
    }
  }

  if (!isUpdate || data.host !== undefined) {
    if (!data.host || typeof data.host !== 'string' || data.host.trim().length === 0) {
      errors.host = 'Host is required';
    }
  }

  if (data.port !== undefined) {
    const port = parseInt(data.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.port = 'Port must be between 1 and 65535';
    }
  }

  if (data.external_port !== undefined && data.external_port !== null) {
    const port = parseInt(data.external_port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.external_port = 'External port must be between 1 and 65535';
    }
  }

  if (data.access_mode !== undefined && !VALID_ACCESS_MODES.includes(data.access_mode)) {
    errors.access_mode = 'Access mode must be internal, external, both, or gateway';
  }

  // Gateway mode needs a gateway peer + a listen port for the auto-
  // created L4 route. Host+port (the LAN target) are already covered
  // by the general RDP-route validation further up.
  if (data.access_mode === 'gateway') {
    if (data.gateway_peer_id === undefined || data.gateway_peer_id === null) {
      errors.gateway_peer_id = 'Gateway peer is required for access_mode=gateway';
    } else {
      const peerId = parseInt(data.gateway_peer_id, 10);
      if (!Number.isInteger(peerId)) {
        errors.gateway_peer_id = 'Gateway peer id must be an integer';
      } else {
        // Referenced peer must actually be a gateway-peer; otherwise the
        // L4 auto-link / WoL push / config-push flows all fail at runtime
        // with a cryptic error instead of this clear config-time message.
        const row = getDb().prepare('SELECT peer_type FROM peers WHERE id = ?').get(peerId);
        if (!row) {
          errors.gateway_peer_id = 'Gateway peer not found';
        } else if (row.peer_type !== 'gateway') {
          errors.gateway_peer_id = 'Referenced peer is not a gateway peer';
        }
      }
    }
    if (data.gateway_listen_port !== undefined && data.gateway_listen_port !== null) {
      const p = parseInt(data.gateway_listen_port, 10);
      if (isNaN(p) || p < 1 || p > 65535) {
        errors.gateway_listen_port = 'Listen port must be between 1 and 65535';
      }
    }
  }

  if (data.credential_mode !== undefined && !VALID_CREDENTIAL_MODES.includes(data.credential_mode)) {
    errors.credential_mode = 'Credential mode must be none, user_only, or full';
  }

  if (data.resolution_mode !== undefined && !VALID_RESOLUTION_MODES.includes(data.resolution_mode)) {
    errors.resolution_mode = 'Resolution mode must be fullscreen, fixed, or dynamic';
  }

  if (data.audio_mode !== undefined && !VALID_AUDIO_MODES.includes(data.audio_mode)) {
    errors.audio_mode = 'Audio mode must be local, remote, or off';
  }

  if (data.network_profile !== undefined && !VALID_NETWORK_PROFILES.includes(data.network_profile)) {
    errors.network_profile = 'Network profile must be lan, broadband, modem, or auto';
  }

  if (data.color_depth !== undefined && ![8, 15, 16, 24, 32].includes(data.color_depth)) {
    errors.color_depth = 'Color depth must be 8, 15, 16, 24, or 32';
  }

  if (data.wol_mac_address !== undefined && data.wol_mac_address !== null && data.wol_mac_address !== '') {
    if (!MAC_RE.test(data.wol_mac_address)) {
      errors.wol_mac_address = 'Invalid MAC address format (expected AA:BB:CC:DD:EE:FF)';
    }
  }

  if (data.session_timeout !== undefined && data.session_timeout !== null) {
    const timeout = parseInt(data.session_timeout, 10);
    if (isNaN(timeout) || timeout < 0) {
      errors.session_timeout = 'Session timeout must be a positive number';
    }
  }

  if (data.bandwidth_limit !== undefined && data.bandwidth_limit !== null) {
    const limit = parseInt(data.bandwidth_limit, 10);
    if (isNaN(limit) || limit < 0) {
      errors.bandwidth_limit = 'Bandwidth limit must be a positive number';
    }
  }

  if (data.credential_rotation_days !== undefined && data.credential_rotation_days !== null) {
    const days = parseInt(data.credential_rotation_days, 10);
    if (isNaN(days) || days < 1) {
      errors.credential_rotation_days = 'Rotation interval must be at least 1 day';
    }
  }

  if (data.token_ids !== undefined && data.token_ids !== null) {
    if (!Array.isArray(data.token_ids)) {
      errors.token_ids = 'Token IDs must be an array';
    }
  }

  if (data.tags !== undefined && data.tags !== null) {
    if (!Array.isArray(data.tags)) {
      errors.tags = 'Tags must be an array';
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

// --- Credential Encryption Helpers -----------------------------

function encryptCredentials(data) {
  const result = {};
  if (data.username !== undefined && data.username !== null && data.username !== '') {
    result.username_encrypted = encrypt(data.username);
  } else if (data.username === '' || data.username === null) {
    result.username_encrypted = null;
  }
  if (data.password !== undefined && data.password !== null && data.password !== '') {
    result.password_encrypted = encrypt(data.password);
  } else if (data.password === '' || data.password === null) {
    result.password_encrypted = null;
  }
  return result;
}

function decryptCredentials(row) {
  const result = { username: null, password: null };
  try {
    if (row.username_encrypted) result.username = decrypt(row.username_encrypted);
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to decrypt RDP username');
  }
  try {
    if (row.password_encrypted) result.password = decrypt(row.password_encrypted);
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to decrypt RDP password');
  }
  return result;
}

/**
 * Check if an RDP route is currently in its maintenance window.
 * Schedule format: "Mo-Fr 08:00-18:00" or multiple lines separated by \n or ;
 * Supports German day names: Mo,Di,Mi,Do,Fr,Sa,So and English: Mon,Tue,Wed,Thu,Fri,Sat,Sun
 */
function isInMaintenanceWindow(routeId) {
  const db = getDb();
  const route = db.prepare('SELECT maintenance_enabled, maintenance_schedule FROM rdp_routes WHERE id = ?').get(routeId);
  if (!route || !route.maintenance_enabled || !route.maintenance_schedule) return false;
  return parseMaintenanceActive(route.maintenance_schedule);
}

function parseMaintenanceActive(schedule) {
  if (!schedule) return false;

  // Backwards compatibility: older rows were JSON.stringify'd, so the string
  // is wrapped in double-quotes. Unwrap it so the regex parses cleanly.
  if (typeof schedule === 'string' && schedule.startsWith('"') && schedule.endsWith('"')) {
    try { schedule = JSON.parse(schedule); } catch {}
  }

  const now = new Date();
  const dayIndex = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const dayMap = {
    'Mo': 1, 'Di': 2, 'Mi': 3, 'Do': 4, 'Fr': 5, 'Sa': 6, 'So': 0,
    'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6, 'Sun': 0,
  };

  const lines = schedule.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\w{2,3})(?:-(\w{2,3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!match) continue;

    const [, dayStart, dayEnd, h1, m1, h2, m2] = match;
    const startDay = dayMap[dayStart];
    const endDay = dayEnd ? dayMap[dayEnd] : startDay;
    const startMin = parseInt(h1) * 60 + parseInt(m1);
    const endMin = parseInt(h2) * 60 + parseInt(m2);

    if (startDay === undefined) continue;

    let dayInRange = false;
    if (startDay <= endDay) {
      dayInRange = dayIndex >= startDay && dayIndex <= endDay;
    } else {
      dayInRange = dayIndex >= startDay || dayIndex <= endDay;
    }

    if (dayInRange && currentMinutes >= startMin && currentMinutes < endMin) {
      return true;
    }
  }

  return false;
}

// --- Strip encrypted fields from response ----------------------

function stripSensitive(row) {
  if (!row) return row;
  const { username_encrypted, password_encrypted, ...safe } = row;
  safe.has_credentials = !!(username_encrypted || password_encrypted);
  // SQLite stores booleans as 0/1 — convert to real booleans for JSON clients
  for (const key of ['multi_monitor', 'redirect_clipboard', 'redirect_printers',
    'redirect_drives', 'admin_session', 'wol_enabled', 'maintenance_enabled', 'enabled']) {
    if (key in safe && typeof safe[key] === 'number') {
      safe[key] = !!safe[key];
    }
  }
  return safe;
}

// --- CRUD ------------------------------------------------------

function getAll({ limit = 250, offset = 0 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM rdp_routes
    ORDER BY name ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return rows.map(stripSensitive);
}

function getById(id, includeCredentials = false) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM rdp_routes WHERE id = ?').get(id);
  if (!row) return null;
  if (includeCredentials) {
    const creds = decryptCredentials(row);
    const safe = stripSensitive(row);
    safe.username = creds.username;
    safe.password = creds.password;
    return safe;
  }
  return stripSensitive(row);
}

async function create(data) {
  const errors = validateRdpRoute(data, false);
  if (errors) {
    const err = new Error(Object.values(errors)[0]);
    err.fields = errors;
    throw err;
  }

  const db = getDb();
  const encrypted = encryptCredentials(data);

  const result = db.prepare(`
    INSERT INTO rdp_routes (
      name, description, host, port, external_hostname, external_port,
      access_mode, gateway_host, gateway_port, enabled,
      credential_mode, username_encrypted, password_encrypted, domain,
      resolution_mode, resolution_width, resolution_height, multi_monitor, color_depth,
      redirect_clipboard, redirect_printers, redirect_drives, redirect_usb, redirect_smartcard, audio_mode,
      network_profile, nla_enabled, disable_wallpaper, disable_themes, disable_animations, bandwidth_limit,
      session_timeout, admin_session, remote_app, start_program,
      wol_enabled, wol_mac_address,
      maintenance_enabled, maintenance_schedule,
      sharing_enabled, sharing_mode, sharing_require_consent,
      screenshot_enabled,
      credential_rotation_enabled, credential_rotation_days,
      token_ids, user_ids, notes, tags,
      health_check_enabled,
      gateway_peer_id, gateway_listen_port
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?,
      ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?
    )
  `).run(
    data.name.trim(),
    data.description || null,
    data.host.trim(),
    parseInt(data.port, 10) || 3389,
    data.external_hostname || null,
    data.external_port != null ? parseInt(data.external_port, 10) : null,
    data.access_mode || 'internal',
    data.gateway_host || null,
    data.gateway_port != null ? parseInt(data.gateway_port, 10) : 443,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
    data.credential_mode || 'none',
    encrypted.username_encrypted || null,
    encrypted.password_encrypted || null,
    data.domain || null,
    data.resolution_mode || 'fullscreen',
    data.resolution_width != null ? parseInt(data.resolution_width, 10) : null,
    data.resolution_height != null ? parseInt(data.resolution_height, 10) : null,
    data.multi_monitor ? 1 : 0,
    parseInt(data.color_depth, 10) || 32,
    data.redirect_clipboard !== undefined ? (data.redirect_clipboard ? 1 : 0) : 1,
    data.redirect_printers ? 1 : 0,
    data.redirect_drives ? 1 : 0,
    data.redirect_usb ? 1 : 0,
    data.redirect_smartcard ? 1 : 0,
    data.audio_mode || 'local',
    data.network_profile || 'auto',
    data.nla_enabled !== undefined ? (data.nla_enabled ? 1 : 0) : 1,
    data.disable_wallpaper ? 1 : 0,
    data.disable_themes ? 1 : 0,
    data.disable_animations ? 1 : 0,
    data.bandwidth_limit != null ? parseInt(data.bandwidth_limit, 10) : null,
    data.session_timeout != null ? parseInt(data.session_timeout, 10) : null,
    data.admin_session ? 1 : 0,
    data.remote_app || null,
    data.start_program || null,
    data.wol_enabled ? 1 : 0,
    data.wol_mac_address || null,
    data.maintenance_enabled ? 1 : 0,
    data.maintenance_schedule ? (typeof data.maintenance_schedule === 'string' ? data.maintenance_schedule : JSON.stringify(data.maintenance_schedule)) : null,
    data.sharing_enabled ? 1 : 0,
    data.sharing_mode || 'view',
    data.sharing_require_consent !== undefined ? (data.sharing_require_consent ? 1 : 0) : 1,
    data.screenshot_enabled ? 1 : 0,
    data.credential_rotation_enabled ? 1 : 0,
    parseInt(data.credential_rotation_days, 10) || 90,
    data.token_ids ? JSON.stringify(data.token_ids) : null,
    data.user_ids ? JSON.stringify(data.user_ids) : null,
    data.notes || null,
    data.tags ? JSON.stringify(data.tags) : null,
    data.health_check_enabled !== undefined ? (data.health_check_enabled ? 1 : 0) : 1,
    data.access_mode === 'gateway' && data.gateway_peer_id != null
      ? parseInt(data.gateway_peer_id, 10) : null,
    data.access_mode === 'gateway' && data.gateway_listen_port != null
      ? parseInt(data.gateway_listen_port, 10) : null
  );

  const routeId = result.lastInsertRowid;

  // Gateway access mode: spin up a linked L4 TCP route that forwards
  // the external listen-port to the RDP target via the gateway's
  // TcpProxyManager. Roll back the RDP row if the L4 side fails —
  // leaving a half-configured pair behind would silently break reads
  // in the admin UI and never attract a fix.
  if (data.access_mode === 'gateway') {
    try {
      await _syncLinkedL4Route(routeId, null);
    } catch (err) {
      db.prepare('DELETE FROM rdp_routes WHERE id = ?').run(routeId);
      throw new Error(`Linked L4 gateway route could not be created: ${err.message}`);
    }
  }

  activity.log('rdp_route_created', `RDP route "${data.name}" created -> ${data.host}:${data.port || 3389}`, {
    source: 'admin',
    severity: 'info',
    details: { routeId, name: data.name, host: data.host, access_mode: data.access_mode || 'internal' },
  });

  logger.info({ routeId, name: data.name }, 'RDP route created');
  return getById(routeId);
}

// Create / update / delete the L4 TCP route that backs a gateway-mode
// RDP route. Keeps rdp_routes.gateway_l4_route_id and the matching row
// in routes(.target_kind='gateway', route_type='l4') in sync.
async function _syncLinkedL4Route(rdpId, previousL4RouteId) {
  const db = getDb();
  const rdp = db.prepare('SELECT * FROM rdp_routes WHERE id = ?').get(rdpId);
  if (!rdp) throw new Error('RDP route not found');

  const routesService = require('./routes');

  // Case A: no longer a gateway-mode route — clean up any leftover L4.
  if (rdp.access_mode !== 'gateway') {
    if (previousL4RouteId) {
      try {
        await routesService.remove(previousL4RouteId);
      } catch (err) {
        logger.warn({ err: err.message, previousL4RouteId },
          'Linked L4 cleanup failed (not fatal — orphan may remain)');
      }
      db.prepare('UPDATE rdp_routes SET gateway_l4_route_id = NULL WHERE id = ?').run(rdpId);
    }
    return;
  }

  // Case B: gateway-mode. Determine the desired listen port; fall back to
  // the RDP target port if the user didn't pick a dedicated one.
  const listenPort = rdp.gateway_listen_port || rdp.port || 3389;

  const l4Payload = {
    domain: null,                              // L4 with tls_mode=none needs no domain
    route_type: 'l4',
    target_kind: 'gateway',
    target_peer_id: rdp.gateway_peer_id,
    target_lan_host: rdp.host,
    target_lan_port: rdp.port || 3389,
    l4_protocol: 'tcp',
    l4_listen_port: String(listenPort),
    l4_tls_mode: 'none',
    target_port: listenPort,                   // legacy NOT NULL column — mirror listen_port
    enabled: !!rdp.enabled,
    description: `auto-created for RDP route "${rdp.name}"`,
  };

  if (previousL4RouteId) {
    await routesService.update(previousL4RouteId, l4Payload);
    return;
  }

  const created = await routesService.create(l4Payload);
  db.prepare('UPDATE rdp_routes SET gateway_l4_route_id = ? WHERE id = ?')
    .run(created.id, rdpId);
}

async function update(id, data) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM rdp_routes WHERE id = ?').get(id);
  if (!existing) throw new Error('RDP route not found');

  const errors = validateRdpRoute(data, true);
  if (errors) {
    const err = new Error(Object.values(errors)[0]);
    err.fields = errors;
    throw err;
  }

  const sets = [];
  const values = [];

  const directFields = [
    'name', 'description', 'host', 'port', 'external_hostname', 'external_port',
    'access_mode', 'gateway_host', 'gateway_port', 'enabled',
    'gateway_peer_id', 'gateway_listen_port',
    'credential_mode', 'domain',
    'resolution_mode', 'resolution_width', 'resolution_height', 'multi_monitor', 'color_depth',
    'redirect_clipboard', 'redirect_printers', 'redirect_drives', 'redirect_usb', 'redirect_smartcard', 'audio_mode',
    'network_profile', 'nla_enabled', 'disable_wallpaper', 'disable_themes', 'disable_animations', 'bandwidth_limit',
    'session_timeout', 'admin_session', 'remote_app', 'start_program',
    'wol_enabled', 'wol_mac_address',
    'maintenance_enabled',
    'sharing_enabled', 'sharing_mode', 'sharing_require_consent',
    'screenshot_enabled',
    'credential_rotation_enabled', 'credential_rotation_days', 'credential_rotation_last',
    'notes',
    'health_check_enabled',
  ];

  const booleanFields = [
    'enabled', 'multi_monitor',
    'redirect_clipboard', 'redirect_printers', 'redirect_drives', 'redirect_usb', 'redirect_smartcard',
    'nla_enabled', 'disable_wallpaper', 'disable_themes', 'disable_animations',
    'admin_session', 'wol_enabled', 'maintenance_enabled',
    'sharing_enabled', 'sharing_require_consent',
    'screenshot_enabled', 'credential_rotation_enabled', 'health_check_enabled',
  ];

  const intFields = [
    'port', 'external_port', 'gateway_port', 'gateway_peer_id', 'gateway_listen_port',
    'resolution_width', 'resolution_height',
    'color_depth', 'bandwidth_limit', 'session_timeout', 'credential_rotation_days',
  ];

  for (const field of directFields) {
    if (data[field] !== undefined) {
      sets.push(`${field} = ?`);
      if (booleanFields.includes(field)) {
        values.push(data[field] ? 1 : 0);
      } else if (intFields.includes(field)) {
        values.push(data[field] != null ? parseInt(data[field], 10) : null);
      } else if (typeof data[field] === 'string') {
        values.push(data[field].trim());
      } else {
        values.push(data[field]);
      }
    }
  }

  if (data.username !== undefined) {
    const enc = encryptCredentials({ username: data.username });
    sets.push('username_encrypted = ?');
    values.push(enc.username_encrypted || null);
  }
  if (data.password !== undefined) {
    const enc = encryptCredentials({ password: data.password });
    sets.push('password_encrypted = ?');
    values.push(enc.password_encrypted || null);
  }

  if (data.maintenance_schedule !== undefined) {
    sets.push('maintenance_schedule = ?');
    values.push(data.maintenance_schedule ? (typeof data.maintenance_schedule === 'string' ? data.maintenance_schedule : JSON.stringify(data.maintenance_schedule)) : null);
  }
  if (data.token_ids !== undefined) {
    sets.push('token_ids = ?');
    values.push(data.token_ids ? JSON.stringify(data.token_ids) : null);
  }
  if (data.user_ids !== undefined) {
    sets.push('user_ids = ?');
    values.push(data.user_ids ? JSON.stringify(data.user_ids) : null);
  }
  if (data.tags !== undefined) {
    sets.push('tags = ?');
    values.push(data.tags ? JSON.stringify(data.tags) : null);
  }

  if (sets.length === 0) return getById(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE rdp_routes SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  // Any gateway-mode relevant field changed → reconcile the linked L4
  // route (create / update / delete). We re-read the post-update row
  // rather than reconstructing it from the SET list so we always see
  // the authoritative final values.
  const gatewayRelevantChanged =
    data.access_mode !== undefined ||
    data.gateway_peer_id !== undefined ||
    data.gateway_listen_port !== undefined ||
    data.host !== undefined ||
    data.port !== undefined ||
    data.enabled !== undefined;

  if (gatewayRelevantChanged) {
    try {
      await _syncLinkedL4Route(id, existing.gateway_l4_route_id || null);
    } catch (err) {
      // Don't roll back the RDP update — user-visible settings stayed
      // consistent with DB. Log loudly so the orphan/missing state
      // surfaces in monitoring; user can re-save to retry.
      logger.error({ err: err.message, rdpId: id },
        'Linked L4 sync failed — RDP update succeeded but gateway-route may be stale');
    }
  }

  activity.log('rdp_route_updated', `RDP route "${existing.name}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { routeId: id, access_mode: data.access_mode },
  });

  logger.info({ routeId: id }, 'RDP route updated');
  return getById(id);
}

async function remove(id) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');

  // Cascade: drop the linked L4 route first so no orphan lingers if
  // the RDP delete fails afterwards.
  if (route.gateway_l4_route_id) {
    try {
      const routesService = require('./routes');
      await routesService.remove(route.gateway_l4_route_id);
    } catch (err) {
      logger.warn({ err: err.message, l4RouteId: route.gateway_l4_route_id, rdpId: id },
        'Linked L4 delete failed during RDP-route removal');
    }
  }

  db.prepare('DELETE FROM rdp_routes WHERE id = ?').run(id);

  activity.log('rdp_route_deleted', `RDP route "${route.name}" deleted`, {
    source: 'admin',
    severity: 'warning',
    details: { routeId: id, name: route.name },
  });

  logger.info({ routeId: id, name: route.name }, 'RDP route deleted');
}

async function toggle(id) {
  const db = getDb();
  const route = db.prepare('SELECT id, name, enabled, gateway_l4_route_id FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');

  const newState = route.enabled ? 0 : 1;
  db.prepare("UPDATE rdp_routes SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newState, id);

  // Keep the linked L4 route in sync so a disabled RDP route also
  // closes its external listen port instead of silently forwarding
  // to a disabled target.
  if (route.gateway_l4_route_id) {
    try {
      const routesService = require('./routes');
      await routesService.update(route.gateway_l4_route_id, { enabled: !!newState });
    } catch (err) {
      logger.warn({ err: err.message, l4RouteId: route.gateway_l4_route_id, rdpId: id },
        'Linked L4 toggle failed — listener may be stale');
    }
  }

  activity.log('rdp_route_toggled', `RDP route "${route.name}" ${newState ? 'enabled' : 'disabled'}`, {
    source: 'admin',
    severity: 'info',
    details: { routeId: id },
  });

  return getById(id);
}

function batch(action, ids) {
  if (!['enable', 'disable', 'delete'].includes(action)) {
    throw new Error('Invalid batch action');
  }

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');

  const routes = db.prepare(`SELECT id, name FROM rdp_routes WHERE id IN (${placeholders})`).all(...ids);
  if (routes.length === 0) throw new Error('No RDP routes found');

  const names = routes.map(r => r.name);

  if (action === 'enable') {
    db.prepare(`UPDATE rdp_routes SET enabled = 1, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'disable') {
    db.prepare(`UPDATE rdp_routes SET enabled = 0, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else {
    db.prepare(`DELETE FROM rdp_routes WHERE id IN (${placeholders})`).run(...ids);
  }

  const actionPast = action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'deleted';

  activity.log(
    `batch_rdp_routes_${actionPast}`,
    `Batch ${actionPast} ${ids.length} RDP route(s): ${names.join(', ')}`,
    {
      source: 'admin',
      severity: action === 'delete' ? 'warning' : 'info',
      details: { routeIds: ids, action },
    }
  );

  logger.info({ action, routeIds: ids, count: ids.length }, `Batch ${actionPast} RDP routes`);
  return ids.length;
}

function getCount() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM rdp_routes').get().count;
  const enabled = db.prepare('SELECT COUNT(*) as count FROM rdp_routes WHERE enabled = 1').get().count;
  return { total, enabled };
}

// --- Credentials -----------------------------------------------

function getCredentials(id) {
  const db = getDb();
  const row = db.prepare('SELECT username_encrypted, password_encrypted, credential_mode, domain FROM rdp_routes WHERE id = ?').get(id);
  if (!row) throw new Error('RDP route not found');
  if (row.credential_mode === 'none') return { credential_mode: 'none', username: null, password: null, domain: null };

  const creds = decryptCredentials(row);
  return {
    credential_mode: row.credential_mode,
    username: creds.username,
    password: row.credential_mode === 'full' ? creds.password : null,
    domain: row.domain,
  };
}

function setCredentials(id, { username, password, domain, credential_mode }) {
  const db = getDb();
  const route = db.prepare('SELECT id, name FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');

  const sets = [];
  const values = [];

  if (credential_mode !== undefined) {
    if (!VALID_CREDENTIAL_MODES.includes(credential_mode)) throw new Error('Invalid credential mode');
    sets.push('credential_mode = ?');
    values.push(credential_mode);
  }

  if (username !== undefined) {
    sets.push('username_encrypted = ?');
    values.push(username ? encrypt(username) : null);
  }

  if (password !== undefined) {
    sets.push('password_encrypted = ?');
    values.push(password ? encrypt(password) : null);
  }

  if (domain !== undefined) {
    sets.push('domain = ?');
    values.push(domain || null);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE rdp_routes SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  activity.log('rdp_credentials_updated', `Credentials for RDP route "${route.name}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { routeId: id },
  });
}

function clearCredentials(id) {
  const db = getDb();
  const route = db.prepare('SELECT id, name FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');

  db.prepare(`UPDATE rdp_routes SET
    credential_mode = 'none',
    username_encrypted = NULL,
    password_encrypted = NULL,
    domain = NULL,
    updated_at = datetime('now')
    WHERE id = ?`).run(id);

  activity.log('rdp_credentials_cleared', `Credentials for RDP route "${route.name}" cleared`, {
    source: 'admin',
    severity: 'warning',
    details: { routeId: id },
  });
}

// --- Token-filtered access -------------------------------------

// Centralized access-check used by both the list endpoint (`getForToken`)
// and the direct-by-id endpoints (`/client/rdp/:id/connect`, `/status`,
// `/session`). Keep the priority order identical everywhere so a user who
// cannot see a route in the list also cannot reach it via a known id.
function canAccessRoute(route, tokenId, userId) {
  if (!route) return false;
  // 1. user_ids set → user-level access control (priority)
  if (route.user_ids) {
    try {
      const allowed = JSON.parse(route.user_ids);
      if (Array.isArray(allowed) && allowed.length > 0) {
        return userId ? allowed.includes(userId) : false;
      }
    } catch {}
  }
  // 2. token_ids set → legacy token-level access control
  if (route.token_ids) {
    try {
      const allowed = JSON.parse(route.token_ids);
      if (Array.isArray(allowed) && allowed.length > 0) {
        return tokenId ? allowed.includes(tokenId) : false;
      }
    } catch {}
  }
  // 3. No restrictions → visible to all
  return true;
}

function getForToken(tokenId, userId) {
  const db = getDb();
  const routes = db.prepare('SELECT * FROM rdp_routes WHERE enabled = 1').all();
  return routes.filter(r => canAccessRoute(r, tokenId, userId)).map(stripSensitive);
}

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
  toggle,
  batch,
  getCount,
  getCredentials,
  setCredentials,
  clearCredentials,
  getForToken,
  canAccessRoute,
  decryptCredentials,
  validateRdpRoute,
  isInMaintenanceWindow,
};
