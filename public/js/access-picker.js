'use strict';

// "Wer darf zugreifen?" (docs/groups.md "Zugriff per Gruppe") — one field
// with chips for groups, persons and (HTTP routes) devices, the live list of
// the people who would get access with the reason per person, and hints for
// disabled accounts / archived groups. Used by the route editor
// (entry-editor.js) and the RDP dialog (rdp.js).
//
//   const picker = window.GCAccessPicker.mount(container, {
//     devices: true|false,        // offer devices (HTTP routes with peer ACL licence)
//     onChange: function (value) {},
//   });
//   picker.setValue({ userIds: [], groupIds: [], peerIds: [] });
//   picker.getValue();            // same shape, ids as numbers
//   picker.setAclEnabled(bool);   // HTTP: devices only count with the ACL on
//   picker.setAclPeople(bool);    // HTTP: the ACL lets the devices of people
//                                 // and groups through (routes.acl_people)
//
// Data: GET /api/v1/access/principals (once per page), POST
// /api/v1/access/preview (debounced). Strings: #acc-i18n (acc.*), German
// fallbacks below. No innerHTML — every node is built with el().
(function () {
  if (window.GCAccessPicker) return;
  var doc = document;

  function readJson(id) {
    try { return JSON.parse((doc.getElementById(id) || {}).textContent || '{}') || {}; } catch (_) { return {}; }
  }
  var I18N = null;
  function T(key, params) {
    if (!I18N) I18N = readJson('acc-i18n');
    var s = I18N[key];
    if (s == null && window.GC && window.GC.t) s = window.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }

  function el(tag, props, children) {
    var n = doc.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'hidden' || k === 'type' || k === 'value' || k === 'disabled') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(children == null ? [] : children).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(c instanceof window.Node ? c : doc.createTextNode(String(c)));
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }

  // ── shared data ───────────────────────────────────────────────────
  var principals = null;
  var principalsPromise = null;
  function loadPrincipals(force) {
    if (principals && !force) return Promise.resolve(principals);
    if (principalsPromise && !force) return principalsPromise;
    principalsPromise = window.api.get('/api/v1/access/principals').then(function (d) {
      principals = {
        groups: (d && d.groups) || [],
        users: (d && d.users) || [],
        peers: (d && d.peers) || [],
      };
      return principals;
    }).catch(function () {
      principalsPromise = null;
      return { groups: [], users: [], peers: [], failed: true };
    });
    return principalsPromise;
  }

  function roleLabel(role) {
    var k = 'acc.role.' + role;
    var s = T(k);
    return s === k ? role : s;
  }

  function whyText(r) {
    if (r.type === 'person') return T('acc.why_person');
    if (r.type === 'device') return T('acc.why_device', { name: r.name });
    if (r.type === 'group') {
      if (!r.direct && r.viaPath) return T('acc.why_group_via', { path: r.path, via: r.viaPath });
      if (r.role && r.role !== 'member' && r.role !== 'child') return T('acc.why_group_role', { path: r.path, role: roleLabel(r.role) });
      return r.path;
    }
    return '';
  }

  var seq = 0;

  function mount(container, opts) {
    var o = opts || {};
    var uid = 'acc' + (++seq);
    var state = {
      value: { userIds: [], groupIds: [], peerIds: [] },
      devices: !!o.devices,
      acl: false,
      aclPeople: true,
      expanded: false,
      preview: null,
      active: -1,
      options: [],
    };
    var timer = null;
    var previewSeq = 0;

    clear(container);
    container.classList.add('acc-picker');

    var input = el('input', {
      type: 'text', class: 'acc-input', id: uid + '-input', role: 'combobox', autocomplete: 'off',
      'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': uid + '-menu',
      placeholder: state.devices ? T('acc.placeholder') : T('acc.placeholder_rdp'),
      'aria-label': state.devices ? T('acc.placeholder') : T('acc.placeholder_rdp'),
    });
    var chips = el('div', { class: 'acc-chips' });
    var field = el('div', { class: 'acc-field', on: { click: function (e) { if (e.target === field || e.target === chips) input.focus(); } } }, [chips, input]);
    var menu = el('ul', { class: 'acc-menu', id: uid + '-menu', role: 'listbox', hidden: true, 'aria-label': T('acc.title') });
    var hint = el('div', { class: 'acc-hint', text: T('acc.hint') });
    var prevHead = el('div', { class: 'acc-prev-ttl', 'aria-live': 'polite' });
    var moreBtn = el('button', { type: 'button', class: 'acc-link', hidden: true, on: { click: function () { state.expanded = !state.expanded; renderPreview(); } } });
    var prevList = el('ul', { class: 'acc-prev-list' });
    var preview = el('div', { class: 'acc-prev' }, [el('div', { class: 'acc-prev-head' }, [prevHead, moreBtn]), prevList]);
    var side = el('div', { class: 'acc-side' });
    container.appendChild(el('div', { class: 'acc-wrap' }, [field, menu]));
    container.appendChild(hint);
    container.appendChild(el('div', { class: 'acc-grid' }, [preview, side]));

    // ── chips ──
    function findGroup(id) { return principals ? principals.groups.find(function (g) { return g.id === id; }) : null; }
    function findUser(id) { return principals ? principals.users.find(function (u) { return u.id === id; }) : null; }
    function findPeer(id) { return principals ? principals.peers.find(function (p) { return p.id === id; }) : null; }

    function chipFor(kind, id) {
      var label;
      var extra = null;
      if (kind === 'group') {
        var g = findGroup(id);
        label = T('acc.chip_group', { name: g ? g.path : T('acc.unknown_group', { id: id }) });
        if (g && g.archived) extra = T('acc.chip_archived');
      } else if (kind === 'user') {
        var u = findUser(id);
        label = u ? T('acc.chip_person', { name: u.name }) : T('acc.chip_stale');
        if (u && !u.enabled) extra = T('acc.chip_disabled');
      } else {
        var p = findPeer(id);
        label = T('acc.chip_device', { name: p ? p.name : T('acc.unknown_device', { id: id }) });
      }
      var off = kind === 'peer' && !state.acl;
      return el('span', { class: 'acc-chip acc-chip-' + kind + (off ? ' is-off' : '') + (extra ? ' is-warn' : ''), title: off ? T('acc.devices_hint_off') : null }, [
        el('span', { class: 'acc-chip-label', text: label }),
        extra ? el('span', { class: 'acc-chip-extra', text: extra }) : null,
        el('button', {
          type: 'button', class: 'acc-chip-x', 'aria-label': T('acc.remove', { label: label }),
          on: { click: function (e) { e.stopPropagation(); remove(kind, id); input.focus(); } },
        }, '×'),
      ]);
    }

    function listOf(kind) { return kind === 'group' ? state.value.groupIds : kind === 'user' ? state.value.userIds : state.value.peerIds; }

    function renderChips() {
      clear(chips);
      state.value.groupIds.forEach(function (id) { chips.appendChild(chipFor('group', id)); });
      state.value.userIds.forEach(function (id) { chips.appendChild(chipFor('user', id)); });
      state.value.peerIds.forEach(function (id) { chips.appendChild(chipFor('peer', id)); });
    }

    function add(kind, id) {
      var list = listOf(kind);
      if (list.indexOf(id) === -1) list.push(id);
      changed();
    }
    function remove(kind, id) {
      var list = listOf(kind);
      var i = list.indexOf(id);
      if (i !== -1) list.splice(i, 1);
      changed();
    }

    // ── menu ──
    function buildOptions(q) {
      var out = [];
      if (!principals) return out;
      var needle = String(q || '').trim().toLowerCase();
      var match = function (s) { return !needle || String(s || '').toLowerCase().indexOf(needle) !== -1; };
      var groups = principals.groups.filter(function (g) { return !g.archived && state.value.groupIds.indexOf(g.id) === -1 && match(g.path); });
      var users = principals.users.filter(function (u) { return state.value.userIds.indexOf(u.id) === -1 && (match(u.name) || match(u.username)); });
      var peers = state.devices ? principals.peers.filter(function (p) { return state.value.peerIds.indexOf(p.id) === -1 && (match(p.name) || match(p.ip) || match(p.owner)); }) : [];
      var limit = needle ? 30 : 8;
      if (groups.length) out.push({ head: T('acc.kind_group') });
      groups.slice(0, limit).forEach(function (g) { out.push({ kind: 'group', id: g.id, label: g.path, detail: T('acc.members', { count: g.totalMemberCount }) }); });
      if (users.length) out.push({ head: T('acc.kind_person') });
      users.slice(0, limit).forEach(function (u) { out.push({ kind: 'user', id: u.id, label: u.name, detail: u.enabled ? (u.name !== u.username ? u.username : '') : T('acc.chip_disabled') }); });
      if (peers.length) out.push({ head: T('acc.kind_device') });
      peers.slice(0, limit).forEach(function (p) { out.push({ kind: 'peer', id: p.id, label: p.name, detail: [p.owner, p.ip].filter(Boolean).join(' · ') }); });
      return out;
    }

    function openMenu() {
      state.options = buildOptions(input.value);
      state.active = state.options.findIndex(function (x) { return !x.head; });
      renderMenu();
    }
    function closeMenu() {
      menu.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function renderMenu() {
      clear(menu);
      if (!state.options.length) {
        menu.appendChild(el('li', { class: 'acc-menu-empty', role: 'presentation', text: principals && principals.failed ? T('acc.load_error') : T('acc.no_match') }));
      }
      state.options.forEach(function (opt, i) {
        if (opt.head) { menu.appendChild(el('li', { class: 'acc-menu-head', role: 'presentation', text: opt.head })); return; }
        var li = el('li', {
          class: 'acc-opt acc-opt-' + opt.kind + (i === state.active ? ' is-active' : ''), role: 'option', id: uid + '-opt-' + i,
          'aria-selected': i === state.active ? 'true' : 'false',
          on: {
            mousedown: function (e) { e.preventDefault(); },
            click: function () { pick(i); },
          },
        }, [el('span', { class: 'acc-opt-label', text: opt.label }), opt.detail ? el('span', { class: 'acc-opt-detail', text: opt.detail }) : null]);
        menu.appendChild(li);
      });
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (state.active >= 0) input.setAttribute('aria-activedescendant', uid + '-opt-' + state.active);
      else input.removeAttribute('aria-activedescendant');
    }
    function pick(i) {
      var opt = state.options[i];
      if (!opt || opt.head) return;
      add(opt.kind, opt.id);
      input.value = '';
      openMenu();
    }
    function move(delta) {
      if (!state.options.length) return;
      var i = state.active;
      for (var n = 0; n < state.options.length; n++) {
        i = (i + delta + state.options.length) % state.options.length;
        if (!state.options[i].head) break;
      }
      state.active = i;
      renderMenu();
      var node = doc.getElementById(uid + '-opt-' + i);
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('focus', function () { loadPrincipals().then(openMenu); });
    input.addEventListener('input', function () { openMenu(); });
    input.addEventListener('blur', function () { setTimeout(closeMenu, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (menu.hidden) openMenu(); else move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { if (!menu.hidden && state.active >= 0) { e.preventDefault(); pick(state.active); } }
      else if (e.key === 'Escape') { if (!menu.hidden) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }
      else if (e.key === 'Backspace' && !input.value) {
        var last = state.value.peerIds.length ? ['peer', state.value.peerIds] : state.value.userIds.length ? ['user', state.value.userIds] : state.value.groupIds.length ? ['group', state.value.groupIds] : null;
        if (last) remove(last[0], last[1][last[1].length - 1]);
      }
    });

    // ── preview ──
    function restricted() { return state.value.userIds.length > 0 || state.value.groupIds.length > 0; }

    function schedulePreview() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(runPreview, 250);
    }
    function runPreview() {
      timer = null;
      var my = ++previewSeq;
      var body = { userIds: state.value.userIds, groupIds: state.value.groupIds, peerIds: state.devices ? state.value.peerIds : [] };
      // HTTP routes: do the devices of people and groups pass the ACL?
      if (state.devices) body.aclPeople = state.aclPeople;
      window.api.post('/api/v1/access/preview', body).then(function (d) {
        if (my !== previewSeq) return;
        state.preview = d && d.ok ? d : null;
        renderPreview();
      }).catch(function () {
        if (my !== previewSeq) return;
        state.preview = null;
        renderPreview();
      });
    }

    function renderPreview() {
      clear(prevList);
      clear(side);
      var p = state.preview;
      // With the ACL on, the devices that pass: the ticked ones plus — with
      // "Geräte der Personen und Gruppen durchlassen" — those of the people.
      var peopleThrough = state.acl && state.aclPeople;
      var devicesCount = (state.devices && state.acl && p)
        ? p.devices.length + (peopleThrough && p.personDevices ? p.personDevices.length : 0) : 0;
      // Devices only count with the device ACL on (HTTP routes).
      var people = p ? p.people.filter(function (x) {
        if (state.acl) return true;
        return x.reasons.some(function (r) { return r.type !== 'device'; });
      }) : [];
      if (!restricted() && !(state.acl && state.value.peerIds.length)) {
        prevHead.textContent = T('acc.preview_all_ttl');
        prevList.appendChild(el('li', { class: 'acc-prev-row acc-prev-note', text: T('acc.preview_all') }));
        moreBtn.hidden = true;
      } else {
        var active = people.filter(function (x) { return !x.disabled; });
        prevHead.textContent = T(active.length === 1 ? 'acc.preview_ttl_one' : 'acc.preview_ttl_other', { count: active.length });
        if (!active.length) prevList.appendChild(el('li', { class: 'acc-prev-row acc-prev-note', text: T('acc.preview_nobody') }));
        var shown = state.expanded ? active : active.slice(0, 5);
        shown.forEach(function (x) {
          var reasons = x.reasons.filter(function (r) { return state.acl || r.type !== 'device'; });
          var why = reasons.map(whyText);
          // Device ACL on: say whether the person's own devices get through.
          if (state.devices && state.acl) {
            if (state.aclPeople && x.ownDevices > 0) why.push(T(x.ownDevices === 1 ? 'acc.why_devices_pass_one' : 'acc.why_devices_pass', { count: x.ownDevices }));
            else if (!state.aclPeople && x.visibleOnly) why.push(T('acc.why_visible_only'));
          }
          prevList.appendChild(el('li', { class: 'acc-prev-row' + (state.devices && state.acl && !state.aclPeople && x.visibleOnly ? ' is-visible-only' : '') }, [
            el('span', { class: 'acc-prev-name', text: x.name }),
            el('span', { class: 'acc-prev-why', text: why.join(' · ') }),
          ]));
        });
        moreBtn.hidden = active.length <= 5;
        moreBtn.textContent = state.expanded ? T('acc.show_less') : T('acc.show_all', { count: active.length });
        people.filter(function (x) { return x.disabled; }).forEach(function (x) {
          side.appendChild(el('div', { class: 'acc-warn', text: T(x.disabledReason === 'directory' ? 'acc.disabled_directory' : 'acc.disabled_admin', { name: x.name }) }));
        });
      }
      if (p) {
        p.groups.filter(function (g) { return g.archived; }).forEach(function (g) {
          side.appendChild(el('div', { class: 'acc-warn', text: T('acc.archived_hint', { path: g.path }) }));
        });
        if (p.unknownUserIds && p.unknownUserIds.length) {
          side.appendChild(el('div', { class: 'acc-note', text: T('acc.stale_hint') }));
        }
      }
      if (state.devices) {
        var txt;
        if (!state.acl) txt = state.value.peerIds.length ? T('acc.devices_hint_off') : T('acc.devices_acl_off');
        else if (state.aclPeople) txt = T('acc.devices_hint', { count: devicesCount });
        else if (state.value.peerIds.length) txt = T('acc.devices_hint_listed', { count: devicesCount });
        else txt = T('acc.devices_hint_none');
        side.appendChild(el('div', { class: 'acc-note', text: txt }));
      }
      side.hidden = !side.firstChild;
    }

    function changed() {
      renderChips();
      schedulePreview();
      if (typeof o.onChange === 'function') {
        try { o.onChange(api.getValue()); } catch (err) { console.error('GCAccessPicker onChange failed:', err); }
      }
    }

    function ids(list) {
      var out = [];
      (Array.isArray(list) ? list : []).forEach(function (v) {
        var n = Number(v);
        if (Number.isSafeInteger(n) && n >= 0 && out.indexOf(n) === -1) out.push(n);
      });
      return out;
    }

    var api = {
      setValue: function (v) {
        var val = v || {};
        state.value = { userIds: ids(val.userIds), groupIds: ids(val.groupIds), peerIds: ids(val.peerIds) };
        state.expanded = false;
        state.preview = null;
        renderChips();
        renderPreview();
        loadPrincipals().then(function () { renderChips(); });
        runPreview();
      },
      getValue: function () {
        return { userIds: state.value.userIds.slice(), groupIds: state.value.groupIds.slice(), peerIds: state.value.peerIds.slice() };
      },
      setAclEnabled: function (on) {
        state.acl = !!on;
        renderChips();
        renderPreview();
      },
      setAclPeople: function (on) {
        var next = !!on;
        if (next === state.aclPeople) return;
        state.aclPeople = next;
        renderPreview();
        schedulePreview();
      },
      reload: function () { return loadPrincipals(true).then(function () { renderChips(); }); },
    };
    renderPreview();
    return api;
  }

  window.GCAccessPicker = { mount: mount, whyText: whyText };
})();
