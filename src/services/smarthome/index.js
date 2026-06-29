'use strict';

const dev = require('./smarthomeDevices');
const { createClient } = require('./deconzClient');
const license = require('../license');

const FEATURE = 'smarthome';
const POLL_INTERVAL_MS = 30000;
let pollTimer = null;
let pollRunning = false;

function clientForGateway(gw) {
  const t = dev.resolveTransport(gw.route_id);
  if (!t) { const e = new Error('smarthome gateway route not resolvable'); e.code = 'SMARTHOME_NO_ROUTE'; throw e; }
  if (!gw.apiKey) { const e = new Error('smarthome gateway has no api key'); e.code = 'SMARTHOME_NO_API_KEY'; throw e; }
  return createClient({ baseUrl: t.baseUrl, apiKey: gw.apiKey, headers: { 'X-Gateway-Target-Domain': t.domain } });
}

function capsFromLight(light) {
  const s = light.state || {};
  let color = 'none';
  if ('xy' in s) color = 'xy';
  else if ('hue' in s || 'sat' in s) color = 'hs';
  else if ('ct' in s) color = 'ct';
  return { on: 'on' in s, bri: 'bri' in s, color };
}

function sensorReading(sensor) {
  const s = sensor.state || {};
  if ('presence' in s) return { type: 'presence', value: s.presence };
  if ('open' in s) return { type: 'open', value: s.open };
  if ('water' in s) return { type: 'water', value: s.water };
  if ('temperature' in s) return { type: 'temperature', value: s.temperature / 100 };
  if ('humidity' in s) return { type: 'humidity', value: s.humidity / 100 };
  if ('lightlevel' in s) return { type: 'lightlevel', value: s.lux != null ? s.lux : s.lightlevel };
  if ('buttonevent' in s) return { type: 'button', value: s.buttonevent };
  return { type: 'unknown', value: null };
}

// deCONZ /lights also carries plugs + the virtual "Configuration tool".
// null = skip (not a real device).
function lightKind(light) {
  if ((light.type || '') === 'Configuration tool') return null;
  return /plug/i.test(light.type || '') ? 'plug' : 'light';
}

// deCONZ /sensors mixes passive sensors, button remotes (ZHASwitch) and virtuals.
// null = skip.
function sensorKind(sensor) {
  const t = sensor.type || '';
  if (t.startsWith('CLIP') || t === 'Daylight') return null; // virtual
  return /switch/i.test(t) ? 'switch' : 'sensor';
}

async function connectGateway({ name, route_id, apiKey }) {
  let key = apiKey;
  if (!key) {
    const t = dev.resolveTransport(route_id);
    if (!t) { const e = new Error('route not resolvable'); e.code = 'SMARTHOME_NO_ROUTE'; throw e; }
    const acquired = await createClient({ baseUrl: t.baseUrl, headers: { 'X-Gateway-Target-Domain': t.domain } }).acquireApiKey();
    key = acquired.apiKey;
  }
  return dev.createGateway({ name, route_id, apiKey: key, enabled: true });
}

async function syncGateway(gatewayId) {
  const gw = dev.getGateway(gatewayId);
  if (!gw) { const e = new Error('gateway not found'); e.code = 'SMARTHOME_GATEWAY_NOT_FOUND'; throw e; }
  const client = clientForGateway(gw);
  const counts = { lights: 0, plugs: 0, groups: 0, scenes: 0, sensors: 0, switches: 0 };
  const seen = [];

  try {
    const lights = await client.getLights();
    for (const [id, l] of Object.entries(lights)) {
      const kind = lightKind(l);
      if (!kind) continue; // skip Configuration tool (virtual)
      dev.upsertResource({ gateway_id: gw.id, deconz_id: id, deconz_type: 'lights', uniqueid: l.uniqueid || null, kind, name: l.name, capabilities: capsFromLight(l) });
      seen.push(`lights:${id}`); counts[kind === 'plug' ? 'plugs' : 'lights']++;
    }
  } catch (_) { /* best-effort */ }

  try {
    const groups = await client.getGroups();
    for (const [id, g] of Object.entries(groups)) {
      dev.upsertResource({ gateway_id: gw.id, deconz_id: id, deconz_type: 'groups', kind: 'group', name: g.name, capabilities: { on: true, bri: true, color: 'hs' } });
      seen.push(`groups:${id}`); counts.groups++;
      for (const sc of (g.scenes || [])) {
        const sceneKey = `${id}/${sc.id}`;
        dev.upsertResource({ gateway_id: gw.id, deconz_id: sceneKey, deconz_type: 'scenes', kind: 'scene', name: `${g.name} · ${sc.name}`, capabilities: { group_id: id, scene_id: sc.id } });
        seen.push(`scenes:${sceneKey}`); counts.scenes++;
      }
    }
  } catch (_) { /* best-effort */ }

  try {
    const sensors = await client.getSensors();
    for (const [id, s] of Object.entries(sensors)) {
      const kind = sensorKind(s);
      if (!kind) continue; // skip CLIP*/Daylight (virtual)
      dev.upsertResource({ gateway_id: gw.id, deconz_id: id, deconz_type: 'sensors', uniqueid: s.uniqueid || null, kind, name: s.name, capabilities: { reading: sensorReading(s).type } });
      seen.push(`sensors:${id}`); counts[kind === 'switch' ? 'switches' : 'sensors']++;
    }
  } catch (_) { /* best-effort */ }

  if (seen.length) { dev.markMissing(gw.id, seen); dev.touchGateway(gw.id); }
  return { counts };
}

async function getResources(gatewayId) {
  return dev.listResources(gatewayId);
}

function validatePatch(resource, raw) {
  const caps = resource.capabilities || {};
  const patch = {};
  if ('on' in raw) patch.on = Boolean(raw.on);
  if ('bri' in raw && caps.bri) patch.bri = Math.max(0, Math.min(100, Number(raw.bri)));
  if (caps.color === 'ct' && 'ct' in raw) patch.ct = Number(raw.ct);
  if (caps.color === 'hs') { if ('hue' in raw) patch.hue = Number(raw.hue); if ('sat' in raw) patch.sat = Number(raw.sat); }
  if (caps.color === 'xy' && 'xy' in raw) patch.xy = raw.xy;
  return patch;
}

async function setResourceState(resourceId, raw) {
  const resource = dev.getResource(resourceId);
  if (!resource) { const e = new Error(`resource ${resourceId} not found`); e.code = 'SMARTHOME_RESOURCE_NOT_FOUND'; throw e; }
  const client = clientForGateway(dev.getGateway(resource.gateway_id));
  if (resource.kind === 'scene') {
    const [groupId, sceneId] = String(resource.deconz_id).split('/');
    return client.recallScene(groupId, sceneId);
  }
  if (resource.kind === 'sensor' || resource.kind === 'switch') {
    const e = new Error(`resource ${resourceId} is not controllable`); e.code = 'SMARTHOME_NOT_CONTROLLABLE'; throw e;
  }
  const patch = validatePatch(resource, raw);
  if (resource.kind === 'group') return client.setGroupState(resource.deconz_id, patch);
  return client.setLightState(resource.deconz_id, patch);
}

// Maßnahme 1: server-side reachability probe — never throws for "unreachable",
// only throws for missing gateway or route (programmer errors, not network state).
async function testGateway(gatewayId) {
  const gw = dev.getGateway(gatewayId);
  if (!gw) { const e = new Error('gateway not found'); e.code = 'SMARTHOME_GATEWAY_NOT_FOUND'; throw e; }
  const t = dev.resolveTransport(gw.route_id);
  if (!t) { const e = new Error('route not resolvable'); e.code = 'SMARTHOME_NO_ROUTE'; throw e; }
  try {
    const client = createClient({ baseUrl: t.baseUrl, apiKey: gw.apiKey, headers: { 'X-Gateway-Target-Domain': t.domain } });
    const config = await client.getConfig();
    return { reachable: true, baseUrl: t.baseUrl, config: { name: config.name, swversion: config.swversion, apiversion: config.apiversion } };
  } catch (err) {
    return { reachable: false, baseUrl: t.baseUrl, code: err.code || 'DECONZ_UNREACHABLE', detail: err.message };
  }
}

async function pollTick() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    for (const gw of dev.listGateways()) {
      if (!gw.enabled) continue;
      await syncGateway(gw.id).catch(() => {});
    }
  } finally { pollRunning = false; }
}

function startPolling() {
  if (pollTimer) return;
  if (!license.hasFeature(FEATURE)) return;
  if (dev.listGateways().length === 0) return;
  pollTimer = setInterval(() => { pollTick().catch(() => {}); }, POLL_INTERVAL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

module.exports = {
  connectGateway, syncGateway, getResources, setResourceState, testGateway,
  startPolling, stopPolling, pollTick, capsFromLight, sensorReading, lightKind, sensorKind,
  listGateways: dev.listGateways, getGateway: dev.getGateway,
  updateGateway: dev.updateGateway, removeGateway: dev.removeGateway,
};
