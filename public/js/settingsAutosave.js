(function () {
  'use strict';
  var Core = window.SettingsAutosaveCore;
  var enqueue = Core.createQueue();           // shared per-cluster serialization
  var t = (window.GC && window.GC.t) || {};
  window.SettingsAutosave = { enqueue: enqueue };

  function flash(statusEl) {
    if (!statusEl) return;
    statusEl.classList.remove('autosave-error');
    statusEl.classList.add('field-saving');
    statusEl.textContent = t['settings.autosave.saved'] || 'Saved';
    setTimeout(function () { statusEl.classList.remove('field-saving'); }, 500);
  }
  function showError(statusEl, msg) {
    if (!statusEl) return;
    statusEl.classList.remove('field-saving');
    statusEl.classList.add('autosave-error');
    statusEl.textContent = msg || t['settings.autosave.error'] || 'Save failed';
  }
  function showPending(statusEl) {
    if (!statusEl) return;
    statusEl.classList.remove('field-saving', 'autosave-error');
    statusEl.textContent = t['settings.autosave.pending'] || 'Will save once all required fields are filled';
  }

  function isDiscrete(el) {
    if (!el || !el.tagName) return false;
    if (el.classList && el.classList.contains('toggle')) return true;
    if (el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return true;
    return false;
  }
  function valueOf(el) {
    if (el.classList && el.classList.contains('toggle')) return el.classList.contains('on');
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    return el.value;
  }

  function bind(opts) {
    var cluster = opts.cluster;
    var cfg = Core.classify(cluster);
    var fields = opts.fields || [];
    var statusEl = opts.statusEl || null;
    var valuesById = opts.valuesById || function () { return {}; };
    var snapshot = JSON.stringify(valuesById());   // last successfully persisted state

    // Dev guard: warn if any bound field id is absent from valuesById (would never be dirty).
    var _boundIds = fields.map(function(f) { return f && f.id; }).filter(Boolean);
    var _missing = Core.missingValueKeys(_boundIds, valuesById());
    if (_missing.length) console.warn('[autosave] ' + cluster + ' valuesById missing bound fields: ' + _missing.join(','));

    function requiredOverride() { return opts.requiredForCommit ? opts.requiredForCommit() : undefined; }

    function rollbackField(el) {
      if (!el || !isDiscrete(el)) return;
      try {
        var snap = JSON.parse(snapshot || '{}');
        if (el.classList && el.classList.contains('toggle')) el.classList.toggle('on', !!snap[el.id]);
        else if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!snap[el.id];
        else if (el.tagName === 'SELECT' && snap[el.id] != null) el.value = snap[el.id];
      } catch (e) {}
    }

    function commit(triggerEl, triggerValue) {
      var values = valuesById();
      if (!Core.isAtomicReady(cfg, values, requiredOverride())) { showPending(statusEl); return; }
      if (!Core.isDirty(values, JSON.parse(snapshot || '{}'))) return;
      if (triggerEl && Core.needsConfirm(cfg, triggerEl.id, triggerValue)) {
        var msg = (cluster === 'machine-binding')
          ? (t['settings.autosave.confirm_mb_mode'] || 'This changes device binding and can affect access. Apply it?')
          : (t['settings.autosave.confirm_self'] || 'This change can affect your current session. Apply it?');
        if (!window.confirm(msg)) { rollbackField(triggerEl); return; }
      }
      var frozen = JSON.stringify(values);          // freeze what we send (spec: snapshot from sent values)
      enqueue(cluster, async function () {
        try {
          var res = await opts.save();
          if (res && res.ok) { snapshot = frozen; flash(statusEl); }
          else { if (isDiscrete(triggerEl)) rollbackField(triggerEl); showError(statusEl, (res && res.error) || null); }
        } catch (err) { showError(statusEl, null); }   // network error -> localized string, value kept, retry next trigger
      });
    }

    fields.forEach(function (el) {
      if (isDiscrete(el)) {
        el.addEventListener('change', function () { commit(el, valueOf(el)); });
      } else {
        var fire = function () { commit(el, el.value); };
        el.addEventListener('blur', function () { clearTimeout(el._asTimer); fire(); });
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { clearTimeout(el._asTimer); el._asTimer = setTimeout(fire, 400); }
        });
      }
    });
  }

  window.SettingsAutosave.bind = bind;
})();
