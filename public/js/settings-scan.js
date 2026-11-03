'use strict';

// Einstellungen › Sicherheit › Virenscan (settings.njk section "virenscan",
// API src/routes/api/settings/scan.js, service src/services/scan/). A section
// with its own script like KI-Anbieter: settings.js calls load() and fills the
// fields of the save bar with what it returns; the group below saves them.
// Immediate actions: "Mit Testdatei prüfen", "Signaturen jetzt aktualisieren",
// "Verbindung testen", the quarantine (erneut prüfen, löschen, trotzdem
// freigeben). Tabs Einstellungen | Quarantäne | Verlauf (ARIA tabs, arrow keys).
//
// The abuse.ch key is write-only: the page only learns whether one is set.
// DOM is built with GCDialog.el / textContent only — never innerHTML.
(function () {
  if (!document.getElementById('scan-p-settings')) return;
  const D = window.GCDialog;
  const el = D.el;
  const lang = (window.GC && window.GC.language) || undefined;
  const $ = (id) => document.getElementById(id);
  const BASE = '/api/v1/settings/scan';
  const SOURCES = ['drive_link', 'drive_own', 'gatedrop', 'mail', 'messenger', 'other'];
  const PLUGIN_NAMES = { 'gatecontrol-drive': 'Drive', 'gatecontrol-gatedrop': 'GateDrop', 'gatecontrol-mail': 'Mail', 'gatecontrol-messenger': 'Messenger' };

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
    if (!iso) return '–';
    try {
      const d = new Date(iso);
      const now = new Date();
      const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      if (d.toDateString() === now.toDateString()) return t('st.scan.today', { time });
      const y = new Date(now.getTime() - 86400000);
      if (d.toDateString() === y.toDateString()) return t('st.scan.yesterday', { time });
      return d.toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) { return iso; }
  }
  function size(b) {
    const n = Number(b) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function pill(tone, text) { return el('span', { class: 'pgx-pill', 'data-tone': tone || null, text }); }
  function kv(label, value, mono, extra) { return el('div', { class: 'pgx-kv' }, [el('span', { text: label }), el('span', { class: mono ? 'pgx-mono' : null }, [value].concat(extra || []))]); }
  function setStatus(text) { const n = $('st-status-virenscan'); if (n && text) n.textContent = text; }
  function sourceText(s) { return t('st.scan.src_short.' + (s || 'other')); }
  function findingText(f) {
    if (!f) return '';
    if (/^GC\./.test(f.finding)) return t('st.scan.rule.' + f.finding.replace(/\./g, '_')) + ' (' + t('st.scan.by_rule') + ')';
    return f.finding;
  }

  let data = null;
  let history = null;
  let filter = 'all';
  let picked = null;

  // ── tabs ──
  const TABS = ['settings', 'quarantine', 'history'];
  function showTab(id, focus) {
    TABS.forEach((x) => {
      const tab = $('scan-t-' + x);
      const on = x === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('scan-p-' + x).hidden = !on;
    });
    if (focus) $('scan-t-' + id).focus();
    if (id === 'history') loadHistory();
  }
  TABS.forEach((x, i) => {
    const tab = $('scan-t-' + x);
    tab.addEventListener('click', () => showTab(x));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        showTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        showTab(e.key === 'Home' ? TABS[0] : TABS[TABS.length - 1], true);
      }
    });
  });
  $('scan-t-found-tile').addEventListener('click', () => showTab('quarantine', true));

  // ── settings tab ──
  function engineLabel(s) {
    if (!s || s.engine === 'none') return t('st.scan.basic_only');
    const where = data.config.engine === 'clamav_local' ? t('st.scan.on_this_server') : data.config.address;
    const name = s.engine === 'icap' ? (s.version || t('st.scan.own_scanner')) : 'ClamAV';
    return t('st.scan.basic_plus', { name, where });
  }
  function renderStatus() {
    const s = data.scanner;
    const parts = [engineLabel(s)];
    if (s.engine !== 'none') {
      if (s.reachable === false) parts.push(t('st.scan.unreachable_now'));
      else if (s.dailyAt) parts.push(t('st.scan.sig_from', { when: when(s.dailyAt) }));
    }
    setStatus(parts.join(' · '));
  }
  function renderTiles() {
    const st = data.stats;
    $('scan-t-checked').textContent = num(st.checked30d);
    $('scan-t-checked-s').textContent = t('st.scan.tile_checked_sub', { n: num(st.external30d) });
    $('scan-t-found').textContent = num(st.found30d);
    $('scan-t-found-s').textContent = t(st.deleted30d ? 'st.scan.tile_found_sub_deleted' : 'st.scan.tile_found_sub', { q: st.quarantined, d: st.deleted30d });
    $('scan-t-unsc').textContent = num(st.unscannable30d);
    $('scan-t-unsc-s').textContent = data.config.unscannable === 'block' ? t('st.scan.tile_unsc_block') : t('st.scan.tile_unsc_mark');
    const s = data.scanner;
    if (s.engine === 'clamav_local' || s.engine === 'clamav_net') {
      $('scan-t-sig').textContent = s.dailyAt ? new Date(s.dailyAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : '–';
      $('scan-t-sig-s').textContent = s.dailyAt ? when(s.dailyAt) : (s.reachable === false ? t('st.scan.unreachable_now') : '–');
    } else {
      $('scan-t-sig').textContent = data.hashlist.count ? num(data.hashlist.count) : '–';
      $('scan-t-sig-s').textContent = data.hashlist.keySet ? t('st.scan.tile_sig_list', { when: when(data.hashlist.updatedAt) }) : t('st.scan.tile_sig_basic');
    }
    const q = $('scan-qcount');
    q.textContent = String(st.quarantined);
    q.hidden = !st.quarantined;
  }
  function attRows() {
    const rows = [];
    const q = data.quarantine || [];
    if (q.length) {
      rows.push({ tone: 'crit', title: tp('st.scan.att_q', q.length), sub: q.slice(0, 2).map((f) => `${f.name || f.mediaId} (${findingText(f)})`).join(' · '),
        pill: t('st.scan.att_q_pill'), action: t('st.scan.att_q_action'), go: () => showTab('quarantine', true) });
    }
    const s = data.scanner;
    const local = localRow(s);
    if (local) rows.push(local);
    else if (data.down) rows.push({ tone: 'crit', title: t('st.scan.att_down'), sub: t('st.scan.att_down_sub', { since: when(data.down.since) }), pill: t('st.scan.att_down_pill') });
    if (s.updateAvailable && s.latest) {
      rows.push({ tone: 'warn', title: t('st.scan.att_update', { v: s.version, latest: s.latest.engine }),
        sub: data.config.engine === 'clamav_local' ? t('st.scan.att_update_local') : t('st.scan.att_update_net', { where: data.config.address }), pill: t('st.scan.att_update_pill') });
    }
    if (s.signaturesOld) rows.push({ tone: 'warn', title: t('st.scan.att_old'), sub: t('st.scan.att_old_sub', { when: when(s.dailyAt) }), pill: t('st.scan.att_old_pill') });
    if (data.hashlist.keySet && data.hashlist.error) rows.push({ tone: 'warn', title: t('st.scan.att_list'), sub: data.hashlist.error, pill: t('st.scan.att_list_pill') });
    return rows;
  }
  // "ClamAV auf diesem Server" chosen but not answering yet: what the host's
  // update.sh did about it (data.local, from .clamav-state.json)
  function localRow(s) {
    const l = data.local;
    if (!l || data.config.engine !== 'clamav_local' || s.engine !== 'clamav_local' || s.reachable !== false) return null;
    const row = (tone, key, sub) => ({ tone, title: t('st.scan.' + key), sub: sub || t('st.scan.' + key + '_sub'), pill: tone === 'crit' ? t('st.scan.att_down_pill') : t('st.scan.local_pill') });
    if (l.state === 'failed') return l.error === 'low_memory' ? row('crit', 'local_low_memory') : row('crit', 'local_failed');
    if (l.state === 'starting' || l.state === 'running') return row('warn', 'local_setup');
    if (l.cron !== 'active') return row('warn', 'local_manual');
    if (l.script && (l.script.host === null || l.script.host < l.script.needed)) return row('warn', 'local_next_update');
    return row('warn', 'local_setup', t('st.scan.local_next_run'));
  }
  function renderAttention() {
    const box = $('scan-att');
    clear(box);
    const rows = attRows();
    $('scan-att-n').textContent = String(rows.length);
    if (!rows.length) box.appendChild(el('li', { class: 'st-empty', text: t('st.scan.att_none') }));
    rows.forEach((r) => {
      const kids = [el('span', { class: 'stx-nm' }, [el('b', { text: r.title }), el('small', { text: r.sub || '' })]), pill(r.tone, r.pill)];
      if (r.action) kids.push(el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', text: r.action, on: { click: r.go } }));
      box.appendChild(el('li', { class: 'stx-row stx-att', 'data-tone': r.tone }, kids));
    });
  }
  function renderUpdates() {
    const box = $('scan-upd');
    clear(box);
    const s = data.scanner;
    if (s.engine === 'clamav_local' || s.engine === 'clamav_net') {
      box.appendChild(kv(t('st.scan.sig_daily'), s.daily ? `${s.daily} · ${when(s.dailyAt)}` : '–', true));
      if (s.latest) {
        box.appendChild(kv(t('st.scan.sig_published'), `daily ${s.latest.daily || '–'} · main ${s.latest.main || '–'} · bytecode ${s.latest.bytecode || '–'}`, true));
      }
    } else if (s.engine === 'icap') {
      box.appendChild(kv(t('st.scan.own_scanner'), s.version || (s.reachable === false ? t('st.scan.unreachable_now') : '–')));
    }
    box.appendChild(kv(t('st.scan.malware_list'), data.hashlist.keySet ? (data.hashlist.count ? `${num(data.hashlist.count)} · ${when(data.hashlist.updatedAt)}` : (data.hashlist.error ? t('st.scan.list_error') : '–')) : t('st.scan.no_key')));
    box.appendChild(kv(t('st.scan.rules'), t('st.scan.with_gc')));
    if (s.engine === 'clamav_local' || s.engine === 'clamav_net') {
      const extra = s.updateAvailable && s.latest ? [' ', pill('warn', s.latest.engine)] : [];
      box.appendChild(kv(t('st.scan.scanner'), s.version ? 'ClamAV ' + s.version : (s.reachable === false ? t('st.scan.unreachable_now') : '–'), true, extra));
    }
    $('scan-upd-note').textContent = data.config.engine === 'clamav_local' ? t('st.scan.upd_local') : (data.config.engine === 'clamav_net' ? t('st.scan.upd_net') : (data.config.engine === 'icap' ? t('st.scan.upd_icap') : t('st.scan.upd_none')));
  }

  // ── quarantine ──
  function renderFilter() {
    const box = $('scan-qfilter');
    clear(box);
    const q = data.quarantine || [];
    const by = {};
    q.forEach((f) => { by[f.source] = (by[f.source] || 0) + 1; });
    const opts = [['all', t('st.scan.f_all'), q.length]].concat(Object.keys(by).map((s) => [s, sourceText(s), by[s]]));
    if (!opts.some((o) => o[0] === filter)) filter = 'all';
    opts.forEach((o) => {
      const b = el('button', { type: 'button', class: 'st-seg-btn', 'data-value': o[0], 'aria-pressed': o[0] === filter ? 'true' : 'false' }, [o[1] + ' ', el('em', { text: String(o[2]) })]);
      b.addEventListener('click', () => { filter = o[0]; renderQuarantine(); });
      box.appendChild(b);
    });
    box.hidden = q.length < 2;
  }
  function renderQuarantine() {
    renderFilter();
    const box = $('scan-q');
    clear(box);
    const q = (data.quarantine || []).filter((f) => filter === 'all' || f.source === filter);
    if (!q.length) box.appendChild(el('li', { class: 'st-empty', text: t('st.scan.q_none') }));
    q.forEach((f) => {
      const btn = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', text: t('st.scan.details'), 'aria-controls': 'scan-detail', 'aria-label': t('st.scan.details_aria', { name: f.name || f.mediaId }) });
      btn.addEventListener('click', () => { picked = f.id; renderQuarantine(); renderDetail(); const d = $('scan-detail'); if (d && d.querySelector('h3')) d.querySelector('h3').focus(); });
      const sub = [sourceText(f.source), f.user, when(f.createdAt)].filter(Boolean).join(' · ');
      box.appendChild(el('li', { class: 'stx-row scan-qrow', 'data-picked': f.id === picked ? '1' : null }, [
        el('span', { class: 'pgx-ic scan-ic', 'data-size': 'sm', 'aria-hidden': 'true', text: '!' }),
        el('span', { class: 'stx-nm' }, [el('b', { text: f.name || f.mediaId }), el('small', { class: 'scan-sig pgx-mono', text: findingText(f) }), el('small', { text: sub })]),
        pill('crit', t('st.scan.in_quarantine')),
        btn,
      ]));
    });
    if (!picked && q.length) { picked = q[0].id; renderDetail(); }
  }
  function explain(f) {
    const d = f.detail || {};
    if (d.kind === 'archive_entry') return d.decoy ? t('st.scan.x_archive_decoy', { entry: d.entry, decoy: d.decoy.toUpperCase() }) : t('st.scan.x_archive', { entry: d.entry });
    if (d.kind === 'double_ext') return t('st.scan.x_double', { decoy: String(d.decoy || '').toUpperCase() });
    if (d.kind === 'disguised') return t('st.scan.x_disguised');
    if (d.kind === 'macro' || d.kind === 'archive_macro') return t('st.scan.x_macro');
    if (d.kind === 'executable') return t('st.scan.x_executable');
    if (d.kind === 'eicar') return t('st.scan.x_eicar');
    return t('st.scan.x_engine', { engine: f.engine === 'icap' ? t('st.scan.own_scanner') : f.engine === 'hashlist' ? 'MalwareBazaar' : 'ClamAV' });
  }
  function renderDetail() {
    const box = $('scan-detail');
    clear(box);
    const f = (data.quarantine || []).find((x) => x.id === picked);
    if (!f) { box.appendChild(el('p', { class: 'pgx-hint', text: t('st.scan.pick') })); return; }
    const engine = f.engine === 'icap' ? t('st.scan.own_scanner') : f.engine === 'hashlist' ? 'MalwareBazaar' : f.engine === 'grundschutz' ? t('st.scan.basic') : 'ClamAV';
    box.appendChild(pill('crit', t('st.scan.found_by', { engine })));
    box.appendChild(el('h3', { class: 'stx-ct', tabindex: '-1', text: f.name || f.mediaId }));
    box.appendChild(el('span', { class: 'pgx-mono scan-sig', text: findingText(f) }));
    box.appendChild(el('p', { class: 'stx-box', 'data-tone': 'crit', text: explain(f) }));
    const kvs = el('div', { class: 'pgx-kvs' });
    kvs.appendChild(kv(t('st.scan.k_source'), sourceText(f.source) + (PLUGIN_NAMES[f.plugin] ? '' : ' · ' + f.plugin)));
    if (f.sender) kvs.appendChild(kv(t('st.scan.k_sender'), f.sender, true));
    if (f.user) kvs.appendChild(kv(t('st.scan.k_person'), f.user));
    kvs.appendChild(kv(t('st.scan.k_found'), when(f.createdAt)));
    kvs.appendChild(kv(t('st.scan.k_size'), size(f.bytes), true));
    const copy = el('button', { type: 'button', class: 'st-icon-btn scan-copy', 'aria-label': t('st.copy'), title: t('st.copy'), text: '⧉' });
    copy.addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(f.sha256).then(() => toast(t('st.copied')), () => {}); });
    kvs.appendChild(kv('SHA-256', f.sha256 ? f.sha256.slice(0, 4) + '…' + f.sha256.slice(-4) : '–', true, f.sha256 ? [' ', copy] : []));
    if (f.detail && f.detail.known) kvs.appendChild(kv(t('st.scan.k_known'), 'MalwareBazaar'));
    if (f.expiresAt) kvs.appendChild(kv(t('st.scan.k_until'), when(f.expiresAt)));
    box.appendChild(kvs);
    const re = el('button', { type: 'button', class: 'pgx-btn', text: t('st.scan.recheck') });
    re.addEventListener('click', async () => {
      busy(re, true);
      const r = await call(window.api.post(BASE + '/findings/' + f.id + '/recheck', {}));
      busy(re, false);
      if (r.ok) { toast(r.finding && r.finding.state === 'clean' ? t('st.scan.recheck_clean') : t('st.scan.recheck_still')); reload(); } else toast(errText(r), 'error');
    });
    const del = el('button', { type: 'button', class: 'pgx-btn pgx-btn-danger', text: t('st.scan.delete') });
    del.addEventListener('click', async () => {
      if (!(await D.confirm({ title: t('st.scan.delete_title'), message: t('st.scan.delete_msg', { name: f.name || f.mediaId }), okLabel: t('st.scan.delete'), danger: true }))) return;
      const r = await call(window.api.del(BASE + '/findings/' + f.id));
      if (r.ok) { toast(t('st.scan.deleted')); picked = null; reload(); } else toast(errText(r), 'error');
    });
    box.appendChild(el('div', { class: 'scan-acts' }, [re, del]));
    const rel = el('button', { type: 'button', class: 'pgx-btn', text: t('st.scan.release') });
    rel.addEventListener('click', async () => {
      if (!(await D.confirm({ title: t('st.scan.release_title'), message: t('st.scan.release_msg', { name: f.name || f.mediaId, finding: f.finding }), okLabel: t('st.scan.release'), danger: true }))) return;
      const r = await call(window.api.post(BASE + '/findings/' + f.id + '/release', {}));
      if (r.ok) { toast(t('st.scan.released')); picked = null; reload(); } else toast(errText(r), 'error');
    });
    box.appendChild(el('details', { class: 'scan-release' }, [
      el('summary', { text: t('st.scan.release_more') }),
      el('p', { class: 'pgx-hint', text: t('st.scan.release_hint') }),
      rel,
    ]));
  }

  // ── history ──
  async function loadHistory() {
    const r = await call(window.api.get(BASE + '/history'));
    if (!r.ok) return;
    history = r.history;
    const box = $('scan-history');
    clear(box);
    if (!history.length) box.appendChild(el('li', { class: 'st-empty', text: t('st.scan.h_none') }));
    const TONE = { deleted: 'crit', released: 'warn', marked: 'warn', unscannable: '', blocked: 'warn', clean: 'good', superseded: '' };
    history.forEach((f) => {
      const sub = [sourceText(f.source), f.user, f.sender, when(f.createdAt)].filter(Boolean).join(' · ');
      const what = f.state === 'unscannable' || f.state === 'blocked' ? t('st.scan.why_unsc.' + (f.finding || 'error')) : findingText(f);
      box.appendChild(el('li', { class: 'stx-row' }, [
        el('span', { class: 'stx-nm' }, [el('b', { text: f.name || f.mediaId || '–' }), el('small', { class: 'pgx-mono', text: what }), el('small', { text: sub })]),
        pill(TONE[f.state] || '', t('st.scan.hs.' + f.state)),
      ]));
    });
  }

  // ── actions ──
  function message(text, tone) {
    const m = $('scan-msg');
    m.textContent = text;
    if (tone) m.dataset.tone = tone; else delete m.dataset.tone;
    m.hidden = !text;
  }
  $('scan-eicar').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    const r = await call(window.api.post(BASE + '/eicar', {}));
    busy(b, false);
    if (!r.ok) { message(errText(r), 'crit'); return; }
    const x = r.result;
    if (x.engine === 'none') message(x.grundschutz ? t('st.scan.eicar_basic_ok') : t('st.scan.eicar_fail'), x.grundschutz ? 'good' : 'crit');
    else if (x.error) message(t('st.scan.eicar_unreachable', { error: x.error }), 'crit');
    else message(x.scanner ? t('st.scan.eicar_ok', { finding: x.scanner }) : t('st.scan.eicar_missed'), x.scanner ? 'good' : 'warn');
  });
  $('scan-refresh').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    const r = await call(window.api.post(BASE + '/refresh', {}));
    busy(b, false);
    if (!r.ok) { message(errText(r), 'crit'); return; }
    const x = r.result;
    const parts = [];
    if (x.reload) parts.push(t('st.scan.refresh_reload'));
    else if (x.error) parts.push(t('st.scan.refresh_unreachable'));
    if (x.hashlist && x.hashlist.ok) parts.push(t('st.scan.refresh_list', { n: num(x.hashlist.total || 0) }));
    else if (x.hashlist && x.hashlist.error && x.hashlist.error !== 'no_key') parts.push(t('st.scan.refresh_list_failed'));
    message(parts.join(' ') || t('st.scan.refresh_nothing'), x.error ? 'warn' : 'good');
    setTimeout(reload, 2500);
  });
  $('scan-test').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const body = { engine: $('scan-engine').value, address: $('scan-address').value.trim(), icap_service: $('scan-service').value.trim() || 'avscan' };
    busy(b, true);
    const r = await call(window.api.post(BASE + '/test', body));
    busy(b, false);
    const m = $('scan-test-msg');
    if (!r.ok) { m.textContent = errText(r); m.dataset.tone = 'crit'; return; }
    const x = r.result;
    if (x.engine === 'none') { m.textContent = t('st.scan.test_none'); delete m.dataset.tone; return; }
    m.dataset.tone = x.ok ? '' : 'crit';
    m.textContent = x.ok ? t('st.scan.test_ok', { version: x.version || x.service || '' }) : t('st.scan.test_fail.' + (['target_not_allowed', 'unresolvable', 'timeout', 'address_invalid'].includes(x.error) ? x.error : 'other'));
  });
  $('scan-recheck-all').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    const r = await call(window.api.post(BASE + '/recheck-all', {}));
    busy(b, false);
    if (r.ok) { toast(tp('st.scan.rechecked', r.checked)); reload(); } else toast(errText(r), 'error');
  });

  function values() {
    const c = data.config;
    const v = {
      'scan-engine': c.engine, 'scan-address': c.address || (c.engine === 'clamav_local' ? data.localAddress : ''), 'scan-service': c.icap_service,
      'scan-unreachable': c.unreachable, 'scan-action': c.action, 'scan-unscannable': c.unscannable, 'scan-notify': c.notify,
      'scan-max': c.max_mb, 'scan-depth': c.archive_depth, 'scan-rescan': c.rescan, 'scan-sigcheck': String(c.sig_check_h), 'scan-key': '',
    };
    SOURCES.forEach((s) => { v['scan-src-' + s] = !!c.sources[s]; });
    const key = $('scan-key');
    if (key) key.placeholder = c.abusech_key_set ? t('st.scan.key_set') : t('st.scan.key_ph');
    return v;
  }
  async function reload() {
    const r = await call(window.api.get(BASE));
    if (!r.ok) { toast(errText(r), 'error'); return null; }
    data = r;
    renderStatus();
    renderTiles();
    renderAttention();
    renderUpdates();
    renderQuarantine();
    renderDetail();
    return values();
  }

  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.virenscan = {
    fills: true,
    load() { return reload(); },
    groups: [{
      fields: ['scan-engine', 'scan-address', 'scan-service', 'scan-unreachable', 'scan-action', 'scan-unscannable', 'scan-notify', 'scan-max',
        'scan-depth', 'scan-rescan', 'scan-sigcheck', 'scan-key'].concat(SOURCES.map((s) => 'scan-src-' + s)),
      map: { engine: 'scan-engine', address: 'scan-address', icap_service: 'scan-service', unreachable: 'scan-unreachable', action: 'scan-action',
        unscannable: 'scan-unscannable', notify: 'scan-notify', max_mb: 'scan-max', archive_depth: 'scan-depth', rescan: 'scan-rescan',
        sig_check_h: 'scan-sigcheck', abusech_key: 'scan-key', sources: 'scan-src-drive_link' },
      save(v, dirty) {
        const body = {
          action: v['scan-action'], unscannable: v['scan-unscannable'], notify: !!v['scan-notify'],
          max_mb: parseInt(v['scan-max'], 10), archive_depth: parseInt(v['scan-depth'], 10), sig_check_h: parseInt(v['scan-sigcheck'], 10), sources: {},
        };
        SOURCES.forEach((s) => { body.sources[s] = !!v['scan-src-' + s]; });
        if (data && data.licensed) {
          body.engine = v['scan-engine'];
          body.address = v['scan-engine'] === 'clamav_local' && v['scan-address'] === data.localAddress ? '' : v['scan-address'];
          body.icap_service = v['scan-service'] || 'avscan';
          body.unreachable = v['scan-unreachable'];
          body.rescan = v['scan-rescan'];
        }
        if (dirty.includes('scan-key') && v['scan-key']) body.abusech_key = v['scan-key'];
        return window.api.put(BASE, body);
      },
      after: () => reload(),
    }],
  };
}());
