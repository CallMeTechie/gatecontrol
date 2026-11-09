'use strict';

// Einstellungen › Sicherheit: IP-Sperre and Routenschutz (settings.njk
// sections "ipsperre" and "routenschutz"; API src/routes/api/settings/
// securityGuards.js). Sections with their own script like KI-Anbieter:
// settings.js calls load() when a section is shown and fills the fields of
// the save bar with the values it returns; the `groups` save them. Immediate
// actions stay immediate: block / unblock, "Nie sperren", "Jetzt
// aktualisieren", "Nur über VPN", "Ist Absicht".
//
// DOM is built with GCDialog.el / textContent only — never innerHTML.
(function () {
  if (!document.getElementById('ipb-bans')) return;
  const D = window.GCDialog;
  const el = D.el;
  const lang = (window.GC && window.GC.language) || undefined;
  const $ = (id) => document.getElementById(id);

  function t(key, params) {
    const s = window.GC && window.GC.t && window.GC.t[key] != null ? window.GC.t[key] : key;
    return window.GCSettingsUI ? window.GCSettingsUI.fmt(s, params) : s;
  }
  function tp(key, n, params) { return t(key + (Number(n) === 1 ? '_one' : '_other'), Object.assign({ n }, params || {})); }
  function call(p) {
    return Promise.resolve(p).then((r) => r || { ok: false }, (e) => (e && e.data) || { ok: false, error: (e && e.message) || t('st.err.generic') });
  }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  function errText(r) { return r && r.feature ? t('st.err.license') : (r && r.error) || t('st.err.generic'); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function busy(btn, on) { if (!btn) return; if (on) { if (window.btnLoading) window.btnLoading(btn); else btn.disabled = true; } else if (window.btnReset) window.btnReset(btn); else btn.disabled = false; }
  function num(n) { try { return new Intl.NumberFormat(lang).format(Number(n) || 0); } catch (_) { return String(n); } }
  function when(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86400000);
      const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      if (d.toDateString() === today.toDateString()) return time;
      if (d.toDateString() === tomorrow.toDateString()) return t('st.ipb.tomorrow', { time });
      return d.toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) { return iso; }
  }
  function setStatus(id, text) { const n = $('st-status-' + id); if (n && text) n.textContent = text; }
  function pill(tone, text, extra) { return el('span', Object.assign({ class: 'pgx-pill', 'data-tone': tone || null, text }, extra || {})); }

  // "Hinzufügen" panels: the button opens the form, Escape / Abbrechen closes it.
  function panel(btnId, formId, onSubmit) {
    const btn = $(btnId);
    const form = $(formId);
    if (!btn || !form) return;
    const close = (back) => {
      form.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      form.querySelectorAll('.st-err').forEach((x) => { x.hidden = true; });
      if (back) btn.focus();
    };
    btn.addEventListener('click', () => {
      if (!form.hidden) { close(false); return; }
      form.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const f = form.querySelector('input');
      if (f) f.focus();
    });
    form.querySelectorAll('[data-add-cancel]').forEach((b) => b.addEventListener('click', () => { form.reset(); close(true); }));
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sub = form.querySelector('[type="submit"]');
      busy(sub, true);
      const ok = await onSubmit();
      busy(sub, false);
      if (ok) { form.reset(); close(true); }
    });
  }
  function fieldError(id, r) {
    const e = $(id);
    if (!e) return;
    e.textContent = (r && r.fields && Object.values(r.fields)[0]) || errText(r);
    e.hidden = false;
  }

  // ══ IP-Sperre ═════════════════════════════════════════════════════════
  const IPB = '/api/v1/settings/ip-block';
  const SOURCES = ['login', 'route_auth', 'share_link', 'waf', 'scan', 'rate_limit'];
  const LISTS = ['drop', 'attackers', 'tor'];
  let ipb = null;

  function levelPill(b) {
    if (b.manual) return pill('blue', t('st.ipb.lvl_manual'));
    if (b.level >= 3) return pill('crit', t('st.ipb.lvl', { n: b.level }));
    if (b.level === 2) return pill('warn', t('st.ipb.lvl', { n: b.level }));
    return pill('', t('st.ipb.lvl', { n: b.level }));
  }
  function whyOf(b) {
    if (b.manual) return t('st.ipb.why_manual');
    const n = b.hits || 0;
    // names without an account brought most of the points (services/ipBlock.js summary)
    if (b.unknownMain && b.unknownUsers) return tp('st.ipb.why_unknown', b.unknownUsers);
    if (b.reason === 'login') return b.targetCount > 1 ? t('st.ipb.why_login_accounts', { n, k: b.targetCount }) : tp('st.ipb.why_login', n);
    return t('st.ipb.why_' + b.reason, { n });
  }
  function detailOf(b) {
    if (b.manual) return [b.note ? '„' + b.note + '“' : null, t('st.ipb.since', { time: when(b.createdAt) })].filter(Boolean).join(' · ');
    const src = Object.keys(b.sources || {}).map((s) => t('st.ipb.src_short.' + s)).join(', ');
    const tg = (b.targets || []).slice(0, 2).join(', ');
    const unk = b.unknownUsers && !b.unknownMain ? tp('st.ipb.detail_unknown', b.unknownUsers) : null;
    return [src, unk, tg, t('st.ipb.since', { time: when(b.createdAt) })].filter(Boolean).join(' · ');
  }
  function renderBans() {
    const box = $('ipb-bans');
    clear(box);
    const bans = (ipb && ipb.bans) || [];
    if (!bans.length) box.appendChild(el('li', { class: 'st-empty', text: t('st.ipb.none') }));
    bans.forEach((b) => {
      const un = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', text: t('st.ipb.unban'), 'aria-label': t('st.ipb.unban_aria', { ip: b.ip }) });
      un.addEventListener('click', async () => {
        if (!(await D.confirm({ title: t('st.ipb.unban_title'), message: t('st.ipb.unban_msg', { ip: b.ip }), okLabel: t('st.ipb.unban') }))) return;
        busy(un, true);
        const r = await call(window.api.del(IPB + '/bans/' + encodeURIComponent(b.ip)));
        busy(un, false);
        if (r.ok) { toast(t('st.ipb.unbanned', { ip: b.ip })); reloadIpb(); } else toast(errText(r), 'error');
      });
      box.appendChild(el('li', { class: 'stx-row ipb-ban', 'data-level': String(b.level) }, [
        el('span', { class: 'ipb-ip' }, [el('b', { class: 'pgx-mono', text: b.ip }), el('small', { text: b.country || (b.manual ? t('st.ipb.by_hand') : '') })]),
        el('span', { class: 'stx-nm' }, [el('b', { text: whyOf(b) }), el('small', { text: detailOf(b) })]),
        levelPill(b),
        el('span', { class: 'ipb-until', text: b.expiresAt ? t('st.ipb.until', { time: when(b.expiresAt) }) : t('st.ipb.permanent') }),
        un,
      ]));
    });
  }
  function renderNever() {
    const box = $('ipb-never');
    clear(box);
    ((ipb && ipb.exceptions) || []).forEach((e) => {
      const sub = e.kind === 'vpn' ? t('st.ipb.never_vpn') : e.kind === 'waf' ? t('st.ipb.never_waf') : (e.label || t('st.ipb.never_own'));
      const kids = [el('span', { class: 'stx-nm' }, [el('b', { class: 'pgx-mono', text: e.ip }), el('small', { text: sub })])];
      if (e.kind === 'own') {
        const rm = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', text: t('st.ipb.never_remove'), 'aria-label': t('st.ipb.never_remove_aria', { ip: e.ip }) });
        rm.addEventListener('click', async () => {
          busy(rm, true);
          const r = await call(window.api.del(IPB + '/never/' + encodeURIComponent(e.ip)));
          busy(rm, false);
          if (r.ok) reloadIpb(); else toast(errText(r), 'error');
        });
        kids.push(rm);
      }
      box.appendChild(el('li', { class: 'stx-row' }, kids));
    });
  }
  function renderIpbStats() {
    const s = ipb.stats;
    $('ipb-t-now').textContent = num(s.blocked);
    $('ipb-t-now-s').textContent = s.blockedDay ? tp('st.ipb.tile_now_day', s.blockedDay) : (s.blockedManual ? tp('st.ipb.tile_now_manual', s.blockedManual) : t('st.ipb.tile_now_none'));
    $('ipb-t-fail').textContent = num(s.failures24h);
    $('ipb-t-fail-s').textContent = tp('st.ipb.tile_failures_sub', s.failureIps24h);
    $('ipb-t-lists').textContent = num(s.blockedHits24h);
    $('ipb-t-ex').textContent = num(s.exceptions);
    const own = (ipb.exceptions || []).filter((e) => e.kind !== 'vpn').length;
    $('ipb-t-ex-s').textContent = own ? tp('st.ipb.tile_ex_sub', own) : t('st.ipb.tile_ex_vpn');
    s.lists.forEach((l) => {
      const m = $('ipb-list-' + l.id + '-meta');
      if (!m) return;
      m.textContent = l.error && l.on ? t('st.ipb.list_error') : l.count ? num(l.count) + (l.updatedAt ? ' · ' + when(l.updatedAt) : '') : '–';
      m.title = l.error || '';
      m.classList.toggle('stx-crit', !!(l.error && l.on));
    });
    $('ipb-engine').hidden = !(ipb.config.enabled && ipb.engine === false);
    const lists = s.lists.filter((l) => l.on && l.licensed);
    const entries = lists.reduce((a, l) => a + (l.count || 0), 0);
    const parts = [ipb.config.enabled ? t('st.ipb.status_on') : t('st.ipb.status_off')];
    if (ipb.config.enabled) parts.push(tp('st.ipb.status_blocked', s.blocked));
    if (ipb.config.enabled && lists.length) parts.push(tp('st.ipb.status_lists', lists.length, { entries: num(entries) }));
    setStatus('ipsperre', parts.join(' · '));
  }
  function ipbValues() {
    const c = ipb.config;
    const v = {
      'ipb-enabled': c.enabled, 'ipb-threshold': c.threshold, 'ipb-window': String(c.window_min),
      'ipb-unknown': String(c.unknown_user_weight), 'ipb-notify': c.notify,
    };
    SOURCES.forEach((s) => { v['ipb-src-' + s] = !!c.sources[s]; });
    // without the licence the lists do not apply: shown off (and not sent)
    LISTS.forEach((l) => { v['ipb-list-' + l] = !!c.lists[l] && !!ipb.licensed; });
    return v;
  }
  async function reloadIpb() {
    const r = await call(window.api.get(IPB));
    if (!r.ok) { toast(errText(r), 'error'); return null; }
    ipb = r;
    renderBans();
    renderNever();
    renderIpbStats();
    return ipbValues();
  }
  let ipbWired = false;
  function wireIpb() {
    if (ipbWired) return;
    ipbWired = true;
    panel('ipb-ban-open', 'ipb-ban-add', async () => {
      const hours = $('ipb-ban-hours').value;
      const r = await call(window.api.post(IPB + '/bans', { ip: $('ipb-ban-ip').value.trim(), hours: hours ? Number(hours) : null, note: $('ipb-ban-note').value.trim() }));
      if (!r.ok) { fieldError('ipb-ban-err', r); $('ipb-ban-ip').focus(); return false; }
      toast(t('st.ipb.banned', { ip: r.ban.ip }));
      reloadIpb();
      return true;
    });
    panel('ipb-never-open', 'ipb-never-add', async () => {
      const r = await call(window.api.post(IPB + '/never', { ip: $('ipb-never-ip').value.trim(), label: $('ipb-never-label').value.trim() }));
      if (!r.ok) { fieldError('ipb-never-err', r); $('ipb-never-ip').focus(); return false; }
      if (r.lifted && r.lifted.length) toast(tp('st.ipb.never_lifted', r.lifted.length));
      reloadIpb();
      return true;
    });
    const ref = $('ipb-refresh');
    if (ref) ref.addEventListener('click', async () => {
      busy(ref, true);
      const r = await call(window.api.post(IPB + '/lists/refresh', {}));
      busy(ref, false);
      const msg = $('ipb-lists-msg');
      if (!r.ok) { msg.textContent = errText(r); msg.dataset.tone = 'crit'; return; }
      const failed = Object.entries(r.result || {}).filter(([, x]) => !x.ok);
      msg.dataset.tone = failed.length ? 'crit' : '';
      msg.textContent = failed.length ? t('st.ipb.refresh_failed', { lists: failed.map(([k]) => t('st.ipb.list.' + k)).join(', ') })
        : (Object.keys(r.result || {}).length ? t('st.ipb.refresh_done') : t('st.ipb.refresh_none'));
      reloadIpb();
    });
  }

  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.ipsperre = {
    fills: true,
    load() { wireIpb(); return reloadIpb(); },
    groups: [{
      fields: ['ipb-enabled', 'ipb-threshold', 'ipb-window', 'ipb-unknown', 'ipb-notify'].concat(SOURCES.map((s) => 'ipb-src-' + s), LISTS.map((l) => 'ipb-list-' + l)),
      map: { enabled: 'ipb-enabled', threshold: 'ipb-threshold', window_min: 'ipb-window', unknown_user_weight: 'ipb-unknown', notify: 'ipb-notify', sources: 'ipb-src-login', lists: 'ipb-list-drop' },
      save(v) {
        const sources = {};
        SOURCES.forEach((s) => { sources[s] = !!v['ipb-src-' + s]; });
        const body = {
          enabled: !!v['ipb-enabled'], threshold: parseInt(v['ipb-threshold'], 10), window_min: parseInt(v['ipb-window'], 10),
          unknown_user_weight: parseInt(v['ipb-unknown'], 10),
          notify: !!v['ipb-notify'], sources,
        };
        if (ipb && ipb.licensed) {
          body.lists = {};
          LISTS.forEach((l) => { body.lists[l] = !!v['ipb-list-' + l]; });
        }
        return window.api.put(IPB, body);
      },
      after: () => reloadIpb(),
    }],
  };

  // ══ Routenschutz ══════════════════════════════════════════════════════
  const RG = '/api/v1/settings/route-guard';
  let rg = null;
  let filter = 'all';
  const RISK_TONE = { high: 'crit', check: 'warn', low: 'good', ack: 'blue' };

  function accessText(r) { return t('st.rg.acc_' + r.access); }
  function authText(r) {
    if (!r.auth) return '–';
    if (r.auth.kind === 'basic') return t('st.rg.auth_basic');
    if (r.auth.kind === 'mtls') return t('st.rg.auth_mtls');
    return t('st.rg.auth_route') + (r.auth.twofa ? ' + 2FA' : '');
  }
  function geoText(r) {
    if (!r.geo) return '–';
    const parts = [];
    if (r.geo.countries.length) parts.push(r.geo.countries.slice(0, 4).join(', ') + (r.geo.countries.length > 4 ? ' …' : ''));
    if (r.geo.addresses) parts.push(tp('st.rg.geo_addrs', r.geo.addresses));
    return (r.geo.mode === 'block' ? t('st.rg.geo_block') + ' ' : '') + (parts.join(' · ') || t('st.state.on'));
  }
  function rateText(r) { return r.rateLimit ? t('st.rg.rate_val', { n: num(r.rateLimit.requests), w: r.rateLimit.window }) : '–'; }
  function wafText(r) { return r.type === 'l4' ? '·' : r.waf ? t('st.rg.waf_' + (r.waf.mode === 'block' ? 'block' : 'detect')) : t('st.state.off'); }
  function riskPill(r) {
    const p = pill(RISK_TONE[r.risk] || '', t('st.rg.risk_' + r.risk));
    if (r.risk !== 'ack') return p;
    const b = el('button', { type: 'button', class: 'pgx-pill rg-ack', 'data-tone': 'blue', text: t('st.rg.risk_ack'), title: t('st.rg.unack'), 'aria-label': t('st.rg.unack_aria', { host: r.host }) });
    b.addEventListener('click', async () => {
      if (!(await D.confirm({ title: t('st.rg.unack'), message: t('st.rg.unack_msg', { host: r.host }), okLabel: t('st.rg.unack') }))) return;
      const res = await call(window.api.del(RG + '/routes/' + r.id + '/ack'));
      if (res.ok) reloadRg(); else toast(errText(res), 'error');
    });
    return b;
  }
  function reasonText(a) {
    const r = a.reasons || [];
    if (a.type === 'l4') return t(r[0] === 'l4_sensitive_port' ? 'st.rg.why_l4_port' : 'st.rg.why_l4');
    if (r[0] === 'admin_port' || r[0] === 'admin_name') return t('st.rg.why_admin');
    return t('st.rg.why_open');
  }
  function renderAttention() {
    const box = $('rg-att');
    clear(box);
    const att = rg.attention || [];
    $('rg-att-n').textContent = String(att.length);
    if (!att.length) box.appendChild(el('li', { class: 'st-empty', text: t('st.rg.att_none') }));
    att.forEach((a) => {
      const acts = [];
      const ack = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', text: t('st.rg.ack') });
      ack.addEventListener('click', async () => {
        busy(ack, true);
        const r = await call(window.api.post(RG + '/routes/' + a.id + '/ack', {}));
        busy(ack, false);
        if (r.ok) { toast(t('st.rg.acked', { host: a.host })); reloadRg(); } else toast(errText(r), 'error');
      });
      acts.push(ack);
      if (a.type === 'http' && a.risk !== 'high') acts.push(el('a', { class: 'pgx-btn pgx-btn-sm', href: a.href, text: t('st.rg.enable_login') }));
      const vpn = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm' + (a.risk === 'high' ? ' pgx-btn-pri' : ''), text: t('st.rg.vpn_only_btn') });
      vpn.addEventListener('click', async () => {
        if (!(await D.confirm({ title: t('st.rg.vpn_only_btn'), message: t('st.rg.vpn_only_msg', { host: a.host }), okLabel: t('st.rg.vpn_only_btn') }))) return;
        busy(vpn, true);
        const r = await call(window.api.post(RG + '/routes/' + a.id + '/vpn-only', {}));
        busy(vpn, false);
        if (r.ok) { toast(t('st.rg.vpn_only_done', { host: a.host })); reloadRg(); } else toast(errText(r), 'error');
      });
      acts.push(vpn);
      box.appendChild(el('li', { class: 'stx-row stx-att', 'data-tone': a.risk === 'high' ? 'crit' : 'warn' }, [
        el('span', { class: 'stx-nm' }, [el('b', { text: t('st.rg.att_title', { host: a.host }) }), el('small', { text: reasonText(a) })]),
        pill(a.risk === 'high' ? 'crit' : 'warn', t('st.rg.risk_' + a.risk)),
        el('span', { class: 'rg-acts' }, acts),
      ]));
    });
  }
  function cell(text, good) { return el('td', { class: good === true ? 'rg-y' : good === false ? 'rg-n' : null, text }); }
  function renderTable() {
    const body = $('rg-rows');
    clear(body);
    const all = (rg.routes || []).filter((r) => r.enabled);
    const open = all.filter((r) => r.access === 'internet' && !r.auth);
    const nowaf = all.filter((r) => r.type === 'http' && !r.waf);
    $('rg-f-all').textContent = String(all.length);
    $('rg-f-open').textContent = String(open.length);
    $('rg-f-nowaf').textContent = String(nowaf.length);
    const list = filter === 'open' ? open : filter === 'nowaf' ? nowaf : all;
    if (!list.length) body.appendChild(el('tr', {}, el('td', { colspan: '7', class: 'st-empty', text: t('st.rg.none') })));
    list.forEach((r) => {
      const tgt = r.target.host ? r.target.host + (r.target.port ? ':' + r.target.port : '') : '';
      body.appendChild(el('tr', { 'data-risk': r.risk }, [
        el('td', {}, [el('a', { class: 'rg-host pgx-mono', href: r.href, text: r.host }), el('small', { class: 'rg-target', text: [r.label, tgt].filter(Boolean).join(' · ') })]),
        cell(accessText(r), r.access !== 'internet'),
        cell(authText(r), r.auth ? true : (r.access === 'internet' ? false : null)),
        cell(geoText(r), r.geo ? true : null),
        cell(rateText(r), r.rateLimit ? true : null),
        cell(wafText(r), r.type === 'l4' ? null : !!r.waf),
        el('td', { class: 'rg-risk' }, riskPill(r)),
      ]));
    });
  }
  function renderRg() {
    const s = rg.stats;
    $('rg-t-vpn').textContent = num(s.vpn);
    $('rg-t-login').textContent = num(s.login);
    $('rg-t-open').textContent = num(s.open);
    $('rg-t-open-tile').dataset.tone = s.high ? 'crit' : 'warn';
    $('rg-t-waf').textContent = s.waf + ' / ' + s.http;
    $('rg-t-waf-s').textContent = s.http - s.waf ? tp('st.rg.tile_waf_sub', s.http - s.waf) : t('st.rg.tile_waf_all');
    setStatus('routenschutz', tp('st.rg.status', s.total) + ' · ' + (s.high + s.check ? tp('st.rg.status_open', s.high + s.check) : t('st.rg.status_ok')));
    $('rg-geo-hint').hidden = rg.geoKey;
    renderAttention();
    renderTable();
  }
  async function reloadRg() {
    const r = await call(window.api.get(RG));
    if (!r.ok) { toast(errText(r), 'error'); return null; }
    rg = r;
    renderRg();
    return { 'rg-access': r.defaults.access, 'rg-waf': r.defaults.waf, 'rg-countries': r.defaults.countries, 'rg-rate': r.defaults.rate_limit, 'rg-two': r.vpn.two_places, 'rg-country': r.vpn.new_country };
  }
  let rgWired = false;
  function wireRg() {
    if (rgWired) return;
    rgWired = true;
    const seg = $('rg-filter');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('.st-seg-btn');
      if (!b) return;
      filter = b.dataset.value;
      seg.querySelectorAll('.st-seg-btn').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      if (rg) renderTable();
    });
  }
  window.GCSettingsExt.routenschutz = {
    fills: true,
    load() { wireRg(); return reloadRg(); },
    groups: [{
      fields: ['rg-access', 'rg-waf', 'rg-countries', 'rg-rate', 'rg-two', 'rg-country'],
      map: { access: 'rg-access', waf: 'rg-waf', countries: 'rg-countries', rate_limit: 'rg-rate', two_places: 'rg-two', new_country: 'rg-country' },
      save(v, dirty) {
        const body = {};
        if (['rg-access', 'rg-waf', 'rg-countries', 'rg-rate'].some((f) => dirty.includes(f))) {
          body.defaults = {};
          if (dirty.includes('rg-access')) body.defaults.access = v['rg-access'];
          if (dirty.includes('rg-waf')) body.defaults.waf = !!v['rg-waf'];
          if (dirty.includes('rg-countries')) body.defaults.countries = v['rg-countries'];
          if (dirty.includes('rg-rate')) body.defaults.rate_limit = parseInt(v['rg-rate'], 10);
        }
        if (dirty.includes('rg-two') || dirty.includes('rg-country')) body.vpn = { two_places: v['rg-two'], new_country: v['rg-country'] };
        return window.api.put(RG, body);
      },
      after: () => reloadRg(),
    }],
  };
}());
