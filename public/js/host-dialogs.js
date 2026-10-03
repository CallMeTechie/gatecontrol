'use strict';

// "Host bearbeiten" and "Neuer Host" of the zones page
// (docs/feature-domain-zones.md, "Seite und Dialoge"). Loaded after
// domain-modal.js (GCZonesUI kit) and before zones-page.js.
//
//   window.GCHostDialogs.openHost(hostId)        edit a host and its entries
//   window.GCHostDialogs.openNewHost(domainId)   create a host (several entries)
//   window.GCHostDialogs.refresh()               page data changed (GET /zones)
//
// Both dialogs save explicitly. "Host bearbeiten" collects the changes and
// then calls PUT /api/v1/hosts/:id and PUT /api/routes/:id per entry (gateway
// targets get target_port AND target_lan_port); adding and deleting an entry
// act at once (own confirmation). "Neuer Host" posts every entry in one
// POST /api/v1/domains/:id/hosts (the server creates them in one go and rolls
// back on failure). DOM via el() only — never innerHTML.
(function () {
  const V = window.GCZonesView;
  const UI = window.GCZonesUI;
  if (!V || !UI) return;
  const { t, el, icon } = UI;
  const GC = window.GC || {};
  GC.features = GC.features || {};

  function ctx() { return UI.ctx ? UI.ctx() : { getData: () => null, reload: () => Promise.resolve() }; }

  function pageZones() { return V.pageZones(ctx().getData() || {}); }
  function findHost(hostId) {
    const id = Number(hostId);
    for (const z of pageZones()) {
      const h = (z.hosts || []).find((x) => x.id === id);
      if (h) return { host: h, zone: z };
    }
    return null;
  }
  function zoneById(domainId) {
    return pageZones().find((z) => z.domain_id === Number(domainId)) || null;
  }
  function peerZone(zone) { return !!(zone && zone.gateway && zone.gateway.kind === 'peer'); }
  function l4Allowed(zone) {
    if (GC.features.l4_routes === 0) return false;
    if (zone && zone.gateway && (zone.gateway.kind === 'gateway' || zone.gateway.kind === 'pool') && GC.features.gateway_tcp_routing === false) return false;
    return true;
  }
  function blockedPorts() {
    const root = document.getElementById('zn-zones');
    return String((root && root.dataset.l4Blocked) || '').split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
  }
  function typeLabel(kind) { return kind === 'http' ? 'HTTPS' : String(kind || '').toUpperCase(); }
  function suffixOf(host, zone) {
    if (!zone || zone.unassigned || !zone.domain) return '';
    return '.' + zone.domain;
  }
  // Server error → text: the contract codes the dialogs know, else the message.
  const ERR_KEYS = {
    HOST_EXISTS: 'host.err_exists', HOST_HAS_HTTP: 'entry.err_http_taken', TYPE_DOMAIN_REQUIRED: 'entry.err_no_domain',
    TYPE_LISTEN_PORT_REQUIRED: 'entry.err_listen_port', LAN_HOST_REQUIRED: 'host.err_lan_required',
    DOMAIN_CONFLICT: 'host.err_domain_conflict', DOMAIN_UNVERIFIED: 'host.err_domain_unverified', LABEL_INVALID: 'entry.err_label',
  };
  function serverText(err) {
    const code = err && err.data && err.data.code;
    if (code && ERR_KEYS[code] && GC.t && GC.t[ERR_KEYS[code]]) return t(ERR_KEYS[code]);
    return UI.errMsg(err);
  }
  function statusTag(host, zone) {
    const h = V.hostHealth(host);
    const cls = h === 'ok' ? 'rt-tag-green' : h === 'disabled' ? 'rt-tag-grey' : h === 'down' ? 'rt-tag-red' : 'rt-tag-amber';
    return el('span', { class: 'rt-tag ' + cls, text: UI.hostStatusText(host, zone) });
  }
  function noteTag(n) {
    let text;
    if (n.id === 'name') return null;
    if (n.id === 'port_label') text = n.value;
    else if (n.id === 'waf') text = t(n.value === 'block' ? 'waf.chip_block' : 'waf.chip_detect');
    else if (n.id === 'backend_https') text = 'Backend HTTPS';
    else if (n.id === 'tls_sni') text = 'TLS-SNI';
    else if (n.id === 'hsts') text = 'HSTS';
    else text = t('zones.note_' + n.id);
    return el('span', { class: 'rt-note', text });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Host bearbeiten
  // ════════════════════════════════════════════════════════════════════════
  let hs = null;

  function openHost(hostId) {
    const found = findHost(hostId);
    if (!found) { UI.toastError(t('host.gone')); return; }
    if (hs) hs.dlg.close(null);
    const dlg = UI.bigDialog({
      title: t('host.edit_title'), icon: 'rdp', kind: 'host-edit', className: 'rt-dlg-host',
      beforeClose: () => {
        const n = hs ? currentPlan().count : 0;
        return n ? UI.confirmDiscard(n) : Promise.resolve(true);
      },
    });
    hs = {
      hostId: found.host.id, dlg, hd: V.hostDraft(found.host), drafts: {}, bases: {}, editing: new Set(),
      adding: null, hostError: null, entryErrors: {}, saving: false, notice: null,
    };
    hs.hdBase = JSON.stringify(hs.hd);
    dlg.promise.then(() => { if (hs && hs.dlg === dlg) hs = null; });
    renderHost();
    const first = dlg.body.querySelector('input');
    if (first) first.focus();
  }

  function current() { return hs ? findHost(hs.hostId) : null; }
  function currentPlan() {
    const f = current();
    if (!f) return { count: 0, entries: [], host: null };
    return V.hostSavePlan(f.host, f.zone, hs.hd, hs.drafts);
  }
  // Drafts start as a copy of the entry; bases remember that copy so a
  // refresh can tell untouched drafts (follow the new data) from edits.
  function draftOf(e) {
    if (!hs.drafts[e.id]) {
      hs.drafts[e.id] = V.entryDraft(e);
      hs.bases[e.id] = JSON.stringify(hs.drafts[e.id]);
    }
    return hs.drafts[e.id];
  }

  function renderHost(opts) {
    if (!hs) return;
    const f = current();
    if (!f) { hs.dlg.close(null); UI.toastError(t('host.gone')); return; }
    const { host, zone } = f;
    const dlg = hs.dlg;
    const scroll = dlg.body.scrollTop;
    const act = document.activeElement;
    const focusKey = act && dlg.box.contains(act) && act.dataset ? act.dataset.rtKey : null;
    const caret = focusKey && typeof act.selectionStart === 'number' ? act.selectionStart : null;

    dlg.sub.replaceChildren(
      el('span', { class: 'rt-mono rt-strong', text: host.fqdn || V.hostLabel(host) }),
      zone && !zone.unassigned ? el('span', { class: 'rt-sub-sep', text: '·' }) : null,
      zone && !zone.unassigned ? el('span', { text: t('host.via_target', { target: UI.targetText(host.gateway_override ? host.target : zone.gateway) }) }) : null,
      statusTag(host, zone),
    );

    const nodes = [];
    if (hs.notice) nodes.push(hs.notice);
    nodes.push(hostSection(host, zone));
    const actions = hostActions(host, zone);
    if (actions) nodes.push(actions);
    nodes.push(entriesSection(host, zone));
    dlg.body.replaceChildren(...nodes);
    dlg.body.scrollTop = scroll;
    renderHostFoot(host, zone);

    if (focusKey) {
      const n = dlg.box.querySelector('[data-rt-key="' + focusKey + '"]');
      if (n) {
        n.focus();
        if (caret != null && typeof n.setSelectionRange === 'function') { try { n.setSelectionRange(caret, caret); } catch (_) { /* number input */ } }
      }
    }
    if (opts && opts.focus) {
      const n = dlg.box.querySelector(opts.focus);
      if (n) { n.focus(); if (n.scrollIntoView) n.scrollIntoView({ block: 'nearest' }); }
    }
  }

  function syncFootOnly() {
    const f = current();
    if (f) renderHostFoot(f.host, f.zone);
  }

  function hostSection(host, zone) {
    const hd = hs.hd;
    const err = hs.hostError;
    const fields = [];
    if (zone && !zone.unassigned) {
      const sub = el('input', { type: 'text', class: 'rt-input rt-mono', value: hd.subdomain, maxLength: 190, autocomplete: 'off', spellcheck: 'false', dataset: { rtKey: 'h-sub' }, 'aria-describedby': null });
      sub.addEventListener('input', () => { hd.subdomain = sub.value; hs.hostError = null; syncFootOnly(); });
      fields.push(UI.field(t('host.subdomain'), sub, {
        wrap: el('div', { class: 'rt-affix' }, [sub, el('span', { class: 'rt-affix-sfx', text: suffixOf(host, zone) })]),
        hint: err && err.field === 'subdomain' ? err.text : t('host.subdomain_hint'), hintClass: err && err.field === 'subdomain' ? 'rt-err' : null,
      }));
    } else {
      const ro = el('div', { class: 'rt-readonly rt-mono', text: host.fqdn || host.name || '—' });
      fields.push(el('div', { class: 'rt-field' }, [el('div', { class: 'rt-label', text: t('host.address') }), ro]));
    }
    const desc = el('input', { type: 'text', class: 'rt-input', value: hd.description, maxLength: 200, placeholder: t('host.description_ph'), dataset: { rtKey: 'h-desc' } });
    desc.addEventListener('input', () => { hd.description = desc.value; syncFootOnly(); });
    fields.push(UI.field(t('host.description'), desc, {
      hint: err && err.field === 'description' ? err.text : null, hintClass: 'rt-err',
    }));
    if (host.lan_host != null) {
      const lan = el('input', { type: 'text', class: 'rt-input rt-mono', value: hd.lan, maxLength: 253, autocomplete: 'off', spellcheck: 'false', placeholder: t('host.lan_ph'), dataset: { rtKey: 'h-lan' } });
      lan.addEventListener('input', () => { hd.lan = lan.value; hs.hostError = null; syncFootOnly(); });
      fields.push(UI.field(t('host.lan_host'), lan, {
        hint: err && err.field === 'lan' ? err.text : t('host.lan_applies_all'), hintClass: err && err.field === 'lan' ? 'rt-err' : null,
      }));
    } else {
      const g = host.target || (zone && zone.gateway) || {};
      fields.push(el('div', { class: 'rt-field' }, [
        el('div', { class: 'rt-label', text: t('host.target') }),
        el('div', { class: 'rt-readonly' }, [icon(UI.gatewayIconName(g.kind), 14), ' ', UI.targetText(g), g.ip ? el('span', { class: 'rt-mono rt-muted', text: ' · ' + g.ip }) : null]),
        el('div', { class: 'rt-hint', text: t('host.target_peer_hint') }),
      ]));
    }
    const head = el('div', { class: 'rt-sec-head' }, [
      el('h3', { class: 'rt-sec-title', id: 'rt-he-s1', text: t('host.section_host') }),
      host.template ? el('span', { class: 'rt-tag rt-tag-blue', text: t('host.template_badge', { name: t('template.' + host.template) }) }) : null,
      window.GCSecOptUI ? window.GCSecOptUI.aliasTags(host) : null,
    ]);
    return el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-he-s1' }, [
      head,
      el('div', { class: 'rt-grid3' }, fields),
      err && !err.field ? el('div', { class: 'rt-err rt-err-box', role: 'alert', text: err.text }) : null,
    ]);
  }

  // Existing host actions: aliases, open, scan-to-folder, gateway reset, template info.
  function hostActions(host, zone) {
    const items = [];
    const SO = window.GCSecOptUI;
    if (SO && zone && !zone.unassigned) {
      const mi = SO.aliasMenuItem(host, zone, { onChanged: (res) => { const n = SO.pausedNotice(res); if (n && window.GCTlsUI) hs.notice = window.GCTlsUI.noticeEl(Object.assign({}, n, { onClose: () => { hs.notice = null; } })); ctx().reload(); } });
      if (mi) items.push(el('button', { type: 'button', class: 'btn btn-secondary rt-btn rt-btn-sm', disabled: !!mi.disabled, title: mi.hint || null, on: { click: () => mi.onClick() } }, [icon('link', 14), mi.label]));
    }
    const httpEntry = (host.entries || []).find((e) => !V.isL4(e) && e.enabled);
    if (httpEntry && host.fqdn) {
      items.push(el('a', { class: 'btn btn-secondary rt-btn rt-btn-sm', href: 'https://' + host.fqdn, target: '_blank', rel: 'noopener' }, [icon('ext', 14), t('host.open')]));
    }
    if (host.template === 'printer') {
      const canScan = GC.features.gateway_scan_egress === true;
      items.push(el('button', {
        type: 'button', class: 'btn btn-secondary rt-btn rt-btn-sm', disabled: !canScan || peerZone(zone),
        title: canScan ? null : t('host.scan_locked'), on: { click: () => openScanDialog(host, zone) },
      }, [icon('folder', 14), t('host.scan_setup'), canScan ? null : UI.proChip()]));
    }
    if (host.gateway_override && zone && !zone.unassigned) {
      items.push(el('button', { type: 'button', class: 'btn btn-secondary rt-btn rt-btn-sm', on: { click: (e) => clearOverride(host, zone, e.currentTarget) } }, [icon('refresh', 14), t('host.override_clear')]));
    }
    if (!items.length && !host.gateway_override) return null;
    return el('div', { class: 'rt-host-actions-bar', role: 'group', 'aria-label': t('host.actions') }, [
      host.gateway_override ? el('span', { class: 'rt-tag rt-tag-amber', title: t('host.override_hint'), text: t('host.override_tag') }) : null,
      items,
    ]);
  }

  function entriesSection(host, zone) {
    const addBtn = el('button', {
      type: 'button', class: 'btn rt-btn rt-btn-teal rt-add-entry', 'aria-expanded': hs.adding ? 'true' : 'false',
      on: { click: () => { startAdd(host, zone); } },
    }, [icon('plus', 15), t('entry.add')]);
    const list = el('ul', { class: 'rt-erows' }, V.sortEntries(host.entries).map((e) => entryRow(e, host, zone)));
    return el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-he-s2' }, [
      el('div', { class: 'rt-sec-head rt-sec-head-split' }, [
        el('div', { class: 'rt-sec-head-text' }, [
          el('h3', { class: 'rt-sec-title', id: 'rt-he-s2', text: t('entry.section') }),
          el('p', { class: 'rt-sec-hint', text: t('entry.section_hint') }),
        ]),
        addBtn,
      ]),
      hs.adding ? addForm(host, zone) : null,
      host.entries && host.entries.length ? list : el('p', { class: 'rt-empty', text: t('entry.none') }),
    ]);
  }

  function entryRow(e, host, zone) {
    if (e.rdp_owned) {
      const line = V.entryLine(e);
      return el('li', { class: 'rt-erow rt-erow-rdp', dataset: { entryId: String(e.id) } }, [
        el('div', { class: 'rt-erow-main' }, [
          UI.typeChip(line.type),
          el('div', { class: 'rt-erow-path' }, [
            el('span', { class: 'rt-mono rt-muted', text: line.from }), el('span', { class: 'rt-arrow', 'aria-hidden': 'true' }, [icon('arrow', 15)]),
            el('span', { class: 'rt-mono', text: line.to }),
            el('span', { class: 'rt-note rt-note-purple', text: t('entry.rdp_tag') }),
          ]),
          el('div', { class: 'rt-erow-tools' }, [
            el('a', { href: '/rdp', class: 'btn btn-secondary rt-btn rt-btn-sm', title: t('entry.rdp_hint') }, [icon('rdp', 14), t('entry.rdp_link')]),
          ]),
        ]),
      ]);
    }
    const d = draftOf(e);
    const changes = V.draftChanges(e, d);
    const editing = hs.editing.has(e.id);
    const errInfo = hs.entryErrors[e.id];
    const kind = d.type;
    const lan = V.entryTargetHost(e) || '?';
    const fromText = kind === 'http' ? (e.https_enabled || V.isL4(e) ? '443' : '80') : ':' + (d.outer || '?');
    const name = d.name.trim();
    const editBtn = el('button', {
      type: 'button', class: 'btn btn-secondary rt-btn rt-btn-sm rt-edit-toggle', 'aria-expanded': editing ? 'true' : 'false',
      on: { click: () => { if (editing) hs.editing.delete(e.id); else hs.editing.add(e.id); renderHost({ focus: editing ? null : '[data-rt-key="e' + e.id + '-port"]' }); } },
    }, [icon('pencil', 14), editing ? t('entry.edit_done') : t('entry.edit')]);
    const optBtn = el('button', {
      type: 'button', class: 'btn btn-secondary rt-btn rt-btn-sm rt-options', disabled: changes.length > 0,
      title: changes.length ? t('entry.options_save_first') : null,
      on: { click: () => openOptions(e, host, zone) },
    }, [icon('sliders', 14), t('entry.options')]);
    const sw = UI.switchEl(d.enabled, t('entry.active_label', { entry: name || (typeLabel(kind) + ' ' + fromText) }), (next) => {
      d.enabled = next; syncFootOnly(); renderRowState(e.id); return true;
    });
    const del = UI.ibtn('trash', t('entry.delete_named', { entry: name || (typeLabel(kind) + ' ' + fromText) }), (btn) => deleteEntry(e, host, zone, btn), 'rt-ibtn-danger');
    const notes = V.entryNotes(e).map(noteTag).filter(Boolean);

    const main = el('div', { class: 'rt-erow-main' }, [
      UI.typeChip(typeLabel(kind)),
      el('div', { class: 'rt-erow-path' }, [
        el('span', { class: 'rt-mono rt-muted', text: fromText }),
        el('span', { class: 'rt-arrow', 'aria-hidden': 'true' }, [icon('arrow', 15)]),
        el('span', { class: 'rt-mono', text: lan + ' : ' + (d.port || '?') }),
        name ? el('span', { class: 'rt-erow-name', text: '· ' + name }) : null,
        UI.accessTag(e.external_enabled ? 'external' : 'internal'),
        notes,
        window.GCSecOptUI ? window.GCSecOptUI.entryTags(e) : null,
        window.GCTlsUI ? window.GCTlsUI.entryTag(e, { onChanged: () => ctx().reload() }) : null,
        changes.length && !editing ? el('span', { class: 'rt-note rt-note-teal', text: t('entry.changed') }) : null,
      ]),
      el('div', { class: 'rt-erow-tools' }, [editBtn, optBtn, sw, del]),
    ]);
    const row = el('li', { class: 'rt-erow' + (editing ? ' editing' : '') + (d.enabled ? '' : ' off'), dataset: { entryId: String(e.id) } }, [main]);
    if (editing) row.appendChild(entryEditor(e, d, host, zone, changes));
    if (errInfo) row.appendChild(errorRow(errInfo, () => {
      if (errInfo.conflict && errInfo.conflict.suggestedPort) { d.outer = String(errInfo.conflict.suggestedPort); delete hs.entryErrors[e.id]; renderHost(); }
    }));
    return row;
  }

  // Only the switch / "geändert" state of a row changed — no full rebuild needed.
  function renderRowState(id) {
    const row = hs.dlg.body.querySelector('.rt-erow[data-entry-id="' + id + '"]');
    const d = hs.drafts[id];
    if (row && d) row.classList.toggle('off', !d.enabled);
  }

  function entryEditor(e, d, host, zone, changes) {
    const otherHttp = (host.entries || []).some((x) => x.id !== e.id && !x.rdp_owned && (hs.drafts[x.id] ? hs.drafts[x.id].type : V.entryKind(x)) === 'http');
    const typeSel = el('select', { class: 'rt-select', dataset: { rtKey: 'e' + e.id + '-type' } }, [
      el('option', { value: 'http', text: 'HTTPS', disabled: otherHttp && d.type !== 'http' }),
      el('option', { value: 'tcp', text: 'TCP', disabled: !l4Allowed(zone) && d.type !== 'tcp' }),
      el('option', { value: 'udp', text: 'UDP', disabled: !l4Allowed(zone) && d.type !== 'udp' }),
    ]);
    typeSel.value = d.type;
    typeSel.addEventListener('change', () => {
      const prev = d.type;
      d.type = typeSel.value;
      if (d.type !== 'http' && prev === 'http' && !d.outer) d.outer = '';
      delete hs.entryErrors[e.id];
      renderHost();
    });
    const outer = el('input', {
      type: 'text', inputmode: 'numeric', class: 'rt-input rt-mono', maxLength: 11, value: d.type === 'http' ? '443' : d.outer,
      disabled: d.type === 'http', placeholder: t('entry.listen_port_ph'), dataset: { rtKey: 'e' + e.id + '-outer' },
    });
    outer.addEventListener('input', () => { d.outer = outer.value.trim(); delete hs.entryErrors[e.id]; refreshChangeHint(e); });
    const port = el('input', { type: 'text', inputmode: 'numeric', class: 'rt-input rt-mono rt-input-accent', maxLength: 5, value: d.port, dataset: { rtKey: 'e' + e.id + '-port' } });
    port.addEventListener('input', () => { d.port = port.value.trim(); delete hs.entryErrors[e.id]; refreshChangeHint(e); });
    const nm = el('input', { type: 'text', class: 'rt-input', maxLength: 64, value: d.name, placeholder: t('entry.label_placeholder'), dataset: { rtKey: 'e' + e.id + '-name' } });
    nm.addEventListener('input', () => { d.name = nm.value; refreshChangeHint(e); });
    const blocked = blockedPorts();
    const outerHint = d.type === 'http' ? t('entry.outer_https_hint') : (blocked.length ? t('entry.outer_hint_reserved', { ports: blocked.join(', ') }) : t('entry.outer_hint'));
    return el('div', { class: 'rt-erow-edit' }, [
      el('div', { class: 'rt-grid4' }, [
        UI.field(t('entry.col_type'), typeSel),
        UI.field(t('entry.listen_port'), outer, { hint: outerHint }),
        UI.field(t('entry.target_port'), port, { hint: '1–65535' }),
        UI.field(t('entry.label_field'), nm),
      ]),
      el('div', { class: 'rt-change', role: 'status', 'aria-live': 'polite', dataset: { changeFor: String(e.id) } }, changeHint(changes)),
    ]);
  }
  function changeHint(changes) {
    const shown = changes.filter((c) => c.field !== 'enabled');
    if (!shown.length) return [];
    const fmt = (c) => {
      if (c.field === 'type') return t('entry.change_type', { from: typeLabel(c.from), to: typeLabel(c.to) });
      if (c.field === 'outer') return t('entry.change_outer', { from: c.from || '—', to: c.to || '—' });
      if (c.field === 'port') return t('entry.change_port', { from: c.from || '—', to: c.to || '—' });
      return t('entry.change_name', { from: c.from || '—', to: c.to || '—' });
    };
    return [icon('info', 14), el('span', { text: shown.map(fmt).join(' · ') + ' · ' + t('entry.change_on_save') })];
  }
  function refreshChangeHint(e) {
    const box = hs.dlg.body.querySelector('[data-change-for="' + e.id + '"]');
    if (box) box.replaceChildren(...changeHint(V.draftChanges(e, hs.drafts[e.id])));
    syncFootOnly();
  }
  function errorRow(info, onUse) {
    return el('div', { class: 'rt-err rt-err-row', role: 'alert' }, [
      icon('alert', 14), el('span', { text: info.text }),
      info.conflict && info.conflict.suggestedPort
        ? el('button', { type: 'button', class: 'btn btn-secondary rt-btn rt-btn-sm', text: t('entry.use_port', { port: info.conflict.suggestedPort }), on: { click: onUse } })
        : null,
    ]);
  }

  // ── Add an entry (immediately, POST /hosts/:id/entries) ──
  function startAdd(host, zone) {
    if (hs.adding) { hs.adding = null; renderHost(); return; }
    const hasHttp = (host.entries || []).some((x) => !V.isL4(x));
    hs.adding = { type: hasHttp && l4Allowed(zone) ? 'tcp' : (hasHttp ? 'tcp' : 'http'), outer: '', port: '', backend: false, error: null, conflict: null };
    renderHost({ focus: '[data-rt-key="add-port"]' });
  }
  function addForm(host, zone) {
    const a = hs.adding;
    const hasHttp = (host.entries || []).some((x) => !V.isL4(x));
    const typeSel = el('select', { class: 'rt-select', dataset: { rtKey: 'add-type' } }, [
      el('option', { value: 'http', text: 'HTTPS', disabled: hasHttp }),
      el('option', { value: 'tcp', text: 'TCP', disabled: !l4Allowed(zone) }),
      el('option', { value: 'udp', text: 'UDP', disabled: !l4Allowed(zone) }),
    ]);
    typeSel.value = a.type;
    typeSel.addEventListener('change', () => { a.type = typeSel.value; a.error = null; a.conflict = null; renderHost(); });
    const outer = el('input', { type: 'text', inputmode: 'numeric', class: 'rt-input rt-mono', maxLength: 11, value: a.type === 'http' ? '443' : a.outer, disabled: a.type === 'http', placeholder: t('entry.listen_port_ph'), dataset: { rtKey: 'add-outer' } });
    outer.addEventListener('input', () => { a.outer = outer.value.trim(); a.conflict = null; });
    const port = el('input', { type: 'text', inputmode: 'numeric', class: 'rt-input rt-mono', maxLength: 5, value: a.port, placeholder: t('entry.target_port_ph'), dataset: { rtKey: 'add-port' } });
    port.addEventListener('input', () => { a.port = port.value.trim(); });
    const submit = el('button', { type: 'button', class: 'btn btn-primary rt-btn', text: t('entry.add_submit'), on: { click: (ev) => submitAdd(host, zone, ev.currentTarget) } });
    const form = el('div', { class: 'rt-addform', on: { keydown: (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); submit.click(); } } } }, [
      el('div', { class: 'rt-addform-title', text: t('entry.new') }),
      el('div', { class: 'rt-grid4 rt-grid-end' }, [
        UI.field(t('entry.col_type'), typeSel),
        UI.field(t('entry.listen_port'), outer),
        UI.field(t('entry.target_port'), port),
        el('div', { class: 'rt-addform-actions' }, [
          el('button', { type: 'button', class: 'btn btn-ghost rt-btn', text: t('common.cancel'), on: { click: () => { hs.adding = null; renderHost(); } } }),
          submit,
        ]),
      ]),
      a.type === 'http' ? el('label', { class: 'rt-check' }, [
        el('input', { type: 'checkbox', checked: a.backend, on: { change: (ev) => { a.backend = ev.target.checked; } } }),
        t('entry.backend_https'),
      ]) : null,
      a.error || a.conflict ? errorRow({ text: a.error || t('entry.port_conflict', { port: a.conflict.port }), conflict: a.conflict }, () => {
        a.outer = String(a.conflict.suggestedPort); a.conflict = null; renderHost(); submitAdd(host, zone, null);
      }) : null,
    ]);
    return form;
  }
  async function submitAdd(host, zone, btn) {
    const a = hs.adding;
    if (!a) return;
    if (!V.validPort(a.port, false)) { a.error = t('entry.err_target_port'); renderHost(); return; }
    const body = { type: a.type, target_port: parseInt(a.port, 10) };
    if (a.type === 'http') body.backend_https = !!a.backend;
    else {
      if (!V.validPort(a.outer, true)) { a.error = t('entry.err_listen_port'); renderHost(); return; }
      body.listen_port = /^\d+$/.test(a.outer) ? parseInt(a.outer, 10) : a.outer;
    }
    UI.busy(btn, true);
    try {
      const res = await UI.call(api.post('/api/v1/hosts/' + host.id + '/entries', body));
      hs.adding = null;
      UI.toastOk(t('entry.created', { host: host.fqdn || V.hostLabel(host) }));
      const TG = window.GCTlsUI;
      const tls = TG && TG.tlsFromResponse(res);
      if (tls && tls.state === 'paused') hs.notice = TG.noticeEl({ host: host.fqdn, tls, reason: TG.pausedReason(tls), onClose: () => { hs.notice = null; } });
      await ctx().reload();
    } catch (err) {
      if (!hs || !hs.adding) return;
      const c = UI.portConflict(err);
      if (c) { a.conflict = c; a.error = null; } else { a.error = serverText(err); }
      renderHost();
    } finally { UI.busy(btn, false); }
  }

  // ── Delete (immediately, with confirmation) ──
  async function deleteEntry(e, host, zone, btn) {
    const line = V.entryLine(e);
    const last = (host.entries || []).filter((x) => !x.rdp_owned).length <= 1;
    const ok = await UI.confirm({
      title: t('entry.delete'),
      message: t('entry.confirm_delete', { entry: line.type + ' ' + line.from + ' → ' + line.to, host: host.fqdn || V.hostLabel(host) }),
      detail: last ? t('entry.confirm_delete_last') : null,
      okLabel: t('common.delete'), danger: true,
    });
    if (!ok) return;
    UI.busy(btn, true);
    try {
      await UI.call(api.del('/api/routes/' + e.id));
      if (hs) { delete hs.drafts[e.id]; hs.editing.delete(e.id); delete hs.entryErrors[e.id]; }
      UI.toastOk(t('entry.deleted'));
      if (last && hs) { hs.drafts = {}; hs.dlg.close(true); }
      await ctx().reload();
    } catch (err) { UI.toastError(err); } finally { UI.busy(btn, false); }
  }

  async function deleteHost(host, zone) {
    const n = (host.entries || []).filter((e) => !e.rdp_owned).length;
    const rdp = (host.entries || []).some((e) => e.rdp_owned);
    const fqdn = host.fqdn || V.hostLabel(host);
    const ok = await UI.confirm({
      title: t('host.delete'), message: t('host.confirm_delete', { host: fqdn, count: n }),
      detail: rdp ? t('host.confirm_delete_rdp') : null, okLabel: t('common.delete'), danger: true,
    });
    if (!ok) return false;
    try {
      await UI.call(api.del('/api/v1/hosts/' + host.id));
      UI.toastOk(t('host.deleted', { host: fqdn }));
      if (hs && hs.hostId === host.id) { hs.drafts = {}; hs.hd = V.hostDraft(host); hs.dlg.close(true); }
      await ctx().reload();
      return true;
    } catch (err) { UI.toastError(err); return false; }
  }

  async function clearOverride(host, zone, btn) {
    const ok = await UI.confirm({
      title: t('host.override_clear'),
      message: t('host.override_confirm', { host: host.fqdn || V.hostLabel(host), target: UI.gatewayLabel(zone.gateway) }),
      okLabel: t('host.override_clear_ok'),
    });
    if (!ok) return;
    UI.busy(btn, true);
    try {
      await UI.call(api.put('/api/v1/hosts/' + host.id + '/gateway-override', { override: false }));
      UI.toastOk(t('host.override_cleared', { host: host.fqdn || V.hostLabel(host) }));
      await ctx().reload();
    } catch (err) { UI.toastError(err); } finally { UI.busy(btn, false); }
  }

  // Full editor ("Optionen") — reloads the page data on save.
  function openOptions(e, host, zone, extra) {
    const ed = window.GCEntryEditor;
    if (!ed || typeof ed.open !== 'function') { UI.toastError(t('entry.editor_missing')); return; }
    try {
      ed.open(e.id, Object.assign({
        context: { host, zone },
        onSaved: () => { ctx().reload(); },
        onChanged: () => { ctx().reload(); },
        onDeleted: () => { ctx().reload(); },
      }, extra || {}));
    } catch (err) { UI.toastError(err); }
  }

  function renderHostFoot(host, zone) {
    const plan = V.hostSavePlan(host, zone, hs.hd, hs.drafts);
    const note = el('span', { class: 'rt-dlg-note' + (plan.count ? ' rt-dirty' : ''), 'aria-live': 'polite', text: plan.count ? t(plan.count === 1 ? 'zones.dirty_one' : 'zones.dirty', { count: plan.count }) : t('zones.no_changes') });
    const del = host.id != null
      ? el('button', { type: 'button', class: 'btn btn-danger rt-btn rt-btn-danger', on: { click: () => deleteHost(host, zone) } }, [icon('trash', 15), t('host.delete')])
      : null;
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost rt-btn', text: t('common.cancel'), on: { click: () => hs.dlg.requestClose() } });
    const save = el('button', { type: 'button', class: 'btn btn-primary rt-btn rt-he-save', text: t('common.save'), disabled: !plan.count || hs.saving, on: { click: (ev) => saveHost(ev.currentTarget) } });
    hs.dlg.foot.replaceChildren(...[del, note, cancel, save].filter(Boolean));
  }

  const HOST_ERR_FIELD = { subdomain: 'subdomain', lan: 'lan' };
  async function saveHost(btn) {
    if (!hs || hs.saving) return;
    const f = current();
    if (!f) return;
    const { host, zone } = f;
    const plan = V.hostSavePlan(host, zone, hs.hd, hs.drafts);
    hs.hostError = null;
    hs.entryErrors = {};
    if (plan.error) {
      if (plan.error.scope === 'host') {
        hs.hostError = { field: HOST_ERR_FIELD[plan.error.code] || null, text: t(plan.error.code === 'lan' ? 'host.err_lan_required' : 'host.err_subdomain') };
      } else {
        const key = { port: 'entry.err_target_port', outer: 'entry.err_listen_port', http_taken: 'entry.err_http_taken', no_domain: 'entry.err_no_domain' }[plan.error.code];
        hs.entryErrors[plan.error.id] = { text: t(key || 'zones.error_generic') };
        hs.editing.add(plan.error.id);
      }
      renderHost();
      return;
    }
    if (!plan.count) return;
    hs.saving = true;
    UI.busy(btn, true);
    let failed = false;
    try {
      if (plan.host) {
        try {
          const res = await UI.call(api.put('/api/v1/hosts/' + host.id, plan.host));
          const SO = window.GCSecOptUI;
          const n = SO && SO.pausedNotice(res);
          if (n && window.GCTlsUI) hs.notice = window.GCTlsUI.noticeEl(Object.assign({}, n, { onClose: () => { if (hs) hs.notice = null; } }));
          // The host fields now match the saved values.
          hs.hdSaved = true;
        } catch (err) {
          failed = true;
          const code = err && err.data && err.data.code;
          const field = plan.host.subdomain !== undefined && /subdomain|HOST_EXISTS|DOMAIN/i.test(String(code || err.message)) ? 'subdomain'
            : plan.host.lan_host !== undefined && /lan/i.test(String(code || err.message)) ? 'lan' : null;
          hs.hostError = { field, text: serverText(err) };
        }
      }
      if (!failed) {
        for (const it of plan.entries) {
          try {
            await UI.call(api.put('/api/routes/' + it.id, it.patch));
            delete hs.drafts[it.id];
            hs.editing.delete(it.id);
          } catch (err) {
            failed = true;
            hs.entryErrors[it.id] = { text: serverText(err), conflict: UI.portConflict(err) };
            hs.editing.add(it.id);
            break;
          }
        }
      }
    } finally {
      if (hs) hs.saving = false;
      UI.busy(btn, false);
    }
    await ctx().reload();
    if (!hs) return;
    // Host fields that were saved are the new baseline.
    const fresh = current();
    if (fresh && plan.host && !hs.hostError) { hs.hd = V.hostDraft(fresh.host); hs.hdBase = JSON.stringify(hs.hd); }
    if (!failed) {
      UI.toastOk(t('host.saved_all', { host: (fresh && fresh.host.fqdn) || host.fqdn || V.hostLabel(host) }));
      hs.drafts = {};
      hs.dlg.close(true);
      return;
    }
    renderHost();
    const errNode = hs.dlg.body.querySelector('.rt-err');
    if (errNode && errNode.scrollIntoView) errNode.scrollIntoView({ block: 'nearest' });
  }

  // ── Scan-to-folder (printer hosts) ──
  function openScanDialog(host, zone) {
    const data = ctx().getData() || {};
    const gateways = (data.gateways || []).map((g) => ({ id: g.peer_id != null ? g.peer_id : g.id, name: g.name || g.hostname || ('#' + (g.peer_id != null ? g.peer_id : g.id)) }));
    const smb = V.smbEntries(zone);
    const st = { vip: '', mode: smb.length ? 'existing' : 'new', routeId: smb.length ? smb[0].id : null, nasIp: '', nasGw: zone.gateway && zone.gateway.kind === 'gateway' ? zone.gateway.peer_id : (gateways[0] && gateways[0].id) };
    const d = UI.dialog({ title: t('host.scan_title'), wide: false });
    const err = el('div', { class: 'zn-field-error', role: 'alert' });
    err.hidden = true;
    const vip = el('input', { type: 'text', class: 'form-input zn-input zn-mono', placeholder: '192.168.1.250', 'aria-label': t('host.scan_vip') });
    vip.addEventListener('input', () => { st.vip = vip.value.trim(); });
    const radio = (value, label, disabled) => {
      const r = el('input', { type: 'radio', name: 'zn-scan-mode', value, checked: st.mode === value, disabled: !!disabled });
      r.addEventListener('change', () => { if (r.checked) { st.mode = value; sync(); } });
      return el('label', { class: 'zn-radio' }, [r, label]);
    };
    const exSel = el('select', { class: 'form-select zn-select', 'aria-label': t('host.scan_target_existing') },
      smb.map((s) => el('option', { value: String(s.id), text: (s.host.fqdn || V.hostLabel(s.host)) + ' · TCP ' + s.entry.l4_listen_port + ' → 445' })));
    exSel.addEventListener('change', () => { st.routeId = parseInt(exSel.value, 10); });
    const exWrap = el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_target_existing') }), exSel]);
    const nasIp = el('input', { type: 'text', class: 'form-input zn-input zn-mono', placeholder: '192.168.1.10', 'aria-label': t('host.scan_nas_ip') });
    nasIp.addEventListener('input', () => { st.nasIp = nasIp.value.trim(); });
    const gwSel = el('select', { class: 'form-select zn-select', 'aria-label': t('host.scan_nas_gateway') }, gateways.map((g) => el('option', { value: String(g.id), text: g.name })));
    if (st.nasGw != null) gwSel.value = String(st.nasGw);
    gwSel.addEventListener('change', () => { st.nasGw = parseInt(gwSel.value, 10); });
    const newWrap = el('div', {}, [
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_nas_ip') }), nasIp]),
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_nas_gateway') }), gwSel]),
    ]);
    function sync() { exWrap.hidden = st.mode !== 'existing'; newWrap.hidden = st.mode !== 'new'; }
    d.body.appendChild(el('p', { class: 'zn-dialog-detail', text: t('host.scan_intro', { host: host.fqdn || V.hostLabel(host) }) }));
    d.body.appendChild(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_vip') }), vip, el('span', { class: 'form-hint', text: t('host.scan_vip_hint') })]));
    d.body.appendChild(el('div', { class: 'form-group zn-radios' }, [radio('existing', t('host.scan_target_existing'), !smb.length), radio('new', t('host.scan_target_new'))]));
    if (!smb.length) d.body.appendChild(el('span', { class: 'form-hint', text: t('host.scan_no_smb') }));
    d.body.appendChild(exWrap);
    d.body.appendChild(newWrap);
    d.body.appendChild(err);
    sync();
    const submit = el('button', { type: 'button', class: 'btn btn-primary', text: t('host.scan_submit') });
    submit.addEventListener('click', async () => {
      const bad = (msg) => { err.textContent = msg; err.hidden = false; };
      if (!V.validIPv4(st.vip)) return bad(t('host.scan_err_vip'));
      let target;
      if (st.mode === 'existing') {
        if (!st.routeId) return bad(t('host.scan_err_route'));
        target = { mode: 'existing', route_id: st.routeId };
      } else {
        if (!V.validIPv4(st.nasIp)) return bad(t('host.scan_err_nas_ip'));
        if (!st.nasGw) return bad(t('host.scan_err_gateway'));
        target = { mode: 'new', nas_ip: st.nasIp, nas_gateway_peer_id: st.nasGw };
      }
      err.hidden = true;
      UI.busy(submit, true);
      try {
        await UI.call(api.post('/api/v1/hosts/' + host.id + '/scan-to-folder', { vip_ip: st.vip, target }));
        d.close(true);
        UI.toastOk(t('host.scan_done', { host: host.fqdn || V.hostLabel(host) }));
        await ctx().reload();
      } catch (e2) { bad(UI.errMsg(e2)); } finally { UI.busy(submit, false); }
    });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(submit);
    vip.focus();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Neuer Host
  // ════════════════════════════════════════════════════════════════════════
  let nh = null;
  let templatesCache = null;
  function loadTemplates() {
    if (templatesCache) return Promise.resolve(templatesCache);
    return UI.call(api.get('/api/v1/host-templates')).then((res) => { templatesCache = res.templates || []; return templatesCache; }).catch(() => []);
  }

  function zonesForNew() { return pageZones().filter((z) => !z.unassigned && z.domain_id != null); }

  function openNewHost(domainId) {
    const zones = zonesForNew();
    if (!zones.length) { UI.toastError(t('host.new_no_domain')); return; }
    const zone = zones.find((z) => z.domain_id === Number(domainId)) || zones[0];
    if (nh) nh.dlg.close(null);
    const dlg = UI.bigDialog({
      title: t('host.new'), icon: 'plus', iconClass: 'rt-dlg-icon-teal', kind: 'new-host', className: 'rt-dlg-new',
      beforeClose: () => (nh && nhDirty() ? UI.confirmDiscard(1) : Promise.resolve(true)),
    });
    nh = {
      dlg, domainId: zone.domain_id, sub: '', desc: '', lan: '', entries: [V.newEntry('http')],
      external: !!zone.default_external_enabled, template: null, www: true, error: null, conflict: null, busy: false,
      fieldError: null,
    };
    dlg.promise.then(() => { if (nh && nh.dlg === dlg) nh = null; });
    UI.discovery.reset();
    dlg.sub.textContent = t('host.new_intro');
    renderNew();
    loadTemplates().then(() => { if (nh && nh.dlg === dlg) renderNew(); });
    const first = dlg.body.querySelector('input');
    if (first) first.focus();
  }

  function nhDirty() {
    return !!(nh.sub || nh.desc || nh.lan || nh.template || nh.entries.length !== 1 || nh.entries[0].port || nh.entries[0].type !== 'http');
  }
  function nhZone() { return zonesForNew().find((z) => z.domain_id === nh.domainId) || null; }

  function renderNew(opts) {
    if (!nh) return;
    const zone = nhZone();
    if (!zone) { nh.dlg.close(null); return; }
    const dlg = nh.dlg;
    const act = document.activeElement;
    const focusKey = act && dlg.box.contains(act) && act.dataset ? act.dataset.rtKey : null;
    const caret = focusKey && typeof act.selectionStart === 'number' ? act.selectionStart : null;
    const mainScroll = dlg.body.querySelector('.rt-new-main') ? dlg.body.querySelector('.rt-new-main').scrollTop : 0;
    const bodyScroll = dlg.body.scrollTop;

    const main = el('div', { class: 'rt-new-main' }, [
      nh.error ? el('div', { class: 'rt-err rt-err-box', role: 'alert' }, [icon('alert', 14), el('span', { text: nh.error })]) : null,
      stepAddress(zone), stepDevice(zone), stepEntries(zone), stepAccess(zone),
    ]);
    const aside = el('aside', { class: 'rt-new-aside', 'aria-label': t('host.new_preview') }, newAside(zone));
    dlg.body.replaceChildren(el('div', { class: 'rt-new-grid' }, [main, aside]));
    dlg.body.scrollTop = bodyScroll;
    main.scrollTop = mainScroll;
    renderNewFoot(zone);
    if (focusKey) {
      const n = dlg.box.querySelector('[data-rt-key="' + focusKey + '"]');
      if (n) { n.focus(); if (caret != null && typeof n.setSelectionRange === 'function') { try { n.setSelectionRange(caret, caret); } catch (_) { /* ignore */ } } }
    }
    if (opts && opts.focus) { const n = dlg.box.querySelector(opts.focus); if (n) n.focus(); }
  }
  // Light update while typing: aside + footer only.
  function refreshNewAside() {
    if (!nh) return;
    const zone = nhZone();
    const aside = nh.dlg.body.querySelector('.rt-new-aside');
    if (aside && zone) aside.replaceChildren(...newAside(zone));
    if (zone) renderNewFoot(zone);
  }
  function fieldErr(field, index) {
    const fe = nh.fieldError;
    return fe && fe.field === field && (index == null || fe.index === index) ? fe.text : null;
  }

  function stepHead(n, id, title) {
    return el('div', { class: 'rt-step-head' }, [el('span', { class: 'rt-step', 'aria-hidden': 'true', text: String(n) }), el('h3', { class: 'rt-sec-title', id, text: title })]);
  }

  function stepAddress(zone) {
    const sub = el('input', { type: 'text', class: 'rt-input rt-mono', value: nh.sub, placeholder: t('host.subdomain_ph'), maxLength: 190, autocomplete: 'off', spellcheck: 'false', dataset: { rtKey: 'nh-sub' } });
    sub.addEventListener('input', () => {
      nh.sub = sub.value.trim(); nh.fieldError = null;
      const wasApex = !!wwwBox; renderWwwSlot();
      if (wasApex !== !!wwwBox) { /* slot already updated */ }
      refreshNewAside();
    });
    const dom = el('select', { class: 'rt-select rt-mono', dataset: { rtKey: 'nh-dom' } }, zonesForNew().map((z) => el('option', { value: String(z.domain_id), text: z.domain })));
    dom.value = String(nh.domainId);
    dom.addEventListener('change', () => {
      nh.domainId = parseInt(dom.value, 10);
      const z = nhZone();
      nh.external = !!(z && z.default_external_enabled);
      nh.conflict = null; nh.error = null;
      UI.discovery.reset();
      renderNew();
    });
    const desc = el('input', { type: 'text', class: 'rt-input', value: nh.desc, placeholder: t('host.description_ph'), maxLength: 200, dataset: { rtKey: 'nh-desc' } });
    desc.addEventListener('input', () => { nh.desc = desc.value; });
    let wwwBox = null;
    const wwwSlot = el('div', { class: 'rt-www-slot' });
    function renderWwwSlot() {
      wwwSlot.replaceChildren();
      wwwBox = null;
      const SO = window.GCSecOptUI;
      const hasHttp = nh.entries.some((e) => e.type === 'http');
      if (!SO || !SO.isApexSub(nh.sub) || !hasHttp) return;
      wwwBox = SO.wwwCheckbox(nh, zone, 'nh');
      wwwBox.classList.add('rt-check');
      wwwSlot.appendChild(wwwBox);
    }
    renderWwwSlot();
    const subErr = fieldErr('sub');
    return el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-nh-s1' }, [
      stepHead(1, 'rt-nh-s1', t('host.step_address')),
      el('div', { class: 'rt-grid2' }, [
        UI.field(t('host.subdomain_name'), sub, { hint: subErr || t('host.subdomain_empty_hint'), hintClass: subErr ? 'rt-err' : null }),
        UI.field(t('host.domain'), dom, { hint: t('host.target_from_domain', { target: UI.targetText(zone.gateway) }) }),
      ]),
      el('div', { class: 'rt-grid1' }, [UI.field(t('host.description_optional'), desc)]),
      wwwSlot,
    ]);
  }

  function stepDevice(zone) {
    const peer = peerZone(zone);
    const parts = [stepHead(2, 'rt-nh-s2', t(peer ? 'host.step_target' : 'host.step_device'))];
    if (peer) {
      parts.push(el('div', { class: 'rt-readonly' }, [icon('peer', 14), ' ', UI.targetText(zone.gateway), zone.gateway.ip ? el('span', { class: 'rt-mono rt-muted', text: ' · ' + zone.gateway.ip }) : null]));
      parts.push(el('div', { class: 'rt-hint', text: t('host.target_peer_hint') }));
    } else {
      const lan = el('input', { type: 'text', class: 'rt-input rt-mono', value: nh.lan, placeholder: t('host.lan_ph'), maxLength: 253, autocomplete: 'off', spellcheck: 'false', dataset: { rtKey: 'nh-lan' } });
      lan.addEventListener('input', () => { nh.lan = lan.value.trim(); nh.fieldError = null; refreshNewAside(); });
      const lanErr = fieldErr('lan');
      const disc = UI.discovery.control(zone, adoptDevice, () => { if (nh) renderNew(); });
      parts.push(el('div', { class: 'rt-row-end' }, [
        UI.field(t('host.lan_host'), lan, { className: 'rt-grow', hint: lanErr, hintClass: 'rt-err' }),
        disc,
      ]));
    }
    // Templates as pills (they prefill the entries).
    const tplId = 'rt-nh-tpl';
    const pills = el('div', { class: 'rt-pills', role: 'group', 'aria-labelledby': tplId });
    const pill = (id, label, title) => {
      const b = el('button', { type: 'button', class: 'rt-pill', 'aria-pressed': (nh.template || '') === id ? 'true' : 'false', title: title || null, text: label });
      b.addEventListener('click', () => pickTemplate(id));
      return b;
    };
    pills.appendChild(pill('', t('template.none_pill')));
    (templatesCache || []).forEach((tpl) => pills.appendChild(pill(tpl.id, t('template.' + tpl.id) !== 'template.' + tpl.id ? t('template.' + tpl.id) : (tpl.name || tpl.id), t('template.' + tpl.id + '_hint'))));
    parts.push(el('div', { class: 'rt-tpl' }, [el('div', { class: 'rt-label', id: tplId, text: t('template.pick_label') }), pills]));
    return el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-nh-s2' }, parts);
  }

  function pickTemplate(id) {
    if (!id) { nh.template = null; renderNew(); return; }
    const tpl = (templatesCache || []).find((x) => x.id === id);
    if (!tpl) return;
    const zone = nhZone();
    let entries = V.entriesFromTemplate(tpl);
    if (!l4Allowed(zone)) entries = entries.filter((e) => e.type === 'http');
    nh.template = id;
    nh.entries = entries.length ? entries : [V.newEntry('http')];
    nh.conflict = null; nh.error = null; nh.fieldError = null;
    renderNew();
  }

  function adoptDevice(dev, port) {
    if (!nh) return;
    const zone = nhZone();
    nh.lan = String(dev.ip || '').trim();
    const sub = V.suggestSubdomain(dev.hostname);
    if (sub && !nh.sub) nh.sub = sub;
    if (!nh.desc && dev.hostname) nh.desc = String(dev.hostname);
    const draft = V.entryDraftFromPort(port, l4Allowed(zone));
    if (draft) {
      const row = draft.type === 'http'
        ? { type: 'http', outer: '443', port: draft.target, backend: draft.bhttps }
        : { type: 'tcp', outer: draft.listen, port: draft.target, backend: false };
      const blank = nh.entries.length === 1 && !nh.entries[0].port;
      if (blank) nh.entries = [row];
      else if (!(row.type === 'http' && nh.entries.some((e) => e.type === 'http'))) nh.entries.push(row);
      nh.template = null;
    }
    nh.error = null; nh.conflict = null; nh.fieldError = null;
    renderNew({ focus: '[data-rt-key="nh-sub"]' });
    UI.toastOk(t('zones.discovery.adopted', { ip: nh.lan }));
  }

  function stepEntries(zone) {
    const l4ok = l4Allowed(zone);
    const rows = nh.entries.map((e, i) => {
      const otherHttp = nh.entries.some((x, j) => j !== i && x.type === 'http');
      const typeSeg = UI.seg([
        { value: 'http', label: 'HTTPS', disabled: otherHttp, title: otherHttp ? t('entry.err_http_taken') : null },
        { value: 'tcp', label: 'TCP', disabled: !l4ok },
        { value: 'udp', label: 'UDP', disabled: !l4ok },
      ], e.type, (v) => {
        const was = e.type;
        e.type = v;
        if (v === 'http') e.outer = '443'; else if (was === 'http') e.outer = '';
        nh.conflict = null; nh.fieldError = null;
        renderNew();
      }, { small: true, label: t('entry.col_type') });
      const outer = el('input', { type: 'text', inputmode: 'numeric', class: 'rt-input rt-input-sm rt-mono', maxLength: 11, value: e.type === 'http' ? '443' : e.outer, disabled: e.type === 'http', placeholder: t('entry.listen_port_ph'), dataset: { rtKey: 'nh-out-' + i } });
      outer.addEventListener('input', () => { e.outer = outer.value.trim(); nh.conflict = null; nh.fieldError = null; refreshNewAside(); });
      const port = el('input', { type: 'text', inputmode: 'numeric', class: 'rt-input rt-input-sm rt-mono', maxLength: 5, value: e.port, placeholder: t('entry.target_port_ph'), dataset: { rtKey: 'nh-port-' + i } });
      port.addEventListener('input', () => { e.port = port.value.trim(); nh.fieldError = null; refreshNewAside(); });
      const outErr = fieldErr('outer', i);
      const portErr = fieldErr('port', i);
      const typeErr = fieldErr('type', i);
      const conflictHere = nh.conflict && e.type !== 'http' && String(nh.conflict.port) === String(e.outer).trim();
      const remove = el('button', {
        type: 'button', class: 'rt-ibtn zn-ibtn', 'aria-label': t('entry.remove_row', { n: i + 1 }), title: t('entry.remove_row', { n: i + 1 }), disabled: nh.entries.length <= 1,
        on: { click: () => { nh.entries.splice(i, 1); nh.conflict = null; nh.fieldError = null; renderNew(); } },
      }, [icon('x', 16)]);
      const typeLbl = UI.nextId('rt-nh-ty');
      return el('div', { class: 'rt-nh-entry', dataset: { index: String(i) } }, [
        el('div', { class: 'rt-field rt-field-type' }, [el('div', { class: 'rt-label', id: typeLbl, text: t('entry.col_type') }), typeSeg, typeErr ? el('div', { class: 'rt-hint rt-err', text: typeErr }) : null]),
        UI.field(t('entry.listen_port'), outer, { className: 'rt-field-port', hint: outErr, hintClass: 'rt-err' }),
        UI.field(t('entry.target_port'), port, { className: 'rt-field-port', hint: portErr, hintClass: 'rt-err' }),
        e.type === 'http' ? el('label', { class: 'rt-check rt-check-inline' }, [
          el('input', { type: 'checkbox', checked: !!e.backend, on: { change: (ev) => { e.backend = ev.target.checked; refreshNewAside(); } } }),
          t('entry.backend_https'),
        ]) : el('span', { class: 'rt-check-inline rt-check-spacer', 'aria-hidden': 'true' }),
        remove,
        conflictHere ? errorRow({ text: t('entry.port_conflict', { port: nh.conflict.port }), conflict: nh.conflict }, () => {
          e.outer = String(nh.conflict.suggestedPort); nh.conflict = null; renderNew();
        }) : null,
      ]);
    });
    const addBtn = el('button', {
      type: 'button', class: 'rt-add-row', on: { click: () => {
        const hasHttp = nh.entries.some((x) => x.type === 'http');
        nh.entries.push(V.newEntry(hasHttp || !l4ok ? (l4ok ? 'tcp' : 'http') : 'tcp'));
        renderNew({ focus: '[data-rt-key="nh-port-' + (nh.entries.length - 1) + '"]' });
      } },
      disabled: !l4ok && nh.entries.some((x) => x.type === 'http'),
    }, [icon('plus', 15), t('entry.add_more')]);
    return el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-nh-s3' }, [
      stepHead(3, 'rt-nh-s3', t('entry.section')),
      el('div', { class: 'rt-nh-entries' }, [rows, addBtn]),
      !l4ok ? el('div', { class: 'rt-hint' }, [t('entry.l4_locked'), ' ', UI.proChip()]) : null,
      fieldErr('entries') ? el('div', { class: 'rt-hint rt-err', text: fieldErr('entries') }) : null,
    ]);
  }

  function stepAccess(zone) {
    const accId = 'rt-nh-acc';
    return el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-nh-s4' }, [
      stepHead(4, 'rt-nh-s4', t('host.step_access')),
      el('div', { class: 'rt-sr', id: accId, text: t('zones.default_access') }),
      UI.seg([{ value: 'ext', label: t('zones.default_external') }, { value: 'int', label: t('zones.default_internal') }],
        nh.external ? 'ext' : 'int', (v) => { nh.external = v === 'ext'; refreshNewAside(); }, { labelledBy: accId }),
      el('div', { class: 'rt-hint', text: t(zone.default_external_enabled ? 'host.access_default_ext' : 'host.access_default_int') + ' ' + t('host.access_more') }),
    ]);
  }

  function newAside(zone) {
    const preview = V.newHostPreview(nh, zone);
    const used = V.usedListenPorts(pageZones());
    const checks = V.newHostChecks(nh, zone, { used, blocked: blockedPorts() });
    const checkText = (c) => {
      if (c.id === 'dns') return t(c.state === 'ok' ? 'host.check_dns_ok' : 'host.check_dns_pending', c.params);
      if (c.id === 'gateway' || c.id === 'peer') return t(c.state === 'ok' ? 'host.check_' + c.id + '_ok' : 'host.check_' + c.id + '_off', c.params);
      if (c.id === 'cert') return t(c.state === 'ok' ? 'host.check_cert_ok' : 'host.check_cert_wait', c.params);
      return t('host.check_' + c.id, c.params);
    };
    return [
      el('h3', { class: 'rt-sec-title', text: t('host.new_preview') }),
      el('ul', { class: 'rt-preview' }, preview.map((p) => el('li', { class: 'rt-preview-item' }, [
        el('div', { class: 'rt-preview-from' }, [UI.typeChip(p.type), el('span', { class: 'rt-mono', text: p.from })]),
        el('div', { class: 'rt-preview-to rt-mono' }, [icon('arrow', 14), p.to]),
      ]))),
      el('div', { class: 'rt-hint', text: t(nh.external ? 'host.preview_external' : 'host.preview_internal') }),
      el('h3', { class: 'rt-sec-title rt-mt', text: t('host.new_checks') }),
      el('ul', { class: 'rt-checks' }, checks.map((c) => el('li', { class: 'rt-checkline rt-check-' + c.state }, [
        el('span', { class: 'rt-check-ic', 'aria-hidden': 'true' }, [icon(c.state === 'ok' ? 'check' : 'alert', 12)]),
        el('span', { text: checkText(c) }),
      ]))),
    ];
  }

  function renderNewFoot(zone) {
    const n = nh.entries.length;
    const fqdn = V.previewFqdn(nh.sub, zone.domain);
    const summary = el('span', { class: 'rt-dlg-note rt-mono-mix' }, [el('span', { class: 'rt-mono', text: fqdn }), ' · ', t(n === 1 ? 'entry.count_one' : 'entry.count', { count: n })]);
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost rt-btn', text: t('common.cancel'), on: { click: () => nh.dlg.requestClose() } });
    const create = el('button', { type: 'button', class: 'btn btn-primary rt-btn rt-nh-create', disabled: nh.busy, on: { click: (ev) => submitNew(ev.currentTarget) } }, [t('host.create')]);
    nh.dlg.foot.replaceChildren(summary, cancel, create);
  }

  const NEW_ERR = {
    subdomain: 'host.err_subdomain', lan: 'host.err_lan_required', entries: 'entry.err_none', http_twice: 'entry.err_http_taken',
    port: 'entry.err_target_port', outer: 'entry.err_listen_port', outer_twice: 'entry.err_listen_twice',
  };
  async function submitNew(btn) {
    if (!nh || nh.busy) return;
    const zone = nhZone();
    nh.error = null; nh.conflict = null; nh.fieldError = null;
    const r = V.newHostBody(nh, zone);
    if (r.error) {
      nh.fieldError = { field: r.error.field, index: r.error.index, text: t(NEW_ERR[r.error.code] || 'zones.error_generic') };
      renderNew();
      const errNode = nh.dlg.body.querySelector('.rt-err');
      if (errNode && errNode.scrollIntoView) errNode.scrollIntoView({ block: 'nearest' });
      return;
    }
    const SO = window.GCSecOptUI;
    const www = SO && SO.wwwAliasFields({ sub: nh.sub, www: nh.www, type: nh.entries.some((e) => e.type === 'http') ? 'http' : 'tcp' }, zone);
    if (www) Object.assign(r.body, www);
    nh.busy = true;
    UI.busy(btn, true);
    try {
      const res = await UI.call(api.post('/api/v1/domains/' + zone.domain_id + '/hosts', r.body));
      const created = res.host || {};
      const fqdn = created.fqdn || V.previewFqdn(r.body.subdomain, zone.domain);
      UI.toastOk(t('host.created', { host: fqdn }));
      const TG = window.GCTlsUI;
      const tls = TG && TG.tlsFromResponse(res);
      if (tls && tls.state === 'paused' && window.showToast) window.showToast(TG.t('tls.created_paused', { host: fqdn, reason: TG.pausedReason(tls) }), 'warning');
      nh.busy = false;
      nh.dlg.close(true);
      await ctx().reload();
      if (created.id != null && window.GCZonesPage && window.GCZonesPage.flashHost) window.GCZonesPage.flashHost(created.id);
    } catch (err) {
      if (!nh) return;
      nh.busy = false;
      UI.busy(btn, false);
      const c = UI.portConflict(err);
      if (c) nh.conflict = c;
      else nh.error = serverText(err);
      renderNew();
      const errNode = nh.dlg.body.querySelector('.rt-err');
      if (errNode && errNode.scrollIntoView) errNode.scrollIntoView({ block: 'nearest' });
    }
  }

  // Page data changed: redraw open dialogs, keeping their drafts.
  function refresh() {
    if (UI.menuOpen()) return;
    if (hs && !hs.saving) {
      const f = current();
      if (f) {
        // Drop drafts of entries that are gone, and untouched drafts (the
        // entry may have changed elsewhere, e.g. in the entry editor).
        const ids = new Set((f.host.entries || []).map((e) => e.id));
        Object.keys(hs.drafts).forEach((id) => {
          if (!ids.has(Number(id)) || JSON.stringify(hs.drafts[id]) === hs.bases[id]) { delete hs.drafts[id]; delete hs.bases[id]; }
        });
        if (JSON.stringify(hs.hd) === hs.hdBase) hs.hd = V.hostDraft(f.host);
        hs.hdBase = JSON.stringify(hs.hd);
      }
      renderHost();
    }
    if (nh && !nh.busy) refreshNewAside();
  }

  window.GCHostDialogs = {
    openHost, openNewHost, refresh, openOptions, deleteHost,
    isOpen: () => !!(hs || nh),
  };
})();
