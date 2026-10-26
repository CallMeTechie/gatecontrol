'use strict';

// Benutzer › Gruppen (/groups, docs/groups.md). Tree on the left (kind
// colour, source badge, members incl. subgroups, search, archived on/off),
// the selected group on the right: path, kind, source, members with role
// (direct ones editable, inherited ones from subgroups read-only), invitation
// links, "Wird genutzt von", archive / restore, delete (usage listed,
// successor for what plugins keep, name typed). Directory groups: name, structure and their own members are
// read-only, GateControl roles and extra local members are allowed; plugin
// groups are read-only. Dialogs: create, edit, add member, invitation link,
// delete, CSV import. Strings: #grp-i18n (grp.*, error.groups.*, common.*).
// No innerHTML — every node is built with el()/textContent.
(function () {
  const doc = document;
  const page = doc.getElementById('grp-page');
  if (!page) return;
  const D = window.GCDialog;

  function readJson(id) {
    try { return JSON.parse((doc.getElementById(id) || {}).textContent || '{}') || {}; } catch (_) { return {}; }
  }
  const I18N = readJson('grp-i18n');
  const CTX = readJson('grp-ctx');
  const LANG = CTX.lang || doc.documentElement.lang || 'de';

  function T(key, params) {
    let s = I18N[key];
    if (s == null && window.GC && window.GC.t) s = window.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function P(base, n, params) { return T(base + (n === 1 ? '_one' : '_other'), Object.assign({ count: n }, params || {})); }

  // ── DOM helpers ────────────────────────────────────────────────────
  const SVGNS = 'http://www.w3.org/2000/svg';
  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected' || k === 'hidden' || k === 'type' || k === 'title') n[k] = v;
      else if (k === 'href') { const s = String(v); n.setAttribute('href', /^\/(?![/\\])/.test(s) ? s : '#'); }
      else if (/^(aria-[a-z]+|role|for|id|datetime|scope)$/.test(k)) n.setAttribute(k, v === true ? '' : String(v));
      else if (k === 'data-id') n.dataset.id = String(v);
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.append(c instanceof window.Node ? c : String(c));
    });
    return n;
  }
  function icon(d, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['width', String(size || 16)], ['height', String(size || 16)]]
      .forEach((a) => svg.setAttribute(a[0], a[1]));
    const path = doc.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }
  const IC = {
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
    chevron: 'M9 6l6 6-6 6',
  };
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function $(id) { return doc.getElementById(id); }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  function errMsg(err) { return (err && err.message) || T('common.error'); }
  function setError(id, msg) { const n = $(id); if (!n) return; n.textContent = msg || ''; n.hidden = !msg; }
  function fmtDate(v) {
    if (!v) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); }
  }
  function initials(name) {
    const w = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
    if (!w.length) return '?';
    return (w.length > 1 ? Array.from(w[0])[0] + Array.from(w[1])[0] : Array.from(w[0]).slice(0, 2).join('')).toUpperCase();
  }

  async function call(method, url, body) {
    const fn = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'del' }[method];
    const res = method === 'GET' || method === 'DELETE' ? await window.api[fn](url) : await window.api[fn](url, body || {});
    if (res && res.ok === false) throw new Error(res.error || T('common.error'));
    return res;
  }

  // ── Dialogs ────────────────────────────────────────────────────────
  doc.querySelectorAll('[data-grp-dialog]').forEach((ov) => {
    // Out of .app (own stacking context) so the dialog covers the bottom nav.
    doc.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => { ov._down = e.target === ov; });
    ov.addEventListener('click', (e) => { if (e.target === ov && ov._down) closeDlg(ov.id); });
  });
  function openDlg(id) {
    window.openModal(id);
    const ov = $(id);
    const first = ov && ov.querySelector('[data-autofocus]');
    if (first) setTimeout(() => { try { first.focus(); } catch (_) { /* gone */ } }, 30);
  }
  function closeDlg(id) { window.closeModal(id); }

  // ── Labels ─────────────────────────────────────────────────────────
  function kindLabel(k) { return T('grp.kind.' + k); }
  function roleLabel(r) { return T('grp.role.' + r); }
  function srcType(source) {
    const s = String(source || 'local');
    if (s.indexOf('directory:') === 0) return 'directory';
    if (s.indexOf('plugin:') === 0) return 'plugin';
    return 'local';
  }
  function srcId(source) { const s = String(source || ''); const i = s.indexOf(':'); return i > 0 ? s.slice(i + 1) : ''; }
  function memberSourceLabel(source) { return T('grp.src.' + srcType(source)); }
  function groupSourceChip(g) {
    const t = srcType(g.source);
    return t === 'local' ? T('grp.src_chip.local') : T('grp.src_chip.' + t, { id: srcId(g.source) });
  }
  function treeBadge(g) {
    if (g.archived) return T('grp.badge.archived');
    const t = srcType(g.source);
    if (t === 'directory') return T('grp.badge.directory');
    if (t === 'plugin') return T('grp.badge.plugin');
    if (g.endsAt) return T('grp.badge.until', { date: fmtDate(g.endsAt) });
    return '';
  }

  // ── State ──────────────────────────────────────────────────────────
  function idFromUrl() {
    try { const v = Number(new URL(window.location.href).searchParams.get('id')); return v > 0 ? v : null; } catch (_) { return null; }
  }
  const state = { flat: [], byId: new Map(), sel: idFromUrl(), detail: null, q: '', archived: false, users: null };

  function writeUrl() {
    try {
      const u = new URL(window.location.href);
      if (state.sel) u.searchParams.set('id', String(state.sel)); else u.searchParams.delete('id');
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (_) { /* old browser */ }
  }

  async function loadGroups() {
    const res = await call('GET', '/api/v1/groups' + (state.archived ? '?archived=1' : ''));
    state.flat = res.groups || [];
    state.byId = new Map(state.flat.map((g) => [g.id, g]));
    renderTree();
  }

  // ── Tree ───────────────────────────────────────────────────────────
  function renderTree() {
    const host = clear($('grp-tree'));
    const q = state.q.trim().toLowerCase();
    let shown = state.flat;
    if (q) {
      const keep = new Set();
      state.flat.forEach((g) => {
        if (g.name.toLowerCase().indexOf(q) >= 0 || g.path.toLowerCase().indexOf(q) >= 0) {
          (g.pathIds || [g.id]).forEach((id) => keep.add(id));
        }
      });
      shown = state.flat.filter((g) => keep.has(g.id));
    }
    if (!state.flat.length) {
      host.appendChild(el('li', { class: 'grp-tree-empty' }, [
        el('p', { class: 'us-muted' }, T('grp.empty')),
        el('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: () => openCreate(null) } }, T('grp.add')),
      ]));
      return;
    }
    if (!shown.length) { host.appendChild(el('li', { class: 'grp-tree-empty us-muted' }, T('grp.no_match'))); return; }
    // state.flat is sorted by path, so parents come before their children.
    shown.forEach((g) => {
      const color = g.color || null;
      const dot = el('span', { class: 'grp-dot grp-kind-' + g.kind, 'aria-hidden': 'true' });
      if (color) dot.style.setProperty('background', color);
      const btn = el('button', {
        type: 'button',
        class: 'grp-node grp-depth-' + Math.min(g.depth || 1, 3) + (g.id === state.sel ? ' is-active' : '') + (g.archived ? ' is-archived' : ''),
        'aria-current': g.id === state.sel ? 'true' : null,
        'data-id': g.id,
        on: { click: () => select(g.id) },
      }, [
        dot,
        el('span', { class: 'grp-node-name' }, g.name),
        el('span', { class: 'grp-node-badge' }, treeBadge(g)),
        el('span', { class: 'grp-node-count', title: P('grp.members_count', g.totalMemberCount) }, String(g.totalMemberCount)),
      ]);
      host.appendChild(el('li', null, btn));
    });
  }

  async function select(id) {
    state.sel = id;
    writeUrl();
    renderTree();
    await loadDetail();
  }

  // ── Detail ─────────────────────────────────────────────────────────
  async function loadDetail() {
    const host = $('grp-detail');
    if (!state.sel) { clear(host).appendChild(el('div', { class: 'grp-empty' }, el('p', { class: 'us-muted' }, T('grp.pick')))); return; }
    try {
      state.detail = await call('GET', '/api/v1/groups/' + state.sel);
      renderDetail();
    } catch (err) {
      state.detail = null;
      clear(host).appendChild(el('p', { class: 'us-error', role: 'alert' }, errMsg(err)));
    }
  }

  function caps(g) {
    const t = srcType(g.source);
    return {
      edit: t === 'local',
      structure: t === 'local',
      addMember: (t === 'local' || t === 'directory') && !g.archived,
      roles: t === 'local' || t === 'directory',
      removeMember: (m) => t === 'local' || (t === 'directory' && m.source === 'local'),
      invite: (t === 'local' || t === 'directory') && !g.archived,
      sub: t === 'local' && g.kind !== 'family' && (g.depth || 1) < 3 && !g.archived,
      archive: t === 'local',
      del: t === 'local',
    };
  }

  function chip(text, cls) { return el('span', { class: 'us-chip ' + (cls || '') }, text); }

  function renderDetail() {
    const d = state.detail;
    const g = d.group;
    const c = caps(g);
    const host = clear($('grp-detail'));
    const parentPath = g.path.split(' › ').slice(0, -1).join(' › ');

    const actions = el('div', { class: 'grp-head-actions' });
    if (c.addMember) actions.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: () => openMember() } }, [icon(IC.plus, 14), ' ', T(srcType(g.source) === 'directory' ? 'grp.add_local_member' : 'grp.add_member')]));
    if (c.invite) actions.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => openInvite() } }, [icon(IC.link, 14), ' ', T('grp.inv.button')]));
    if (c.edit) actions.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => openEdit() } }, T('grp.edit.button')));
    if (srcType(g.source) === 'plugin' || srcType(g.source) === 'directory') {
      // Colour only (everything else comes from the source).
      actions.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => openEdit() } }, T('grp.edit.color_button')));
    }

    const head = el('header', { class: 'grp-head' }, [
      el('div', { class: 'grp-head-text' }, [
        parentPath ? el('div', { class: 'grp-crumbs' }, parentPath + ' ›') : null,
        el('h2', { class: 'grp-title' }, g.name),
        el('div', { class: 'grp-chips' }, [
          chip(kindLabel(g.kind), 'grp-chip-kind grp-kind-' + g.kind),
          chip(groupSourceChip(g)),
          g.endsAt ? chip(T('grp.ends_chip', { date: fmtDate(g.endsAt) }), 'us-chip-warn') : null,
          g.archived ? chip(T('grp.archived_chip', { date: fmtDate(g.archivedAt) }), 'us-chip-off') : null,
        ]),
      ]),
      actions,
    ]);
    host.appendChild(head);
    if (g.description) host.appendChild(el('p', { class: 'grp-desc' }, g.description));
    if (srcType(g.source) === 'directory') host.appendChild(el('div', { class: 'grp-note' }, T('grp.note.directory')));
    if (srcType(g.source) === 'plugin') host.appendChild(el('div', { class: 'grp-note' }, T('grp.note.plugin', { id: srcId(g.source) })));
    if (g.archived) host.appendChild(el('div', { class: 'grp-note grp-note-warn' }, T('grp.note.archived')));

    host.appendChild(renderMembers(d, c));
    if (c.invite || (d.invites || []).some((i) => i.active)) host.appendChild(renderInvites(d));
    host.appendChild(renderUsage(g));

    // Footer actions: subgroup, archive / restore, delete.
    const foot = el('div', { class: 'grp-foot' });
    if (!c.sub && !c.archive && !c.del) foot.hidden = true;
    if (c.sub) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => openCreate(g.id) } }, [icon(IC.plus, 14), ' ', T('grp.add_sub')]));
    if (c.archive && g.archived) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => unarchive(g) } }, T('grp.unarchive')));
    else if (c.archive) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => archive(g) } }, T('grp.archive')));
    if (c.del) foot.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-danger', on: { click: () => openDelete() } }, [icon(IC.trash, 14), ' ', T('grp.delete')]));
    host.appendChild(foot);
  }

  function personCell(m) {
    return el('div', { class: 'grp-person' }, [
      el('span', { class: 'us-avatar us-tone-member grp-avatar' + (m.enabled ? '' : ' us-avatar-off'), 'aria-hidden': 'true' }, initials(m.name)),
      el('span', { class: 'grp-person-text' }, [
        el('a', { class: 'grp-person-name', href: '/users/' + m.userId }, m.name),
        el('span', { class: 'grp-person-sub' }, [m.email || ('@' + m.username), m.enabled ? null : ' · ' + T('grp.disabled')]),
      ]),
    ]);
  }

  function renderMembers(d, c) {
    const g = d.group;
    const direct = (d.members || []).filter((m) => m.direct);
    const inherited = (d.members || []).filter((m) => !m.direct);
    const sec = el('section', { class: 'grp-section' }, [
      el('h3', { class: 'grp-section-title' }, [T('grp.members'), el('span', { class: 'grp-section-count' }, String(direct.length))]),
    ]);
    if (!direct.length) sec.appendChild(el('p', { class: 'us-muted' }, T('grp.no_members')));
    else {
      const tbody = el('tbody');
      direct.forEach((m) => {
        let roleCell;
        if (c.roles) {
          const sel = el('select', { class: 'form-input grp-role-select', 'aria-label': T('grp.role_of', { name: m.name }) });
          (d.roles || []).forEach((r) => sel.appendChild(el('option', { value: r, selected: r === m.role }, roleLabel(r))));
          sel.addEventListener('change', async () => {
            sel.disabled = true;
            try {
              await call('PUT', '/api/v1/groups/' + g.id + '/members/' + m.userId, { role: sel.value });
              toast(T('grp.toast.role'));
              await loadDetail();
            } catch (err) { sel.disabled = false; sel.value = m.role; D.alert({ message: errMsg(err), danger: true }); }
          });
          roleCell = sel;
        } else roleCell = el('span', null, roleLabel(m.role));
        const act = c.removeMember(m)
          ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost grp-icon-btn', 'aria-label': T('grp.remove_member', { name: m.name }), title: T('grp.remove_member', { name: m.name }), on: { click: () => removeMember(g, m) } }, icon(IC.trash, 15))
          : null;
        tbody.appendChild(el('tr', null, [
          el('td', null, personCell(m)),
          el('td', null, roleCell),
          el('td', { class: 'us-muted' }, memberSourceLabel(m.source)),
          el('td', null, act),
        ]));
      });
      sec.appendChild(el('div', { class: 'us-table-wrap' }, el('table', { class: 'us-table grp-table' }, [
        el('thead', null, el('tr', null, [
          el('th', { scope: 'col' }, T('grp.col.person')), el('th', { scope: 'col' }, T('grp.col.role')),
          el('th', { scope: 'col' }, T('grp.col.source')), el('th', { scope: 'col' }, el('span', { class: 'us-sr' }, T('grp.col.actions'))),
        ])),
        tbody,
      ])));
    }
    if (inherited.length) {
      const list = el('ul', { class: 'grp-inherited' });
      inherited.forEach((m) => {
        const from = state.byId.get(m.groupId);
        list.appendChild(el('li', null, [personCell(m), el('span', { class: 'grp-via' }, T('grp.via', { name: from ? from.name : '#' + m.groupId }))]));
      });
      sec.appendChild(el('details', { class: 'grp-inherited-box' }, [
        el('summary', null, P('grp.inherited', inherited.length)),
        el('p', { class: 'us-hint' }, T('grp.inherited_hint')),
        list,
      ]));
    }
    return sec;
  }

  function renderInvites(d) {
    const g = d.group;
    const active = (d.invites || []).filter((i) => i.active);
    const sec = el('section', { class: 'grp-section' }, [el('h3', { class: 'grp-section-title' }, T('grp.inv.list'))]);
    if (!active.length) { sec.appendChild(el('p', { class: 'us-muted' }, T('grp.inv.none'))); return sec; }
    const ul = el('ul', { class: 'grp-invites' });
    active.forEach((i) => {
      ul.appendChild(el('li', null, [
        el('span', { class: 'grp-inv-text' }, T('grp.inv.row', { role: roleLabel(i.role), uses: i.uses, max: i.maxUses == null ? '∞' : i.maxUses, date: fmtDate(i.expiresAt) })),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => revokeInvite(g, i) } }, T('grp.inv.revoke')),
      ]));
    });
    sec.appendChild(ul);
    return sec;
  }

  function usageKind(u) { return u.core ? T('grp.usage.' + u.kind) : u.kind; }
  // Core entries carry an i18n key (grp.usage.route_locked, …), plugins their own text.
  function usageThen(u) { return u.onDeleteKey ? T(u.onDeleteKey) : (u.onDelete || ''); }

  function renderUsage(g) {
    const grid = el('div', { class: 'grp-usage' }, el('p', { class: 'us-muted' }, T('common.loading')));
    const sec = el('section', { class: 'grp-section' }, [el('h3', { class: 'grp-section-title' }, T('grp.usage.title')), grid]);
    call('GET', '/api/v1/groups/' + g.id + '/usage').then((res) => {
      clear(grid);
      const list = res.usage || [];
      if (!list.length) { grid.appendChild(el('p', { class: 'us-muted' }, T('grp.usage.none'))); return; }
      list.forEach((u) => grid.appendChild(el('div', { class: 'grp-use' }, [
        el('div', { class: 'grp-use-kind' }, usageKind(u)),
        el('div', { class: 'grp-use-label' }, u.label),
      ])));
    }).catch((err) => { clear(grid).appendChild(el('p', { class: 'us-error' }, errMsg(err))); });
    return sec;
  }

  // ── Actions ────────────────────────────────────────────────────────
  async function refreshAll() {
    // An archived group drops out of the default tree; its detail stays shown.
    await loadGroups();
    await loadDetail();
  }

  async function removeMember(g, m) {
    const ok = await D.confirm({ title: T('grp.confirm.remove_title'), message: T('grp.confirm.remove_text', { name: m.name, group: g.name }), okLabel: T('grp.confirm.remove_ok'), danger: true });
    if (!ok) return;
    try {
      await call('DELETE', '/api/v1/groups/' + g.id + '/members/' + m.userId);
      toast(T('grp.toast.removed'));
      await refreshAll();
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  async function archive(g) {
    const ok = await D.confirm({ title: T('grp.confirm.archive_title', { name: g.name }), message: T('grp.confirm.archive_text'), okLabel: T('grp.archive'), danger: true });
    if (!ok) return;
    try {
      await call('POST', '/api/v1/groups/' + g.id + '/archive');
      toast(T('grp.toast.archived'));
      await refreshAll();
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  async function unarchive(g) {
    try {
      await call('POST', '/api/v1/groups/' + g.id + '/unarchive');
      toast(T('grp.toast.unarchived'));
      await refreshAll();
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  async function revokeInvite(g, i) {
    const ok = await D.confirm({ title: T('grp.confirm.revoke_title'), message: T('grp.confirm.revoke_text'), okLabel: T('grp.inv.revoke'), danger: true });
    if (!ok) return;
    try {
      await call('DELETE', '/api/v1/groups/' + g.id + '/invites/' + i.id);
      toast(T('grp.toast.revoked'));
      await loadDetail();
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  // Parents a group may get: local, not archived, not family, depth < 3,
  // and (when moving) neither the group nor one of its subgroups.
  function parentOptions(sel, current, movingId, height) {
    clear(sel);
    sel.appendChild(el('option', { value: '' }, T('grp.f.no_parent')));
    state.flat.forEach((g) => {
      if (srcType(g.source) !== 'local' || g.archived || g.kind === 'family') return;
      if ((g.depth || 1) + 1 + (height || 0) > 3) return;
      if (movingId && (g.id === movingId || (g.pathIds || []).indexOf(movingId) >= 0)) return;
      sel.appendChild(el('option', { value: String(g.id), selected: g.id === current }, g.path));
    });
  }
  function subtreeHeight(id) {
    let h = 0;
    state.flat.forEach((g) => {
      const i = (g.pathIds || []).indexOf(id);
      if (i >= 0) h = Math.max(h, g.pathIds.length - 1 - i);
    });
    return h;
  }

  // Create
  function syncEnds(kindSel, field) { field.hidden = kindSel.value !== 'project'; }
  function openCreate(parentId) {
    parentOptions($('grp-create-parent'), parentId, null, 0);
    $('grp-create-kind').value = parentId ? 'team' : 'department';
    $('grp-create-name').value = '';
    $('grp-create-desc').value = '';
    $('grp-create-ends').value = '';
    syncEnds($('grp-create-kind'), $('grp-create-ends-field'));
    setError('grp-create-error', '');
    openDlg('grp-dlg-create');
  }
  $('grp-create-kind').addEventListener('change', () => syncEnds($('grp-create-kind'), $('grp-create-ends-field')));
  $('grp-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = $('grp-create-kind').value;
    const body = {
      parentId: $('grp-create-parent').value ? Number($('grp-create-parent').value) : null,
      kind,
      name: $('grp-create-name').value.trim(),
      description: $('grp-create-desc').value.trim() || null,
      endsAt: kind === 'project' && $('grp-create-ends').value ? $('grp-create-ends').value : null,
    };
    if (!body.name) { setError('grp-create-error', T('error.groups.invalid_name')); return; }
    try {
      const res = await call('POST', '/api/v1/groups', body);
      closeDlg('grp-dlg-create');
      toast(T('grp.toast.created'));
      state.sel = res.group.id;
      writeUrl();
      await refreshAll();
    } catch (err) { setError('grp-create-error', errMsg(err)); }
  });

  // Edit (local: everything; directory / plugin: colour only)
  function openEdit() {
    const g = state.detail.group;
    const local = srcType(g.source) === 'local';
    $('grp-edit-name').value = g.name;
    $('grp-edit-desc').value = g.description || '';
    $('grp-edit-kind').value = g.kind;
    $('grp-edit-ends').value = g.endsAt || '';
    $('grp-edit-color').value = g.color || '#7aa2ff';
    $('grp-edit-color').dataset.reset = g.color ? '' : '1';
    parentOptions($('grp-edit-parent'), g.parentId, g.id, subtreeHeight(g.id));
    ['grp-edit-name', 'grp-edit-desc', 'grp-edit-kind', 'grp-edit-ends', 'grp-edit-parent'].forEach((id) => { $(id).disabled = !local; });
    syncEnds($('grp-edit-kind'), $('grp-edit-ends-field'));
    setError('grp-edit-error', '');
    openDlg('grp-dlg-edit');
  }
  $('grp-edit-kind').addEventListener('change', () => syncEnds($('grp-edit-kind'), $('grp-edit-ends-field')));
  $('grp-edit-color').addEventListener('input', () => { $('grp-edit-color').dataset.reset = ''; });
  $('grp-edit-color-reset').addEventListener('click', () => { $('grp-edit-color').dataset.reset = '1'; toast(T('grp.f.color_reset_done')); });
  $('grp-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = state.detail.group;
    const color = $('grp-edit-color').dataset.reset === '1' ? null : $('grp-edit-color').value;
    let body = { color };
    if (srcType(g.source) === 'local') {
      const kind = $('grp-edit-kind').value;
      body = {
        name: $('grp-edit-name').value.trim(),
        description: $('grp-edit-desc').value.trim() || null,
        kind,
        endsAt: kind === 'project' && $('grp-edit-ends').value ? $('grp-edit-ends').value : null,
        parentId: $('grp-edit-parent').value ? Number($('grp-edit-parent').value) : null,
        color,
      };
    }
    try {
      await call('PATCH', '/api/v1/groups/' + g.id, body);
      closeDlg('grp-dlg-edit');
      toast(T('grp.toast.saved'));
      await refreshAll();
    } catch (err) { setError('grp-edit-error', errMsg(err)); }
  });

  // Add member
  async function loadUsers() {
    if (state.users) return state.users;
    const res = await call('GET', '/api/v1/users');
    state.users = (res.users || []).map((u) => ({ id: u.id, name: u.display_name || u.username, username: u.username, email: u.email || '', enabled: u.enabled === 1 }));
    return state.users;
  }
  function fillUserPick() {
    const sel = clear($('grp-member-user'));
    const d = state.detail;
    const taken = new Set((d.members || []).filter((m) => m.direct).map((m) => m.userId));
    const q = $('grp-member-filter').value.trim().toLowerCase();
    (state.users || []).filter((u) => !taken.has(u.id))
      .filter((u) => !q || (u.name + ' ' + u.username + ' ' + u.email).toLowerCase().indexOf(q) >= 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((u) => sel.appendChild(el('option', { value: String(u.id) }, u.name + (u.email ? ' · ' + u.email : '') + (u.enabled ? '' : ' (' + T('grp.disabled') + ')'))));
    if (sel.options.length) sel.selectedIndex = 0;
  }
  async function openMember() {
    const d = state.detail;
    setError('grp-member-error', '');
    $('grp-member-filter').value = '';
    $('grp-member-note').hidden = srcType(d.group.source) !== 'directory';
    const role = clear($('grp-member-role'));
    (d.roles || []).forEach((r) => role.appendChild(el('option', { value: r }, roleLabel(r))));
    try { await loadUsers(); } catch (err) { setError('grp-member-error', errMsg(err)); }
    fillUserPick();
    openDlg('grp-dlg-member');
  }
  $('grp-member-filter').addEventListener('input', fillUserPick);
  $('grp-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const uid = Number($('grp-member-user').value);
    if (!uid) { setError('grp-member-error', T('grp.member.pick')); return; }
    try {
      await call('PUT', '/api/v1/groups/' + state.detail.group.id + '/members/' + uid, { role: $('grp-member-role').value });
      closeDlg('grp-dlg-member');
      toast(T('grp.toast.added'));
      await refreshAll();
    } catch (err) { setError('grp-member-error', errMsg(err)); }
  });

  // Invitation link
  function openInvite() {
    const d = state.detail;
    const role = clear($('grp-invite-role'));
    (d.roles || []).forEach((r) => role.appendChild(el('option', { value: r, selected: r === 'member' || r === 'child' }, roleLabel(r))));
    $('grp-invite-days').value = '7';
    $('grp-invite-uses').value = '1';
    $('grp-invite-result').hidden = true;
    $('grp-invite-opts').hidden = false;
    $('grp-invite-ok').hidden = false;
    $('grp-invite-close').textContent = T('common.cancel');
    setError('grp-invite-error', '');
    openDlg('grp-dlg-invite');
  }
  $('grp-invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await call('POST', '/api/v1/groups/' + state.detail.group.id + '/invites', {
        role: $('grp-invite-role').value, expiresInDays: Number($('grp-invite-days').value), maxUses: Number($('grp-invite-uses').value),
      });
      $('grp-invite-link').value = res.invite.url;
      $('grp-invite-valid').textContent = T('grp.inv.valid_until', { date: fmtDate(res.invite.expiresAt), count: res.invite.maxUses });
      $('grp-invite-result').hidden = false;
      $('grp-invite-opts').hidden = true;
      $('grp-invite-ok').hidden = true;
      $('grp-invite-close').textContent = T('common.close');
      loadDetail();
    } catch (err) { setError('grp-invite-error', errMsg(err)); }
  });
  $('grp-invite-copy').addEventListener('click', () => {
    const v = $('grp-invite-link').value;
    if (!v) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(() => toast(T('grp.toast.copied')), () => {});
    else { $('grp-invite-link').select(); }
  });

  // Delete (Loeschen.dc.html): usage listed, successor, name typed, archive
  // instead. The successor takes over what plugins keep for the group
  // (groupDeleting); preselected is the group's lead / deputy (walking up).
  let delSeq = 0;
  let people = null;
  async function loadPeople() {
    if (people) return people;
    try { people = ((await call('GET', '/api/v1/principals')).users || []).filter((u) => u && u.id); } catch (_) { people = []; }
    return people;
  }
  function fillSuccessor(def, list) {
    const sel = clear($('grp-del-successor'));
    if (def) {
      sel.appendChild(el('option', { value: String(def.userId) },
        T(def.inherited ? 'grp.del.successor_default_up' : 'grp.del.successor_default', { name: def.name, role: roleLabel(def.role) })));
    }
    sel.appendChild(el('option', { value: 'none' }, T('grp.del.successor_none')));
    const others = el('optgroup', null);
    others.label = T('grp.del.successor_others');
    list.forEach((u) => {
      if (def && Number(u.id) === Number(def.userId)) return;
      others.appendChild(el('option', { value: String(u.id) }, u.sub ? u.label + ' (' + u.sub + ')' : u.label));
    });
    if (others.children.length) sel.appendChild(others);
    sel.value = def ? String(def.userId) : 'none';
  }
  // A plugin text that continues the label ("wird in … verschoben") reads as
  // one sentence after it; a full sentence (core keys) gets its own line.
  function effectText(u) {
    const then = usageThen(u);
    if (then && !u.onDeleteKey && /^\p{Ll}/u.test(then)) return el('span', null, [el('b', null, u.label), ' ' + then]);
    return el('span', null, [el('b', null, u.label), then ? el('span', { class: 'us-effect-text' }, then) : null]);
  }
  async function loadEffects(g, successor) {
    const seq = ++delSeq;
    const list = $('grp-del-effects');
    try {
      const res = await call('GET', '/api/v1/groups/' + g.id + '/usage' + (successor ? '?successor=' + encodeURIComponent(successor) : ''));
      if (seq !== delSeq) return null;
      clear(list);
      const usage = res.usage || [];
      if (!usage.length) list.appendChild(el('li', { class: 'us-effect' }, el('span', null, T('grp.usage.none'))));
      usage.forEach((u) => list.appendChild(el('li', { class: 'us-effect grp-effect' }, [
        el('span', { class: 'grp-effect-kind' }, usageKind(u)),
        effectText(u),
      ])));
      return res;
    } catch (err) {
      if (seq === delSeq) clear(list).appendChild(el('li', { class: 'us-error' }, errMsg(err)));
      return null;
    }
  }
  async function openDelete() {
    const d = state.detail;
    const g = d.group;
    const direct = (d.members || []).filter((m) => m.direct).length;
    $('grp-del-title').textContent = T('grp.del.title', { name: g.name });
    $('grp-del-intro').textContent = direct ? P('grp.del.intro', direct) : T('grp.del.intro_none');
    const list = clear($('grp-del-effects'));
    list.appendChild(el('li', { class: 'us-muted' }, T('common.loading')));
    clear($('grp-del-successor'));
    $('grp-del-successor').disabled = true;
    $('grp-del-confirm').value = '';
    $('grp-del-ok').disabled = true;
    setError('grp-del-error', g.childIds && g.childIds.length ? T('error.groups.has_children') : '');
    openDlg('grp-dlg-delete');
    const [res, list2] = await Promise.all([loadEffects(g, null), loadPeople()]);
    if (!res) return; // no picker: the server's default (lead / deputy) applies
    fillSuccessor(res ? res.defaultSuccessor : null, list2);
    $('grp-del-successor').disabled = false;
  }
  $('grp-del-successor').addEventListener('change', () => {
    const g = state.detail && state.detail.group;
    if (g) loadEffects(g, $('grp-del-successor').value);
  });
  $('grp-del-confirm').addEventListener('input', () => {
    const g = state.detail && state.detail.group;
    $('grp-del-ok').disabled = !g || $('grp-del-confirm').value.trim() !== g.name || (g.childIds && g.childIds.length > 0);
  });
  $('grp-del-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = state.detail.group;
    if ($('grp-del-confirm').value.trim() !== g.name) return;
    try {
      const successor = $('grp-del-successor').value;
      await call('DELETE', '/api/v1/groups/' + g.id + '?confirm=' + encodeURIComponent($('grp-del-confirm').value.trim())
        + (successor ? '&successor=' + encodeURIComponent(successor) : ''));
      closeDlg('grp-dlg-delete');
      toast(T('grp.toast.deleted'));
      state.sel = g.parentId || null;
      writeUrl();
      await refreshAll();
    } catch (err) { setError('grp-del-error', errMsg(err)); }
  });
  $('grp-del-archive').addEventListener('click', async () => {
    const g = state.detail.group;
    try {
      await call('POST', '/api/v1/groups/' + g.id + '/archive');
      closeDlg('grp-dlg-delete');
      toast(T('grp.toast.archived'));
      await refreshAll();
    } catch (err) { setError('grp-del-error', errMsg(err)); }
  });

  // CSV import
  function openImport() {
    $('grp-import-text').value = '';
    $('grp-import-file').value = '';
    clear($('grp-import-result')).hidden = true;
    setError('grp-import-error', '');
    openDlg('grp-dlg-import');
  }
  $('grp-import-file').addEventListener('change', () => {
    const f = $('grp-import-file').files && $('grp-import-file').files[0];
    if (!f) return;
    if (f.size > 1024 * 1024) { setError('grp-import-error', T('grp.import.too_large')); return; }
    const r = new FileReader();
    r.onload = () => { $('grp-import-text').value = String(r.result || ''); };
    r.readAsText(f);
  });
  $('grp-import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('grp-import-text').value;
    if (!text.trim()) { setError('grp-import-error', T('error.groups.csv_required')); return; }
    setError('grp-import-error', '');
    try {
      const res = await call('POST', '/api/v1/groups/import', { csv: text });
      const box = clear($('grp-import-result'));
      box.hidden = false;
      box.appendChild(el('p', { class: 'grp-import-sum' }, T('grp.import.summary', { created: res.created.length, added: res.added, updated: res.updated, unchanged: res.unchanged })));
      if (res.errors.length) {
        const ul = el('ul', { class: 'grp-import-errors' });
        res.errors.forEach((x) => {
          const key = 'grp.import.err.' + x.code;
          const text = T(key) === key ? x.message : T(key);
          ul.appendChild(el('li', null, T('grp.import.line', { line: x.line }) + ': ' + text));
        });
        box.appendChild(el('p', { class: 'us-warnbox' }, P('grp.import.errors', res.errors.length)));
        box.appendChild(ul);
      }
      await loadGroups();
    } catch (err) { setError('grp-import-error', errMsg(err)); }
  });

  // ── Wiring ─────────────────────────────────────────────────────────
  $('grp-btn-add').addEventListener('click', () => openCreate(state.detail && caps(state.detail.group).sub ? state.detail.group.id : null));
  $('grp-btn-import').addEventListener('click', openImport);
  $('grp-search').addEventListener('input', () => { state.q = $('grp-search').value; renderTree(); });
  $('grp-show-archived').addEventListener('change', async () => {
    state.archived = $('grp-show-archived').checked;
    try { await loadGroups(); } catch (err) { toast(errMsg(err), 'error'); }
  });

  (async function init() {
    try { await loadGroups(); } catch (err) {
      clear($('grp-tree')).appendChild(el('li', { class: 'us-error', role: 'alert' }, errMsg(err)));
      return;
    }
    if (!state.sel && state.flat.length) state.sel = state.flat[0].id;
    if (state.sel) { writeUrl(); renderTree(); await loadDetail(); }
  })();
})();
