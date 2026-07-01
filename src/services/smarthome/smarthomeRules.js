'use strict';
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const dev = require('./smarthomeDevices');
const { createClient } = require('./deconzClient');
const translate = require('./rulesTranslate');
const caps = require('./deconzCapabilities');

const LIMIT_CODES = new Set(caps.ruleLimit.errorCodes); // deckt HTTP-Status UND 200-Body-Error-Codes ab (Spike Step 6)
function isLimit(e) { return !!(e && LIMIT_CODES.has(e.code)); }
function ruleLimitError() { const e = new Error('deconz rule limit reached'); e.code = 'DECONZ_RULE_LIMIT_REACHED'; return e; }
function limitWarn(gcRuleCount) { return gcRuleCount * 4 > 150; } // Worst-Case-Slot-Multiplikator (§8/§10)

// Default-Factory: lokaler Gateway-Client wie index.js' privates clientForGateway (kein index-Import → kein Zirkularbezug).
function defaultClientFactory(gatewayId) {
  const gw = dev.getGateway(gatewayId);
  if (!gw) { const e = new Error('gateway not found'); e.code = 'SMARTHOME_GATEWAY_NOT_FOUND'; throw e; }
  const t = dev.resolveTransport(gw.route_id);
  if (!t) { const e = new Error('route not resolvable'); e.code = 'SMARTHOME_NO_ROUTE'; throw e; }
  if (!gw.apiKey) { const e = new Error('no api key'); e.code = 'SMARTHOME_NO_API_KEY'; throw e; }
  return createClient({ baseUrl: t.baseUrl, apiKey: gw.apiKey, headers: { 'X-Gateway-Target-Domain': t.domain } });
}
let clientFactory = defaultClientFactory;
function _setClientFactoryForTest(fn) { clientFactory = fn; }

function resolveFor(gatewayId) {
  return (resourceId) => {
    const r = dev.getResource(resourceId);
    if (!r || r.gateway_id !== gatewayId) { const e = new Error('resource not in gateway'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'foreign_resource'; throw e; }
    return r;
  };
}

function parseRow(row) {
  if (!row) return null;
  return { id: row.id, gateway_id: row.gateway_id, name: row.name, enabled: !!row.enabled,
    definition: JSON.parse(row.definition_json || '{}'),
    deconz_rule_id: row.deconz_rule_id, deconz_schedule_id: row.deconz_schedule_id, deconz_clip_sensor_id: row.deconz_clip_sensor_id,
    synced: row.deconz_rule_id != null };
}

// true wenn ALLE in der definition referenzierten resourceIds (Trigger+Aktionen) im selben Gateway auflösbar sind.
function resourcesResolve(def, gatewayId) {
  const ids = [...((def && def.triggers) || []).map((t) => t.resourceId), ...((def && def.actions) || []).map((a) => a.resourceId)].filter((x) => x != null);
  for (const id of ids) { const r = dev.getResource(id); if (!r || r.gateway_id !== gatewayId) return false; }
  return true;
}
function list(gatewayId) {
  return getDb().prepare('SELECT * FROM smarthome_rules WHERE gateway_id = ? ORDER BY id').all(gatewayId).map((row) => {
    const r = parseRow(row);
    r.orphaned = !resourcesResolve(r.definition, gatewayId); // verwaiste Referenz → UI read-only mit Warnung (§11)
    return r;
  });
}
function get(id) { return parseRow(getDb().prepare('SELECT * FROM smarthome_rules WHERE id = ?').get(id)); }

// Erzeugt die deCONZ-Objekte aus dem Objekt-Plan; löst __schedule__/__clip_state__ auf;
// merkt erzeugte IDs für Kompensation. Gibt {ruleId, scheduleId, clipId} zurück.
async function materialize(client, objectPlan, apiKey) {
  const created = []; // [kind, id]
  let scheduleId = null, clipId = null, ruleId = null;
  try {
    // Reihenfolge clip → schedule → rules ist im Objekt-Plan garantiert (buildRuleObjects). Platzhalter werden hier aufgelöst.
    for (const obj of objectPlan.objects) {
      if (obj.type === 'clip') { clipId = await client.createClipSensor(obj.payload); created.push(['clip', clipId]); continue; }
      if (obj.type === 'schedule') {
        // SPIKE-OVERRIDE: schedule.command.address MUSS mit /api/<apiKey> präfixiert sein (Rule-Actions bleiben bare).
        const sp = JSON.parse(JSON.stringify(obj.payload));
        if (sp.command && typeof sp.command.address === 'string' && !sp.command.address.startsWith('/api/')) {
          sp.command.address = `/api/${apiKey}${sp.command.address}`;
        }
        scheduleId = await client.createSchedule(sp); created.push(['schedule', scheduleId]); continue;
      }
      const payload = JSON.parse(JSON.stringify(obj.payload));
      payload.actions = (payload.actions || []).map((a) => {
        if (a.address === '__schedule__') { if (!scheduleId) throw new Error('__schedule__ unresolved (no schedule preceded this rule)'); return { ...a, address: `/schedules/${scheduleId}` }; }
        if (a.address === '__clip_state__') { if (!clipId) throw new Error('__clip_state__ unresolved (no clip sensor preceded this rule)'); return { ...a, address: `/sensors/${clipId}/state` }; }
        return a;
      });
      const id = await client.createRule(payload);
      created.push(['rule', id]);
      if (obj.ref !== 'reset' && obj.ref !== 'cancel') ruleId = id; // primäre Auslöse-Regel
    }
    return { ruleId, scheduleId, clipId };
  } catch (e) {
    // Kompensation: in umgekehrter Reihenfolge best-effort löschen — keine Waisen.
    for (const [kind, id] of created.reverse()) {
      try {
        if (kind === 'rule') await client.deleteRule(id);
        else if (kind === 'schedule') await client.deleteSchedule(id);
        else if (kind === 'clip') { if (caps.clipDeletable && client.deleteClipSensor) await client.deleteClipSensor(id); }
      } catch (ce) { logger.warn({ error: ce.message, kind, id }, 'smarthome: compensation delete failed (potential orphan)'); }
    }
    if (isLimit(e)) throw ruleLimitError();
    throw e;
  }
}

async function create(gatewayId, name, definition) {
  if (!name || typeof name !== 'string' || name.length > 20) { const e = new Error('name too long'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'name_too_long'; throw e; } // deCONZ-Regelname ~32 Zeichen inkl. GC:<id>:-Präfix
  const resolve = resolveFor(gatewayId);
  const gw = dev.getGateway(gatewayId);
  const db = getDb();
  // Zeile zuerst anlegen (für den GC:<id>-Label-Präfix), IDs noch NULL.
  const id = Number(db.prepare('INSERT INTO smarthome_rules (gateway_id, name, enabled, definition_json) VALUES (?,?,?,?)')
    .run(gatewayId, name, 1, JSON.stringify(definition)).lastInsertRowid);
  try {
    const plan = translate.buildRuleObjects(definition, resolve, `GC:${id}:${name}`); // wirft bei Validierung → Zeile unten gelöscht
    const { ruleId, scheduleId, clipId } = await materialize(clientFactory(gatewayId), plan, gw && gw.apiKey);
    db.prepare('UPDATE smarthome_rules SET deconz_rule_id=?, deconz_schedule_id=?, deconz_clip_sensor_id=? WHERE id=?')
      .run(ruleId, scheduleId, clipId, id);
    return get(id);
  } catch (e) {
    db.prepare('DELETE FROM smarthome_rules WHERE id = ?').run(id); // kein Waisen-GC-Eintrag
    throw e;
  }
}

async function update(id, name, definition) {
  if (!name || typeof name !== 'string' || name.length > 20) { const e = new Error('name too long'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'name_too_long'; throw e; }
  const db = getDb();
  const row = get(id);
  if (!row) { const e = new Error('rule not found'); e.code = 'SMARTHOME_RULE_NOT_FOUND'; throw e; }
  const gw = dev.getGateway(row.gateway_id);
  const client = clientFactory(row.gateway_id);
  const resolve = resolveFor(row.gateway_id);
  // NULL-before-delete: IDs lösen, dann alte Objekte best-effort entfernen (Lösch-Fehler != 404 loggen → sichtbare Waisen).
  db.prepare('UPDATE smarthome_rules SET deconz_rule_id=NULL, deconz_schedule_id=NULL, deconz_clip_sensor_id=NULL WHERE id=?').run(id);
  for (const [m, did] of [['deleteRule', row.deconz_rule_id], ['deleteSchedule', row.deconz_schedule_id], ['deleteClipSensor', row.deconz_clip_sensor_id]]) {
    if (did && client[m]) { try { await client[m](did); } catch (e) { if (e.code !== 'DECONZ_HTTP_404') logger.warn({ error: e.message, method: m, id: did }, 'smarthome: old deconz object delete failed (potential orphan)'); } }
  }
  db.prepare('UPDATE smarthome_rules SET name=?, definition_json=? WHERE id=?').run(name, JSON.stringify(definition), id);
  try {
    const plan = translate.buildRuleObjects(definition, resolve, `GC:${id}:${name}`);
    const { ruleId, scheduleId, clipId } = await materialize(client, plan, gw && gw.apiKey);
    db.prepare('UPDATE smarthome_rules SET deconz_rule_id=?, deconz_schedule_id=?, deconz_clip_sensor_id=? WHERE id=?').run(ruleId, scheduleId, clipId, id);
    return get(id);
  } catch (e) {
    db.prepare('UPDATE smarthome_rules SET enabled=0 WHERE id=?').run(id); // §7: nicht synchronisiert + enabled=false → resyncPending überspringt es (keine Waisen-Kaskade)
    throw e;
  }
}

async function remove(id) {
  const db = getDb();
  const row = get(id);
  if (!row) return;
  const client = clientFactory(row.gateway_id);
  for (const [m, did] of [['deleteRule', row.deconz_rule_id], ['deleteSchedule', row.deconz_schedule_id], ['deleteClipSensor', row.deconz_clip_sensor_id]]) {
    if (did && client[m]) { try { await client[m](did); } catch (e) { if (e.code !== 'DECONZ_HTTP_404') logger.warn({ error: e.message, method: m, id: did }, 'smarthome: deconz object delete failed (potential orphan)'); } }
  }
  db.prepare('DELETE FROM smarthome_rules WHERE id = ?').run(id);
}

async function setEnabled(id, on) {
  const db = getDb();
  const row = get(id);
  if (!row) { const e = new Error('rule not found'); e.code = 'SMARTHOME_RULE_NOT_FOUND'; throw e; }
  if (row.deconz_rule_id) { try { await clientFactory(row.gateway_id).updateRule(row.deconz_rule_id, { status: on ? 'enabled' : 'disabled' }); } catch (_) { /* best-effort */ } }
  db.prepare('UPDATE smarthome_rules SET enabled=? WHERE id=?').run(on ? 1 : 0, id);
  return get(id);
}

async function gatewayRuleCount(gatewayId) {
  const rules = await clientFactory(gatewayId).getRules() || {};
  const total = Object.keys(rules).length;
  // GC-owned rules carry the "GC:" name prefix (primary + #reset/#cancel secondary rules).
  // Counting by prefix over the live response — not the DB deconz_rule_id column, which only holds
  // the primary rule id — so cancel/reset chains are attributed to gc, not miscounted as external.
  const gc = Object.values(rules).filter((r) => r && typeof r.name === 'string' && r.name.startsWith('GC:')).length;
  return { total_rules: total, gc_rules: gc, external_rules: Math.max(0, total - gc) };
}

async function resyncPending() {
  const rows = getDb().prepare('SELECT id FROM smarthome_rules WHERE enabled = 1 AND deconz_rule_id IS NULL').all();
  for (const { id } of rows) {
    const row = get(id);
    try { await update(id, row.name, row.definition); } catch (_) { /* log-and-continue */ }
  }
  return rows.length;
}

module.exports = { list, get, create, update, remove, setEnabled, gatewayRuleCount, resyncPending, limitWarn, _setClientFactoryForTest };
