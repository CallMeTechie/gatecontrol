'use strict';

const { getDb } = require('../../db/connection');
const { encrypt, decrypt } = require('../../utils/crypto');
const routes = require('../routes');

function rowToGateway(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, route_id: row.route_id,
    enabled: row.enabled, last_seen_at: row.last_seen_at,
    apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : null,
  };
}

function createGateway({ name, route_id = null, apiKey = null, enabled = true }) {
  const info = getDb().prepare(`
    INSERT INTO smarthome_gateways (name, route_id, api_key_enc, enabled) VALUES (?, ?, ?, ?)
  `).run(name, route_id, apiKey ? encrypt(apiKey) : null, enabled ? 1 : 0);
  return getGateway(info.lastInsertRowid);
}

function getGateway(id) {
  return rowToGateway(getDb().prepare('SELECT * FROM smarthome_gateways WHERE id=?').get(id));
}

function listGateways() {
  return getDb().prepare('SELECT * FROM smarthome_gateways ORDER BY id').all().map(rowToGateway);
}

function updateGateway(id, patch) {
  const db = getDb();
  const sets = [], vals = [];
  if ('name' in patch) { sets.push('name=?'); vals.push(patch.name); }
  if ('route_id' in patch) { sets.push('route_id=?'); vals.push(patch.route_id); }
  if ('enabled' in patch) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
  if ('apiKey' in patch) { sets.push('api_key_enc=?'); vals.push(patch.apiKey ? encrypt(patch.apiKey) : null); }
  if (sets.length) {
    sets.push("updated_at=datetime('now')");
    db.prepare(`UPDATE smarthome_gateways SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  }
  return getGateway(id);
}

function touchGateway(id) {
  getDb().prepare("UPDATE smarthome_gateways SET last_seen_at=datetime('now') WHERE id=?").run(id);
}

function removeGateway(id) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM smarthome_resource_owners WHERE resource_id IN (SELECT id FROM smarthome_resources WHERE gateway_id=?)').run(id);
    db.prepare('DELETE FROM smarthome_rules WHERE gateway_id=?').run(id);
    db.prepare('DELETE FROM smarthome_resources WHERE gateway_id=?').run(id);
    db.prepare('DELETE FROM smarthome_gateways WHERE id=?').run(id);
  })();
  return { ok: true };
}

// Delegates to routes.resolveCompanionUrl — returns just the baseUrl or null.
function resolveBaseUrl(routeId) {
  if (routeId == null) return null;
  const t = routes.resolveCompanionUrl(routeId);
  return t ? t.baseUrl : null;
}

// Returns { baseUrl, domain } or null — used by the orchestrator to set the
// domain header on every companion request.
function resolveTransport(routeId) {
  if (routeId == null) return null;
  return routes.resolveCompanionUrl(routeId);
}

function rowToResource(row) {
  if (!row) return null;
  const { capabilities_json, state_json, ...rest } = row;
  return {
    ...rest,
    capabilities: capabilities_json ? JSON.parse(capabilities_json) : {},
    state: state_json ? JSON.parse(state_json) : {},
  };
}

function listResources(gatewayId) {
  const db = getDb();
  const rows = gatewayId
    ? db.prepare('SELECT * FROM smarthome_resources WHERE gateway_id=? ORDER BY kind, name').all(gatewayId)
    : db.prepare('SELECT * FROM smarthome_resources ORDER BY gateway_id, kind, name').all();
  return rows.map(rowToResource);
}

function getResource(id) {
  return rowToResource(getDb().prepare('SELECT * FROM smarthome_resources WHERE id=?').get(id));
}

function upsertResource({ gateway_id, deconz_id, deconz_type, uniqueid = null, kind, name, capabilities, state }) {
  const db = getDb();
  // Lights/sensors match by stable uniqueid (survives Conbee ID reassignment).
  // Groups/scenes match by deconz_id (no stable MAC-like identifier).
  let existing = null;
  if (uniqueid && (deconz_type === 'lights' || deconz_type === 'sensors')) {
    existing = db.prepare('SELECT id FROM smarthome_resources WHERE gateway_id=? AND uniqueid=?').get(gateway_id, uniqueid);
  }
  if (!existing) {
    existing = db.prepare('SELECT id FROM smarthome_resources WHERE gateway_id=? AND deconz_type=? AND deconz_id=?')
      .get(gateway_id, deconz_type, String(deconz_id));
  }
  const caps = JSON.stringify(capabilities || {});
  // state omitted (undefined) → keep existing cached state; explicit value → overwrite.
  const stateJson = state === undefined ? undefined : JSON.stringify(state || {});
  if (existing) {
    if (stateJson === undefined) {
      db.prepare(`UPDATE smarthome_resources SET deconz_id=?, uniqueid=?, kind=?, name=?, capabilities_json=?, enabled=1, updated_at=datetime('now') WHERE id=?`)
        .run(String(deconz_id), uniqueid, kind, name, caps, existing.id);
    } else {
      db.prepare(`UPDATE smarthome_resources SET deconz_id=?, uniqueid=?, kind=?, name=?, capabilities_json=?, state_json=?, enabled=1, updated_at=datetime('now') WHERE id=?`)
        .run(String(deconz_id), uniqueid, kind, name, caps, stateJson, existing.id);
    }
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO smarthome_resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gateway_id, String(deconz_id), deconz_type, uniqueid, kind, name, caps, stateJson === undefined ? null : stateJson);
  return Number(info.lastInsertRowid);
}

// seenKeys: Array of `${deconz_type}:${deconz_id}`. Unseen resources → enabled=0.
function markMissing(gatewayId, seenKeys) {
  const db = getDb();
  const seen = new Set(seenKeys);
  const rows = db.prepare('SELECT id, deconz_type, deconz_id FROM smarthome_resources WHERE gateway_id=?').all(gatewayId);
  const disable = db.prepare("UPDATE smarthome_resources SET enabled=0, updated_at=datetime('now') WHERE id=?");
  for (const r of rows) if (!seen.has(`${r.deconz_type}:${r.deconz_id}`)) disable.run(r.id);
}

module.exports = {
  createGateway, getGateway, listGateways, updateGateway, touchGateway, removeGateway,
  resolveBaseUrl, resolveTransport, listResources, getResource, upsertResource, markMissing,
};
