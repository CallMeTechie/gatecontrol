// Assistant "Gateway hinzufügen" on /gateways (docs/feature-gateway-wizard.md).
//
//   1  name, location (Gateway-Standort: one of the list or "Neuer Standort …",
//      created right before the gateway — docs/feature-gateway-locations.md), platform
//   2  Raspberry Pi only: model, LAN/WLAN, Zigbee, advanced (host name, time
//      zone, WLAN country, SSH key)
//   →  "Gateway anlegen": POST /api/v1/peers { is_gateway, platform, location_id } —
//      the same endpoint, rights, CSRF and licence checks as before (a new
//      location first: POST /api/v1/gateway-locations)
//   3  instructions per platform (Pi image + gatecontrol-setup.zip built HERE,
//      Proxmox one-liner). Synology and Linux: the setup page of the gateway
//      (gateway docs/setup-page.md) — a compose without access data, then the
//      server address and a setup code (POST …/gateway-pairing-code, 10 min)
//      on http://<address>:8642; the step goes on by itself once the code is
//      redeemed. The file way (Synology package / gateway.env) stays one
//      click away (state.way = 'file').
//   4  live status (GET /api/v1/gateways/:id/setup-status, polled with
//      back-off and on gc:gateway events)
//
// The WLAN password and the SSH key never leave the browser: settings.txt and
// the ZIP are made here (GCGatewayKit), the gateway.env comes from the server
// (creation response, else POST …/gateway-env/rotate). The env lives only in
// memory. Every name/host from the server goes in with textContent.
//
// Public: window.GCGatewayWizard.open({ mode: 'add' }) / open({ mode: 'resume', id }).
(function () {
  'use strict';
  var kit = window.GCGatewayKit;
  var LK = window.GCGatewayLocationKit;
  var D = window.GCDialog;
  var overlay = document.getElementById('gwz-overlay');
  if (!overlay || !kit) return;
  // <main> is its own stacking context below the mobile bottom navigation —
  // the assistant lives directly under <body> so its footer stays clickable.
  if (overlay.parentNode !== document.body) document.body.appendChild(overlay);

  var I = {};
  try { I = JSON.parse((document.getElementById('gwiz-i18n') || {}).textContent || '{}') || {}; } catch (e) { I = {}; }
  function T(k, d, params) {
    var s = I[k] != null ? I[k] : (d != null ? d : k);
    if (params) Object.keys(params).forEach(function (p) { s = s.split('{{' + p + '}}').join(String(params[p])); });
    return s;
  }
  function csrf() { return (window.GC && GC.csrfToken) || ''; }
  function $(id) { return document.getElementById(id); }
  function show(node, on) { if (node) node.hidden = !on; }

  var MODEL_DEVICE = { pi5: 'Raspberry Pi 5', pi4: 'Raspberry Pi 4', pi3bplus: 'Raspberry Pi 3', pizero2w: 'Raspberry Pi Zero 2 W' };
  var MODEL_NAME = { pi5: 'Raspberry Pi 5', pi4: 'Raspberry Pi 4', pi3bplus: 'Raspberry Pi 3 B+', pizero2w: 'Raspberry Pi Zero 2 W' };
  var HELP_AFTER_MS = 10 * 60 * 1000;

  var state;
  function freshState() {
    return {
      step: 1, platform: null, peerId: null, name: '', locationId: '', newLoc: null, newLocId: null, created: false, createdAt: null,
      env: null, everConnected: false, busy: false,
      // Synology/Linux: 'code' = setup page of the gateway, 'file' = download gateway.env (the way before)
      way: 'code', pair: null, cwTimer: null, cwPoll: null, cwDone: false,
      pi: { model: 'pi4', net: 'lan', zigbee: 'auto', ssid: '', psk: '', hidden: false, hostname: '', hostnameDirty: false,
        tz: browserTz(), country: browserCountry(), ssh: '' },
      info: null, status: null, step4Since: 0, pollTimer: null, pollDelay: 3000, pairTimer: null, pairExpires: 0,
    };
  }
  function browserTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; } catch (e) { return 'Europe/Berlin'; }
  }
  function browserCountry() {
    var m = /^[a-z]{2,3}-([A-Z]{2})$/.exec(navigator.language || '');
    return m ? m[1] : 'DE';
  }
  function knownTimezones() {
    try { if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone'); } catch (e) { /* old browser */ }
    return ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Paris',
      'Europe/London', 'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Prague', 'Europe/Copenhagen',
      'Europe/Stockholm', 'Europe/Oslo', 'Europe/Helsinki', 'Europe/Lisbon', 'America/New_York', 'America/Chicago',
      'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opts.headers['X-CSRF-Token'] = csrf(); opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j = j || {}; j._status = r.status; return j; });
    });
  }
  function saveBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = T('gwiz.copied', 'Kopiert');
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { /* denied */ }); return; }
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  // ─── Error display ─────────────────────────────────────────────────────
  function setError(msg) { var e = $('gwz-error'); e.textContent = msg || ''; show(e, !!msg); }
  function fieldError(id, code) {
    var n = $(id + '-err');
    var input = $(id);
    if (n) { n.textContent = code ? T('gwiz.err.' + code, code) : ''; show(n, !!code); }
    if (input) { if (code) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }

  // ─── Steps ─────────────────────────────────────────────────────────────
  function isOpen() { return overlay.style.display === 'flex'; }

  function title() {
    var n = state.name;
    if (state.step === 1) return T('gwiz.add', 'Gateway hinzufügen');
    if (state.step === 2) return T('gwiz.s2.title', 'Raspberry Pi einstellen');
    if (state.step === 3) return T('gwiz.s3.title_' + state.platform, '„{{name}}“ einrichten', { name: n });
    var st = state.status;
    return st && st.connected ? T('gwiz.s4.title_done', '„{{name}}“ ist verbunden', { name: n }) : T('gwiz.s4.title', 'Warten auf „{{name}}“', { name: n });
  }

  function render() {
    overlay.querySelectorAll('.gwz-step').forEach(function (s) {
      var on = String(state.step) === s.getAttribute('data-step')
        && (!s.hasAttribute('data-platform') || s.getAttribute('data-platform') === state.platform)
        && (!s.hasAttribute('data-way') || s.getAttribute('data-way') === way());
      s.hidden = !on;
    });
    $('gwz-title').textContent = title();
    $('gwz-stepno').textContent = T('gwiz.step_of', 'Schritt {{n}} von 4', { n: state.step });
    overlay.querySelectorAll('.gwz-bar span').forEach(function (b, i) { b.classList.toggle('on', i < state.step); });

    var back = $('gwz-back');
    var next = $('gwz-next');
    var created = state.created;
    if (state.step === 1) {
      back.textContent = T('common.cancel', 'Abbrechen');
      next.textContent = (state.platform === 'rpi' || created) ? T('gwiz.next', 'Weiter') : T('gwiz.create_next', 'Gateway anlegen und weiter');
    } else if (state.step === 2) {
      back.textContent = T('gwiz.back', 'Zurück');
      next.textContent = created ? T('gwiz.next', 'Weiter') : T('gwiz.create_next', 'Gateway anlegen und weiter');
    } else if (state.step === 3) {
      back.textContent = T('gwiz.back', 'Zurück');
      next.textContent = T('gwiz.s3.next_' + state.platform, 'Weiter');
    } else {
      back.textContent = T('gwiz.s4.again', 'Anleitung nochmal');
      next.textContent = T('gwiz.s4.finish', 'Fertig – zum Gateway');
    }
    next.disabled = !!state.busy;
    renderStep1(); renderStep2(); renderStep3();
  }

  // Synology and Linux have two ways through step 3; the Pi and Proxmox keep their own.
  function way() { return state.platform === 'synology' || state.platform === 'linux' ? state.way : null; }

  function go(step) {
    setError('');
    stopPairing();
    stopCode();
    if (step !== 4) stopPolling();
    state.step = step;
    if (step === 2 && !state.pi.hostnameDirty) state.pi.hostname = kit.suggestHostname(state.name);
    if (step === 2) fillStep2();
    if (step === 3) enterStep3();
    if (step === 4) { state.step4Since = Date.now(); renderStatus(); startPolling(); }
    render();
    var body = overlay.querySelector('.gwz-body');
    if (body) body.scrollTop = 0;
    var t = $('gwz-title');
    if (t) t.focus();
  }

  // ── Step 1 ──
  function renderStep1() {
    if (state.step !== 1) return;
    $('gwz-name').disabled = state.created;
    $('gwz-location').disabled = state.created;
    show($('gwz-loc-new'), !state.created && $('gwz-location').value === 'new');
    show($('gwz-created-note'), state.created);
    // A gateway created before the assistant has no platform yet: pick one.
    var lockPlatform = state.created && !!state.platformLocked;
    overlay.querySelectorAll('input[name="gwz-platform"]').forEach(function (r) {
      r.checked = r.value === state.platform;
      r.disabled = lockPlatform;
      r.closest('.gwz-plat').classList.toggle('on', r.checked);
    });
  }
  // The gateway locations (GET /api/v1/gateway-locations): "Kein Standort", the list, "Neuer Standort …".
  function loadLocations() {
    var sel = $('gwz-location');
    api('GET', '/api/v1/gateway-locations').then(function (d) {
      var newOpt = sel.querySelector('option[value="new"]');
      Array.prototype.slice.call(sel.options).forEach(function (o) { if (o.value !== '' && o.value !== 'new') o.remove(); });
      (d.locations || []).forEach(function (l) {
        var o = document.createElement('option');
        o.value = String(l.id); o.textContent = l.city ? l.name + ' – ' + l.city : l.name;
        sel.insertBefore(o, newOpt);
      });
      sel.value = state.locationId || '';
      if (sel.value !== String(state.locationId || '')) sel.value = '';
      renderStep1();
    }).catch(function () { /* optional */ });
  }
  function fillCountries() {
    var sel = $('gwz-loc-country');
    if (!sel || sel.options.length || !LK) return;
    var none = document.createElement('option'); none.value = ''; none.textContent = '—'; sel.appendChild(none);
    LK.countryOptions((window.GC && GC.language) === 'en' ? 'en' : 'de').forEach(function (c) {
      var o = document.createElement('option'); o.value = c.code; o.textContent = c.name; sel.appendChild(o);
    });
    sel.value = '';
  }
  function readNewLoc() {
    return { name: $('gwz-loc-name').value, city: $('gwz-loc-city').value, street: $('gwz-loc-street').value,
      postal_code: $('gwz-loc-postal').value, country: $('gwz-loc-country').value };
  }
  var NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/;
  function step1Next() {
    if (!state.created) {
      state.name = $('gwz-name').value.trim();
      state.locationId = $('gwz-location').value;
      var bad = !state.name ? 'name_required' : (!NAME_RE.test(state.name) ? 'name_invalid' : null);
      fieldError('gwz-name', bad);
      if (bad) { $('gwz-name').focus(); return; }
      state.newLoc = null;
      if (state.locationId === 'new') {
        state.newLoc = LK ? LK.body(readNewLoc()) : readNewLoc();
        var lbad = !state.newLoc.name ? 'loc_name_required' : null;
        fieldError('gwz-loc-name', lbad);
        if (lbad) { $('gwz-loc-name').focus(); return; }
      }
    }
    var pe = $('gwz-platform-err');
    if (!state.platform) { pe.textContent = T('gwiz.err.platform_required', 'Bitte eine Plattform wählen.'); show(pe, true); return; }
    show(pe, false);
    if (state.created) {
      if (!state.platformLocked) {
        state.busy = true; render();
        api('PUT', '/api/v1/gateways/' + state.peerId + '/platform', { platform: state.platform }).then(function (d) {
          state.busy = false;
          if (!d.ok) { setError(d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.')); render(); return; }
          state.platformLocked = true;
          notifyList();
          go(state.platform === 'rpi' ? 2 : 3);
        }).catch(function () { state.busy = false; setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); render(); });
        return;
      }
      go(state.platform === 'rpi' ? 2 : 3);
      return;
    }
    if (state.platform === 'rpi') { go(2); return; }
    createGateway();
  }

  // ── Step 2 (Pi) ──
  function fillStep2() {
    var p = state.pi;
    setRadio('gwz-model', p.model);
    setRadio('gwz-net', p.net);
    setRadio('gwz-zigbee', p.zigbee);
    $('gwz-ssid').value = p.ssid;
    $('gwz-psk').value = p.psk;
    $('gwz-hidden').checked = !!p.hidden;
    $('gwz-hostname').value = p.hostname;
    $('gwz-country').value = p.country;
    $('gwz-ssh').value = p.ssh;
    var tz = $('gwz-tz');
    if (!tz.options.length) {
      var list = knownTimezones().slice();
      if (list.indexOf(p.tz) < 0) list.unshift(p.tz);
      list.forEach(function (z) { var o = document.createElement('option'); o.value = z; o.textContent = z; tz.appendChild(o); });
    }
    tz.value = p.tz;
  }
  function setRadio(name, value) {
    overlay.querySelectorAll('input[name="' + name + '"]').forEach(function (r) { r.checked = r.value === value; });
  }
  function radioValue(name) {
    var r = overlay.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : null;
  }
  function renderStep2() {
    if (state.step !== 2) return;
    var p = state.pi;
    $('gwz-model-hint').textContent = T('gwiz.model.' + p.model, '');
    // The Zero 2 W has no LAN port.
    var lan = overlay.querySelector('input[name="gwz-net"][value="lan"]');
    if (lan) lan.disabled = p.model === 'pizero2w';
    show($('gwz-wifi'), p.net === 'wifi');
  }
  function readStep2() {
    var p = state.pi;
    p.model = radioValue('gwz-model') || p.model;
    p.net = radioValue('gwz-net') || p.net;
    if (p.model === 'pizero2w') p.net = 'wifi';
    p.zigbee = radioValue('gwz-zigbee') || p.zigbee;
    p.ssid = $('gwz-ssid').value;
    p.psk = $('gwz-psk').value;
    p.hidden = $('gwz-hidden').checked;
    var hn = $('gwz-hostname').value.trim().toLowerCase();
    if (hn !== p.hostname) p.hostnameDirty = true;
    p.hostname = hn;
    p.tz = $('gwz-tz').value;
    p.country = $('gwz-country').value.trim().toUpperCase();
    p.ssh = $('gwz-ssh').value.trim();
  }
  function settings() {
    var p = state.pi;
    return kit.buildSettingsTxt({ hostname: p.hostname, zigbee: p.zigbee, timezone: p.tz, network: p.net, ssid: p.ssid, psk: p.psk,
      country: p.country, hidden: p.hidden, sshKey: p.ssh, knownTimezones: knownTimezones() });
  }
  function showSettingsErrors(errors) {
    var map = { ssid: 'gwz-ssid', psk: 'gwz-psk', hostname: 'gwz-hostname', timezone: 'gwz-tz', country: 'gwz-country', sshKey: 'gwz-ssh' };
    Object.keys(map).forEach(function (k) { fieldError(map[k], errors[k] || null); });
    var first = Object.keys(map).find(function (k) { return errors[k]; });
    if (first) {
      if (['hostname', 'timezone', 'country', 'sshKey'].indexOf(first) >= 0 && !(first === 'country' && state.pi.net !== 'wifi')) $('gwz-advanced').open = true;
      if (first === 'country') $('gwz-advanced').open = true;
      $(map[first]).focus();
    }
    return !!first;
  }
  function step2Next() {
    readStep2();
    var s = settings();
    if (showSettingsErrors(s.errors || {})) return;
    if (state.created) { go(3); return; }
    createGateway();
  }

  // ── Creation (the existing endpoint) ──
  // "Neuer Standort …": created first (once — a second try after a refused gateway reuses it)
  function ensureLocation() {
    if (state.locationId !== 'new') return Promise.resolve(state.locationId ? Number(state.locationId) : null);
    if (state.newLocId && state.newLocId.name === state.newLoc.name) return Promise.resolve(state.newLocId.id);
    return api('POST', '/api/v1/gateway-locations', state.newLoc).then(function (d) {
      if (!d.ok || !d.location) {
        var msg = (d.fields && (d.fields.name || d.fields.postal_code || d.fields.country)) || d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.');
        var e = new Error(msg); e.loc = true; e.field = d.fields && d.fields.name ? 'gwz-loc-name' : null; throw e;
      }
      state.newLocId = { id: d.location.id, name: d.location.name };
      return d.location.id;
    });
  }
  function createGateway() {
    if (state.busy) return;
    state.busy = true; setError(''); render();
    ensureLocation().then(function (locationId) {
      var body = { name: state.name, is_gateway: true, platform: state.platform };
      if (locationId) body.location_id = locationId;
      return api('POST', '/api/v1/peers', body);
    }).then(function (d) {
      state.busy = false;
      if (!d.ok || !d.peer) {
        if (d.fields && d.fields.name) {
          state.step = 1; render(); fieldError('gwz-name', null);
          var ne = $('gwz-name-err'); ne.textContent = d.fields.name; show(ne, true);
          $('gwz-name').setAttribute('aria-invalid', 'true');
        }
        setError(d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.'));
        render();
        return;
      }
      state.created = true;
      state.platformLocked = true;
      state.peerId = d.peer.id;
      state.createdAt = Date.now();
      state.env = d.gateway && d.gateway.envContent ? d.gateway.envContent : null;
      // A reload continues here (#setup/<id>) instead of creating a second one.
      try { history.replaceState(null, '', location.pathname + location.search + '#setup/' + d.peer.id); } catch (e) { /* ignore */ }
      notifyList();
      go(3);
    }).catch(function (err) {
      state.busy = false;
      if (err && err.loc) {
        state.step = 1; render();
        if (err.field) { var le = $('gwz-loc-name-err'); le.textContent = err.message; show(le, true); $('gwz-loc-name').setAttribute('aria-invalid', 'true'); }
        setError(T('gwiz.err.loc_failed', 'Der Standort konnte nicht angelegt werden: {{error}}', { error: err.message }));
        render();
        return;
      }
      setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); render();
    });
  }
  function notifyList() { document.dispatchEvent(new CustomEvent('gc:gateway-wizard', { detail: { peerId: state.peerId } })); }

  /** gateway.env: from the creation response, else new tokens (asks first when the gateway already ran). */
  function ensureEnv() {
    if (state.env) return Promise.resolve(state.env);
    var ask = state.everConnected
      ? D.confirm({ message: T('gwiz.rotate_confirm', ''), danger: true, okLabel: T('gwiz.rotate_ok', 'Neu erzeugen') })
      : Promise.resolve(true);
    return ask.then(function (ok) {
      if (!ok) return null;
      return api('POST', '/api/v1/peers/' + state.peerId + '/gateway-env/rotate', {}).then(function (d) {
        if (!d.ok || !d.envContent) { setError(d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.')); return null; }
        state.env = d.envContent;
        renderStep3();
        return state.env;
      });
    });
  }

  // ── Step 3 ──
  function enterStep3() {
    if (state.platform === 'proxmox') loadPairing();
    if (way() === 'code') { loadCode(); startCodePoll(); }
  }
  function fmtMB(n) { return n ? Math.round(n / 1048576) + ' MB' : ''; }
  // "Ausführliche Anleitung im Handbuch" of every platform: the handbook of the
  // Gateways page at that chapter (#gw/<id>/handbook/<anchor>, gateway-docs.js)
  // — in a new tab, the assistant stays open. The gateway exists from step 3
  // on; without it (or for a topic outside the handbook) the link of the page
  // stays: the user guide.
  var HB_TOPICS = {};
  try { HB_TOPICS = JSON.parse((document.getElementById('gw-handbook-topics') || {}).textContent || '{}') || {}; } catch (e) { HB_TOPICS = {}; }
  function guideLinks() {
    var DK = window.GCGatewayDocsKit;
    overlay.querySelectorAll('a[data-guide]').forEach(function (a) {
      if (a.dataset.guideExt == null) a.dataset.guideExt = a.getAttribute('href') || '';
      var hash = DK && DK.topicHash ? DK.topicHash(state.peerId, a.dataset.guide, HB_TOPICS) : null;
      a.setAttribute('href', hash ? location.pathname + hash : a.dataset.guideExt);
    });
  }
  function renderStep3() {
    if (state.step !== 3) return;
    guideLinks();
    overlay.querySelectorAll('.gwz-rotate-note').forEach(function (n) { n.hidden = !!state.env; });
    var info = state.info || {};
    if (state.platform === 'rpi') {
      var p = state.pi;
      $('gwz-pi-need').textContent = T('gwiz.pi.need', '', { model: MODEL_NAME[p.model] || 'Raspberry Pi' });
      $('gwz-pi-imager-device').textContent = MODEL_DEVICE[p.model] || 'Raspberry Pi';
      var a = $('gwz-pi-image');
      var img = info.rpi_image;
      if (img && img.url) {
        var m = /gatecontrol-gateway-(.+)-rpi-arm64\.img\.xz$/.exec(img.name || '');
        var parts = [m ? 'v' + m[1] : null, fmtMB(img.size)].filter(Boolean);
        a.href = img.url;
        $('gwz-pi-image-label').textContent = T('gwiz.pi.dl_image', 'Pi-Image') + (parts.length ? ' (' + parts.join(' · ') + ')' : '');
      } else {
        a.href = info.releases_url || kit.RELEASES_URL;
        $('gwz-pi-image-label').textContent = T('gwiz.pi.dl_image_page', 'Pi-Image (Release-Seite)');
      }
      $('gwz-imager-url').textContent = info.imager_repo_url || kit.IMAGER_REPO_URL;
      var sum = $('gwz-pi-summary');
      if (sum) {
        var bits = [p.net === 'wifi' ? T('gwiz.pi.sum_wifi', 'WLAN „{{ssid}}“', { ssid: p.ssid }) : T('gwiz.s2.net_lan', 'LAN-Kabel'),
          T('gwiz.pi.sum_zigbee_' + p.zigbee, 'Zigbee'), p.hostname || kit.suggestHostname(state.name)];
        if (p.ssh) bits.push(T('gwiz.pi.sum_ssh', 'SSH mit Schlüssel'));
        $('gwz-pi-summary-text').textContent = bits.join(' · ');
      }
    }
    if (way() === 'code') { renderCodeWay(); return; }
    if (state.platform === 'synology') {
      $('gwz-nas-cmd').textContent = kit.nasTaskCommand(kit.NAS_DIR);
    } else if (state.platform === 'linux') {
      var net = radioValue('gwz-linux-net') || 'host';
      $('gwz-linux-compose-text').textContent = kit.buildCompose({ platform: 'linux', network: net });
      $('gwz-linux-net-hint').textContent = T('gwiz.linux.net_hint_' + net, '');
      $('gwz-linux-update').href = '/api/v1/gateways/' + state.peerId + '/update-sh';
    }
  }

  function downloadPiSetup() {
    var s = settings();
    if (s.errors) { go(2); showSettingsErrors(s.errors); return; }
    ensureEnv().then(function (env) {
      if (!env) return;
      var zip = kit.piSetupZip(env, s.text);
      saveBlob(new Blob([zip], { type: 'application/zip' }), 'gatecontrol-setup.zip');
    }).catch(function () { setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
  }

  function downloadNasBundle() {
    var ask = state.everConnected
      ? D.confirm({ message: T('gwiz.rotate_confirm', ''), danger: true, okLabel: T('gwiz.rotate_ok', 'Neu erzeugen') })
      : Promise.resolve(true);
    ask.then(function (ok) {
      if (!ok) return;
      return fetch('/api/v1/gateways/' + state.peerId + '/setup-bundle', {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf(), 'Content-Type': 'application/json' }, body: '{}',
      }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { setError(j.error || T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
        state.env = null; // the tokens of the creation response are no longer valid
        return r.blob().then(function (b) { saveBlob(b, 'gatecontrol-gateway-nas.zip'); });
      });
    }).catch(function () { setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
  }

  // ── Step 3, Synology/Linux through the setup page of the gateway ──
  function cwNet() { return state.platform === 'linux' ? (radioValue('gwz-cw-net') || 'host') : 'host'; }
  function cwCompose() { return kit.buildCompose({ platform: state.platform, network: cwNet() }); }
  function renderCodeWay() {
    var pf = state.platform;
    var linux = pf === 'linux';
    $('gwz-cw-need').textContent = T('gwiz.cw.need_' + pf, '');
    $('gwz-cw-s1-title').textContent = T('gwiz.cw.s1_title_' + pf, '');
    $('gwz-cw-s1-text').textContent = T('gwiz.cw.s1_text_' + pf, '');
    $('gwz-cw-s1-hint').textContent = T('gwiz.cw.s1_hint_' + pf, '');
    show($('gwz-cw-net'), linux);
    show($('gwz-cw-up'), linux);
    show($('gwz-cw-package'), !linux);
    if (linux) $('gwz-cw-net-hint').textContent = T('gwiz.linux.net_hint_' + cwNet(), '');
    $('gwz-cw-compose').textContent = cwCompose();
    $('gwz-cw-url').textContent = T('gwiz.cw.url_' + pf, 'http://<…>:8642');
    // automatic updates: the same command as before, collapsed
    $('gwz-cw-update-text').textContent = T(linux ? 'gwiz.linux.update_text' : 'gwiz.nas.update_text', '');
    $('gwz-cw-update-cmd').textContent = linux ? $('gwz-linux-cron').textContent : kit.nasTaskCommand(kit.NAS_DIR);
    $('gwz-cw-update-hint').textContent = linux ? '' : T('gwiz.nas.volume_hint', '');
    var sh = $('gwz-cw-update-sh');
    sh.href = '/api/v1/gateways/' + state.peerId + '/update-sh';
    show(sh, linux);
    renderCode();
  }
  function renderCode() {
    var p = state.pair;
    $('gwz-cw-server').textContent = p ? p.server : '…';
    $('gwz-cw-code').textContent = p ? p.code : T('gwiz.pve.generating', 'Wird erzeugt …');
    tickCode();
    $('gwz-cw-wait').classList.toggle('done', !!state.cwDone);
    $('gwz-cw-wait-text').textContent = state.cwDone ? T('gwiz.cw.redeemed', '') : T('gwiz.cw.wait', '');
  }
  function tickCode() {
    var el = $('gwz-cw-countdown');
    var p = state.pair;
    if (!p) { el.textContent = ''; return; }
    var ms = p.expiresAt - Date.now();
    el.classList.toggle('over', ms <= 0);
    if (ms <= 0) { el.textContent = T('gwiz.cw.expired', 'abgelaufen'); return; }
    var sec = Math.floor(ms / 1000);
    el.textContent = T('gwiz.cw.left', 'noch {{t}}', { t: Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') });
  }
  /** A fresh setup code (the one before stops working). Creating it changes nothing for a running gateway. */
  function loadCode() {
    state.pair = null; state.cwDone = false;
    renderCode();
    var id = state.peerId;
    api('POST', '/api/v1/peers/' + id + '/gateway-pairing-code', {}).then(function (d) {
      if (!state || state.peerId !== id || state.step !== 3 || way() !== 'code') return;
      if (!d.ok || !d.code) { $('gwz-cw-code').textContent = '—'; setError(d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.')); return; }
      // a server before the two fields: CODE@host
      var server = d.server || String(d.token || '').split('@')[1] || location.host;
      state.pair = { code: d.code, server: server, expiresAt: d.expiresAt };
      renderCode();
      if (state.cwTimer) clearInterval(state.cwTimer);
      state.cwTimer = setInterval(tickCode, 1000);
    }).catch(function () { setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
  }
  // "geht von selbst weiter": the status says when the gateway redeemed the code
  function startCodePoll() {
    if (state.cwPoll) clearTimeout(state.cwPoll);
    state.cwPoll = setTimeout(pollCode, 3000);
  }
  function pollCode() {
    if (!state || !isOpen() || state.step !== 3 || way() !== 'code') return;
    var id = state.peerId;
    api('GET', '/api/v1/gateways/' + id + '/setup-status').then(function (d) {
      if (!state || state.peerId !== id || state.step !== 3 || way() !== 'code') return;
      var pr = d.ok && d.gateway && d.gateway.pairing;
      if (pr && state.pair && pr.consumed_at && pr.expires_at === state.pair.expiresAt) {
        state.cwDone = true;
        state.status = d.gateway;
        renderCode();
        setTimeout(function () { if (state && state.peerId === id && state.step === 3 && isOpen()) go(4); }, 1200);
        return;
      }
      startCodePoll();
    }).catch(function () { startCodePoll(); });
  }
  function stopCode() {
    if (!state) return;
    if (state.cwTimer) { clearInterval(state.cwTimer); state.cwTimer = null; }
    if (state.cwPoll) { clearTimeout(state.cwPoll); state.cwPoll = null; }
  }
  function downloadPackage() {
    fetch('/api/v1/gateways/' + state.peerId + '/setup-package', {
      method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf(), 'Content-Type': 'application/json' }, body: '{}',
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { setError(j.error || T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
      return r.blob().then(function (b) { saveBlob(b, 'gatecontrol-gateway-nas.zip'); });
    }).catch(function () { setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
  }

  // Proxmox pairing code (10 min, single active per gateway)
  function loadPairing() {
    stopPairing();
    $('gwz-pve-cmd').textContent = T('gwiz.pve.generating', 'Wird erzeugt …');
    $('gwz-pve-countdown').textContent = '';
    api('POST', '/api/v1/peers/' + state.peerId + '/gateway-pairing-code', {}).then(function (d) {
      if (!d.ok || !d.token) { $('gwz-pve-cmd').textContent = ''; setError(d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.')); return; }
      $('gwz-pve-cmd').textContent = kit.pairingCommand(d.token);
      state.pairExpires = d.expiresAt;
      tickPairing();
      state.pairTimer = setInterval(tickPairing, 1000);
    }).catch(function () { setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); });
  }
  function tickPairing() {
    var ms = state.pairExpires - Date.now();
    var el = $('gwz-pve-countdown');
    if (ms <= 0) { el.textContent = T('gwiz.pve.expired', 'Abgelaufen – neuen Code erzeugen.'); stopPairing(); return; }
    var s = Math.floor(ms / 1000);
    el.textContent = T('gwiz.pve.valid_for', 'Gültig noch {{t}}', { t: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') });
  }
  function stopPairing() { if (state && state.pairTimer) { clearInterval(state.pairTimer); state.pairTimer = null; } }

  // ── Step 4: live status ──
  function startPolling() { stopPolling(); state.pollDelay = 3000; poll(); }
  function stopPolling() { if (state && state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; } }
  function schedule(ms) { stopPolling(); state.pollTimer = setTimeout(poll, ms); }
  function poll() {
    if (!isOpen() || state.step !== 4 || !state.peerId) return;
    api('GET', '/api/v1/gateways/' + state.peerId + '/setup-status').then(function (d) {
      if (!isOpen() || state.step !== 4) return;
      if (d.ok && d.gateway) { state.status = d.gateway; if (d.gateway.connected) state.everConnected = true; renderStatus(); render(); }
      var st = state.status || {};
      var settled = st.connected && (st.hardware || st.hardware_supported === false)
        && (!st.zigbee || (st.deconz && st.deconz.reachable === true));
      // back-off: 3 s → ×1.5 → 15 s while waiting, 30 s once everything is there
      state.pollDelay = settled ? 30000 : Math.min(15000, Math.round(state.pollDelay * 1.5));
      schedule(state.pollDelay);
    }).catch(function () { state.pollDelay = Math.min(30000, state.pollDelay * 2); schedule(state.pollDelay); });
  }
  function hhmm(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function gb(n, digits) { return n ? (Math.round(n / 1073741824 * (digits || 1)) / (digits || 1)) + ' GB' : null; }
  function setCheck(name, cls, titleText, sub) {
    var li = overlay.querySelector('#gwz-checks [data-check="' + name + '"]');
    if (!li) return null;
    var dot = li.querySelector('.gwz-dot');
    dot.className = 'gwz-dot ' + cls;
    var stateWord = T('gwiz.s4.state_' + cls, cls);
    dot.setAttribute('title', stateWord);
    var t = li.querySelector('[data-title]');
    if (t && titleText != null) t.textContent = titleText;
    var s = li.querySelector('[data-sub]');
    if (s) s.textContent = sub || '';
    li.setAttribute('data-state', cls);
    return li;
  }
  function renderStatus() {
    var st = state.status || {};
    var platformWord = T('gwiz.s4.contact_' + (state.platform || 'other'), T('gwiz.s4.contact_other', 'Gateway hat sich gemeldet'));
    setCheck('created', 'done', null, T('gwiz.s4.created_sub', 'Zugangsschlüssel erstellt · {{t}}', { t: hhmm(st.created_at || state.createdAt) }));

    if (st.connected) {
      var sub = st.first_seen_at ? T('gwiz.s4.contact_sub', 'Erster Kontakt um {{t}}', { t: hhmm(st.first_seen_at) }) : '';
      if (st.tunnel_up) sub += (sub ? ' · ' : '') + T('gwiz.s4.tunnel_up', 'Tunnel steht');
      setCheck('contact', 'done', platformWord, sub);
    } else {
      setCheck('contact', 'wait', T('gwiz.s4.contact_wait', 'Warten auf den ersten Kontakt …'),
        state.platform === 'rpi' ? T('gwiz.s4.contact_wait_pi', '') : '');
    }

    var hw = st.hardware;
    if (!st.connected) setCheck('hardware', 'wait', null, '');
    else if (hw) {
      var parts = [hw.model, hw.cpu_cores ? T('gwiz.s4.cores', '{{n}} Kerne', { n: hw.cpu_cores }) : null,
        hw.mem_total ? T('gwiz.s4.ram', '{{x}} RAM', { x: gb(hw.mem_total) }) : null,
        hw.storage_free ? T('gwiz.s4.free', '{{x}} frei', { x: gb(hw.storage_free) }) : null,
        st.gateway_version ? 'Gateway ' + st.gateway_version : null].filter(Boolean);
      setCheck('hardware', 'done', null, parts.join(' · '));
    } else if (st.hardware_supported === false) {
      setCheck('hardware', 'skip', null, T('gwiz.s4.hardware_old', '', { v: st.gateway_version || '?' }));
    } else setCheck('hardware', 'run', null, '');

    var zb = st.zigbee;
    var zli = overlay.querySelector('#gwz-checks [data-check="zigbee"]');
    zli.hidden = !zb;
    if (zb) {
      var label = zb.label || T('gwiz.s4.zigbee_radio', 'Funkmodul');
      var running = st.deconz && st.deconz.reachable === true;
      setCheck('zigbee', running ? 'done' : 'run',
        running ? T('gwiz.s4.zigbee_running', 'Zigbee: {{radio}} – deCONZ läuft', { radio: label }) : T('gwiz.s4.zigbee_starting', 'Zigbee: {{radio}} gefunden – deCONZ startet …', { radio: label }),
        T('gwiz.s4.zigbee_sub', ''));
      var ph = $('gwz-phoscon');
      var lan = $('gwz-phoscon-lan');
      if (st.deconz && st.deconz.url) { ph.href = st.deconz.url; show(ph, true); show(lan, false); }
      else {
        show(ph, false);
        var host = st.hostname || (state.platform === 'rpi' && state.pi.hostname) || st.lan_ip;
        lan.textContent = host ? T('gwiz.s4.phoscon_lan', 'Phoscon im Heimnetz: {{url}}', { url: 'http://' + host + ':' + kit.DECONZ_PORT }) : '';
        show(lan, !!host);
      }
      var sh = st.smarthome || {};
      var btn = $('gwz-smarthome');
      var open = $('gwz-smarthome-open');
      var msg = $('gwz-smarthome-msg');
      if (!sh.installed) {
        show(btn, false);
        open.href = '/settings/plugins/catalog/gatecontrol-smarthome';
        open.textContent = T('gwiz.s4.smarthome_install', 'Smart-Home-Plugin installieren');
        show(open, true);
        msg.textContent = T('gwiz.s4.smarthome_missing', '');
        show(msg, true);
      } else if (sh.assigned) {
        show(btn, false);
        open.href = sh.plugin_url || '/plugins/gatecontrol-smarthome';
        open.textContent = T('gwiz.s4.smarthome_open', 'Smart Home öffnen');
        show(open, true);
        msg.textContent = T('gwiz.s4.smarthome_done', '');
        show(msg, true);
      } else {
        show(btn, !!sh.target_declared);
        show(open, false);
        if (!msg.dataset.keep) { msg.textContent = ''; show(msg, false); }
      }
    }

    var help = !st.connected && state.step4Since && (Date.now() - state.step4Since > HELP_AFTER_MS);
    $('gwz-help-text').textContent = T('gwiz.s4.help_' + (state.platform || 'linux'), T('gwiz.s4.help_linux', ''));
    show($('gwz-help'), !!help);
  }

  function connectSmarthome() {
    var st = state.status || {};
    var zone = (state.info && state.info.dns_domain) || 'gc.internal';
    var suggestion = 'phoscon-' + kit.suggestHostname(state.name).replace(/^gc-/, '') + '.' + zone;
    var hasRoute = !!(st.deconz && st.deconz.route_id);
    var ask = hasRoute
      ? D.confirm({ title: T('gwiz.s4.smarthome', 'Im Smart Home einbinden'), message: T('gwiz.s4.smarthome_confirm_route', ''), okLabel: T('gwiz.s4.smarthome_ok', 'Einbinden') })
        .then(function (ok) { return ok ? '' : null; })
      : D.prompt({ title: T('gwiz.s4.smarthome', 'Im Smart Home einbinden'), message: T('gwiz.s4.smarthome_confirm', ''),
        label: T('gwiz.s4.smarthome_domain', 'Adresse der Route (nur über VPN erreichbar)'), value: suggestion, maxLength: 253,
        okLabel: T('gwiz.s4.smarthome_ok', 'Einbinden'),
        validate: function (v) { return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(v) ? null : T('gwiz.err.domain_invalid', 'Ungültige Adresse'); } });
    ask.then(function (domain) {
      if (domain == null) return;
      var btn = $('gwz-smarthome');
      btn.disabled = true;
      return api('POST', '/api/v1/gateways/' + state.peerId + '/smarthome', domain ? { domain: domain } : {}).then(function (d) {
        btn.disabled = false;
        var msg = $('gwz-smarthome-msg');
        if (!d.ok) { msg.textContent = d.error || T('gwiz.err.generic', 'Das hat nicht geklappt.'); msg.dataset.keep = '1'; show(msg, true); return; }
        delete msg.dataset.keep;
        poll();
      });
    }).catch(function () { $('gwz-smarthome').disabled = false; });
  }

  // ─── Open / close ──────────────────────────────────────────────────────
  function loadInfo() {
    return api('GET', '/api/v1/gateways/setup-info').then(function (d) { if (d.ok) { state.info = d; renderStep3(); } }).catch(function () { /* fallbacks */ });
  }

  function resetForm() {
    $('gwz-name').value = '';
    fieldError('gwz-name', null);
    fillCountries();
    $('gwz-location').value = '';
    ['gwz-loc-name', 'gwz-loc-city', 'gwz-loc-street', 'gwz-loc-postal'].forEach(function (id) { $(id).value = ''; });
    $('gwz-loc-country').value = '';
    $('gwz-loc-more').open = false;
    fieldError('gwz-loc-name', null);
    show($('gwz-platform-err'), false);
    ['gwz-ssid', 'gwz-psk', 'gwz-hostname', 'gwz-tz', 'gwz-country', 'gwz-ssh'].forEach(function (id) { fieldError(id, null); });
    $('gwz-advanced').open = false;
    var msg = $('gwz-smarthome-msg'); if (msg) { delete msg.dataset.keep; msg.textContent = ''; msg.hidden = true; }
    setError('');
  }

  function open(opts) {
    var o = opts || {};
    if (state) { stopPolling(); stopPairing(); stopCode(); }
    state = freshState();
    // "gateway.env neu herunterladen (bisheriger Weg)" of the gateway management
    if (o.way === 'file') state.way = 'file';
    resetForm();
    if (window.openModal) window.openModal('gwz-overlay'); else overlay.style.display = 'flex';
    loadInfo();
    if (o.mode === 'resume' && o.id) {
      state.peerId = Number(o.id);
      state.created = true;
      state.busy = true;
      state.step = 1;
      render();
      api('GET', '/api/v1/gateways/' + encodeURIComponent(o.id) + '/setup-status').then(function (d) {
        state.busy = false;
        if (!d.ok || !d.gateway) { close(); if (D) D.alert({ message: T('gwiz.err.not_found', 'Dieses Gateway gibt es nicht mehr.'), danger: true }); return; }
        var g = d.gateway;
        state.status = g;
        state.name = g.name;
        state.createdAt = g.created_at;
        state.everConnected = !!g.connected;
        state.platform = g.platform;
        state.platformLocked = !!g.platform;
        state.pi.hostname = kit.suggestHostname(g.name);
        state.locationId = g.location_id ? String(g.location_id) : '';
        $('gwz-name').value = g.name;
        if (state.platform) go(3);
        else { loadLocations(); go(1); }
      }).catch(function () { state.busy = false; setError(T('gwiz.err.generic', 'Das hat nicht geklappt.')); render(); });
      return;
    }
    loadLocations();
    go(1);
    setTimeout(function () { $('gwz-name').focus(); }, 0);
  }

  function close() {
    stopPolling(); stopPairing(); stopCode();
    if (state) state.env = null;
    if (window.closeModal) window.closeModal('gwz-overlay'); else overlay.style.display = 'none';
    if (/^#(add|setup\/)/.test(location.hash)) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    }
    notifyList();
  }

  // ─── Events ────────────────────────────────────────────────────────────
  overlay.addEventListener('click', function (e) {
    if (e.target.closest('[data-gwz-close]')) { close(); return; }
    var cp = e.target.closest('[data-gwz-copy]');
    if (cp) { var src = $(cp.getAttribute('data-gwz-copy')); if (src) copyText(src.textContent, cp); return; }
    if (e.target.closest('#gwz-pi-setup')) { downloadPiSetup(); return; }
    if (e.target.closest('#gwz-pi-edit')) { go(2); return; }
    if (e.target.closest('#gwz-nas-bundle')) { downloadNasBundle(); return; }
    if (e.target.closest('#gwz-pve-regen')) { loadPairing(); return; }
    var wy = e.target.closest('[data-gwz-way]');
    if (wy) { state.way = wy.getAttribute('data-gwz-way') === 'file' ? 'file' : 'code'; go(3); return; }
    if (e.target.closest('#gwz-cw-regen')) { setError(''); loadCode(); startCodePoll(); return; }
    if (e.target.closest('#gwz-cw-download')) { saveBlob(new Blob([cwCompose()], { type: 'text/yaml' }), 'docker-compose.yml'); return; }
    if (e.target.closest('#gwz-cw-package')) { downloadPackage(); return; }
    if (e.target.closest('#gwz-smarthome')) { connectSmarthome(); return; }
    if (e.target.closest('#gwz-linux-compose')) {
      saveBlob(new Blob([kit.buildCompose({ platform: 'linux', network: radioValue('gwz-linux-net') || 'host' })], { type: 'text/yaml' }), 'docker-compose.yml');
      return;
    }
    if (e.target.closest('#gwz-linux-env')) {
      ensureEnv().then(function (env) { if (env) saveBlob(new Blob([env], { type: 'text/plain' }), 'gateway.env'); });
    }
  });
  // a corrected field loses its error right away
  overlay.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.id && t.getAttribute('aria-invalid') === 'true') fieldError(t.id, null);
  });
  overlay.addEventListener('change', function (e) {
    var n = e.target.name;
    if (n === 'gwz-platform') { state.platform = e.target.value; show($('gwz-platform-err'), false); render(); }
    else if (e.target.id === 'gwz-location') {
      renderStep1();
      if (e.target.value === 'new') $('gwz-loc-name').focus();
    }
    else if (n === 'gwz-model' || n === 'gwz-net' || n === 'gwz-zigbee') { readStep2(); renderStep2(); }
    else if (n === 'gwz-linux-net' || n === 'gwz-cw-net') renderStep3();
  });
  $('gwz-back').addEventListener('click', function () {
    if (state.busy) return;
    if (state.step === 1) { close(); return; }
    if (state.step === 2) { readStep2(); go(1); return; }
    if (state.step === 3) { go(state.platform === 'rpi' ? 2 : 1); return; }
    go(3);
  });
  $('gwz-next').addEventListener('click', function () {
    if (state.busy) return;
    if (state.step === 1) { step1Next(); return; }
    if (state.step === 2) { step2Next(); return; }
    if (state.step === 3) { go(4); return; }
    var id = state.peerId;
    close();
    location.hash = '#gw/' + encodeURIComponent(id);
  });
  // Enter in a text field = "Weiter" (not in the SSH key textarea).
  overlay.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio' && (state.step === 1 || state.step === 2)) {
      e.preventDefault();
      $('gwz-next').click();
    }
  });
  // app.js closes every overlay on Escape — clean up behind it.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !state) return;
    setTimeout(function () {
      if (isOpen()) return;
      stopPolling(); stopPairing(); stopCode();
      state.env = null;
      if (/^#(add|setup\/)/.test(location.hash)) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* ignore */ }
      }
    }, 0);
  });
  var evDeb = null;
  function onLive() {
    if (state && state.step === 3 && isOpen() && way() === 'code') { if (state.cwPoll) clearTimeout(state.cwPoll); state.cwPoll = setTimeout(pollCode, 600); return; }
    if (!state || state.step !== 4 || !isOpen()) return;
    clearTimeout(evDeb);
    evDeb = setTimeout(function () { state.pollDelay = 3000; poll(); }, 600);
  }
  document.addEventListener('gc:gateway', onLive);
  document.addEventListener('gc:reconnected', onLive);
  // the help box appears after 10 minutes even without a new status
  setInterval(function () { if (state && state.step === 4 && isOpen()) renderStatus(); }, 30000);

  window.GCGatewayWizard = { open: open, close: close, isOpen: isOpen };
})();
