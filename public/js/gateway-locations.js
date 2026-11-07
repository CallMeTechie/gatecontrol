'use strict';

// Gateway-Standorte on the gateways page (docs/feature-gateway-locations.md):
// the dialog "Standorte" (list, create, edit, delete), the dialog "Standort
// von …" of a gateway (with "Auch für den Pool-Partner übernehmen"), the
// switch "Gruppieren nach: Standorte | Pools" and the sections per location
// of the fleet, the location tag of a card, the chip of the detail head and
// the row "Standort" of the card "Gerät & Software". gateways.js owns the
// views and the poll; this module renders into what it is given.
//
//   window.GCGatewayLocations.init({ fleet: () => gateways, pools: () => pools, changed: () => reload, redraw: () => draw fleet })
//   .load() → Promise<locations|null>   .list() / .count()
//   .mode() → 'locations' | 'pools'      .bar() → the switch (null without locations)
//   .sections(gateways, { card, online }) → the fleet by location
//   .cardTag(g) / .headChip(g) / .deviceRow(g, kvRow)
//   .openManage({ edit }) / .openChange(g)
//
// API: /api/v1/gateway-locations, PUT /api/v1/gateways/:id/location
// (src/routes/api/gatewayLocations.js). The choice of the switch is kept per
// browser (localStorage). Pure rules: gateway-location-kit.js. Every node is
// built with GCDialog.el and textContent.
(function () {
  const E = window.GCGatewayEdge;
  const K = window.GCGatewayLocationKit;
  const D = window.GCDialog;
  if (!E || !E.ui || !K || !D) return;
  const U = E.ui;
  const h = D.el;
  const t = U.t;
  const LANG = U.LANG;
  const API = '/api/v1/gateway-locations';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let locs = null;          // last GET (null = not loaded / failed)
  let fleet = () => [];
  let pools = () => [];
  let changed = () => {};
  let redraw = () => {};

  function init(o) {
    fleet = (o && o.fleet) || fleet;
    pools = (o && o.pools) || pools;
    changed = (o && o.changed) || changed;
    redraw = (o && o.redraw) || redraw;
  }
  function load() {
    return U.api('GET', API).then((j) => { locs = (j && j.locations) || []; return locs; }, (err) => {
      console.warn('[gateways] loading the locations failed', err);
      return locs;
    });
  }
  function list() { return locs || []; }
  function count() { return list().length; }
  function byId(id) { return list().find((l) => String(l.id) === String(id)) || null; }

  // ─── Icons ─────────────────────────────────────────────────────────────
  const IC = {
    pin: [['path', { d: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z' }], ['circle', { cx: 12, cy: 9.5, r: 2.5 }]],
    nopin: [['path', { d: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', 'stroke-dasharray': '3 3' }]],
    edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }]],
    trash: [['path', { d: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  };
  function svg(name, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 16)], ['height', String(size || 16)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']]
      .forEach((a) => s.setAttribute(a[0], a[1]));
    (IC[name] || []).forEach((p) => {
      const n = document.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach((k) => n.setAttribute(k, String(p[1][k])));
      s.appendChild(n);
    });
    return s;
  }

  function countText(n) { return n === 0 ? t('gwp.loc.count_none') : (n === 1 ? t('gwp.loc.count_one') : t('gwp.loc.count', { n })); }
  /** Address and country in one line ("Musterweg 12, 10115 Berlin · Deutschland"). */
  function fullAddress(l) {
    return [K.addressLine(l), l && l.country ? K.countryName(l.country, LANG) : ''].filter(Boolean).join(' · ');
  }
  function errMsg(e) {
    const b = (e && e.body) || {};
    return b.error || U.errText(e);
  }

  // ─── "Gruppieren nach" ─────────────────────────────────────────────────
  function stored() { try { return localStorage.getItem(K.MODE_KEY); } catch (e) { return null; } }
  function mode() { return K.mode(stored(), count()); }
  function setMode(m) {
    try { localStorage.setItem(K.MODE_KEY, m); } catch (e) { /* per browser only */ }
    redraw();
  }
  /** The switch above the fleet; null while there is no location. */
  function bar() {
    if (!count()) return null;
    const cur = mode();
    const seg = h('div', { class: 'gwe-seg', role: 'group', 'aria-label': t('gwp.loc.group_by') }, K.MODES.map((m) =>
      h('button', { type: 'button', class: 'gwe-seg-b', 'aria-pressed': m === cur ? 'true' : 'false', 'data-gwl-mode': m,
        text: t(m === 'locations' ? 'gwp.loc.by_locations' : 'gwp.loc.by_pools'),
        on: { click: () => { if (m !== mode()) setMode(m); } } })));
    return h('div', { class: 'gwl-bar' }, [h('span', { class: 'gwe-d', text: t('gwp.loc.group_by') }), seg]);
  }

  // ─── Fleet by location ─────────────────────────────────────────────────
  function sections(gateways, o) {
    return K.fleetSections(gateways, list()).map((s) => {
      const l = s.location;
      const hid = 'gwl-s-' + (l ? l.id : 'none');
      const online = s.gateways.filter((g) => o.online(g)).length;
      const head = h('div', { class: 'gwp-group-head' }, [
        h('span', { class: 'gwp-group-ic' }, [svg(l ? 'pin' : 'nopin', 20)]),
        h('h2', { id: hid, class: 'gwp-group-title', text: l ? l.name : t('gwp.loc.none') }),
        h('span', { class: 'gwl-addr', text: l ? K.addressLine(byId(l.id) || l) : t('gwp.loc.none_hint') }),
        h('span', { class: 'gwp-grow' }),
        h('span', { class: 'gwe-d', text: t('gwp.loc.online', { k: online, n: s.gateways.length }) }),
        l ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-gwl-edit': String(l.id), 'aria-label': t('gwp.loc.edit_named', { name: l.name }),
          text: t('gwp.loc.edit'), on: { click: (e) => { e.stopPropagation(); openManage({ edit: l.id }); } } }) : null,
      ]);
      return h('section', { class: 'gwp-group gwl-section' + (l ? '' : ' gwl-section-none'), 'aria-labelledby': hid, 'data-location': l ? String(l.id) : 'none' },
        [head, h('div', { class: 'grid gwp-grid' }, s.gateways.map((g) => o.card(g)))]);
    });
  }

  /** The location on a card of the pool view (only once there are locations). */
  function cardTag(g) {
    if (!count()) return null;
    const l = g && g.location;
    return h('span', { class: 'tag tag-grey gwl-tag', 'data-gwl-tag': l ? String(l.id) : 'none' }, [svg('pin', 12), l ? l.name : t('gwp.loc.none')]);
  }

  /** The chip of the detail head (only for a gateway with a location). */
  function headChip(g) {
    const l = g && g.location;
    if (!l) return null;
    return h('button', { type: 'button', class: 'tag tag-grey gwl-chip', 'data-act': 'location', 'data-id': String(g.peer_id), 'data-fk': 'gwl-chip',
      title: t('gwp.loc.chip_title') }, [svg('pin', 12), [l.name, l.city].filter(Boolean).join(' · ')]);
  }

  /** The row "Standort" of the card "Gerät & Software". */
  function deviceRow(g, kvRow) {
    const l = g && g.location ? (byId(g.location.id) || g.location) : null;
    const v = h('span', { class: 'gwl-dev' }, [
      l ? h('span', { text: [l.name, K.addressLine(l)].filter(Boolean).join(' · ') }) : h('span', { class: 'gwe-d', text: t('gwp.loc.none') }),
      ' ',
      h('button', { type: 'button', class: 'gwz-link', 'data-act': 'location', 'data-id': String(g.peer_id), 'data-fk': 'gwl-dev',
        text: t(l ? 'gwp.loc.change' : 'gwp.loc.set') }),
    ]);
    return kvRow(t('gwp.loc.row'), v);
  }

  // ─── The address form ──────────────────────────────────────────────────
  let formSeq = 0;
  function field(id, label, input, cls) {
    const err = h('span', { class: 'gwz-ferr', id: id + '-err' });
    err.hidden = true;
    input.id = id;
    input.setAttribute('aria-describedby', id + '-err');
    return { node: h('div', { class: 'gwz-field' + (cls ? ' ' + cls : '') }, [h('label', { for: id, text: label }), input, err]), input, err };
  }
  function countrySelect(value) {
    const sel = h('select', {}, [h('option', { value: '', text: t('gwp.loc.f.country_none') })]);
    K.countryOptions(LANG).forEach((c) => sel.appendChild(h('option', { value: c.code, text: c.name })));
    sel.value = value || '';
    return sel;
  }
  /** → { node, values(), errors(map), focus() } */
  function addressForm(loc, opts) {
    const p = 'gwl-f' + (++formSeq);
    const l = loc || {};
    const f = {
      name: field(p + '-name', t('gwp.loc.f.name'), h('input', { type: 'text', maxLength: K.LIMITS.name, autocomplete: 'off', value: l.name || '' })),
      street: field(p + '-street', t('gwp.loc.f.street'), h('input', { type: 'text', maxLength: K.LIMITS.street, autocomplete: 'off', value: l.street || '' })),
      postal_code: field(p + '-zip', t('gwp.loc.f.postal_code'), h('input', { type: 'text', maxLength: K.LIMITS.postal_code, autocomplete: 'off', value: l.postal_code || '' })),
      city: field(p + '-city', t('gwp.loc.f.city'), h('input', { type: 'text', maxLength: K.LIMITS.city, autocomplete: 'off', value: l.city || '' })),
      country: field(p + '-country', t('gwp.loc.f.country'), countrySelect(l.country)),
    };
    const node = h('div', { class: 'gwl-form', 'data-gwl-form': loc && loc.id ? String(loc.id) : 'new' }, [
      h('strong', { text: t(loc && loc.id ? 'gwp.loc.form_edit' : 'gwp.loc.form_new') }),
      h('div', { class: 'gwz-grid2' }, [f.name.node, f.street.node]),
      h('div', { class: 'gwl-grid3' }, [f.postal_code.node, f.city.node, f.country.node]),
      opts && opts.actions ? h('div', { class: 'gwl-actions' }, opts.actions) : null,
    ]);
    // map: field → error code (the form's own check) or, with `texts`, the server's translated message
    function errors(map, texts) {
      Object.keys(f).forEach((k) => {
        const code = map && map[k];
        f[k].err.textContent = code ? (texts ? String(code) : t('error.gateway_locations.' + code)) : '';
        f[k].err.hidden = !code;
        if (code) f[k].input.setAttribute('aria-invalid', 'true'); else f[k].input.removeAttribute('aria-invalid');
      });
      const first = Object.keys(f).find((k) => map && map[k]);
      if (first) f[first].input.focus();
      return !!first;
    }
    node.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') { e.target.removeAttribute('aria-invalid'); const er = document.getElementById(e.target.id + '-err'); if (er) er.hidden = true; } });
    return {
      node,
      values: () => K.body({ name: f.name.input.value, street: f.street.input.value, postal_code: f.postal_code.input.value, city: f.city.input.value, country: f.country.input.value }),
      errors,
      focus: () => f.name.input.focus(),
    };
  }
  /** Saves the form (POST or PUT) → the location, or null after showing the errors. */
  async function saveForm(form, loc, errBox) {
    const v = form.values();
    const bad = K.check(v);
    if (bad) { form.errors(bad); return null; }
    try {
      const r = loc && loc.id ? await U.api('PUT', API + '/' + encodeURIComponent(loc.id), v) : await U.api('POST', API, v);
      U.showErr(errBox, '');
      return r.location;
    } catch (e) {
      const b = (e && e.body) || {};
      if (b.fields && form.errors(b.fields, true)) { U.showErr(errBox, ''); return null; }
      U.showErr(errBox, errMsg(e));
      return null;
    }
  }

  // ─── Dialog "Standorte" ────────────────────────────────────────────────
  function openManage(opts) {
    const o = opts || {};
    const dlg = U.openDialog({ title: t('gwp.loc.title'), wide: true, cls: 'gwl-dlg' });
    dlg.box.setAttribute('data-gwl', 'manage');
    const listBox = h('div', { class: 'gwl-list' });
    const errBox = U.errorBox();
    let editing = o.edit != null ? String(o.edit) : null; // id | 'new' | null
    const newBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-gwl-new': '1' }, [svg('plus', 16), h('span', { text: t('gwp.loc.new') })]);
    newBtn.addEventListener('click', () => { editing = 'new'; draw(); });
    dlg.body.append(h('p', { class: 'gwe-d', text: t('gwp.loc.intro') }), listBox, errBox);
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.close'), on: { click: () => dlg.close(null) } }), newBtn);

    function formFor(loc) {
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('common.cancel') });
      const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-gwl-save': '1', text: t(loc ? 'gwp.loc.save' : 'gwp.loc.create') });
      const form = addressForm(loc, { actions: [cancel, save] });
      cancel.addEventListener('click', () => { editing = null; U.showErr(errBox, ''); draw(); });
      const doSave = async () => {
        save.disabled = true;
        const r = await saveForm(form, loc, errBox);
        save.disabled = false;
        if (!r) return;
        U.toast(loc ? t('gwp.loc.saved') : t('gwp.loc.created', { name: r.name }));
        editing = null;
        await load();
        draw();
        changed(true);
      };
      save.addEventListener('click', doSave);
      form.node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); doSave(); } });
      return form;
    }
    function row(l) {
      const edit = h('button', { type: 'button', class: 'icon-action', 'data-gwl-edit': String(l.id), title: t('gwp.loc.edit'), 'aria-label': t('gwp.loc.edit_named', { name: l.name }) }, [svg('edit', 15)]);
      const del = h('button', { type: 'button', class: 'icon-action danger', 'data-gwl-del': String(l.id), title: t('common.delete'), 'aria-label': t('gwp.loc.delete_named', { name: l.name }) }, [svg('trash', 15)]);
      edit.addEventListener('click', () => { editing = String(l.id); draw(); });
      del.addEventListener('click', () => remove(l));
      const addr = fullAddress(l);
      return h('div', { class: 'gwl-row', 'data-gwl-row': String(l.id) }, [
        h('span', { class: 'gwz-ic gwz-ic-teal', 'aria-hidden': 'true' }, [svg('pin', 18)]),
        h('span', { class: 'gwl-row-t' }, [h('strong', { text: l.name }), addr ? h('span', { class: 'gwe-d', text: addr }) : null]),
        h('span', { class: 'tag tag-grey', text: countText(l.gateway_count) }),
        edit, del,
      ]);
    }
    async function remove(l) {
      const names = (l.gateways || []).map((g) => g.name).join(', ');
      const n = l.gateway_count || 0;
      const ok = await D.confirm({
        title: t('gwp.loc.del_title', { name: l.name }),
        message: n === 0 ? t('gwp.loc.del_unused') : t(n === 1 ? 'gwp.loc.del_used_one' : 'gwp.loc.del_used', { n, names }),
        detail: n ? t('gwp.loc.del_detail') : null,
        okLabel: t('gwp.loc.del_ok'),
        danger: true,
      });
      if (!ok) return;
      try {
        await U.api('DELETE', API + '/' + encodeURIComponent(l.id));
        U.toast(t('gwp.loc.deleted', { name: l.name }));
        U.showErr(errBox, '');
        if (editing === String(l.id)) editing = null;
        await load();
        draw();
        changed(true);
      } catch (e) { U.showErr(errBox, errMsg(e)); }
    }
    let focusForm = null;
    function draw() {
      focusForm = null;
      const nodes = [];
      list().forEach((l) => {
        if (editing === String(l.id)) { const f = formFor(l); focusForm = f; nodes.push(f.node); } else nodes.push(row(l));
      });
      if (!list().length && editing !== 'new') {
        nodes.push(h('div', { class: 'gwl-empty' }, [
          h('span', { class: 'gwz-ic gwz-ic-teal', 'aria-hidden': 'true' }, [svg('pin', 18)]),
          h('strong', { text: t('gwp.loc.empty_title') }),
          h('span', { class: 'gwe-d', text: t('gwp.loc.empty_text') }),
        ]));
      }
      if (editing === 'new') { const f = formFor(null); focusForm = f; nodes.push(f.node); }
      listBox.replaceChildren(...nodes);
      newBtn.disabled = editing !== null;
      if (focusForm) setTimeout(() => focusForm.focus(), 0);
    }
    if (locs === null) load().then(draw); else draw();
    if (!focusForm) newBtn.focus();
    return dlg.promise;
  }

  // ─── Dialog "Standort von …" ───────────────────────────────────────────
  function openChange(g) {
    if (!g) return Promise.resolve(null);
    const dlg = U.openDialog({ title: t('gwp.loc.change_title', { name: g.name }), cls: 'gwl-dlg' });
    dlg.box.setAttribute('data-gwl', 'change');
    const cur = g.location ? String(g.location.id) : '';
    const name = 'gwl-pick-' + g.peer_id;
    const opts = h('div', { class: 'gwp-opts', role: 'radiogroup', 'aria-label': t('gwp.loc.row') });
    const errBox = U.errorBox();
    let form = null;
    function opt(value, title, sub) {
      const id = name + '-' + (value || 'none');
      const input = h('input', { type: 'radio', name, id, value });
      input.checked = value === cur;
      return h('label', { class: 'gwp-opt' + (input.checked ? ' gwp-opt-on' : ''), for: id }, [input,
        h('span', { class: 'gwp-opt-t' }, [h('strong', { text: title }), sub ? h('span', { class: 'gwe-d', text: ' · ' + sub }) : null])]);
    }
    function drawOpts() {
      opts.replaceChildren(...list().map((l) => opt(String(l.id), l.name, K.addressLine(l))), opt('', t('gwp.loc.none'), null));
    }
    opts.addEventListener('change', () => {
      opts.querySelectorAll('.gwp-opt').forEach((n) => n.classList.toggle('gwp-opt-on', n.querySelector('input').checked));
      if (form) { form.node.remove(); form = null; newLink.hidden = false; }
    });
    const newLink = h('button', { type: 'button', class: 'gwz-link gwl-newlink', 'data-gwl-newpick': '1' }, [svg('plus', 16), t('gwp.loc.new_more')]);
    newLink.addEventListener('click', () => {
      opts.querySelectorAll('input').forEach((i) => { i.checked = false; });
      opts.querySelectorAll('.gwp-opt').forEach((n) => n.classList.remove('gwp-opt-on'));
      form = addressForm(null, {});
      newLink.hidden = true;
      newLink.after(form.node);
      form.focus();
    });
    const pp = K.poolPartners(pools(), g.peer_id, fleet());
    let also = null;
    if (pp.partners.length) {
      also = h('input', { type: 'checkbox', 'data-gwl-also': '1' });
      // ticked when the partners stand where this gateway stands now (they move together)
      also.checked = pp.partners.every((p) => {
        const pg = fleet().find((x) => String(x.peer_id) === String(p.peer_id));
        return String((pg && pg.location && pg.location.id) || '') === cur;
      });
    }
    dlg.body.append(opts, newLink);
    if (also) {
      dlg.body.append(h('label', { class: 'gwe-check gwl-also' }, [also,
        h('span', { text: t('gwp.loc.also', { names: pp.partners.map((p) => p.name).join(', '), pool: pp.pool }) })]));
    }
    dlg.body.append(errBox);
    const save = h('button', { type: 'button', class: 'btn btn-primary', 'data-gwl-save': '1', text: t('common.save') });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), save);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        let target;
        if (form) {
          const loc = await saveForm(form, null, errBox);
          if (!loc) return;
          target = loc.id;
        } else {
          const sel = opts.querySelector('input:checked');
          target = sel && sel.value ? Number(sel.value) : null;
        }
        const body = { location_id: target };
        if (also && also.checked) body.also = pp.partners.map((p) => p.peer_id);
        await U.api('PUT', '/api/v1/gateways/' + encodeURIComponent(g.peer_id) + '/location', body);
        U.toast(t('gwp.loc.changed'));
        dlg.close(true);
        await load();
        changed(true);
      } catch (e) {
        U.showErr(errBox, errMsg(e));
      } finally { save.disabled = false; }
    });
    const ready = locs === null ? load() : Promise.resolve();
    ready.then(() => {
      drawOpts();
      const first = opts.querySelector('input:checked') || opts.querySelector('input');
      if (first) first.focus();
    });
    return dlg.promise;
  }

  // the button "Standorte" of the page head
  const btn = document.getElementById('btn-locations');
  if (btn) btn.addEventListener('click', () => openManage({}));

  window.GCGatewayLocations = {
    init, load, list, count, mode, bar, sections, cardTag, headChip, deviceRow, openManage, openChange,
  };
})();
