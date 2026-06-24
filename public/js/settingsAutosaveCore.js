(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node tests
  else root.SettingsAutosaveCore = api;                                        // browser global
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Single declarative source for per-cluster special behavior (spec §4.5e).
  // Clusters not listed default to { klass: 'independent' }.
  // alerts.requiredForCommit + route-block are overridden at bind-time via
  // isAtomicReady's overrideRequired arg (events-active / action=redirect).
  const SETTINGS_CLUSTERS = {
    smtp:              { klass: 'atomic',      secretKeys: ['password'], requiredForCommit: ['smtp-host', 'smtp-from'] },
    alerts:            { klass: 'atomic',      requiredForCommit: ['alerts-email'] },  // override: only if an event group is active
    'route-block':     { klass: 'atomic',      requiredForCommit: [] },                // override: ['settings-route-block-redirect'] when action=redirect
    ip2location:       { klass: 'independent', secretKeys: ['api_key'] },
    pihole:            { klass: 'fullPayload' },
    'split-tunnel':    { klass: 'fullPayload' },
    security:          { klass: 'independent', selfAffecting: [{ field: 'security-lockout-attempts', confirmIf: '<=2' }] },
    'machine-binding': { klass: 'independent', selfAffecting: [{ field: 'mb-mode', confirmAlways: true }] },
  };

  function classify(cluster) { return SETTINGS_CLUSTERS[cluster] || { klass: 'independent' }; }

  function isDirty(payload, snapshot) { return JSON.stringify(payload) !== JSON.stringify(snapshot); }

  function stripEmptySecrets(payload, secretKeys) {
    const out = Object.assign({}, payload);
    for (const k of secretKeys || []) {
      if (out[k] === '' || out[k] === null || out[k] === undefined) delete out[k];
    }
    return out;
  }

  function needsConfirm(config, fieldId, value) {
    for (const sa of (config && config.selfAffecting) || []) {
      if (sa.field !== fieldId) continue;
      if (sa.confirmAlways) return true;
      if (sa.confirmIf === '<=2' && Number(value) <= 2) return true;
    }
    return false;
  }

  function isAtomicReady(config, valuesById, overrideRequired) {
    if (!config || config.klass !== 'atomic') return true;
    const required = overrideRequired || config.requiredForCommit || [];
    return required.every(id => String((valuesById && valuesById[id]) || '').trim() !== '');
  }

  // Per-key serialized promise chain (spec §4.5c). Used by the controller for
  // field autosaves AND by full-payload list-mutation buttons → one lock.
  function createQueue() {
    const chains = {};
    return function enqueue(key, fn) {
      const prev = chains[key] || Promise.resolve();
      const next = prev.then(fn, fn);          // runs even after a prior rejection
      chains[key] = next.catch(function () {});
      return next;
    };
  }

  return { SETTINGS_CLUSTERS, classify, isDirty, stripEmptySecrets, needsConfirm, isAtomicReady, createQueue };
});
