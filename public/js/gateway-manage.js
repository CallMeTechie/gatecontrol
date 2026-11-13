'use strict';

// Gateway management on /gateways (docs/feature-peers-page.md): the actions
// that used to live in the Peers page's edit dialog of a gateway peer —
// name/description/peer group, "Zugang erneuern" (a setup code with the server address for the
// setup page of the gateway; the file way through the assistant at step 3), proxy port,
// disable / enable and delete with the list of routes it takes down.
//
//   GCGatewayManage.menuItems(g, item, menu)  adds the entries to the "Mehr"
//                                             menu of the gateway detail view
//                                             (gateways.js calls it)
//   GCGatewayManage.run(action, id, g)        runs one entry (gm-*)
//
// Disabled gateways drop out of GET /api/v1/gateways; they are listed below
// the fleet (#gw-disabled) with "Aktivieren" and "Entfernen", so nothing
// becomes unreachable. Every server value goes in with textContent; CSRF via
// the X-CSRF-Token header.
(function () {
  var D = window.GCDialog;
  var I = {};
  try { I = JSON.parse((document.getElementById('gwm-i18n') || {}).textContent || '{}') || {}; } catch (e) { I = {}; }
  function T(key, params) {
    var s = I[key] != null ? I[key] : key;
    if (params) Object.keys(params).forEach(function (p) { s = s.split('{{' + p + '}}').join(String(params[p])).split('{' + p + '}').join(String(params[p])); });
    return s;
  }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    // children: Element.append() — a node is inserted as it is, any other value
    // (a label, a search text from the address) only as plain text, never parsed as HTML
    (kids || []).forEach(function (c) { if (c != null) n.append(c instanceof Node ? c : String(c)); });
    return n;
  }
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      opts.headers['X-CSRF-Token'] = (window.GC && GC.csrfToken) || '';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
    });
  }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type); }
  function changed() { document.dispatchEvent(new CustomEvent('gc:gateway-wizard', { detail: { source: 'manage' } })); loadDisabled(); }
  function fail(msg) { return D.alert({ message: msg || T('common.error'), danger: true }); }

  // ── "Mehr" menu entries ──
  function menuItems(g, item, menu) {
    if (!g || !item || !menu) return;
    menu.appendChild(el('div', { class: 'gw-menu-sep', role: 'separator' }));
    menu.appendChild(el('div', { class: 'gw-menu-label', 'aria-hidden': 'true', text: T('gwm.section') }));
    item('gm-rename', T('gwm.rename'));
    item('gm-renew', T('gwm.renew'));
    item('gm-proxy', T('gwm.proxy_port'));
    item('gm-disable', T('gwm.disable'));
    menu.appendChild(el('div', { class: 'gw-menu-sep', role: 'separator' }));
    item('gm-delete', T('gwm.delete'), true);
  }

  function run(action, id, g) {
    if (!id) return;
    if (action === 'gm-rename') return rename(id);
    if (action === 'gm-renew') return renew(id, g);
    if (action === 'gm-reconnect') { location.hash = '#setup/' + encodeURIComponent(id); return; }
    if (action === 'gm-proxy') return proxyPort(id);
    if (action === 'gm-disable') return setEnabled(id, false, g && g.name);
    if (action === 'gm-enable') return setEnabled(id, true);
    if (action === 'gm-delete') return remove(id);
  }

  // ── Name, description and peer group (PUT /api/v1/peers/:id — partial update) ──
  function rename(id) {
    return Promise.all([
      api('GET', '/api/v1/peers/' + encodeURIComponent(id)),
      api('GET', '/api/v1/peer-groups').catch(function () { return {}; }),
    ]).then(function (res) {
      var r = res[0];
      var groups = (res[1] && res[1].groups) || [];
      var p = r && r.peer;
      if (!p) return fail(r && r.error);
      var d = D.dialog({ title: T('gwm.rename_title') });
      var name = el('input', { type: 'text', class: 'form-input', id: 'gwm-name', maxlength: 63, autocomplete: 'off' });
      name.value = p.name || '';
      var desc = el('input', { type: 'text', class: 'form-input', id: 'gwm-desc', maxlength: 255, autocomplete: 'off' });
      desc.value = p.description || '';
      var group = el('select', { class: 'form-input', id: 'gwm-group' });
      group.appendChild(new Option(T('gwm.group_none'), ''));
      groups.forEach(function (gr) { group.appendChild(new Option(gr.name, String(gr.id))); });
      group.value = p.group_id ? String(p.group_id) : '';
      var err = el('div', { class: 'zn-field-error', role: 'alert' }); err.hidden = true;
      d.body.appendChild(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'gwm-name', text: T('gwm.name') }), name]));
      // Name im VPN (vpn-names.js): a gateway reports its name itself; one given
      // here is kept (PATCH /api/v1/peers/:id/hostname). Licence: internal_dns.
      var VN = window.GCVpnNames;
      var vnField = VN && VN.cfg.licensed ? VN.field({ id: 'gwm-hostname', saveBtn: null }) : null;
      if (vnField) { d.body.appendChild(vnField.root); vnField.set(p); }
      d.body.appendChild(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'gwm-desc', text: T('gwm.description') }), desc]));
      d.body.appendChild(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'gwm-group', text: T('gwm.group') }), group,
        el('small', { class: 'form-hint', text: T('gwm.group_hint') })]));
      d.body.appendChild(err);
      var save = el('button', { type: 'button', class: 'btn btn-primary', id: 'gwm-save', text: T('common.save') });
      var cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: T('common.cancel') });
      cancel.addEventListener('click', function () { d.close(null); });
      save.addEventListener('click', function () {
        var n = name.value.trim();
        if (!n) { err.textContent = T('gwm.name_required'); err.hidden = false; name.focus(); return; }
        if (vnField && !vnField.valid()) { vnField.input.focus(); return; }
        save.disabled = true;
        api('PUT', '/api/v1/peers/' + encodeURIComponent(id), { name: n, description: desc.value.trim(), group_id: group.value ? Number(group.value) : null }).then(function (res) {
          if (!res || !res.ok || !vnField || !vnField.changed()) return res;
          return api('PATCH', '/api/v1/peers/' + encodeURIComponent(id) + '/hostname', { hostname: vnField.value() }).then(function (hn) {
            if (hn && hn.ok) return res;
            vnField.serverError(hn);
            return { ok: false, atField: true };
          });
        }).then(function (res) {
          save.disabled = false;
          if (res && res.atField) { changed(); return; }
          if (!res || !res.ok) { err.textContent = (res && res.error) || T('common.error'); err.hidden = false; return; }
          d.close(true);
          toast(T('gwm.saved'));
          changed();
        }).catch(function (e) { save.disabled = false; err.textContent = e.message; err.hidden = false; });
      });
      d.foot.appendChild(cancel);
      d.foot.appendChild(save);
      name.focus();
      name.select();
      return d.promise;
    }).catch(function (e) { return fail(e.message); });
  }

  // ── "Zugang erneuern" (POST /api/v1/gateways/:id/renew-access) ──
  // The access of the running gateway ends at once, so this always asks first. Then the server
  // address and a setup code are shown: the gateway asks for them on its setup page in the home
  // network (http://<address>:8642, "Zugang ungültig" — gateway docs/setup-page.md). A gateway
  // that does not know the page yet goes the file way (the assistant at step 3) as before.
  function telemetryOf(g) { return (g && g.health && g.health.telemetry) || {}; }
  // asked fresh from the server (the list of the page can be a moment old): does this gateway know the setup page?
  function knowsSetupPage(id, g) {
    return api('GET', '/api/v1/gateways/' + encodeURIComponent(id) + '/features').then(function (r) {
      var sup = r && r.ok && r.gateway && r.gateway.support;
      if (sup) return sup.setupPage === true;
      var caps = telemetryOf(g).capabilities;
      return Array.isArray(caps) && caps.indexOf('setup-page') >= 0;
    });
  }
  function fileWay(id) {
    var W = window.GCGatewayWizard;
    if (W && W.open) {
      // the address as "Einrichtung fortsetzen" sets it: a reload continues here
      try { history.replaceState(null, '', location.pathname + location.search + '#setup/' + encodeURIComponent(id)); } catch (e) { /* ignore */ }
      W.open({ mode: 'resume', id: Number(id), way: 'file' });
    } else location.hash = '#setup/' + encodeURIComponent(id);
  }
  function copy(text, btn) {
    function done() { var old = btn.textContent; btn.textContent = T('gwm.renew_copied'); setTimeout(function () { btn.textContent = old; }, 1600); }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { /* denied */ }); return; }
    var ta = el('textarea', { class: 'sr-only' });
    ta.value = text;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }
  function renew(id, g) {
    var name = (g && g.name) || '';
    return knowsSetupPage(id, g).then(function (knows) {
      // a gateway before the setup page: the way as before (the assistant asks before it rotates)
      if (!knows) {
        return D.confirm({ title: T('gwm.renew_title'), message: T('gwm.renew_confirm_old', { name: name }), okLabel: T('gwm.renew_file') })
          .then(function (ok) { if (ok) fileWay(id); });
      }
      return D.confirm({ title: T('gwm.renew_title'), message: T('gwm.renew_confirm', { name: name }), danger: true, okLabel: T('gwm.renew_ok') }).then(function (ok) {
        if (!ok) return;
        return api('POST', '/api/v1/gateways/' + encodeURIComponent(id) + '/renew-access', {}).then(function (r) {
          if (!r || !r.ok || !r.code) return fail(r && r.error);
          changed();
          return renewDialog(id, g, r);
        });
      });
    }).catch(function (e) { return fail(e.message); });
  }
  function renewDialog(id, g, first) {
    var d = D.dialog({ title: T('gwm.renew_title') });
    d.box.classList.add('gwm-renew');
    var lan = telemetryOf(g).lan_ip;
    var url = 'http://' + (lan && /^[0-9.]+$/.test(lan) ? lan : '<' + T('gwm.renew_url') + '>') + ':8642';
    var pair = first;
    var timer = null, poll = null, closed = false;
    var server = el('strong', { class: 'gwz-pair-v', id: 'gwm-renew-server' });
    var code = el('strong', { class: 'gwz-pair-v', id: 'gwm-renew-code' });
    var left = el('span', { class: 'gwz-pair-t', id: 'gwm-renew-left' });
    var cpS = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: T('gwm.renew_copy') });
    var cpC = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: T('gwm.renew_copy') });
    cpS.addEventListener('click', function () { copy(pair.server, cpS); });
    cpC.addEventListener('click', function () { copy(pair.code, cpC); });
    var again = el('button', { type: 'button', class: 'gwz-link', id: 'gwm-renew-new', text: T('gwm.renew_new') });
    var waitText = el('span', { text: T('gwm.renew_wait') });
    var wait = el('div', { class: 'gwz-wait', role: 'status' }, [el('span', { class: 'gwz-spin', 'aria-hidden': 'true' }), waitText]);
    var err = el('div', { class: 'zn-field-error', role: 'alert' }); err.hidden = true;
    var file = el('button', { type: 'button', class: 'gwz-link', id: 'gwm-renew-file', text: T('gwm.renew_file') });
    d.body.appendChild(el('p', { class: 'gwm-renew-text' }, [T('gwm.renew_text'), ' ', el('code', { class: 'gwz-k', text: url })]));
    d.body.appendChild(el('div', { class: 'gwz-pairbox' }, [
      el('div', { class: 'gwz-pair' }, [el('span', { class: 'gwz-pair-l', text: T('gwm.renew_server') }), server, cpS]),
      el('div', { class: 'gwz-pair' }, [el('span', { class: 'gwz-pair-l', text: T('gwm.renew_code') }), code, left, cpC]),
    ]));
    d.body.appendChild(el('p', { class: 'form-hint' }, [again]));
    d.body.appendChild(wait);
    d.body.appendChild(err);
    d.body.appendChild(el('p', { class: 'form-hint' }, [T('gwm.renew_file_text'), ' ', file]));
    function tick() {
      var ms = pair.expiresAt - Date.now();
      left.classList.toggle('over', ms <= 0);
      if (ms <= 0) { left.textContent = T('gwm.renew_expired'); return; }
      var sec = Math.floor(ms / 1000);
      left.textContent = T('gwm.renew_left', { t: Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') });
    }
    function show() { server.textContent = pair.server; code.textContent = pair.code; tick(); }
    function stop() { closed = true; clearInterval(timer); clearTimeout(poll); }
    function check() {
      if (closed) return;
      api('GET', '/api/v1/gateways/' + encodeURIComponent(id) + '/setup-status').then(function (r) {
        if (closed) return;
        var pr = r && r.ok && r.gateway && r.gateway.pairing;
        if (pr && pr.consumed_at && pr.expires_at === pair.expiresAt) {
          wait.classList.add('done');
          waitText.textContent = T('gwm.renew_redeemed', { name: (g && g.name) || (r.gateway && r.gateway.name) || '' });
          clearInterval(timer); left.textContent = '';
          changed();
          return;
        }
        poll = setTimeout(check, 3000);
      }).catch(function () { poll = setTimeout(check, 5000); });
    }
    again.addEventListener('click', function () {
      again.disabled = true; err.hidden = true;
      // the access is already invalid: only a new code (the one before stops working)
      api('POST', '/api/v1/peers/' + encodeURIComponent(id) + '/gateway-pairing-code', {}).then(function (r) {
        again.disabled = false;
        if (!r || !r.ok || !r.code) { err.textContent = (r && r.error) || T('common.error'); err.hidden = false; return; }
        pair = { code: r.code, server: r.server || pair.server, expiresAt: r.expiresAt };
        wait.classList.remove('done'); waitText.textContent = T('gwm.renew_wait');
        show();
        clearInterval(timer); timer = setInterval(tick, 1000);
        clearTimeout(poll); poll = setTimeout(check, 3000);
      }).catch(function (e) { again.disabled = false; err.textContent = e.message; err.hidden = false; });
    });
    file.addEventListener('click', function () { d.close(null); fileWay(id); });
    var close = el('button', { type: 'button', class: 'btn btn-primary', id: 'gwm-renew-close', text: T('gwm.renew_close') });
    close.addEventListener('click', function () { d.close(true); });
    d.foot.appendChild(close);
    show();
    timer = setInterval(tick, 1000);
    poll = setTimeout(check, 3000);
    d.promise.then(stop, stop);
    close.focus();
    return d.promise;
  }

  // ── Proxy port (PATCH /api/v1/peers/:id/proxy-port) ──
  function proxyPort(id) {
    return api('GET', '/api/v1/peers/' + encodeURIComponent(id) + '/gateway-info').then(function (r) {
      var cur = r && r.ok && r.gateway && r.gateway.proxy_port ? String(r.gateway.proxy_port) : '8080';
      return D.prompt({
        title: T('gwm.proxy_title'), label: T('gwm.proxy_label'), value: cur, hint: T('peer_gateway_proxy_port_hint'), maxLength: 5,
        validate: function (v) { var n = Number(v); return /^\d{1,5}$/.test(v) && n >= 1 && n <= 65535 ? null : T('gwm.proxy_invalid'); },
      });
    }).then(function (v) {
      if (v == null) return;
      return api('PATCH', '/api/v1/peers/' + encodeURIComponent(id) + '/proxy-port', { proxy_port: Number(v) }).then(function (res) {
        if (!res || !res.ok) return fail(res && res.error);
        toast(T('gwm.saved'));
        changed();
      });
    }).catch(function (e) { return fail(e.message); });
  }

  // ── Disable / enable (PUT /api/v1/peers/:id/toggle) ──
  function setEnabled(id, on, name) {
    var ask = on ? Promise.resolve(true) : D.confirm({ title: T('gwm.disable_title'), message: T('gwm.disable_confirm', { name: name || '' }), danger: true, okLabel: T('gwm.disable_ok') });
    return ask.then(function (ok) {
      if (!ok) return;
      return api('GET', '/api/v1/peers/' + encodeURIComponent(id)).then(function (r) {
        var p = r && r.peer;
        if (!p) return fail(r && r.error);
        if (!!p.enabled === on) { changed(); return; }
        return api('PUT', '/api/v1/peers/' + encodeURIComponent(id) + '/toggle', {}).then(function (res) {
          if (!res || !res.ok) return fail(res && res.error);
          toast(T(on ? 'gwm.enabled_toast' : 'gwm.disabled_toast', { name: p.name }));
          if (!on && /^#gw\//.test(location.hash)) location.hash = '';
          changed();
        });
      });
    }).catch(function (e) { return fail(e.message); });
  }

  // ── Delete: routes that go down + type the tunnel IP (GET …/delete-impact, DELETE …/:id) ──
  function remove(id) {
    return api('GET', '/api/v1/peers/' + encodeURIComponent(id) + '/delete-impact').then(function (impact) {
      if (!impact || !impact.ok || !impact.peer) return fail(impact && impact.error);
      var peer = impact.peer;
      var d = D.dialog({ title: T('gateway_delete_title') });
      d.box.classList.add('gwm-delete');
      d.body.appendChild(el('div', { class: 'gwm-warn' }, [el('strong', { text: T('gateway_delete_warning_title') }), el('div', { text: T('gateway_delete_warning_body') })]));
      d.body.appendChild(el('div', { class: 'form-group' }, [el('span', { class: 'form-label', text: T('gateway_delete_peer_label') }), el('div', { class: 'gwm-summary', text: peer.name + '  (' + peer.ip + ')' })]));
      var routes = (impact.httpRoutes || []).map(function (r) { return r.domain || ('#' + r.id); })
        .concat((impact.rdpRoutes || []).map(function (r) { return 'RDP: ' + (r.name || r.host); }));
      if (routes.length) {
        d.body.appendChild(el('div', { class: 'form-group', id: 'gwm-routes' }, [
          el('span', { class: 'form-label', text: T('gateway_delete_affected_routes') }),
          el('ul', { class: 'gwm-routes' }, routes.map(function (x) { return el('li', { text: x }); })),
          el('small', { class: 'form-hint', text: T('gateway_delete_routes_hint', { count: routes.length }) }),
        ]));
      } else {
        d.body.appendChild(el('p', { class: 'form-hint', text: T('gateway_delete_no_routes') }));
      }
      var input = el('input', { type: 'text', class: 'form-input gwm-ip', id: 'gwm-delete-ip', autocomplete: 'off', spellcheck: 'false', placeholder: peer.ip });
      var status = el('small', { class: 'form-hint', id: 'gwm-delete-status', 'aria-live': 'polite' });
      d.body.appendChild(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'gwm-delete-ip', text: T('gateway_delete_confirm_ip_label') + ' ' + peer.ip }), input, status]));
      var go = el('button', { type: 'button', class: 'btn btn-danger', id: 'gwm-delete-ok', text: T('gateway_delete_button') });
      go.disabled = true;
      var cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: T('common.cancel') });
      cancel.addEventListener('click', function () { d.close(null); });
      input.addEventListener('input', function () {
        var v = input.value.trim();
        go.disabled = v !== peer.ip;
        status.textContent = !v ? '' : (v === peer.ip ? T('gateway_delete_ip_match') : T('gateway_delete_ip_mismatch'));
      });
      go.addEventListener('click', function () {
        go.disabled = true;
        api('DELETE', '/api/v1/peers/' + encodeURIComponent(peer.id)).then(function (res) {
          if (!res || res.ok === false) { status.textContent = (res && res.error) || T('common.error'); go.disabled = false; return; }
          d.close(true);
          toast(T('gwm.deleted_toast', { name: peer.name }));
          if (/^#gw\//.test(location.hash)) location.hash = '';
          changed();
        }).catch(function (e) { status.textContent = e.message; go.disabled = false; });
      });
      d.foot.appendChild(cancel);
      d.foot.appendChild(go);
      input.focus();
      return d.promise;
    }).catch(function (e) { return fail(e.message); });
  }

  // ── Disabled gateways below the fleet ──
  var box = document.getElementById('gw-disabled');
  function loadDisabled() {
    if (!box) return Promise.resolve();
    return api('GET', '/api/v1/peers?type=gateway').then(function (r) {
      var off = ((r && r.peers) || []).filter(function (p) { return !p.enabled; });
      box.replaceChildren();
      box.hidden = !off.length;
      if (!off.length) return;
      var list = el('div', { class: 'gwm-off-list' }, off.map(function (p) {
        var ip = p.allowed_ips ? String(p.allowed_ips).split('/')[0] : '';
        var en = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-gm': 'gm-enable', 'data-id': p.id, text: T('gwm.enable') });
        var del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm gwm-del', 'data-gm': 'gm-delete', 'data-id': p.id, text: T('gwm.delete') });
        return el('div', { class: 'gwm-off', 'data-id': p.id }, [
          el('div', { class: 'gwm-off-t' }, [el('strong', { text: p.name }), el('span', { class: 'gwm-off-d', text: [ip, p.description].filter(Boolean).join(' · ') })]),
          el('span', { class: 'tag tag-amber tag-dot', text: T('gwm.disabled_tag') }),
          el('span', { class: 'gwm-off-a' }, [en, del]),
        ]);
      }));
      box.appendChild(el('section', { class: 'card gwm-off-card' }, [
        el('h2', { class: 'card-title', text: T('gwm.disabled_title') }),
        el('p', { class: 'gwm-off-hint', text: T('gwm.disabled_hint') }),
        list,
      ]));
    }).catch(function (e) { console.warn('[gateways] loading disabled gateways failed', e); });
  }
  if (box) {
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-gm]');
      if (b) run(b.getAttribute('data-gm'), b.getAttribute('data-id'));
    });
    loadDisabled();
    document.addEventListener('gc:gateway', function () { loadDisabled(); });
  }

  window.GCGatewayManage = { menuItems: menuItems, run: run, refresh: loadDisabled };
})();
