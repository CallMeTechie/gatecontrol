'use strict';

// Benutzer › Verzeichnis (/directory, docs/groups.md "Verzeichnis-Abgleich und
// Anmeldung"). Cards of the connected directories (state, where, counts, last
// run); the selected one below: actions (sync now, test, edit, delete), a
// stopped mass change with confirm / discard, the settings, the options
// (create accounts, disable, sign-in, interval, parent group), the group
// selection (search in the directory, checkboxes), conflicts (merge / keep
// separate) and the last runs with details. Strings: #dir-i18n (dir.*,
// error.directory.*, common.*). No innerHTML — every node is built with el().
(function () {
  const doc = document;
  const page = doc.getElementById('dir-page');
  if (!page) return;
  const D = window.GCDialog;

  function readJson(id) {
    try { return JSON.parse((doc.getElementById(id) || {}).textContent || '{}') || {}; } catch (_) { return {}; }
  }
  const I18N = readJson('dir-i18n');
  const CTX = readJson('dir-ctx');
  const LANG = CTX.lang || doc.documentElement.lang || 'de';

  function T(key, params) {
    let s = I18N[key];
    if (s == null && window.GC && window.GC.t) s = window.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }

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
      else if (/^(aria-[a-z]+|role|for|id|datetime|scope|placeholder|min|max)$/.test(k)) n.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.append(c instanceof window.Node ? c : String(c));
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function $(id) { return doc.getElementById(id); }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  function errMsg(err) { return (err && err.message) || T('common.error'); }
  function setError(id, msg) { const n = $(id); if (!n) return; n.textContent = msg || ''; n.hidden = !msg; }
  function fmtDateTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    try { return d.toLocaleString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }

  async function call(method, url, body) {
    const fn = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'del' }[method];
    const res = method === 'GET' || method === 'DELETE' ? await window.api[fn](url) : await window.api[fn](url, body || {});
    if (res && res.ok === false) throw new Error(res.error || T('common.error'));
    return res;
  }

  // ── Dialogs ────────────────────────────────────────────────────────
  doc.querySelectorAll('[data-dir-dialog]').forEach((ov) => {
    doc.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => { ov._down = e.target === ov; });
    ov.addEventListener('click', (e) => { if (e.target === ov && ov._down) window.closeModal(ov.id); });
  });
  function openDlg(id) {
    window.openModal(id);
    const first = $(id) && $(id).querySelector('[data-autofocus]');
    if (first) setTimeout(() => { try { first.focus(); } catch (_) { /* gone */ } }, 30);
  }

  // ── State ──────────────────────────────────────────────────────────
  const state = { list: [], selectedId: null, detail: null, runs: [], conflicts: [], localGroups: [], search: null, pickedGroups: null, poll: null };
  const qsId = Number(new URLSearchParams(window.location.search).get('id')) || null;

  function kindLabel(k) { return T('dir.kind.' + k); }
  function statusOf(d) {
    if (!d.enabled) return { text: T('dir.state.off'), tone: '' };
    if (d.pendingRun) return { text: T('dir.state.pending'), tone: 'us-chip-warn' };
    if (d.lastStatus === 'error') return { text: T('dir.state.error'), tone: 'us-chip-crit' };
    if (d.lastStatus === 'warning') return { text: T('dir.state.warning'), tone: 'us-chip-warn' };
    if (d.lastStatus === 'ok') return { text: T('dir.state.ok'), tone: 'us-chip-good' };
    return { text: T('dir.state.new'), tone: '' };
  }
  function whereOf(d) {
    const c = d.config || {};
    if (d.kind === 'entra') return T('dir.where.entra', { tenant: c.tenantId || '' });
    return (c.security === 'starttls' ? 'ldap+StartTLS://' : 'ldaps://') + (c.host || '') + ':' + (c.port || '');
  }
  function statsOf(d) {
    const s = d.stats || {};
    const parts = [T('dir.stats.accounts', { count: s.linked || 0 }), T('dir.stats.groups', { count: s.groups || 0 })];
    if (s.disabled) parts.push(T('dir.stats.disabled', { count: s.disabled }));
    if (d.loginEnabled) parts.push(d.kind === 'entra' ? T('dir.stats.login_microsoft') : T('dir.stats.login_password'));
    if (d.selfEnroll) parts.push(T('dir.stats.self_enroll'));
    return parts.join(' · ');
  }
  function lastOf(d) {
    return T('dir.last', { interval: d.intervalMin, when: d.lastSyncAt ? fmtDateTime(d.lastSyncAt) : T('dir.never') });
  }

  // ── Cards ──────────────────────────────────────────────────────────
  function renderCards() {
    const box = clear($('dir-cards'));
    if (!state.list.length) {
      box.appendChild(el('div', { class: 'dir-empty card' }, [
        el('p', null, T('dir.empty')),
        el('p', { class: 'us-muted' }, T('dir.empty_hint')),
      ]));
      return;
    }
    state.list.forEach((d) => {
      const st = statusOf(d);
      const card = el('button', {
        type: 'button', class: 'dir-card card' + (d.id === state.selectedId ? ' is-active' : ''), 'aria-pressed': d.id === state.selectedId ? 'true' : 'false',
        on: { click: () => select(d.id) },
      }, [
        el('span', { class: 'dir-card-head' }, [
          el('span', { class: 'dir-card-name' }, d.name),
          el('span', { class: 'us-chip ' + st.tone }, st.text),
        ]),
        el('span', { class: 'dir-card-kind' }, kindLabel(d.kind)),
        el('span', { class: 'dir-card-where us-mono' }, whereOf(d)),
        el('span', { class: 'dir-card-stats' }, statsOf(d)),
        el('span', { class: 'dir-card-last us-muted' }, lastOf(d)),
      ]);
      box.appendChild(card);
    });
  }

  async function loadList() {
    try {
      const res = await call('GET', '/api/v1/directories');
      state.list = res.directories || [];
    } catch (err) {
      clear($('dir-cards')).appendChild(el('p', { class: 'us-error' }, errMsg(err)));
      return;
    }
    if (state.selectedId && !state.list.some((d) => d.id === state.selectedId)) state.selectedId = null;
    if (!state.selectedId && state.list.length) state.selectedId = (qsId && state.list.some((d) => d.id === qsId)) ? qsId : state.list[0].id;
    renderCards();
    if (state.selectedId) await loadDetail();
    else $('dir-detail').hidden = true;
  }

  async function select(id) {
    state.selectedId = id;
    state.search = null;
    state.searchQ = '';
    state.pickedGroups = null;
    renderCards();
    await loadDetail();
  }

  async function loadDetail() {
    const id = state.selectedId;
    try {
      const [d, runs, conflicts] = await Promise.all([
        call('GET', '/api/v1/directories/' + id),
        call('GET', '/api/v1/directories/' + id + '/runs?limit=10'),
        call('GET', '/api/v1/directories/' + id + '/conflicts'),
      ]);
      if (id !== state.selectedId) return;
      state.detail = d.directory;
      state.running = !!d.running || !!runs.running;
      state.runs = runs.runs || [];
      state.conflicts = conflicts.conflicts || [];
      if (!state.pickedGroups) state.pickedGroups = (state.detail.selectedGroups || []).map((g) => Object.assign({}, g));
      const i = state.list.findIndex((x) => x.id === id);
      if (i >= 0) { state.list[i] = state.detail; renderCards(); }
      renderDetail();
      schedulePoll();
    } catch (err) {
      const box = clear($('dir-detail'));
      box.hidden = false;
      box.appendChild(el('p', { class: 'us-error' }, errMsg(err)));
    }
  }

  function schedulePoll() {
    if (state.poll) { clearTimeout(state.poll); state.poll = null; }
    if (state.running) state.poll = setTimeout(() => { state.poll = null; loadDetail(); }, 2500);
  }

  // ── Detail ─────────────────────────────────────────────────────────
  function section(title, extra, body) {
    return el('section', { class: 'grp-section dir-section' }, [
      el('h3', { class: 'grp-section-title' }, [title].concat(extra || [])),
    ].concat(body));
  }

  function switchRow(label, help, checked, onChange, opts) {
    const o = opts || {};
    const sw = el('button', { type: 'button', class: 'st-switch us-switch', role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': label, disabled: !!o.locked },
      el('span', { class: 'st-knob', 'aria-hidden': 'true' }));
    if (!o.locked) {
      sw.addEventListener('click', async () => {
        const want = sw.getAttribute('aria-checked') !== 'true';
        sw.disabled = true;
        try { await onChange(want); sw.setAttribute('aria-checked', want ? 'true' : 'false'); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
        sw.disabled = false;
      });
    }
    return el('div', { class: 'us-switchrow dir-opt' }, [
      el('div', { class: 'us-switchrow-text' }, [el('div', { class: 'dir-opt-name' }, label), el('div', { class: 'us-hint' }, help)]),
      sw,
    ]);
  }

  async function patch(fields, okMsg) {
    const res = await call('PATCH', '/api/v1/directories/' + state.detail.id, fields);
    state.detail = res.directory;
    if (okMsg) toast(okMsg);
    const i = state.list.findIndex((x) => x.id === state.detail.id);
    if (i >= 0) { state.list[i] = state.detail; renderCards(); }
    return res.directory;
  }

  function renderDetail() {
    const d = state.detail;
    const box = clear($('dir-detail'));
    box.hidden = false;
    const st = statusOf(d);

    // Head
    const syncBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: state.running, on: { click: syncNow } }, state.running ? T('dir.syncing') : T('dir.sync_now'));
    box.appendChild(el('div', { class: 'grp-head' }, [
      el('div', { class: 'grp-head-text' }, [
        el('div', { class: 'grp-crumbs' }, T('dir.crumb', { kind: kindLabel(d.kind) })),
        el('h2', { class: 'grp-title' }, d.name),
        el('div', { class: 'grp-chips' }, [el('span', { class: 'us-chip ' + st.tone }, st.text), el('span', { class: 'us-chip' }, whereOf(d))]),
      ]),
      el('div', { class: 'grp-head-actions' }, [
        syncBtn,
        el('button', { type: 'button', class: 'btn btn-ghost', on: { click: testStored } }, T('dir.test')),
        el('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => openForm(d) } }, T('common.edit')),
        el('button', { type: 'button', class: 'btn btn-ghost btn-danger', on: { click: openDelete } }, T('common.delete')),
      ]),
    ]));
    if (d.needsSecret) {
      box.appendChild(el('div', { class: 'grp-note grp-note-warn' }, T(d.kind === 'entra' ? 'dir.needs_secret_entra' : 'dir.needs_secret')));
    }
    if (d.lastStatus === 'error' && d.lastError) {
      box.appendChild(el('div', { class: 'grp-note grp-note-warn' }, T('dir.last_error', { error: d.lastError })));
    }

    // Pending mass change
    if (d.pendingRun) box.appendChild(pendingBox(d));

    // Settings (read-only facts; "Bearbeiten" changes them)
    const c = d.config || {};
    const facts = d.kind === 'entra' ? [
      [T('dir.f.tenant'), c.tenantId], [T('dir.f.client'), c.clientId], [T('dir.f.secret_entra'), d.secret || '—'],
      [T('dir.f.redirect'), d.redirectUri],
    ] : [
      [T('dir.f.server'), whereOf(d)], [T('dir.f.bind_dn'), c.bindDn], [T('dir.f.secret_ldap'), d.secret || '—'],
      [T('dir.f.user_base_dn'), c.userBaseDn || c.baseDn], [T('dir.f.group_base_dn'), c.groupBaseDn || c.baseDn],
      [T('dir.f.match'), d.kind === 'ad' ? T('dir.f.match_ad') : T('dir.f.match_ldap', { id: (c.attrs && c.attrs.id) || 'entryUUID', login: (c.attrs && c.attrs.login) || 'uid' })],
      c.caCert ? [T('dir.f.ca'), T('dir.f.ca_set')] : null,
    ];
    const dl = el('dl', { class: 'up-facts dir-facts' });
    facts.forEach((r) => { if (r) { dl.appendChild(el('dt', null, r[0])); dl.appendChild(el('dd', { class: 'us-mono' }, r[1] || '—')); } });
    box.appendChild(section(T('dir.settings'), null, [dl]));

    // Options
    const intervalSel = el('select', { class: 'form-input dir-interval', 'aria-label': T('dir.opt.interval') });
    [5, 10, 15, 30, 60, 120, 240, 720, 1440].concat([d.intervalMin]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).forEach((m) => {
      intervalSel.appendChild(el('option', { value: String(m), selected: m === d.intervalMin }, T('dir.opt.every', { minutes: m })));
    });
    intervalSel.addEventListener('change', async () => {
      try { await patch({ intervalMin: Number(intervalSel.value) }, T('dir.saved')); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    });
    const parentSel = el('select', { class: 'form-input', 'aria-label': T('dir.opt.parent') });
    parentSel.appendChild(el('option', { value: '' }, T('dir.opt.parent_none')));
    state.localGroups.forEach((g) => parentSel.appendChild(el('option', { value: String(g.id), selected: g.id === d.parentGroupId }, g.path)));
    parentSel.addEventListener('change', async () => {
      try { await patch({ parentGroupId: parentSel.value ? Number(parentSel.value) : null }, T('dir.saved')); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    });
    box.appendChild(section(T('dir.options'), null, [
      switchRow(T('dir.opt.enabled'), T('dir.opt.enabled_help'), d.enabled, (v) => patch({ enabled: v }, T('dir.saved'))),
      switchRow(T('dir.opt.provision'), T(d.loginEnabled ? 'dir.opt.provision_help_login' : 'dir.opt.provision_help'), d.provision, (v) => patch({ provision: v }, T('dir.saved'))),
      switchRow(T('dir.opt.deprovision'), T('dir.opt.deprovision_help'), d.deprovision, (v) => patch({ deprovision: v }, T('dir.saved'))),
      switchRow(d.kind === 'entra' ? T('dir.opt.login_entra') : (d.kind === 'ad' ? T('dir.opt.login_ad') : T('dir.opt.login_ldap')),
        d.kind === 'entra' ? T('dir.opt.login_entra_help') : T('dir.opt.login_help'), d.loginEnabled, async (v) => { await patch({ loginEnabled: v }, T('dir.saved')); renderDetail(); }),
      // Own devices for every account of this directory (users.mayEnroll; default off).
      switchRow(T('dir.opt.self_enroll'), T('dir.opt.self_enroll_help'), d.selfEnroll, (v) => patch({ selfEnroll: v }, T('dir.saved'))),
      switchRow(T('dir.opt.readonly'), T('dir.opt.readonly_help'), true, null, { locked: true }),
      el('div', { class: 'dir-opt-grid' }, [
        el('label', { class: 'us-field' }, [el('span', { class: 'us-label' }, T('dir.opt.interval')), intervalSel, el('span', { class: 'us-hint' }, T('dir.opt.interval_help'))]),
        el('label', { class: 'us-field' }, [el('span', { class: 'us-label' }, T('dir.opt.parent')), parentSel, el('span', { class: 'us-hint' }, T('dir.opt.parent_help'))]),
      ]),
    ]));

    // Groups
    box.appendChild(groupsSection(d));

    // Conflicts
    if (state.conflicts.length) box.appendChild(conflictsSection());

    // Runs
    box.appendChild(runsSection());
  }

  function pendingBox(d) {
    const p = d.pendingRun;
    const s = p.summary || {};
    const reasons = String(p.reason || '').split(',').filter(Boolean);
    const names = el('ul', { class: 'dir-names' }, el('li', { class: 'us-muted' }, T('common.loading')));
    call('GET', '/api/v1/directories/' + d.id + '/runs/' + p.id).then((res) => {
      clear(names);
      const list = (res.run && res.run.plan && res.run.plan.disableNames) || [];
      list.slice(0, 50).forEach((x) => names.appendChild(el('li', null, x.name + ' — ' + T('dir.why.' + x.why))));
      if (list.length > 50) names.appendChild(el('li', { class: 'us-muted' }, T('dir.more', { count: list.length - 50 })));
    }).catch(() => clear(names));
    return el('div', { class: 'dir-pending' }, [
      el('strong', null, T('dir.pending.title')),
      el('p', null, reasons.map((r) => T('dir.pending.' + r, { count: s.disable || 0, linked: s.linked || 0 })).join(' ')),
      names,
      el('div', { class: 'us-btnrow' }, [
        el('button', { type: 'button', class: 'btn btn-danger solid', on: { click: () => confirmPending(p.id) } }, T('dir.pending.confirm')),
        el('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => discardPending(p.id) } }, T('dir.pending.discard')),
      ]),
    ]);
  }

  async function confirmPending(runId) {
    const ok = await D.confirm({ title: T('dir.pending.confirm'), message: T('dir.pending.confirm_text'), danger: true, okLabel: T('dir.pending.confirm') });
    if (!ok) return;
    try {
      const res = await call('POST', '/api/v1/directories/' + state.detail.id + '/runs/' + runId + '/confirm');
      toast(res.run && res.run.status === 'pending' ? T('dir.pending.again') : T('dir.pending.done'), res.run && res.run.status === 'pending' ? 'warning' : 'success');
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    await loadDetail();
  }
  async function discardPending(runId) {
    try { await call('POST', '/api/v1/directories/' + state.detail.id + '/runs/' + runId + '/discard'); toast(T('dir.pending.discarded')); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    await loadDetail();
  }

  // ── Group selection ────────────────────────────────────────────────
  function groupsSection(d) {
    const picked = state.pickedGroups || [];
    const pickedSet = () => new Set(picked.map((g) => String(g.externalId).toLowerCase()));
    const chips = el('div', { class: 'dir-picked' });
    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true }, T('dir.groups.save'));
    function dirty() {
      const a = (d.selectedGroups || []).map((g) => String(g.externalId).toLowerCase()).sort().join('|');
      const b = picked.map((g) => String(g.externalId).toLowerCase()).sort().join('|');
      return a !== b;
    }
    function renderChips() {
      clear(chips);
      if (!picked.length) chips.appendChild(el('span', { class: 'us-muted' }, T('dir.groups.none')));
      picked.forEach((g, i) => {
        chips.appendChild(el('span', { class: 'us-chip us-chip-member dir-chip' }, [
          g.name,
          el('button', { type: 'button', class: 'dir-chip-x', 'aria-label': T('dir.groups.remove', { name: g.name }), on: { click: () => { picked.splice(i, 1); renderChips(); renderResults(); } } }, '×'),
        ]));
      });
      saveBtn.disabled = !dirty();
    }
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await patch({ selectedGroups: picked }, T('dir.groups.saved'));
        state.pickedGroups = (state.detail.selectedGroups || []).map((g) => Object.assign({}, g));
        renderDetail();
      } catch (err) { saveBtn.disabled = false; D.alert({ message: errMsg(err), danger: true }); }
    });

    // The value survives re-renders (the page refreshes while a sync runs).
    const input = el('input', { type: 'search', class: 'form-input', placeholder: T('dir.groups.search_ph'), 'aria-label': T('dir.groups.search'), value: state.searchQ || '' });
    const results = el('ul', { class: 'dir-results', 'aria-live': 'polite' });
    function renderResults() {
      clear(results);
      const s = state.search;
      if (!s) { results.appendChild(el('li', { class: 'us-muted' }, T('dir.groups.search_hint'))); return; }
      if (s.loading) { results.appendChild(el('li', { class: 'us-muted' }, T('common.loading'))); return; }
      if (s.error) { results.appendChild(el('li', { class: 'us-error' }, s.error)); return; }
      if (!s.groups.length) { results.appendChild(el('li', { class: 'us-muted' }, T('dir.groups.no_results'))); return; }
      const set = pickedSet();
      s.groups.forEach((g) => {
        const id = 'dir-g-' + String(g.externalId).replace(/[^A-Za-z0-9_-]/g, '');
        const cb = el('input', { type: 'checkbox', id, checked: set.has(String(g.externalId).toLowerCase()) });
        cb.addEventListener('change', () => {
          const key = String(g.externalId).toLowerCase();
          const idx = picked.findIndex((x) => String(x.externalId).toLowerCase() === key);
          if (cb.checked && idx < 0) picked.push({ externalId: g.externalId, name: g.name, dn: g.dn || null });
          if (!cb.checked && idx >= 0) picked.splice(idx, 1);
          renderChips();
        });
        results.appendChild(el('li', { class: 'dir-result' }, [
          cb,
          el('label', { for: id }, [el('span', { class: 'dir-result-name' }, g.name), g.dn ? el('span', { class: 'dir-result-dn us-mono' }, g.dn) : (g.description ? el('span', { class: 'dir-result-dn' }, g.description) : null)]),
        ]));
      });
    }
    let timer = null;
    async function search() {
      const q = input.value.trim();
      state.search = { loading: true, groups: [] };
      renderResults();
      try {
        const res = await window.api.get('/api/v1/directories/' + d.id + '/groups?q=' + encodeURIComponent(q));
        state.search = { groups: (res && res.groups) || [], error: res && res.ok === false ? (res.error || T('common.error')) : null };
      } catch (err) { state.search = { groups: [], error: errMsg(err) }; }
      renderResults();
    }
    input.addEventListener('input', () => { state.searchQ = input.value; clearTimeout(timer); timer = setTimeout(search, 350); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } });
    const browse = el('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => { clearTimeout(timer); search(); } } }, T('dir.groups.browse'));
    renderChips();
    renderResults();
    return section(T('dir.groups.title'), [el('span', { class: 'grp-section-count' }, String(picked.length))], [
      el('p', { class: 'us-hint' }, T('dir.groups.help')),
      chips,
      el('div', { class: 'dir-search' }, [input, browse]),
      results,
      el('div', { class: 'us-btnrow' }, [saveBtn]),
    ]);
  }

  // ── Conflicts ──────────────────────────────────────────────────────
  function conflictsSection() {
    const ul = el('ul', { class: 'dir-conflicts' });
    state.conflicts.forEach((c) => {
      const who = c.user ? (c.user.displayName || c.user.username) : '—';
      ul.appendChild(el('li', { class: 'dir-conflict' }, [
        el('div', { class: 'dir-conflict-text' }, [
          el('strong', null, c.email || c.loginName || c.externalId),
          el('span', { class: 'us-muted' }, T(c.user && c.user.role === 'admin' ? 'dir.conflict.text_admin' : 'dir.conflict.text', { name: c.displayName || c.loginName || '', account: who })),
        ]),
        el('div', { class: 'us-btnrow' }, [
          el('button', { type: 'button', class: 'btn btn-primary', disabled: !c.canMerge, title: c.canMerge ? null : T('dir.conflict.no_merge'), on: { click: () => resolve(c, 'merge') } }, T('dir.conflict.merge')),
          el('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => resolve(c, 'separate') } }, T('dir.conflict.separate')),
        ]),
      ]));
    });
    return section(T('dir.conflict.title'), [el('span', { class: 'grp-section-count' }, String(state.conflicts.length))], [
      el('p', { class: 'us-hint' }, T('dir.conflict.help')), ul,
    ]);
  }
  async function resolve(c, action) {
    if (action === 'merge') {
      const ok = await D.confirm({ title: T('dir.conflict.merge'), message: T('dir.conflict.merge_text', { email: c.email || '', account: c.user ? c.user.username : '' }), okLabel: T('dir.conflict.merge') });
      if (!ok) return;
    }
    try {
      await call('POST', '/api/v1/directories/' + state.detail.id + '/conflicts/' + c.id + '/' + action);
      toast(action === 'merge' ? T('dir.conflict.merged') : T('dir.conflict.separated'));
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    await loadDetail();
  }

  // ── Runs ───────────────────────────────────────────────────────────
  function runLine(r) {
    const s = r.summary || {};
    if (r.status === 'error') return T('dir.run.line_error', { error: r.error || '' });
    if (r.status === 'pending' || r.status === 'superseded' || r.status === 'discarded') return T('dir.run.line_' + r.status, { count: s.disable || 0 });
    if (r.status === 'running') return T('dir.syncing');
    return T('dir.run.line_ok', { created: s.created || 0, disabled: s.disabled || 0, enabled: s.enabled || 0, groups: s.groupChanges || 0, conflicts: s.conflicts || 0 });
  }
  function runTone(r) {
    return { ok: 'us-dot-good', confirmed: 'us-dot-good', error: 'us-dot-crit', pending: 'us-dot-warn', running: 'us-dot-accent' }[r.status] || 'us-dot-off';
  }
  function runsSection() {
    const ol = el('ol', { class: 'us-log dir-runs' });
    if (!state.runs.length) ol.appendChild(el('li', { class: 'us-muted' }, T('dir.run.none')));
    state.runs.forEach((r) => {
      ol.appendChild(el('li', { class: 'us-log-item' }, [
        el('span', { class: 'us-dot ' + runTone(r), 'aria-hidden': 'true' }),
        el('span', { class: 'us-log-text' }, [
          el('strong', null, T('dir.run.status.' + r.status)), ' · ', runLine(r),
          r.status === 'ok' || r.status === 'confirmed' ? el('button', { type: 'button', class: 'btn btn-ghost dir-run-more', on: { click: () => showRun(r.id) } }, T('dir.run.details')) : null,
        ]),
        el('time', { class: 'us-muted', datetime: r.startedAt }, fmtDateTime(r.startedAt)),
      ]));
    });
    return section(T('dir.run.last'), null, [ol]);
  }

  async function showRun(runId) {
    const body = clear($('dir-run-body'));
    body.appendChild(el('p', { class: 'us-muted' }, T('common.loading')));
    openDlg('dir-dlg-run');
    try {
      const res = await call('GET', '/api/v1/directories/' + state.detail.id + '/runs/' + runId);
      const r = res.run;
      const x = r.details || {};
      clear(body);
      body.appendChild(el('p', { class: 'us-muted' }, fmtDateTime(r.startedAt) + ' · ' + T('dir.run.trigger.' + r.trigger)));
      const block = (title, items, fmt) => {
        if (!items || !items.length) return;
        body.appendChild(el('h3', { class: 'dir-run-h' }, title + ' · ' + items.length));
        const ul = el('ul', { class: 'dir-names' });
        items.slice(0, 200).forEach((i) => ul.appendChild(el('li', null, fmt(i))));
        body.appendChild(ul);
      };
      block(T('dir.run.created'), x.created, (i) => i.name + (i.username ? ' (@' + i.username + ')' : '') + (i.invited ? ' · ' + T('dir.run.invited') : ''));
      block(T('dir.run.disabled'), x.disabled, (i) => i.name + ' — ' + T('dir.why.' + i.why) + (i.peers ? ' · ' + T('dir.run.peers', { count: i.peers }) : ''));
      block(T('dir.run.enabled'), x.enabled, (i) => i.name);
      block(T('dir.run.updated'), x.updated, (i) => i.name);
      block(T('dir.run.group_changes'), x.groupChanges, (i) => i.group + ': ' + [i.added.length ? '+ ' + i.added.join(', ') : '', i.removed.length ? '− ' + i.removed.join(', ') : ''].filter(Boolean).join(' · '));
      block(T('dir.run.groups_created'), x.groupsCreated, (i) => i);
      block(T('dir.run.groups_archived'), x.groupsArchived, (i) => i);
      block(T('dir.run.conflicts'), x.conflicts, (i) => T('dir.run.conflict_line', { email: i.email || '', account: i.username || '' }));
      block(T('dir.run.skipped'), x.skipped, (i) => i.name + ' — ' + T('dir.skip.' + i.why));
      block(T('dir.run.admins_kept'), x.adminsKept, (i) => i.name);
      block(T('dir.run.warnings'), x.warnings, (i) => T('dir.warn.' + i.code, { name: i.name || '' }));
      block(T('dir.run.errors'), x.errors, (i) => (i.name ? i.name + ': ' : '') + (i.message || i.code));
      if (body.children.length === 1) body.appendChild(el('p', null, T('dir.run.nothing')));
    } catch (err) {
      clear(body).appendChild(el('p', { class: 'us-error' }, errMsg(err)));
    }
  }

  async function syncNow() {
    try {
      await call('POST', '/api/v1/directories/' + state.detail.id + '/sync');
      state.running = true;
      toast(T('dir.sync_started'));
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    await loadDetail();
  }

  function testResultText(res) {
    const r = res.result || {};
    const det = r.details || {};
    return T('dir.test_ok') + (det.sampleGroups != null ? ' · ' + T('dir.test_groups', { count: det.sampleGroups }) : '');
  }

  async function testStored() {
    try {
      const res = await window.api.post('/api/v1/directories/' + state.detail.id + '/test', {});
      if (res && res.ok) D.alert({ title: T('dir.test'), message: testResultText(res) });
      else D.alert({ title: T('dir.test'), message: (res && res.error) + (res && res.detail ? ' (' + res.detail + ')' : ''), danger: true });
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  // ── Create / edit form ─────────────────────────────────────────────
  let editing = null;
  const F = (id) => $('dir-f-' + id);
  function showKind(kind) {
    doc.querySelectorAll('#dir-form [data-kinds]').forEach((fs) => { fs.hidden = fs.getAttribute('data-kinds').split(' ').indexOf(kind) < 0; });
    $('dir-f-secret-label').textContent = kind === 'entra' ? T('dir.f.secret_entra') : T('dir.f.secret_ldap');
    if (!editing) {
      F('port').placeholder = F('security').value === 'starttls' ? '389' : '636';
    }
  }
  function openForm(d) {
    editing = d || null;
    $('dir-form').reset();
    setError('dir-form-error', '');
    $('dir-form-test').hidden = true;
    $('dir-form-title').textContent = d ? T('dir.form.title_edit') : T('dir.form.title_new');
    $('dir-f-kind-field').hidden = !!d;
    F('kind').value = d ? d.kind : 'ad';
    F('name').value = d ? d.name : '';
    const c = (d && d.config) || {};
    const a = c.attrs || {};
    F('host').value = c.host || '';
    F('security').value = c.security || 'ldaps';
    F('port').value = c.port || '';
    F('bind-dn').value = c.bindDn || '';
    F('base-dn').value = c.baseDn || '';
    F('user-base').value = c.userBaseDn || '';
    F('group-base').value = c.groupBaseDn || '';
    F('tls-name').value = c.tlsServerName || '';
    F('ca').value = c.caCert || '';
    F('attr-id').value = a.id || '';
    F('attr-login').value = a.login || '';
    F('attr-email').value = a.email || '';
    F('attr-name').value = a.name || '';
    F('attr-group-id').value = a.groupId || '';
    F('attr-group-name').value = a.groupName || '';
    F('attr-member').value = a.member || 'member';
    F('attr-disabled').value = a.disabled || '';
    F('user-filter').value = c.userFilter || '';
    F('group-filter').value = c.groupFilter || '';
    F('tenant').value = c.tenantId || '';
    F('client').value = c.clientId || '';
    F('secret').value = '';
    $('dir-f-secret-hint').hidden = !(d && d.hasSecret);
    const redirect = $('dir-f-redirect');
    redirect.hidden = !(d && d.redirectUri);
    redirect.textContent = d && d.redirectUri ? T('dir.f.redirect_hint', { uri: d.redirectUri }) : '';
    showKind(F('kind').value);
    openDlg('dir-dlg-form');
  }
  function formBody() {
    const kind = editing ? editing.kind : F('kind').value;
    let config;
    if (kind === 'entra') config = { tenantId: F('tenant').value.trim(), clientId: F('client').value.trim() };
    else {
      config = {
        host: F('host').value.trim(), security: F('security').value, port: F('port').value ? Number(F('port').value) : '',
        bindDn: F('bind-dn').value.trim(), baseDn: F('base-dn').value.trim(), userBaseDn: F('user-base').value.trim(),
        groupBaseDn: F('group-base').value.trim(), tlsServerName: F('tls-name').value.trim(), caCert: F('ca').value.trim(),
      };
      if (kind === 'ldap') {
        config.attrs = {
          id: F('attr-id').value.trim() || 'entryUUID', login: F('attr-login').value.trim() || 'uid', email: F('attr-email').value.trim() || 'mail',
          name: F('attr-name').value.trim() || 'displayName', groupId: F('attr-group-id').value.trim() || 'entryUUID',
          groupName: F('attr-group-name').value.trim() || 'cn', member: F('attr-member').value, disabled: F('attr-disabled').value.trim(),
        };
        config.userFilter = F('user-filter').value.trim();
        config.groupFilter = F('group-filter').value.trim();
      }
    }
    const body = { kind, name: F('name').value.trim(), config };
    if (F('secret').value) body.secret = F('secret').value;
    return body;
  }
  F('kind').addEventListener('change', () => showKind(F('kind').value));
  F('security').addEventListener('change', () => { F('port').placeholder = F('security').value === 'starttls' ? '389' : '636'; });
  $('dir-form-test-btn').addEventListener('click', async () => {
    const out = $('dir-form-test');
    out.hidden = false;
    out.className = 'dir-test-result';
    out.textContent = T('dir.testing');
    try {
      const b = formBody();
      if (editing) b.id = editing.id;
      const res = await window.api.post('/api/v1/directories/test', b);
      if (res && res.ok) { out.className = 'dir-test-result is-ok'; out.textContent = testResultText(res); }
      else { out.className = 'dir-test-result is-bad'; out.textContent = (res && res.error ? res.error : T('common.error')) + (res && res.detail ? ' (' + res.detail + ')' : ''); }
    } catch (err) { out.className = 'dir-test-result is-bad'; out.textContent = errMsg(err); }
  });
  $('dir-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('dir-form-error', '');
    const btn = $('dir-form-ok');
    btn.disabled = true;
    try {
      const b = formBody();
      let res;
      if (editing) {
        delete b.kind;
        res = await call('PATCH', '/api/v1/directories/' + editing.id, b);
      } else {
        res = await call('POST', '/api/v1/directories', b);
      }
      window.closeModal('dir-dlg-form');
      toast(T('dir.saved'));
      state.selectedId = res.directory.id;
      state.pickedGroups = null;
      await loadList();
    } catch (err) {
      setError('dir-form-error', errMsg(err));
    } finally { btn.disabled = false; }
  });
  $('dir-btn-add').addEventListener('click', () => openForm(null));

  // ── Delete ─────────────────────────────────────────────────────────
  function openDelete() {
    const d = state.detail;
    $('dir-del-label').textContent = T('dir.del.confirm_label', { name: d.name });
    $('dir-del-confirm').value = '';
    $('dir-del-ok').disabled = true;
    setError('dir-del-error', '');
    openDlg('dir-dlg-delete');
  }
  $('dir-del-confirm').addEventListener('input', () => { $('dir-del-ok').disabled = $('dir-del-confirm').value.trim() !== (state.detail && state.detail.name); });
  $('dir-del-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call('DELETE', '/api/v1/directories/' + state.detail.id + '?confirm=' + encodeURIComponent($('dir-del-confirm').value.trim()));
      window.closeModal('dir-dlg-delete');
      toast(T('dir.del.done'));
      state.selectedId = null;
      state.pickedGroups = null;
      await loadList();
    } catch (err) { setError('dir-del-error', errMsg(err)); }
  });

  // ── Start ──────────────────────────────────────────────────────────
  (async function init() {
    try {
      const res = await call('GET', '/api/v1/groups');
      state.localGroups = (res.groups || []).filter((g) => g.source === 'local' && g.kind !== 'family' && !g.archived && g.depth < 3);
    } catch (_) { state.localGroups = []; }
    await loadList();
  })();
})();
