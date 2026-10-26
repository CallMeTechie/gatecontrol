'use strict';

// GateControl's picker for groups and people in plugin frames
// (GC.pickPrincipals, docs/plugins.md "Groups").
//
// A plugin frame is sandboxed and gets no list of people. It asks the parent
// page (plugin-bridge.js, message gc-pick, only frames with
// data-plugin-groups = plugin.json permissions.groups), and this page shows
// the picker with what the VIEWER may see:
//   admin pages  GET /api/v1/principals            every group (path) and every
//                                                  enabled person (display name)
//   portal       GET /api/v1/portal/groups/principals  the groups by name (no
//                                                  member lists) and the viewer
// and answers only what was chosen: [{ type: 'group'|'user', id, label }], or
// null when cancelled (Abbrechen, Escape, a new document in the frame).
//
//   GCPrincipalPicker.open({ name, title, groups, users, multiple, portal })
//     → { promise: Promise<Array|null>, cancel() }
//   groups / users: which kinds to offer (default: groups only); multiple:
//   several entries (chips) or one (a click picks it).
//
// Admin pages: the shared dialog (gc-dialog.js, .modal-overlay.zn-dialog);
// the portal: its own .pt-overlay/.pt-dialog. Texts German/English by
// <html lang>. No innerHTML anywhere.
(function (root) {
  const doc = root && root.document;

  const STR = {
    de: {
      title: 'Auswählen',
      title_groups: 'Gruppe auswählen',
      title_users: 'Person auswählen',
      title_both: 'Gruppen und Personen auswählen',
      for: 'für {name}',
      search: 'Suchen …',
      loading: 'Wird geladen …',
      none: 'Nichts gefunden.',
      failed: 'Die Auswahl konnte nicht geladen werden.',
      login: 'Bitte melde dich an, um Gruppen auszuwählen.',
      group: 'Gruppe',
      person: 'Person',
      me: 'ich',
      remove: '{label} entfernen',
      selected: 'Ausgewählt',
      nothing: 'Noch nichts ausgewählt.',
      ok: 'Übernehmen',
      cancel: 'Abbrechen',
      privacy: '{name} bekommt nur, was du hier auswählst.',
    },
    en: {
      title: 'Choose',
      title_groups: 'Choose a group',
      title_users: 'Choose a person',
      title_both: 'Choose groups and people',
      for: 'for {name}',
      search: 'Search …',
      loading: 'Loading …',
      none: 'Nothing found.',
      failed: 'The list could not be loaded.',
      login: 'Please sign in to choose groups.',
      group: 'Group',
      person: 'Person',
      me: 'me',
      remove: 'Remove {label}',
      selected: 'Chosen',
      nothing: 'Nothing chosen yet.',
      ok: 'Apply',
      cancel: 'Cancel',
      privacy: '{name} only gets what you choose here.',
    },
  };
  const MAX_TITLE = 120;
  const MAX_NAME = 80;
  const MAX_SHOWN = 200;

  function lang() {
    const l = String((doc && doc.documentElement.getAttribute('lang')) || 'de').slice(0, 2).toLowerCase();
    return l === 'en' ? 'en' : 'de';
  }
  function t(key, params) {
    let s = STR[lang()][key] || STR.de[key] || key;
    Object.keys(params || {}).forEach((k) => { s = s.split('{' + k + '}').join(String(params[k])); });
    return s;
  }
  function clean(v, max) {
    // eslint-disable-next-line no-control-regex
    return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  }

  function el(tag, attrs, children) {
    const n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach((c) => { if (c) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }

  /** The shell: admin (GCDialog) or portal (.pt-dialog) — like qr-scan.js. */
  function shell(title, sub) {
    const G = root.GCDialog;
    if (G && typeof G.dialog === 'function' && !doc.querySelector('body.pt-body')) {
      const d = G.dialog({ title });
      d.overlay.classList.add('gc-pp-overlay');
      d.box.classList.add('gc-pp-box');
      if (sub) {
        const head = d.box.querySelector('.modal-title');
        if (head) head.appendChild(el('small', { text: sub }));
      }
      return {
        body: d.body, foot: d.foot, overlay: d.overlay,
        close: () => d.close(true),
        onClose: (fn) => { d.promise.then((r) => fn(r === true ? 'closed' : 'cancelled')); },
        btn: (kind) => 'btn ' + (kind === 'primary' ? 'btn-primary' : 'btn-ghost'),
      };
    }
    const titleId = 'gc-pp-t-' + Date.now();
    const body = el('div', { class: 'gc-pp-body' });
    const foot = el('div', { class: 'pt-dialog-foot' });
    const box = el('div', { class: 'pt-dialog gc-pp-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'gc-pp-head' }, [el('h2', { class: 'pt-h2', id: titleId, text: title }), sub ? el('p', { class: 'pt-small pt-muted gc-pp-sub', text: sub }) : null]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'pt-overlay gc-pp-overlay' }, [box]);
    const prev = doc.activeElement;
    let closeFn = null;
    let closed = false;
    function close(how) {
      if (closed) return;
      closed = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prev && prev.focus && doc.contains(prev)) { try { prev.focus(); } catch (_) { /* gone */ } }
      if (closeFn) closeFn(how);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close('cancelled'); }
    }
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    return {
      body, foot, overlay,
      close: () => close('closed'),
      onClose: (fn) => { closeFn = fn; },
      btn: (kind) => 'pt-btn' + (kind === 'primary' ? ' pt-btn-primary' : ''),
    };
  }

  /**
   * The answer of the principals endpoint → [{ type, id, label, sub, self }]
   * (only well-formed entries of the kinds asked for).
   */
  function entries(body, o) {
    const out = [];
    const take = (list, type) => {
      (Array.isArray(list) ? list : []).forEach((x) => {
        if (!x || !Number.isSafeInteger(x.id) || x.id <= 0) return;
        const label = clean(x.label, 200);
        if (!label) return;
        out.push({ type, id: x.id, label, sub: clean(x.sub, 120), self: x.self === true });
      });
    };
    if (o.groups) take(body && body.groups, 'group');
    if (o.users) take(body && body.users, 'user');
    return out;
  }

  function matches(e, q) {
    if (!q) return true;
    const hay = (e.label + ' ' + e.sub).toLocaleLowerCase();
    return q.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.indexOf(w) >= 0);
  }

  let current = null;

  function open(opts) {
    const o = opts || {};
    if (current || !doc) return { promise: Promise.resolve(null), cancel() {} };
    const want = { groups: o.groups !== false, users: o.users === true };
    if (!want.groups && !want.users) want.groups = true;
    const multiple = o.multiple === true;
    const name = clean(o.name, MAX_NAME) || 'Plugin';
    const title = clean(o.title, MAX_TITLE) || t(want.groups && want.users ? 'title_both' : (want.users ? 'title_users' : 'title_groups'));
    const url = o.portal ? '/api/v1/portal/groups/principals' : '/api/v1/principals';

    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    const ui = shell(title, t('for', { name }));
    ui.overlay.style.zIndex = '2147483600'; // above the dimming of an open plugin dialog (plugin-bridge.js)
    let finished = false;
    let all = [];
    const chosen = [];

    function finish(list) {
      if (finished) return;
      finished = true;
      current = null;
      resolveFn(list);
      ui.close();
    }
    ui.onClose(() => finish(null));

    const search = el('input', { type: 'search', class: 'gc-pp-search' + (o.portal ? ' pt-input' : ' input'), placeholder: t('search'),
      'aria-label': t('search'), autocomplete: 'off', maxlength: '100' });
    const status = el('p', { class: 'gc-pp-status', role: 'status', text: t('loading') });
    const list = el('ul', { class: 'gc-pp-list', role: 'listbox', 'aria-multiselectable': multiple ? 'true' : 'false', 'aria-label': title });
    const chips = el('div', { class: 'gc-pp-chips', 'aria-label': t('selected') });
    ui.body.appendChild(search);
    if (multiple) ui.body.appendChild(chips);
    ui.body.appendChild(list);
    ui.body.appendChild(status);
    ui.body.appendChild(el('p', { class: 'gc-pp-privacy', text: t('privacy', { name }) }));
    const cancelBtn = el('button', { type: 'button', class: ui.btn('ghost'), text: t('cancel'), on: { click: () => finish(null) } });
    ui.foot.appendChild(cancelBtn);
    const okBtn = multiple ? el('button', { type: 'button', class: ui.btn('primary'), text: t('ok'), disabled: true,
      on: { click: () => finish(chosen.map((e) => ({ type: e.type, id: e.id, label: e.label }))) } }) : null;
    if (okBtn) ui.foot.appendChild(okBtn);

    const isChosen = (e) => chosen.some((c) => c.type === e.type && c.id === e.id);
    function renderChips() {
      if (!multiple) return;
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      if (!chosen.length) chips.appendChild(el('span', { class: 'gc-pp-none', text: t('nothing') }));
      chosen.forEach((e) => {
        chips.appendChild(el('span', { class: 'gc-pp-chip', 'data-type': e.type }, [
          el('span', { text: e.label }),
          el('button', { type: 'button', class: 'gc-pp-chip-x', 'aria-label': t('remove', { label: e.label }), text: '×',
            on: { click: () => { toggle(e); } } }),
        ]));
      });
      okBtn.disabled = !chosen.length;
    }
    function toggle(e) {
      if (!multiple) { finish([{ type: e.type, id: e.id, label: e.label }]); return; }
      const i = chosen.findIndex((c) => c.type === e.type && c.id === e.id);
      if (i >= 0) chosen.splice(i, 1); else chosen.push(e);
      renderChips();
      renderList();
    }
    function renderList() {
      while (list.firstChild) list.removeChild(list.firstChild);
      const shown = all.filter((e) => matches(e, search.value.trim())).slice(0, MAX_SHOWN);
      shown.forEach((e) => {
        const on = isChosen(e);
        list.appendChild(el('li', { role: 'none' }, [
          el('button', { type: 'button', role: 'option', class: 'gc-pp-opt' + (on ? ' is-on' : ''), 'aria-selected': on ? 'true' : 'false',
            'data-type': e.type, on: { click: () => toggle(e) } }, [
            el('span', { class: 'gc-pp-kind', text: e.type === 'group' ? t('group') : t('person') }),
            el('span', { class: 'gc-pp-label', text: e.label + (e.self ? ' (' + t('me') + ')' : '') }),
            e.sub ? el('span', { class: 'gc-pp-sub2', text: e.sub }) : null,
          ]),
        ]));
      });
      status.textContent = shown.length ? '' : t('none');
    }
    search.addEventListener('input', renderList);
    renderChips();
    current = { cancel: () => finish(null) };

    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => r.json().catch(() => null).then((body) => ({ status: r.status, body })))
      .then((res) => {
        if (finished) return;
        if (!res.body || !res.body.ok) { status.textContent = res.status === 401 || res.status === 403 ? t('login') : t('failed'); return; }
        all = entries(res.body, want);
        renderList();
        try { search.focus(); } catch (_) { /* cosmetic */ }
      })
      .catch(() => { if (!finished) status.textContent = t('failed'); });

    return { promise, cancel: () => finish(null) };
  }

  const api = { open, entries, matches, active: () => !!current, STR };
  if (root) root.GCPrincipalPicker = Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : null));
