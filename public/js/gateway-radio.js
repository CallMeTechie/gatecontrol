'use strict';

// Gateway detail › tab "Funk" (phase 3c, step 2: Zigbee with deCONZ or zigbee2mqtt, Bluetooth with keys
// for encrypted sensors, Thread with the OpenThread Border Router) and
// its row "Funk (Zigbee, Bluetooth, Thread)" in the group "Geräte im Heimnetz"
// of the tab "Funktionen". gateway-edge.js builds the tab bar and hands the tab
// to this module; gateway-net.js asks it for the row. Data: the admin API
// /api/v1/gateways/:id/radio (session + CSRF, routes/api/gatewayRadio.js) and
// the switches through PUT /api/v1/gateways/:id/features { radio }.
//
//   window.GCGatewayRadio.mount(box, g, tab, ctx)    → fills `box` with the tab 'radio'
//   window.GCGatewayRadio.featureRow(id, d, changed) → the row for the card (d = the features overview)
//   window.GCGatewayRadio.badge(node, id)            → the badge of the tab
//   window.GCGatewayRadio.prefetch(g) / unmount()
//
// Pure rules live in gateway-radio-kit.js. Nothing here uses innerHTML.
(function () {
  const E = window.GCGatewayEdge;
  const K = window.GCGatewayRadioKit;
  const D = window.GCDialog;
  if (!E || !E.ui || !K || !D) return;
  const U = E.ui;
  const h = D.el;
  const t = U.t;
  const LOCALE = U.LANG === 'en' ? 'en-GB' : 'de-DE';
  const API = '/api/v1/gateways/';
  const GW_RELEASES = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';

  function url(id, rest) { return API + encodeURIComponent(String(id)) + (rest || ''); }
  function has(key) { return t(key) !== key; }
  function errText(e) {
    const code = e && e.code;
    if (code && has('gwr.err.' + code)) return t('gwr.err.' + code);
    if (code && has('gwn.err.' + code)) return t('gwn.err.' + code);
    return U.errText(e);
  }
  function nf(v, digits) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString(LOCALE, { maximumFractionDigits: digits == null ? 0 : digits, minimumFractionDigits: digits || 0 });
  }

  // ─── Data cache ───────────────────────────────────────────────────────
  const cache = {};   // gateway id → { data, err, at, inflight }
  let cur = null;     // { box, g, tab }
  let timer = null;

  function entry(id) { const k = String(id); if (!cache[k]) cache[k] = { data: null, err: null, at: 0, inflight: null }; return cache[k]; }
  function load(id, force) {
    const e = entry(id);
    if (e.inflight) return e.inflight;
    if (!force && e.data && Date.now() - e.at < 8000) return Promise.resolve(e.data);
    e.inflight = U.api('GET', url(id, '/radio')).then((j) => {
      e.data = j.radio; e.err = null; e.at = Date.now(); e.inflight = null;
      return e.data;
    }, (err) => { e.err = err; e.inflight = null; throw err; });
    return e.inflight;
  }
  function redraw() {
    if (!cur || !cur.box.isConnected) return;
    const fk = cur.box.contains(document.activeElement) ? U.focusKey() : null;
    draw();
    U.restoreFocus(cur.box, fk);
  }
  function features(id) { if (window.GCGatewayNet && window.GCGatewayNet.reloadFeatures) return window.GCGatewayNet.reloadFeatures(id); return Promise.resolve(); }
  function badges(id) { if (E.fillBadges) E.fillBadges(document, id); }
  function reload(id) {
    return load(id, true).then(() => { redraw(); features(id).then(() => badges(id)); }, () => redraw());
  }

  // while the pairing window is open: count down every second, ask the gateway every 5 s
  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!cur) return;
    const d = entry(cur.g.peer_id).data;
    const z = d && d.radio && d.radio.zigbee;
    const left = z ? K.secondsLeft(z.permitUntil) : 0;
    if (left <= 0 && !(z && z.state === 'starting')) return;
    timer = setTimeout(() => {
      timer = null;
      if (!cur || !cur.box.isConnected) return;
      const e = entry(cur.g.peer_id);
      const p = Date.now() - e.at >= (left > 0 ? 5000 : 10000) ? load(cur.g.peer_id, true) : Promise.resolve();
      p.then(() => { updateCountdown(); if (Date.now() - entry(cur.g.peer_id).at < 1500) redraw(); }, () => {}).finally(schedule);
    }, 1000);
  }
  function updateCountdown() {
    if (!cur) return;
    const d = entry(cur.g.peer_id).data;
    const n = cur.box.querySelector('[data-radio-countdown]');
    if (!n || !d || !d.radio) return;
    const left = K.secondsLeft(d.radio.zigbee.permitUntil);
    n.textContent = left > 0 ? t('gwr.zb.searching', { time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') }) : '';
  }

  // ─── Settings ─────────────────────────────────────────────────────────
  function putRadio(id, patch, okMsg) {
    return U.api('PUT', url(id, '/features'), { radio: patch }).then(() => {
      if (okMsg) U.toast(okMsg);
      return reload(id);
    });
  }
  function toggle(btn, run) {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    return run(next).catch((e) => {
      btn.disabled = false;
      btn.setAttribute('aria-checked', next ? 'false' : 'true');
      D.alert({ message: errText(e), danger: true });
    });
  }
  function actBtn(label, fk, cls, run) {
    const b = h('button', { type: 'button', class: 'btn ' + (cls || 'btn-ghost btn-sm'), 'data-fk': fk, text: label });
    b.addEventListener('click', () => { b.disabled = true; Promise.resolve().then(run).catch((e) => D.alert({ message: errText(e), danger: true })).finally(() => { b.disabled = false; }); });
    return b;
  }

  // ─── Pieces ───────────────────────────────────────────────────────────
  function stickName(s) {
    if (!s) return '';
    const where = s.bus === 'uart' ? t('gwr.bus.uart') : s.bus === 'usb' ? t('gwr.bus.usb') : t('gwr.bus.builtin');
    return (s.model || t('gwr.stick.unknown')) + ' (' + where + ')';
  }
  function head(title, tagNode, sw) {
    return h('div', { class: 'gwr-head' }, [h('h3', { class: 'gwr-h', text: title }), h('div', { class: 'gwr-head-r' }, [tagNode, sw])]);
  }
  function section(key, children) {
    const id = 'gwr-' + key;
    const titleNode = children[0];
    if (titleNode && titleNode.querySelector) { const hh = titleNode.querySelector('h3'); if (hh) hh.id = id + '-h'; }
    return h('section', { class: 'gw gwe-card gwr-card', 'data-radio': key, 'aria-labelledby': id + '-h' }, h('div', { class: 'body gwe-body gwr-body' }, children));
  }
  function sub(text) { return h('p', { class: 'gwe-d gwr-sub', text }); }
  function smarthomeAction(d, kind, mac) {
    const sh = d.smarthome || {};
    const link = K.smarthomeLink(kind, mac);
    if (sh.installed && link && (kind === 'ble' || sh.assigned)) return h('a', { class: 'gwn-link', href: link, 'data-radio-name': kind, text: t('gwr.to_smarthome') });
    if (sh.installed && kind === 'zigbee' && !sh.assigned) {
      return actBtn(t('gwr.connect_smarthome'), 'gwr-connect-' + mac, 'btn-ghost btn-sm', () => U.api('POST', url(d.gateway.id, '/smarthome'), {})
        .then(() => { U.toast(t('gwr.connected_smarthome')); return reload(d.gateway.id); }));
    }
    return h('a', { class: 'gwn-link', href: '/settings/plugins/catalog/' + K.SMARTHOME, text: t('gwr.install_smarthome') });
  }

  // ═══ Zigbee ═══════════════════════════════════════════════════════════
  function stackSeg(g, d) {
    const id = g.peer_id;
    const cur0 = d.settings.stack || 'deconz';
    const seg = h('div', { class: 'gwe-seg', role: 'group', 'aria-label': t('gwr.zb.stack'), 'data-radio-stack': cur0 });
    ['deconz', 'zigbee2mqtt'].forEach((st) => {
      const b = h('button', { type: 'button', class: 'gwe-seg-b', 'aria-pressed': st === cur0 ? 'true' : 'false', 'data-fk': 'gwr-stack-' + st, 'data-stack': st, text: t('gwr.zb.stack.' + st) });
      if (!d.supported || (st === 'zigbee2mqtt' && !d.stacksSupported && cur0 !== st)) b.disabled = true;
      b.addEventListener('click', () => {
        if (st === (d.settings.stack || 'deconz')) return;
        seg.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        putRadio(id, { stack: st }, t('gwr.zb.stack_done', { name: t('gwr.zb.stack.' + st) })).catch((e) => { D.alert({ message: errText(e), danger: true }); redraw(); });
      });
      seg.appendChild(b);
    });
    return h('div', { class: 'gwr-stack' }, [h('span', { class: 'gwe-d', text: t('gwr.zb.stack') }), seg]);
  }

  /**
   * The sticks with what fits them ("passt zu zigbee2mqtt"), what they serve now and the choice
   * "Automatisch (Standard) / Zigbee / Thread / nicht verwenden" (d.sticks = stickPlan of the
   * server; sticks set by hand that are not plugged in are listed too). Hints, never bans.
   */
  function stickList(g, d) {
    const rows = Array.isArray(d.sticks) ? d.sticks : ((d.radio && d.radio.sticks) || []).filter((s) => s.kind !== 'bluetooth').map((s) => ({ ...s, choice: 'auto', present: true, hints: [] }));
    if (!rows.length) return null;
    const stack = d.settings.stack || 'deconz';
    return h('ul', { class: 'gwr-sticks', 'data-radio-sticks': String(rows.length) }, rows.map((s, i) => {
      const name = s.present ? stickName(s) : (s.model || t('gwr.stick.unknown'));
      const parts = [];
      if (!s.present) parts.push(t('gwr.stick.missing'));
      else {
        parts.push(s.use ? t('gwr.stick.use.' + s.use) : t('gwr.stick.use.none'));
        const fit = s.choice === 'auto' ? K.stickHint(s, stack) : null;
        if (fit) parts.push(t(fit.key));
      }
      const sel = h('select', { id: 'gwr-stick-' + i, class: 'form-select gwr-stick-sel', 'data-fk': 'gwr-stick-' + i, 'aria-label': t('gwr.stick.choice_for', { name }) },
        K.STICK_CHOICES.map((c) => h('option', { value: c, text: t('gwr.stick.choice.' + c) })));
      sel.value = s.choice || 'auto';
      if (!d.assignSupported || !s.id) sel.disabled = true;
      sel.addEventListener('change', () => {
        const use = sel.value;
        sel.disabled = true;
        U.api('PUT', url(g.peer_id, '/radio/sticks'), { id: s.id, use })
          .then(() => { U.toast(t('gwr.stick.done.' + use, { name })); return reload(g.peer_id); })
          .catch((e) => { D.alert({ message: errText(e), danger: true }); redraw(); });
      });
      const hints = K.stickHintKeys(s, stack).map((key) => h('li', { class: 'gwe-d', 'data-radio-stick-hint': key.replace('gwr.stick.hint.', '') }, [U.icon('info', 14), ' ', t(key)]));
      const idLine = s.id && s.idKind !== 'port' ? h('span', { class: 'gwe-d gwe-muted gwr-stick-id', text: t('gwr.stick.id', { id: s.id }) }) : null;
      return h('li', { class: 'gwr-stick', 'data-radio-stick': s.id || '', 'data-radio-choice': s.choice || 'auto', 'data-radio-present': s.present ? 'true' : 'false' }, [
        h('div', { class: 'gwr-stick-row' }, [
          h('div', { class: 'gwr-stick-t' }, [
            h('strong', { text: name }),
            h('span', { class: 'gwe-d', text: ' · ' + parts.join(' · ') }),
            idLine,
          ]),
          h('label', { class: 'gwr-stick-c' }, [h('span', { class: 'gwe-d', text: t('gwr.stick.choice') }), sel]),
        ]),
        hints.length ? h('ul', { class: 'gwr-stick-hints' }, hints) : null,
      ]);
    }));
  }

  function zigbeeCard(g, d) {
    if ((d.settings.stack || 'deconz') === 'zigbee2mqtt') return z2mCard(g, d);
    const r = d.radio || { zigbee: { state: 'off', recent: [] }, sticks: [] };
    const z = r.zigbee;
    const id = g.peer_id;
    const on = z.state === 'running' || (d.settings.zigbee === null ? z.want : d.settings.zigbee === true);
    const sw = U.switchBtn(on, t('gwr.zb.title'), 'gwr-zb', () => toggle(sw, (v) => putRadio(id, { zigbee: v }, t(v ? 'gwr.zb.on_done' : 'gwr.zb.off_done'))), !d.supported);
    const tx = K.zigbeeText(z);
    const tagNode = U.tag(K.zigbeeTone(z.state), t(tx.key, tx.params), true);
    tagNode.setAttribute('data-radio-state', z.state);
    const stick = (r.sticks || []).find((s) => s.use === 'deconz') || (r.sticks || []).find((s) => s.deconz);
    const subParts = [];
    if (stick || z.model) subParts.push(stick ? stickName(stick) : z.model);
    if (z.firmware) subParts.push(t('gwr.zb.firmware', { v: z.firmware.replace(/^0x/, '') }));
    if (z.channel) subParts.push(t('gwr.zb.channel', { n: z.channel }));
    const nodes = [head(t('gwr.zb.title'), tagNode, sw)];
    if (subParts.length) nodes.push(sub(subParts.join(' · ')));
    nodes.push(h('p', { class: 'gwe-d', text: t('gwr.zb.text') }));
    if (d.supported) nodes.push(stackSeg(g, d));
    if (d.supported && !d.stacksSupported) nodes.push(h('p', { class: 'gwe-d gwe-muted', 'data-radio-stack-old': '', text: t('gwr.zb.stack_old', { version: d.lastWithoutStacks || '1.31.0' }) }));
    if (d.settings.zigbee === null && d.supported) nodes.push(h('p', { class: 'gwe-d gwe-muted', 'data-radio-auto': '', text: t('gwr.zb.auto') }));
    // what is in the way
    const hint = zigbeeHint(g, d, z);
    if (hint) nodes.push(hint);
    if (z.state === 'running') nodes.push(pairBox(id, z));
    (z.recent || []).forEach((dev) => nodes.push(recentRow(d, dev)));
    if (z.state === 'running' && d.smarthome && d.smarthome.installed && !d.smarthome.assigned && !(z.recent || []).length) {
      nodes.push(h('div', { class: 'gwr-li' }, [h('span', { class: 'gwr-li-t gwe-d', text: t('gwr.zb.smarthome_hint') }), smarthomeAction(d, 'zigbee', '00:00:00:00:00:00:00:00')]));
    }
    return section('zigbee', nodes);
  }

  function pairBox(id, z) {
    const left = K.secondsLeft(z.permitUntil);
    const pairBtn = actBtn(t('gwr.zb.pair'), 'gwr-pair', 'btn-primary btn-sm', () => U.api('POST', url(id, '/radio/zigbee/pair'), {})
      .then(() => { U.toast(t('gwr.zb.pair_done')); return reload(id).then(schedule); }));
    if (left > 0) pairBtn.disabled = true;
    return h('div', { class: 'gwr-pair' }, [
      h('div', { class: 'gwr-pair-t' }, [h('strong', { text: t('gwr.zb.pair_title') }), h('span', { class: 'gwe-d', text: t('gwr.zb.pair_text') })]),
      h('div', { class: 'gwr-pair-a' }, [pairBtn, h('span', { class: 'gwe-d', role: 'status', 'data-radio-countdown': '', text: '' })]),
    ]);
  }

  function recentRow(d, dev) {
    const name = dev.name && !/^(OpenClose|Temperature|Humidity|Switch|Light|Presence)\s*\d*$/i.test(dev.name) && !/^0x[0-9a-f]{16}$/i.test(dev.name) ? dev.name : (dev.model || t('gwr.zb.device'));
    const ago = K.sinceMinutes(dev.at);
    return h('div', { class: 'gwr-li', 'data-radio-recent': dev.mac }, [
      U.tag('green', t('gwr.new')),
      h('span', { class: 'gwr-li-t' }, [h('strong', { text: name + (dev.manufacturer ? ' · ' + dev.manufacturer : '') }),
        h('span', { class: 'gwe-d', text: ago != null && ago < 2 ? t('gwr.zb.paired_now') : t('gwr.zb.paired_ago', { n: ago == null ? '?' : ago }) })]),
      smarthomeAction(d, 'zigbee', dev.mac),
    ]);
  }

  function zigbeeHint(g, d, z) {
    const st = z.state;
    const r = d.radio || {};
    if (z.service === 'image' && d.settings.zigbee !== null) return U.note('info', [t('gwr.zb.image')]);
    if (st === 'stick_missing') return U.note('warn', [h('span', { 'data-radio-stick-missing': 'zigbee', text: t('gwr.zb.stick_missing') })]);
    if (st === 'no_stick' && z.want) return U.note('info', [t('gwr.zb.no_stick')]);
    if (st === 'off' && !(r.sticks || []).some((s) => s.deconz)) {
      // a stick deCONZ does not speak, but zigbee2mqtt does: say so instead of the shopping list
      if (d.stacksSupported && (r.sticks || []).some((s) => !s.deconz && s.z2m)) return U.note('info', [t('gwr.zb.try_z2m')]);
      return U.note('info', [t('gwr.zb.which')]);
    }
    if (st === 'unsupported') {
      const names = (r.sticks || []).filter((s) => !s.deconz && s.kind !== 'bluetooth').map((s) => s.model).filter(Boolean).join(', ');
      return U.note('warn', [t(d.stacksSupported ? 'gwr.zb.unsupported_z2m' : 'gwr.zb.unsupported', { list: names || '—' })]);
    }
    if (st === 'service_missing' || d.compose === 'compose' || d.compose === 'image') return composeNote(g, d, 'gwr.zb.compose');
    if (st === 'key_needed') {
      return U.note('warn', [t('gwr.zb.key_needed'), ' ', actBtn(t('gwr.retry'), 'gwr-retry', 'btn-ghost btn-sm', () => U.api('POST', url(d.gateway.id, '/radio/zigbee/retry'), {}).then(() => reload(d.gateway.id)))]);
    }
    if (st === 'starting') return U.note('info', [t('gwr.zb.starting')]);
    if (st === 'error') {
      const code = z.error && z.error.code;
      return U.note('crit', [t(code && has('gwr.zb.err.' + code) ? 'gwr.zb.err.' + code : 'gwr.zb.err.other')]);
    }
    return null;
  }

  function composeNote(g, d, key) {
    if (d.compose === 'image' || (d.gateway.platform === 'rpi')) return U.note('warn', [t('gwr.zb.old_image'), ' ', h('a', { href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwr.releases') })]);
    const dl = window.GCGatewayCompose ? actBtn(t('gwr.compose'), 'gwr-compose', 'btn-ghost btn-sm', () => { window.GCGatewayCompose.open(cur ? cur.g : g, 'gwr-compose'); }) : null;
    return U.note('warn', [h('span', { 'data-radio-compose': '', text: t(key) }), ' ', dl]);
  }

  /** Hints, not bans: small board, firmware of multi sticks. */
  function boardNote(d, what) {
    if (!K.smallBoard(d.gateway)) return null;
    return U.note('info', [h('span', { 'data-radio-small': what, text: t('gwr.hint.small_board', { what: t('gwr.hint.small.' + what) }) })]);
  }
  function firmwareNote(d) {
    if (!((d.radio && d.radio.sticks) || []).some((s) => s.kind === 'multi')) return null;
    return h('p', { class: 'gwe-d gwe-muted', 'data-radio-firmware': '', text: t('gwr.hint.firmware') });
  }

  // ─── zigbee2mqtt ──────────────────────────────────────────────────────
  function z2mCard(g, d) {
    const r = d.radio || { sticks: [] };
    const z = r.zigbee2mqtt || { state: d.settings.zigbee === false ? 'off' : 'starting', recent: [] };
    const id = g.peer_id;
    const on = d.settings.zigbee !== false;
    const sw = U.switchBtn(on, t('gwr.zb.title'), 'gwr-zb', () => toggle(sw, (v) => putRadio(id, { zigbee: v }, t(v ? 'gwr.z2m.on_done' : 'gwr.zb.off_done'))), !d.supported);
    const tx = K.zigbeeText(z);
    const tagNode = U.tag(K.zigbeeTone(z.state), has('gwr.z2m.state.' + z.state) && z.state !== 'running' ? t('gwr.z2m.state.' + z.state) : t(tx.key, tx.params), true);
    tagNode.setAttribute('data-radio-state', z.state);
    const stick = (r.sticks || []).find((s) => s.use === 'zigbee2mqtt');
    const subParts = [];
    if (stick || z.model) subParts.push(stick ? stickName(stick) : z.model);
    if (z.version) subParts.push('zigbee2mqtt ' + z.version);
    if (z.firmware) subParts.push(t('gwr.zb.firmware', { v: z.firmware }));
    if (z.channel) subParts.push(t('gwr.zb.channel', { n: z.channel }));
    const nodes = [head(t('gwr.zb.title'), tagNode, sw)];
    if (subParts.length) nodes.push(sub(subParts.join(' · ')));
    nodes.push(h('p', { class: 'gwe-d', text: t('gwr.z2m.text') }));
    nodes.push(stackSeg(g, d));
    const hint = z2mHint(g, d, z);
    if (hint) nodes.push(hint);
    if (on) { const b = boardNote(d, 'z2m'); if (b) nodes.push(b); }
    if (z.state === 'running') nodes.push(pairBox(id, z));
    (z.recent || []).forEach((dev) => nodes.push(recentRow(d, dev)));
    const devs = (d.zigbeeDevices || []);
    if (devs.length) {
      nodes.push(h('h4', { class: 'gwr-h4', text: t('gwr.z2m.devices', { n: devs.length }) }));
      devs.forEach((dev) => nodes.push(z2mRow(g, d, dev)));
    } else if (z.state === 'running') nodes.push(h('p', { class: 'gwe-empty', text: t('gwr.z2m.none') }));
    if (z.state === 'running' && devs.length) nodes.push(h('p', { class: 'gwe-d gwe-muted', text: t(d.smarthome && d.smarthome.installed ? 'gwr.z2m.smarthome' : 'gwr.z2m.smarthome_install') }));
    return section('zigbee', nodes);
  }

  function z2mHint(g, d, z) {
    const st = z.state;
    if (st === 'mqtt_off' || st === 'mqtt_missing') {
      if (st === 'mqtt_missing') return composeNote(g, d, 'gwr.z2m.mqtt_missing');
      const e = d.edge || {};
      const b = actBtn(t(e.edgeEnabled ? 'gwr.z2m.mqtt_on' : 'gwr.z2m.edge_mqtt_on'), 'gwr-mqtt-on', 'btn-primary btn-sm', () => U.api('PUT', '/api/v1/edge/gateways/' + encodeURIComponent(String(g.peer_id)) + '/settings', { edgeEnabled: true, mqttEnabled: true })
        .then(() => { U.toast(t('gwr.z2m.mqtt_done')); return reload(g.peer_id); }));
      return U.note('warn', [h('span', { 'data-radio-mqtt-off': '', text: t('gwr.z2m.mqtt_off') }), ' ', b]);
    }
    if (st === 'stick_missing') return U.note('warn', [h('span', { 'data-radio-stick-missing': 'zigbee', text: t('gwr.zb.stick_missing') })]);
    if (st === 'unsupported') return U.note('warn', [t('gwr.z2m.unsupported')]);
    if (st === 'no_stick') return U.note('info', [t('gwr.z2m.no_stick')]);
    if (st === 'service_missing' || d.compose === 'compose' || d.compose === 'image') return composeNote(g, d, 'gwr.z2m.compose');
    if (st === 'starting') return U.note('info', [t('gwr.z2m.starting')]);
    if (st === 'error') {
      const code = z.error && z.error.code;
      return U.note('crit', [t(code && has('gwr.z2m.err.' + code) ? 'gwr.z2m.err.' + code : 'gwr.z2m.err.other')]);
    }
    return null;
  }

  function z2mRow(g, d, dev) {
    const name = dev.name && !/^0x[0-9a-f]{16}$/i.test(dev.name) ? dev.name : (dev.model || t('gwr.zb.device'));
    const parts = [];
    if (dev.vendor || dev.model) parts.push([dev.vendor, dev.model].filter(Boolean).join(' '));
    parts.push(t('gwr.z2m.kind.' + (dev.kind || 'other')));
    const v = dev.values || {};
    if (typeof v.on === 'boolean') parts.push(t(v.on ? 'gwr.z2m.on' : 'gwr.z2m.off') + (typeof v.bri === 'number' && v.on ? ' ' + nf(v.bri) + ' %' : ''));
    const vl = valuesLine(v);
    if (vl) parts.push(vl);
    const right = [];
    if (!dev.supported) right.push(U.tag('amber', t('gwr.z2m.unsupported')));
    else if (dev.interview !== 'done') right.push(U.tag('amber', t('gwr.z2m.interview.' + (dev.interview === 'failed' ? 'failed' : 'running'))));
    if (dev.available === false) right.push(U.tag('grey', t('gwr.z2m.offline')));
    K.sensorTags(v).filter((x) => x.tone !== 'grey').forEach((x) => right.push(U.tag(x.tone, t(x.key, x.params))));
    if (d.smarthome && d.smarthome.installed && dev.supported && dev.kind !== 'other') right.push(h('a', { class: 'gwn-link', href: K.smarthomeLink('zigbee', dev.ieee), text: t('gwr.to_smarthome') }));
    right.push(actBtn(t('gwr.z2m.remove'), 'gwr-rm-' + dev.ieee, 'btn-ghost btn-sm', () => D.confirm({ message: t('gwr.z2m.remove_q', { name }), danger: true, okLabel: t('gwr.z2m.remove') })
      .then((yes) => (yes ? U.api('POST', url(g.peer_id, '/radio/zigbee/remove'), { ieee: dev.ieee }).then(() => { U.toast(t('gwr.z2m.removed')); return reload(g.peer_id); }) : null))));
    return h('div', { class: 'gwr-li', 'data-radio-device': dev.ieee }, [
      h('span', { class: 'gwr-li-t' }, [h('strong', { text: name }), h('span', { class: 'gwe-d', text: parts.join(' · ') })]),
      h('span', { class: 'gwr-li-r' }, right),
    ]);
  }

  // ═══ Bluetooth ════════════════════════════════════════════════════════
  function valuesLine(values) {
    const parts = K.valueParts(values).map((p) => {
      if (p.flag !== undefined) return t('gwr.ble.flag.' + p.key + (p.flag ? '_on' : '_off'));
      return nf(p.value, p.digits) + (p.unit === '%' ? ' %' : ' ' + p.unit);
    });
    return parts.join(' · ');
  }

  function bleCard(g, d) {
    const r = d.radio || { ble: { state: 'off' } };
    const b = r.ble;
    const id = g.peer_id;
    const sw = U.switchBtn(!!d.settings.ble, t('gwr.ble.title'), 'gwr-ble', () => toggle(sw, (v) => putRadio(id, { ble: v }, t(v ? 'gwr.ble.on_done' : 'gwr.ble.off_done'))), !d.supported);
    const accepted = (d.sensors || []).filter((s) => s.accepted);
    const fresh = (d.sensors || []).filter((s) => !s.accepted && s.online);
    const tagNode = U.tag(K.bleTone(b.state), b.state === 'running' ? t(accepted.length === 1 ? 'gwr.ble.count_one' : 'gwr.ble.count', { n: accepted.length }) : t('gwr.ble.state.' + b.state), true);
    tagNode.setAttribute('data-radio-state', b.state);
    const nodes = [head(t('gwr.ble.title'), tagNode, sw)];
    const where = b.adapter ? (b.adapter.bus === 'usb' ? (b.adapter.model || t('gwr.ble.usb')) : t(d.gateway.platform === 'rpi' ? 'gwr.ble.builtin_pi' : 'gwr.ble.builtin')) : null;
    nodes.push(sub((where ? where + ' · ' : '') + t('gwr.ble.passive')));
    nodes.push(h('p', { class: 'gwe-d', text: t('gwr.ble.text') }));
    if (d.settings.ble && b.state === 'no_adapter') nodes.push(U.note('info', [t(d.gateway.platform === 'rpi' ? 'gwr.ble.no_adapter_pi' : (d.gateway.platform === 'synology' ? 'gwr.ble.no_adapter_nas' : 'gwr.ble.no_adapter'))]));
    if (d.settings.ble && b.state === 'error') {
      const code = b.error && b.error.code;
      nodes.push(U.note('crit', [t(code && has('gwr.ble.err.' + code) ? 'gwr.ble.err.' + code : 'gwr.ble.err.other')]));
    }
    if (d.settings.ble || accepted.length) {
      accepted.forEach((s) => nodes.push(sensorRow(g, d, s)));
      if (d.settings.ble) fresh.forEach((s) => nodes.push(sensorRow(g, d, s)));
      if (d.settings.ble && b.state === 'running' && !accepted.length && !fresh.length) nodes.push(h('p', { class: 'gwe-empty', text: t('gwr.ble.none') }));
      if ((d.sensors || []).some((s) => s.encrypted)) nodes.push(h('p', { class: 'gwe-d gwe-muted', text: t(d.stacksSupported ? 'gwr.ble.encrypted_keys' : 'gwr.ble.encrypted') }));
    }
    return section('ble', nodes);
  }

  /** The line of a sensor: its values, or why an encrypted one has none. */
  function sensorLine(d, s) {
    if (!s.encrypted) return valuesLine(s.values);
    if (!d.stacksSupported) return t('gwr.ble.encrypted_short');
    if (s.keyState === 'ok') return valuesLine(s.values) || t('gwr.ble.key.ok');
    if (s.hasKey && s.keyState === 'no_key') return t('gwr.ble.key.pending');
    return t('gwr.ble.key.' + (s.keyState || (s.hasKey ? 'pending' : 'no_key')));
  }

  function sensorRow(g, d, s) {
    const name = s.name || s.advName || s.model || t('gwr.ble.sensor');
    const line = sensorLine(d, s);
    const right = [];
    if (s.accepted) {
      K.sensorTags(s.values).forEach((x) => right.push(U.tag(x.tone, t(x.key, x.params))));
      if (s.encrypted && d.stacksSupported && s.keyState && s.keyState !== 'ok') right.push(U.tag(K.keyTone(s.keyState), t('gwr.ble.key.tag.' + s.keyState)));
      if (!s.online) right.push(U.tag('grey', t('gwr.ble.offline')));
      if (s.encrypted && d.stacksSupported) right.push(actBtn(t(s.hasKey ? 'gwr.ble.key.change' : 'gwr.ble.key.enter'), 'gwr-key-' + s.mac, 'btn-ghost btn-sm', () => keyDialog(g, s)));
      right.push(actBtn(t('gwr.ble.rename'), 'gwr-rn-' + s.mac, 'btn-ghost btn-sm', () => nameDialog(g, s, false)));
      right.push(smarthomeAction(d, 'ble', s.mac));
      return h('div', { class: 'gwr-li', 'data-radio-sensor': s.mac }, [
        h('span', { class: 'gwr-li-t' }, [h('strong', { text: name + (s.model && s.name ? ' · ' + s.model : '') }), h('span', { class: 'gwe-d', text: line || '—' })]),
        h('span', { class: 'gwr-li-r' }, right)]);
    }
    const mins = K.sinceMinutes(s.firstSeen);
    return h('div', { class: 'gwr-li gwr-li-new', 'data-radio-sensor': s.mac }, [
      h('span', { class: 'gwr-li-t' }, [h('strong', { text: t('gwr.ble.unknown') + ' · ' + s.mac.slice(0, 8) + ':…' }),
        h('span', { class: 'gwe-d', text: (s.model ? s.model + ' · ' : '') + t('gwr.ble.since', { n: mins == null ? '?' : Math.max(1, mins) }) + (line ? ' · ' + line : '') })]),
      h('span', { class: 'gwr-li-r' }, [actBtn(t('gwr.ble.accept'), 'gwr-acc-' + s.mac, 'btn-primary btn-sm', () => nameDialog(g, s, true))]),
    ]);
  }

  function nameDialog(g, s, accept) {
    const dlg = U.openDialog({ title: t(accept ? 'gwr.ble.accept_title' : 'gwr.ble.rename_title'), returnFk: 'gwr-acc-' + s.mac });
    const inp = h('input', { type: 'text', id: 'gwr-sname', class: 'form-input', maxlength: '60', value: s.name || s.advName || '' });
    const err = U.errorBox();
    dlg.body.append(
      h('p', { class: 'gwe-d', text: t('gwr.ble.accept_text', { mac: s.mac, model: s.model || t('gwr.ble.sensor') }) }),
      h('label', { class: 'form-label', for: 'gwr-sname', text: t('gwr.ble.name') }), inp);
    // an encrypted sensor: the key can come along right away (optional)
    const withKey = accept && s.encrypted && cur && entry(cur.g.peer_id).data && entry(cur.g.peer_id).data.stacksSupported;
    const keyInp = withKey ? h('input', { type: 'password', id: 'gwr-skey', class: 'form-input', autocomplete: 'off', spellcheck: 'false', maxlength: '64', placeholder: t('gwr.ble.key.placeholder') }) : null;
    if (keyInp) dlg.body.append(h('label', { class: 'form-label', for: 'gwr-skey', text: t('gwr.ble.key.label') }), keyInp, h('p', { class: 'gwe-d gwe-muted', text: t('gwr.ble.key.where.' + (s.format === 'mibeacon' ? 'mibeacon' : 'bthome')) }));
    dlg.body.append(err);
    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwr-sname-ok', text: t(accept ? 'gwr.ble.accept' : 'gwr.ble.save') });
    const drop = accept ? null : h('button', { type: 'button', class: 'btn btn-ghost', text: t('gwr.ble.give_back') });
    dlg.foot.append(...[drop, h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok].filter(Boolean));
    const send = (body) => U.api('PUT', url(g.peer_id, '/radio/sensors/' + encodeURIComponent(s.mac)), body)
      .then(() => { dlg.close(true); U.toast(t(body.accepted === false ? 'gwr.ble.given_back' : 'gwr.ble.saved')); return reload(g.peer_id); })
      .catch((e) => { U.showErr(err, errText(e)); ok.disabled = false; });
    ok.addEventListener('click', () => {
      const body = { accepted: true, name: inp.value.trim() || null };
      if (keyInp && keyInp.value.trim()) {
        if (!K.validKey(keyInp.value)) { U.showErr(err, t('gwr.err.invalid_key')); return; }
        body.key = keyInp.value.trim();
      }
      ok.disabled = true;
      send(body);
    });
    if (drop) drop.addEventListener('click', () => send({ accepted: false }));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    inp.focus();
  }

  function keyDialog(g, s) {
    const dlg = U.openDialog({ title: t('gwr.ble.key.title'), returnFk: 'gwr-key-' + s.mac });
    const inp = h('input', { type: 'password', id: 'gwr-key', class: 'form-input', autocomplete: 'off', spellcheck: 'false', maxlength: '64', placeholder: t('gwr.ble.key.placeholder') });
    const err = U.errorBox();
    dlg.body.append(
      h('p', { class: 'gwe-d', text: t('gwr.ble.key.text', { name: s.name || s.advName || s.mac }) }),
      h('p', { class: 'gwe-d gwe-muted', text: t('gwr.ble.key.where.' + (s.format === 'mibeacon' ? 'mibeacon' : 'bthome')) }),
      h('label', { class: 'form-label', for: 'gwr-key', text: t('gwr.ble.key.label') }), inp, err);
    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwr-key-ok', text: t('gwr.ble.save') });
    const drop = s.hasKey ? h('button', { type: 'button', class: 'btn btn-ghost', text: t('gwr.ble.key.remove') }) : null;
    dlg.foot.append(...[drop, h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok].filter(Boolean));
    const send = (key) => U.api('PUT', url(g.peer_id, '/radio/sensors/' + encodeURIComponent(s.mac)), { key })
      .then(() => { dlg.close(true); U.toast(t(key ? 'gwr.ble.key.saved' : 'gwr.ble.key.removed')); return reload(g.peer_id); })
      .catch((e) => { U.showErr(err, errText(e)); ok.disabled = false; });
    ok.addEventListener('click', () => {
      if (!K.validKey(inp.value)) { U.showErr(err, t('gwr.err.invalid_key')); return; }
      ok.disabled = true;
      send(inp.value.trim());
    });
    if (drop) drop.addEventListener('click', () => send(null));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    inp.focus();
  }

  // ═══ Thread ═══════════════════════════════════════════════════════════
  function threadCard(g, d) {
    const th = (d.radio && d.radio.thread) || { sticks: 0, models: [] };
    if (!d.stacksSupported || !th.supported) return threadOldCard(d, th);
    const id = g.peer_id;
    const sw = U.switchBtn(!!d.settings.thread, t('gwr.th.title'), 'gwr-th', () => toggle(sw, (v) => putRadio(id, { thread: v }, t(v ? 'gwr.th.on_done' : 'gwr.th.off_done'))), !d.supported);
    const st = d.settings.thread ? th.state : 'off';
    const tagNode = U.tag(K.threadTone(st), st === 'running' && th.role ? t('gwr.th.role.' + th.role) : t('gwr.th.state.' + st), true);
    tagNode.setAttribute('data-radio-state', st);
    const stick = ((d.radio && d.radio.sticks) || []).find((s) => s.use === 'thread');
    const subParts = [];
    if (stick) subParts.push(stickName(stick));
    else if (th.sticks > 0) subParts.push(t('gwr.th.found', { list: th.models.join(', ') || t('gwr.stick.unknown') }));
    else subParts.push(t('gwr.th.none'));
    const nodes = [head(t('gwr.th.title'), tagNode, sw), sub(subParts.join(' · ')), h('p', { class: 'gwe-d', text: t('gwr.th.text2') })];
    if (!d.settings.thread) {
      const f = firmwareNote(d);
      if (f) nodes.push(f);
      return section('thread', nodes);
    }
    const b = boardNote(d, 'thread');
    if (b) nodes.push(b);
    if (st === 'stick_missing') nodes.push(U.note('warn', [h('span', { 'data-radio-stick-missing': 'thread', text: t('gwr.th.stick_missing') })]));
    else if (st === 'stick_busy') nodes.push(U.note('warn', [t('gwr.th.stick_busy')]));
    else if (st === 'no_stick') nodes.push(U.note('info', [t('gwr.th.no_stick')]));
    else if (st === 'no_lan') nodes.push(U.note('warn', [t('gwr.th.no_lan')]));
    else if (st === 'service_missing' || (d.compose && th.service !== 'managed')) nodes.push(composeNote(g, d, 'gwr.th.compose'));
    else if (st === 'starting') nodes.push(U.note('info', [t('gwr.th.starting')]));
    else if (st === 'error') {
      const code = th.error && th.error.code;
      nodes.push(U.note('crit', [t(code && has('gwr.th.err.' + code) ? 'gwr.th.err.' + code : 'gwr.th.err.other')]));
    }
    if (st === 'no_network' || st === 'detached') {
      nodes.push(h('div', { class: 'gwr-pair' }, [
        h('div', { class: 'gwr-pair-t' }, [h('strong', { text: t('gwr.th.network_title') }), h('span', { class: 'gwe-d', text: t('gwr.th.network_text') })]),
        h('div', { class: 'gwr-pair-a' }, [
          actBtn(t('gwr.th.form'), 'gwr-th-form', 'btn-primary btn-sm', () => U.api('POST', url(id, '/radio/thread/form'), {}).then(() => { U.toast(t('gwr.th.formed')); return reload(id); })),
          actBtn(t('gwr.th.join'), 'gwr-th-join', 'btn-ghost btn-sm', () => joinDialog(g)),
        ]),
      ]));
    }
    if (th.network && (st === 'running' || st === 'detached')) {
      const n = th.network;
      const facts = [];
      if (n.name) facts.push(t('gwr.th.net.name', { v: n.name }));
      if (n.channel) facts.push(t('gwr.zb.channel', { n: n.channel }));
      if (n.panId != null) facts.push(t('gwr.th.net.pan', { v: '0x' + n.panId.toString(16).padStart(4, '0') }));
      if (n.extPanId) facts.push(t('gwr.th.net.ext', { v: n.extPanId }));
      if (Number.isInteger(th.routers)) facts.push(t(th.routers === 1 ? 'gwr.th.net.routers_one' : 'gwr.th.net.routers', { n: th.routers }));
      nodes.push(h('p', { class: 'gwe-d', 'data-radio-thread-net': '' }, facts.join(' · ')));
      nodes.push(h('div', { class: 'gwr-li' }, [
        h('span', { class: 'gwr-li-t gwe-d', text: t('gwr.th.dataset_text') }),
        actBtn(t('gwr.th.dataset'), 'gwr-th-ds', 'btn-ghost btn-sm', () => datasetDialog(g)),
      ]));
    }
    if (st === 'running') {
      if (th.forwarding === false) nodes.push(U.note('warn', [h('span', { 'data-radio-forwarding': '', text: t('gwr.th.forwarding') })]));
      nodes.push(U.note(K.matterReady(th) ? 'info' : 'warn', [h('span', { 'data-radio-matter': K.matterReady(th) ? 'ready' : 'not_ready', text: t(K.matterReady(th) ? 'gwr.th.matter_ready' : 'gwr.th.matter_not_ready') })]));
    }
    const f = firmwareNote(d);
    if (f) nodes.push(f);
    return section('thread', nodes);
  }

  function threadOldCard(d, th) {
    const found = th.sticks > 0;
    const tagNode = U.tag(found ? 'amber' : 'grey', t(found ? 'gwr.th.update' : 'gwr.th.unavailable'), true);
    const nodes = [head(t('gwr.th.title'), tagNode, null),
      sub(found ? t('gwr.th.found', { list: th.models.join(', ') || t('gwr.stick.unknown') }) : t('gwr.th.none')),
      h('p', { class: 'gwe-d', text: t('gwr.th.text2') })];
    if (found) nodes.push(U.note('info', [t('gwr.th.found_update', { version: d.lastWithoutStacks || '1.31.0' }), ' ', h('a', { href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwr.releases') })]));
    return section('thread', nodes);
  }

  function joinDialog(g) {
    const dlg = U.openDialog({ title: t('gwr.th.join_title'), returnFk: 'gwr-th-join' });
    const ta = h('textarea', { id: 'gwr-th-tlv', class: 'form-input', rows: '4', spellcheck: 'false', autocomplete: 'off', placeholder: '0e080000000000010000…' });
    const err = U.errorBox();
    dlg.body.append(h('p', { class: 'gwe-d', text: t('gwr.th.join_text') }), h('label', { class: 'form-label', for: 'gwr-th-tlv', text: t('gwr.th.join_label') }), ta, err);
    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwr-th-join-ok', text: t('gwr.th.join') });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok);
    ok.addEventListener('click', () => {
      const v = ta.value.replace(/\s+/g, '');
      if (!/^[0-9a-fA-F]{20,508}$/.test(v)) { U.showErr(err, t('gwr.err.invalid_dataset')); return; }
      ok.disabled = true;
      U.api('POST', url(g.peer_id, '/radio/thread/join'), { dataset: v })
        .then(() => { dlg.close(true); U.toast(t('gwr.th.joined')); return reload(g.peer_id); })
        .catch((e) => { U.showErr(err, errText(e)); ok.disabled = false; });
    });
    ta.focus();
  }

  function datasetDialog(g) {
    return U.api('POST', url(g.peer_id, '/radio/thread/dataset'), {}).then((j) => {
      const dlg = U.openDialog({ title: t('gwr.th.dataset_title'), returnFk: 'gwr-th-ds' });
      const ta = h('textarea', { id: 'gwr-th-ds-v', class: 'form-input', rows: '4', readonly: 'readonly', spellcheck: 'false' });
      ta.value = j.dataset || '';
      dlg.body.append(h('p', { class: 'gwe-d', text: t('gwr.th.dataset_secret') }), ta, h('p', { class: 'gwe-d gwe-muted', text: t('gwr.th.dataset_where') }));
      const copy = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwr.th.copy') });
      copy.addEventListener('click', () => {
        const done = () => U.toast(t('gwr.th.copied'));
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); });
        else { ta.select(); }
      });
      dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.close'), on: { click: () => dlg.close(null) } }), copy);
      ta.focus();
      ta.select();
    });
  }

  function nasCard(g, d) {
    const p = d.gateway.platform;
    if (p !== 'synology' && d.compose !== 'compose') return null;
    const dl = window.GCGatewayCompose && d.compose === 'compose' ? actBtn(t('gwr.compose'), 'gwr-compose-nas', 'btn-ghost btn-sm', () => { window.GCGatewayCompose.open(g, 'gwr-compose-nas'); }) : null;
    return h('div', { class: 'gwr-nas' }, [U.note('info', [h('strong', { text: t(p === 'synology' ? 'gwr.nas.title' : 'gwr.nas.title_linux') }), ' ', t('gwr.nas.text'), dl ? ' ' : null, dl])]);
  }

  // ─── Drawing ──────────────────────────────────────────────────────────
  function draw() {
    const e = entry(cur.g.peer_id);
    const nodes = [];
    if (!e.data) {
      if (e.err) {
        const retry = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('gwe.retry'), 'data-fk': 'retry', on: { click: () => reload(cur.g.peer_id) } });
        nodes.push(h('div', { class: 'gw gwe-card' }, h('div', { class: 'body gwe-body' }, [U.note('crit', [h('strong', { text: t('gwe.load_failed') }), ' ', errText(e.err)]), h('div', null, retry)])));
      } else nodes.push(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
      cur.box.replaceChildren(...nodes);
      return;
    }
    const d = e.data;
    if (!d.supported) {
      nodes.push(U.bigNote('warn', 'up', t('gwr.old.title', { min: d.minGateway }), t('gwr.old.text', { version: d.gateway.version || '—' }),
        [U.whatsNew(cur && cur.g)]));
    }
    nodes.push(h('p', { class: 'gwe-d gwr-lead' }, [t('gwr.lead'), ' ', U.guide('feat.radio')]));
    nodes.push(h('div', { class: 'gwr-grid' }, [zigbeeCard(cur.g, d), bleCard(cur.g, d), threadCard(cur.g, d)]));
    const st = stickList(cur.g, d);
    if (st) {
      const old = d.supported && !d.assignSupported
        ? h('p', { class: 'gwe-d gwe-muted', 'data-radio-assign-old': '' }, [t('gwr.stick.assign_old', { version: d.lastWithoutAssign || '1.33.1' }), ' ',
          h('a', { href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwr.releases') })])
        : null;
      nodes.push(h('section', { class: 'gwr-sticks-box', 'data-radio': 'sticks', 'aria-labelledby': 'gwr-sticks-h' }, [h('h3', { class: 'gwr-h', id: 'gwr-sticks-h', text: t('gwr.stick.title') }), st,
        h('p', { class: 'gwe-d gwe-muted', text: t('gwr.stick.one') }), old]));
    }
    const nas = nasCard(cur.g, d);
    if (nas) nodes.push(nas);
    cur.box.replaceChildren(...nodes);
    updateCountdown();
  }

  // ─── The row "Funk" in the tab "Funktionen" ───────────────────────────
  function featureRow(id, d, changed) {
    const r = d.radio;
    if (!r) return null;
    const old = !r.supported;
    const on = !!r.enabled;
    const sw = U.switchBtn(on, t('gwr.row.title'), 'gwn-f-radio', () => toggle(sw, (v) => U.api('PUT', url(id, '/features'), { radio: v ? { zigbee: null, ble: true } : (r.stacksSupported ? { zigbee: false, ble: false, thread: false } : { zigbee: false, ble: false }) })
      .then(() => { U.toast(t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwr.row.short') })); delete cache[String(id)]; return changed(id); })), old && !on);
    const extra = [];
    if (old) extra.push(h('span', { class: 'gwn-hint', 'data-radio-old': '' }, [U.icon('info', 14), t('gwr.row.old', { min: r.minGateway, version: (d.support && d.support.version) || '—' })]));
    else {
      const list = K.rowSticks(r.sticks).map((s) => (s.kind === 'bluetooth' ? t('gwr.row.bt') : (s.model || t('gwr.stick.unknown'))) + ' (' + t('gwr.bus.' + (s.bus === 'uart' ? 'uart' : s.bus === 'usb' ? 'usb' : 'builtin')) + ')');
      extra.push(h('span', { class: 'gwe-d', 'data-radio-found': String(list.length) }, list.length ? t('gwr.row.found', { list: list.join(', ') }) : t('gwr.row.none')));
      if (r.compose === 'compose') extra.push(h('span', { class: 'gwn-hint' }, [U.icon('info', 14), t('gwr.row.compose')]));
    }
    extra.push(h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/radio', class: 'gwn-link', text: t('gwr.row.to_tab') }));
    return h('div', { class: 'gwn-fr', 'data-feature': 'radio' }, [
      h('div', { class: 'gwn-fr-t' }, [h('strong', { text: t('gwr.row.title') }), h('span', { class: 'gwe-d' }, [t('gwr.row.text'), ' ', U.guide('feat.radio')]), ...extra]),
      sw,
    ]);
  }

  // ─── Badge ────────────────────────────────────────────────────────────
  function badge(node, id, d) {
    node.replaceChildren();
    node.className = 'gwe-tab-badge';
    const b = K.badge(d);
    if (!b) return;
    node.className = 'gwe-tab-badge tag tag-' + b.tone;
    node.textContent = t(b.key, b.params);
  }

  // ─── Public ───────────────────────────────────────────────────────────
  function mount(box, g, tab, ctx) {
    cur = { box, g, tab, ctx: ctx || {} };
    box.classList.add('gwe-panel', 'gwr-panel');
    draw();
    load(g.peer_id, false).then(() => { redraw(); schedule(); }, () => redraw());
  }
  function prefetch() { /* the tab loads live from the gateway; nothing to prefetch */ }
  function unmount() { cur = null; if (timer) { clearTimeout(timer); timer = null; } }

  window.GCGatewayRadio = { mount, unmount, prefetch, featureRow, badge, _cache: cache };
})();
