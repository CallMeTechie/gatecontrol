'use strict';

const { briToDeconz } = require('./deconzClient');
const caps = require('./deconzCapabilities');

function invalid(detail) { const e = new Error(`rule invalid: ${detail}`); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = detail; return e; }

// event-trigger → { address, value, op? } auf dem Sensor; dx kommt immer auf lastupdated.
function eventCondition(t, r) {
  const base = `/sensors/${r.deconz_id}/state`;
  switch (t.kind) {
    case 'motion':   return { address: `${base}/presence`, value: t.event === 'detected' ? 'true' : 'false' };
    case 'contact':  return { address: `${base}/open`,     value: t.event === 'open' ? 'true' : 'false' };
    case 'water':    return { address: `${base}/water`,    value: t.event === 'wet' ? 'true' : 'false' };
    case 'button': {
      const code = caps.buttonCode(r.capabilities && r.capabilities.modelid, t.button, t.action);
      if (code == null) throw invalid('unknown_button_action');
      return { address: `${base}/buttonevent`, value: String(code) };
    }
    case 'daylight': {
      const d = caps.daylight[t.event]; if (!d) throw invalid('unknown_daylight_event');
      return { address: `${base}/${d.field}`, value: d.value, op: d.op };
    }
    default: throw invalid('not_event_trigger');
  }
}

function buildConditions(def, resolve) {
  const out = [];
  for (const t of def.triggers || []) {
    if (t.kind === 'temperature' || t.kind === 'lux') {
      const r = resolve(t.resourceId);
      if (t.op !== 'lt' && t.op !== 'gt') throw invalid('bad_threshold_op');
      const field = t.kind === 'temperature' ? 'temperature' : 'lightlevel';
      const value = t.kind === 'temperature' ? String(Math.round(Number(t.value) * 100)) : String(Math.round(Number(t.value)));
      out.push({ address: `/sensors/${r.deconz_id}/state/${field}`, operator: t.op, value });
      continue;
    }
    const r = resolve(t.resourceId);
    const ec = eventCondition(t, r);
    out.push({ address: ec.address, operator: ec.op || 'eq', value: ec.value });
    out.push({ address: `/sensors/${r.deconz_id}/state/lastupdated`, operator: 'dx' }); // edge-OR marker
  }
  if (def.timeWindow && def.timeWindow.from && def.timeWindow.to) {
    const timeRe = /^[0-2]\d:[0-5]\d$/;
    if (!timeRe.test(def.timeWindow.from) || !timeRe.test(def.timeWindow.to)) throw invalid('bad_time_window');
    out.push({ address: '/config/localtime', operator: 'in', value: `T${def.timeWindow.from}:00/T${def.timeWindow.to}:00` });
  }
  return out;
}

function buildActions(def, resolve) {
  return (def.actions || []).map((a) => {
    const r = resolve(a.resourceId);
    if (a.kind === 'scene') {
      const [g, s] = String(r.deconz_id).split('/');
      if (!/^\d+$/.test(g) || !/^\d+$/.test(s)) throw invalid('invalid_scene_deconz_id');
      return { address: `/groups/${g}/scenes/${s}/recall`, method: 'PUT', body: { on: true } };
    }
    const set = a.set || {};
    const body = {};
    if ('on' in set) body.on = !!set.on;
    if ('bri' in set) {
      if (a.kind === 'plug') throw invalid('plug_no_bri');
      if (!r.capabilities || !r.capabilities.bri) throw invalid('no_bri_capability');
      body.bri = briToDeconz(Number(set.bri));
    }
    if ('color' in set) {
      if (a.kind === 'plug') throw invalid('plug_no_color');
      if (!r.capabilities || !r.capabilities.color) throw invalid('no_color_capability');
      if (set.color.ct != null) body.ct = Number(set.color.ct);
      else if (set.color.xy) body.xy = set.color.xy;
    }
    const address = a.kind === 'group' ? `/groups/${r.deconz_id}/action` : `/lights/${r.deconz_id}/state`;
    return { address, method: 'PUT', body };
  });
}

function relTime(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `PT${h}:${m}:00`;
}

// Cancel-condition = trigger back to its inverse binary state.
// Only eq-conditions with 'true'/'false' values are binary-invertible.
// button (numeric code) and daylight (non-eq) are excluded.
function cancelConditionsFrom(conditions) {
  return conditions
    .filter((c) => c.operator === 'eq' && (c.value === 'true' || c.value === 'false'))
    .map((c) => ({ address: c.address, operator: 'eq', value: c.value === 'true' ? 'false' : 'true' }));
}

// ruleLabel = "GC:<gcRuleId>:<name>" — prefix to identify GC-owned deCONZ objects.
// Placeholders '__schedule__' and '__clip_state__' are resolved by Task-4 service after object creation.
function buildRuleObjects(def, resolve, ruleLabel) {
  const conditions = buildConditions(def, resolve);
  const actions = buildActions(def, resolve);
  const delay = def.delay && def.delay.minutes ? def.delay : null;

  if (delay) {
    if (!Number.isInteger(delay.minutes) || delay.minutes < 1 || delay.minutes > 1440) { const e = new Error('bad delay'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'bad_delay_minutes'; throw e; }
    if (actions.length > 1) { const e = new Error('multi-action delay'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'delay_multi_action_not_supported'; throw e; }
  }

  if (!delay) {
    return { objects: [{ type: 'rule', payload: { name: ruleLabel, status: 'enabled', conditions, actions } }], effectiveOnRetrigger: null };
  }

  let mode = delay.onRetrigger || 'ignore';
  if (mode === 'cancel' && !caps.cancelSupported) mode = 'reset'; // ponytail: spike-gated downgrade

  const schedule = { type: 'schedule', payload: { name: `${ruleLabel}#sched`, time: relTime(delay.minutes), status: 'disabled', autodelete: false, command: { address: actions[0].address, method: 'PUT', body: actions[0].body } } };
  const armSchedule = { address: '__schedule__', method: 'PUT', body: { status: 'enabled' } };

  if (mode === 'ignore' || mode === 'reset') {
    const objects = [
      schedule,
      { type: 'rule', payload: { name: ruleLabel, status: 'enabled', conditions, actions: [armSchedule] }, ref: 'arm' },
    ];
    if (mode === 'reset') {
      objects.push({ type: 'rule', payload: { name: `${ruleLabel}#reset`, status: 'enabled', conditions, actions: [armSchedule] }, ref: 'reset' });
    }
    return { objects, effectiveOnRetrigger: mode };
  }

  // cancel: CLIP flag + schedule + arm-rule (flag→true, arm schedule) + cancel-rule (flag→false, disable schedule).
  const cancelConds = cancelConditionsFrom(conditions);
  if (!cancelConds.length) { const e = new Error('cancel needs binary trigger'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'cancel_requires_binary_trigger'; throw e; }
  const objects = [
    { type: 'clip', payload: { name: `${ruleLabel}#flag`, type: 'CLIPGenericFlag', modelid: 'GC-Flag', manufacturername: 'GateControl', uniqueid: `${ruleLabel}#flag`, swversion: '1', state: { flag: false } } },
    schedule,
    { type: 'rule', payload: { name: ruleLabel, status: 'enabled', conditions, actions: [{ address: '__clip_state__', method: 'PUT', body: { flag: true } }, armSchedule] }, ref: 'arm' },
    { type: 'rule', payload: { name: `${ruleLabel}#cancel`, status: 'enabled', conditions: cancelConds, actions: [{ address: '__clip_state__', method: 'PUT', body: { flag: false } }, { address: '__schedule__', method: 'PUT', body: { status: 'disabled' } }] }, ref: 'cancel' },
  ];
  return { objects, effectiveOnRetrigger: 'cancel' };
}

module.exports = { buildConditions, buildActions, buildRuleObjects, relTime, cancelConditionsFrom };
