'use strict';

// Client policy form (settings → Client-Richtlinien and the peer edit dialog).
//
//   ClientPolicyForm.create(container, { mode, idPrefix })
//     mode 'global'   — every field has a value (selects + checkboxes)
//     mode 'override' — every field can "inherit"; the inherited value is
//                       shown in the inherit option (setInherited)
//   → { getValue(), setValue(policy), setInherited(policy, sources), isValid() }
//
// getValue() in override mode returns only the overridden fields
// (inherit = field absent), which is what the API stores.
// All text goes through textContent; labels come from GC.t.

(function () {
  var ENUMS = {
    kill_switch: ['user', 'required'],
    auto_connect: ['user', 'required', 'always_on'],
    autostart: ['user', 'required', 'forbidden'],
  };
  var SPLIT_MODES = ['off', 'exclude', 'include'];
  var BOOLS = ['lock_settings', 'lock_server'];

  function tr(key, params) {
    var s = (window.GC && GC.t && GC.t[key]) || key;
    Object.keys(params || {}).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function valueLabel(field, value) {
    if (field === 'split_tunnel_modes') {
      return (value || []).map(function (m) { return tr('client_policy.split_mode.' + m); }).join(', ');
    }
    if (BOOLS.indexOf(field) !== -1) return tr(value ? 'client_policy.on' : 'client_policy.off');
    return tr('client_policy.' + field + '.' + value);
  }

  function create(container, opts) {
    opts = opts || {};
    var override = opts.mode === 'override';
    var prefix = opts.idPrefix || 'cp';
    var controls = {};
    var inherited = null;
    var sources = null;

    while (container.firstChild) container.removeChild(container.firstChild);

    function inheritText(field) {
      if (!inherited) return tr('client_policy.inherit');
      var v = valueLabel(field, inherited[field]);
      var src = sources && sources[field] ? ' · ' + tr('client_policy.source.' + sources[field]) : '';
      return tr('client_policy.inherit_value', { value: v + src });
    }

    // Enum fields → select
    Object.keys(ENUMS).forEach(function (field) {
      var group = el('div', { class: 'form-group' });
      var id = prefix + '-' + field.replace(/_/g, '-');
      group.appendChild(el('label', { class: 'form-label', for: id }, tr('client_policy.' + field)));
      var sel = el('select', { id: id, style: 'width:100%', 'data-policy-field': field });
      if (override) sel.appendChild(el('option', { value: '' }, tr('client_policy.inherit')));
      ENUMS[field].forEach(function (v) { sel.appendChild(el('option', { value: v }, tr('client_policy.' + field + '.' + v))); });
      group.appendChild(sel);
      container.appendChild(group);
      controls[field] = { type: 'enum', sel: sel };
    });

    // Split modes → (override: inherit/custom select +) checkboxes
    (function () {
      var field = 'split_tunnel_modes';
      var group = el('div', { class: 'form-group' });
      group.appendChild(el('div', { class: 'form-label' }, tr('client_policy.' + field)));
      var modeSel = null;
      if (override) {
        modeSel = el('select', { id: prefix + '-split-inherit', style: 'width:100%;margin-bottom:6px', 'data-policy-field': field });
        modeSel.appendChild(el('option', { value: '' }, tr('client_policy.inherit')));
        modeSel.appendChild(el('option', { value: 'custom' }, tr('client_policy.custom')));
        group.appendChild(modeSel);
      }
      var box = el('div', { style: 'display:flex;flex-direction:column;gap:4px' });
      var checks = {};
      SPLIT_MODES.forEach(function (m) {
        var lbl = el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px' });
        var cb = el('input', { type: 'checkbox', id: prefix + '-split-' + m, value: m });
        lbl.appendChild(cb);
        lbl.appendChild(el('span', null, tr('client_policy.split_mode.' + m)));
        box.appendChild(lbl);
        checks[m] = cb;
      });
      group.appendChild(box);
      group.appendChild(el('small', { class: 'form-hint' }, tr('client_policy.split_hint')));
      container.appendChild(group);
      function syncBox() {
        var custom = !modeSel || modeSel.value === 'custom';
        box.style.display = custom ? 'flex' : 'none';
      }
      if (modeSel) modeSel.addEventListener('change', function () {
        if (modeSel.value === 'custom' && inherited) {
          SPLIT_MODES.forEach(function (m) { checks[m].checked = inherited.split_tunnel_modes.indexOf(m) !== -1; });
        }
        syncBox();
      });
      controls[field] = { type: 'modes', sel: modeSel, checks: checks, sync: syncBox };
      syncBox();
    })();

    // Booleans → global: checkbox, override: select inherit/yes/no
    BOOLS.forEach(function (field) {
      var group = el('div', { class: 'form-group' });
      var id = prefix + '-' + field.replace(/_/g, '-');
      if (override) {
        group.appendChild(el('label', { class: 'form-label', for: id }, tr('client_policy.' + field)));
        var sel = el('select', { id: id, style: 'width:100%', 'data-policy-field': field });
        sel.appendChild(el('option', { value: '' }, tr('client_policy.inherit')));
        sel.appendChild(el('option', { value: 'true' }, tr('client_policy.on')));
        sel.appendChild(el('option', { value: 'false' }, tr('client_policy.off')));
        group.appendChild(sel);
        controls[field] = { type: 'boolsel', sel: sel };
      } else {
        var lbl = el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px' });
        var cb = el('input', { type: 'checkbox', id: id, 'data-policy-field': field });
        lbl.appendChild(cb);
        lbl.appendChild(el('span', null, tr('client_policy.' + field)));
        group.appendChild(lbl);
        controls[field] = { type: 'bool', cb: cb };
      }
      if (field === 'lock_settings') group.appendChild(el('small', { class: 'form-hint' }, tr('client_policy.lock_settings_hint')));
      container.appendChild(group);
    });

    function refreshInheritLabels() {
      if (!override) return;
      Object.keys(controls).forEach(function (field) {
        var c = controls[field];
        if (c.sel && c.sel.options[0]) c.sel.options[0].textContent = inheritText(field);
      });
    }

    function setValue(policy) {
      policy = policy || {};
      Object.keys(controls).forEach(function (field) {
        var c = controls[field];
        var v = policy[field];
        if (c.type === 'enum') c.sel.value = v == null ? (override ? '' : ENUMS[field][0]) : v;
        else if (c.type === 'bool') c.cb.checked = v === true;
        else if (c.type === 'boolsel') c.sel.value = v == null ? '' : String(v === true);
        else if (c.type === 'modes') {
          var list = Array.isArray(v) ? v : (override ? (inherited ? inherited.split_tunnel_modes : SPLIT_MODES) : SPLIT_MODES);
          if (c.sel) c.sel.value = Array.isArray(v) ? 'custom' : '';
          SPLIT_MODES.forEach(function (m) { c.checks[m].checked = list.indexOf(m) !== -1; });
          c.sync();
        }
      });
    }

    function getValue() {
      var out = {};
      Object.keys(controls).forEach(function (field) {
        var c = controls[field];
        if (c.type === 'enum') { if (c.sel.value) out[field] = c.sel.value; }
        else if (c.type === 'bool') out[field] = c.cb.checked;
        else if (c.type === 'boolsel') { if (c.sel.value) out[field] = c.sel.value === 'true'; }
        else if (c.type === 'modes') {
          if (!c.sel || c.sel.value === 'custom') {
            out[field] = SPLIT_MODES.filter(function (m) { return c.checks[m].checked; });
          }
        }
      });
      return out;
    }

    function isValid() {
      var v = getValue();
      return !v.split_tunnel_modes || v.split_tunnel_modes.length > 0;
    }

    function setInherited(policy, src) {
      inherited = policy || null;
      sources = src || null;
      refreshInheritLabels();
    }

    // Every control element (for change listeners / disabling)
    function elements() {
      var list = [];
      Object.keys(controls).forEach(function (field) {
        var c = controls[field];
        if (c.sel) list.push(c.sel);
        if (c.cb) list.push(c.cb);
        if (c.checks) SPLIT_MODES.forEach(function (m) { list.push(c.checks[m]); });
      });
      return list;
    }

    setValue(override ? {} : null);
    return { getValue: getValue, setValue: setValue, setInherited: setInherited, isValid: isValid, elements: elements };
  }

  window.ClientPolicyForm = { create: create, valueLabel: valueLabel, SPLIT_MODES: SPLIT_MODES };
})();
