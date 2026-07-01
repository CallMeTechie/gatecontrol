'use strict';

function briToDeconz(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round((p / 100) * 254);
}
function briFromDeconz(raw) {
  const r = Math.max(0, Math.min(254, Number(raw) || 0));
  return Math.round((r / 254) * 100);
}

function toDeconzBody(patch) {
  const body = {};
  if ('on' in patch) body.on = Boolean(patch.on);
  if ('bri' in patch) body.bri = briToDeconz(patch.bri);
  if ('ct' in patch) body.ct = Number(patch.ct);
  if ('hue' in patch) body.hue = Number(patch.hue);
  if ('sat' in patch) body.sat = Number(patch.sat);
  if ('xy' in patch && Array.isArray(patch.xy)) body.xy = patch.xy.map(Number);
  return body;
}

function createClient({ baseUrl, apiKey, headers: extraHeaders = {} } = {}) {
  const base = (baseUrl || '').replace(/\/$/, '');

  async function raw(path, { method = 'GET', body } = {}) {
    const headers = {
      ...extraHeaders,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const e = new Error(`deconz_http_${res.status}`); e.code = `DECONZ_HTTP_${res.status}`; throw e; }
    return res.json();
  }

  // deCONZ-Antworten sind Arrays von {success}/{error}; wirft bei error.
  function assertNoError(arr) {
    if (Array.isArray(arr)) {
      const err = arr.find((x) => x && x.error);
      if (err) {
        const e = new Error(err.error.description || `deconz_error_${err.error.type}`);
        e.code = err.error.type === 101 ? 'DECONZ_LINK_BUTTON_NOT_PRESSED' : `DECONZ_ERR_${err.error.type}`;
        throw e;
      }
    }
    return arr;
  }

  function firstId(arr) {
    const ok = Array.isArray(arr) ? arr.find((x) => x && x.success && x.success.id != null) : null;
    return ok ? String(ok.success.id) : null;
  }

  async function acquireApiKey() {
    const out = assertNoError(await raw('/api', { method: 'POST', body: { devicetype: 'GateControl' } }));
    const ok = Array.isArray(out) ? out.find((x) => x && x.success) : null;
    if (!ok || !ok.success.username) { const e = new Error('deconz_no_key'); e.code = 'DECONZ_NO_KEY'; throw e; }
    return { apiKey: ok.success.username };
  }

  const api = (p) => `/api/${apiKey}${p}`;

  return {
    acquireApiKey,
    // ponytail: getConfig falls back to /api/config (keyless) for reachability probe
    getConfig: () => apiKey ? raw(api('/config')) : raw('/api/config'),
    getLights: () => raw(api('/lights')),
    getGroups: () => raw(api('/groups')),
    getSensors: () => raw(api('/sensors')),
    setLightState: (id, patch) => raw(api(`/lights/${id}/state`), { method: 'PUT', body: toDeconzBody(patch) }).then(assertNoError),
    setGroupState: (id, patch) => raw(api(`/groups/${id}/action`), { method: 'PUT', body: toDeconzBody(patch) }).then(assertNoError),
    recallScene: (groupId, sceneId) => raw(api(`/groups/${groupId}/scenes/${sceneId}/recall`), { method: 'PUT', body: {} }).then(assertNoError),
    getRules: () => raw(api('/rules')),
    createRule: (rule) => raw(api('/rules'), { method: 'POST', body: rule }).then(assertNoError).then(firstId),
    updateRule: (id, rule) => raw(api(`/rules/${id}`), { method: 'PUT', body: rule }).then(assertNoError),
    deleteRule: (id) => raw(api(`/rules/${id}`), { method: 'DELETE' }),
    createSchedule: (sched) => raw(api('/schedules'), { method: 'POST', body: sched }).then(assertNoError).then(firstId),
    deleteSchedule: (id) => raw(api(`/schedules/${id}`), { method: 'DELETE' }),
    createClipSensor: (sensor) => raw(api('/sensors'), { method: 'POST', body: sensor }).then(assertNoError).then(firstId),
    setClipSensorState: (id, state) => raw(api(`/sensors/${id}/state`), { method: 'PUT', body: state }).then(assertNoError),
    deleteClipSensor: (id) => raw(api(`/sensors/${id}`), { method: 'DELETE' }), // CLIP-Sensoren leben unter /sensors
  };
}

module.exports = { createClient, briToDeconz, briFromDeconz, toDeconzBody };
