'use strict';

// Settings → Client-Richtlinien: global policy + per-peer-group overrides.
// Uses ClientPolicyForm (client-policy-form.js). Saving is explicit (button);
// the server answers with the full state (global, groups, warnings).

(function () {
  var globalBox = document.getElementById('cp-global-form');
  var groupsBox = document.getElementById('cp-group-form');
  var groupSel = document.getElementById('cp-group-select');
  if (!globalBox || !groupsBox || !groupSel || !window.ClientPolicyForm) return;

  var globalStatus = document.getElementById('cp-global-status');
  var groupStatus = document.getElementById('cp-group-status');
  var warnEl = document.getElementById('cp-warning');
  var groupsEmpty = document.getElementById('cp-groups-empty');
  var groupsBody = document.getElementById('cp-groups-body');

  function tr(key) { return (window.GC && GC.t && GC.t[key]) || key; }

  var globalForm = ClientPolicyForm.create(globalBox, { mode: 'global', idPrefix: 'cp-global' });
  var groupForm = ClientPolicyForm.create(groupsBox, { mode: 'override', idPrefix: 'cp-group' });
  var state = null;

  function status(elm, text, isError) {
    if (!elm) return;
    elm.textContent = text || '';
    elm.style.color = isError ? 'var(--red)' : 'var(--text-3)';
  }

  function renderWarnings(warnings) {
    if (!warnEl) return;
    var list = warnings || [];
    warnEl.style.display = list.length ? '' : 'none';
    warnEl.textContent = list.map(function (w) { return tr('client_policy.' + w.replace('split_tunnel_preset_conflict', 'split_preset_conflict')); }).join(' ');
  }

  function selectedGroup() {
    if (!state) return null;
    var id = Number(groupSel.value);
    return state.groups.find(function (g) { return g.id === id; }) || null;
  }

  function showGroup() {
    var g = selectedGroup();
    groupForm.setInherited(state.global, null);
    groupForm.setValue(g ? g.policy : {});
  }

  function apply(data) {
    state = data;
    globalForm.setValue(data.global);
    renderWarnings(data.warnings);

    var prev = groupSel.value;
    while (groupSel.firstChild) groupSel.removeChild(groupSel.firstChild);
    data.groups.forEach(function (g) {
      var o = document.createElement('option');
      o.value = String(g.id);
      o.textContent = g.name + (Object.keys(g.policy || {}).length ? ' •' : '');
      groupSel.appendChild(o);
    });
    if (prev && data.groups.some(function (g) { return String(g.id) === prev; })) groupSel.value = prev;
    var hasGroups = data.groups.length > 0;
    if (groupsEmpty) groupsEmpty.style.display = hasGroups ? 'none' : '';
    if (groupsBody) groupsBody.style.display = hasGroups ? '' : 'none';
    if (hasGroups) showGroup();
  }

  function load() {
    return api.get('/api/v1/settings/client-policy').then(function (r) {
      if (r && r.ok) apply(r.data);
    }).catch(function (err) {
      status(globalStatus, err.message || '', true);
    });
  }

  groupSel.addEventListener('change', showGroup);

  document.getElementById('cp-global-save').addEventListener('click', function () {
    if (!globalForm.isValid()) { status(globalStatus, tr('error.client_policy.invalid'), true); return; }
    status(globalStatus, '');
    api.put('/api/v1/settings/client-policy', globalForm.getValue()).then(function (r) {
      if (r && r.ok) { apply(r.data); status(globalStatus, tr('client_policy.saved')); }
      else status(globalStatus, (r && r.error) || tr('common.error'), true);
    }).catch(function (err) { status(globalStatus, err.message || tr('common.error'), true); });
  });

  function saveGroup(body) {
    var g = selectedGroup();
    if (!g) return;
    status(groupStatus, '');
    api.put('/api/v1/settings/client-policy/groups/' + g.id, body).then(function (r) {
      if (r && r.ok) { apply(r.data); status(groupStatus, tr('client_policy.saved')); }
      else status(groupStatus, (r && r.error) || tr('common.error'), true);
    }).catch(function (err) { status(groupStatus, err.message || tr('common.error'), true); });
  }

  document.getElementById('cp-group-save').addEventListener('click', function () {
    if (!groupForm.isValid()) { status(groupStatus, tr('error.client_policy.invalid'), true); return; }
    saveGroup(groupForm.getValue());
  });
  document.getElementById('cp-group-reset').addEventListener('click', function () { saveGroup({}); });

  load();
})();
