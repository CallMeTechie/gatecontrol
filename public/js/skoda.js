(() => {
  'use strict';
  const GC = window.GC || {};
  const T = (k, params) => {
    let s = (GC.t && GC.t[k]) || k;
    for (const [p, v] of Object.entries(params || {})) s = s.replace(`{{${p}}}`, v);
    return s;
  };
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': GC.csrfToken };
  async function api(method, path, body) {
    const res = await fetch('/api/v1/skoda' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { code: json.code });
    return json;
  }
  async function apiRoot(method, path, body) {
    const res = await fetch('/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { code: json.code });
    return json;
  }

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const showModal = (id) => { el(id).style.display = 'flex'; };
  const hideModal = (id) => { el(id).style.display = 'none'; };
  let current = { accounts: [], vehicles: [] };
  let ownerVehicleId = null;
  let spinAccountId = null;
  const skodaEnrich = {}; // vehId -> rendered details HTML, cached only on success
  const skodaPending = new Set(); // vehId currently being fetched (in-flight guard)

  function accountRow(a) {
    const statusKey = `skoda.accounts.status.${a.status}`;
    const statusText = a.status === 'rate_limited'
      ? T(statusKey, { time: a.next_retry_at ? new Date(a.next_retry_at).toLocaleTimeString() : '—' })
      : T(statusKey);
    return `<div class="skoda-account" data-id="${a.id}">
      <span class="skoda-account-email">${esc(a.email)}</span>
      <span class="skoda-badge skoda-badge-${esc(a.status)}" title="${esc(a.status_detail || '')}">${esc(statusText)}</span>
      <button class="btn btn-sm" data-action="password">${T('skoda.accounts.change_password')}</button>
      <button class="btn btn-sm" data-action="spin">${T('skoda.cmd.spin')}</button>
      <button class="btn btn-sm btn-danger" data-action="remove">${T('skoda.accounts.remove')}</button>
    </div>`;
  }

  const DAY_KEYS = [['MONDAY', 'mon'], ['TUESDAY', 'tue'], ['WEDNESDAY', 'wed'], ['THURSDAY', 'thu'], ['FRIDAY', 'fri'], ['SATURDAY', 'sat'], ['SUNDAY', 'sun']];

  function timerRow(vehId, t) {
    const days = Array.isArray(t.days) ? t.days : [];
    // Nur RECURRING ist schreibbar — der Server lehnt alles andere mit
    // SKODA_TIMER_READONLY ab. Werte werden trotzdem angezeigt, nur gesperrt.
    const editable = t.type === 'RECURRING';
    const dis = editable ? '' : ' disabled';
    const chips = DAY_KEYS.map(([code, k]) =>
      `<button type="button" class="skoda-timer-day" data-day="${code}" aria-pressed="${days.includes(code) ? 'true' : 'false'}"${dis}>${T('skoda.timers.day.' + k)}</button>`).join('');
    return `<div class="skoda-timer" data-veh="${vehId}" data-timer="${t.id}">
      <div class="skoda-timer-head">
        <strong>${T('skoda.timers.timer', { n: Number(t.id) })}</strong>
        <label><input type="checkbox" data-timer-enabled${t.enabled ? ' checked' : ''}${dis}> ${T('skoda.timers.active')}</label>
        <label>${T('skoda.timers.time')} <input type="time" data-timer-time value="${esc(t.time || '')}"${dis}></label>
      </div>
      <div class="skoda-timer-days" role="group" aria-label="${T('skoda.timers.days')}">${chips}</div>
      <div class="skoda-timer-foot">
        ${editable ? `<button class="btn btn-sm" data-timer-save>${T('skoda.timers.save')}</button>` : ''}
        <span class="skoda-timer-msg">${t.type === 'ONE_OFF' ? T('skoda.timers.readonly') : ''}</span>
      </div>
    </div>`;
  }

  function timersBlock(v) {
    const timers = (v.state && v.state.climate && v.state.climate.timers) || [];
    const body = timers.length ? timers.map((t) => timerRow(v.id, t)).join('') : `<p>${T('skoda.timers.none')}</p>`;
    return `<details class="skoda-timers-block"><summary>${T('skoda.timers.title')}</summary>${body}</details>`;
  }

  function vehicleCard(v) {
    const s = v.state || {};
    const lock = s.locked === true ? T('skoda.vehicle.locked') : s.locked === false ? T('skoda.vehicle.unlocked') : '—';
    // sqlite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC -> proper ISO first
    const fetched = v.fetched_at ? T('skoda.vehicle.fetched', { time: new Date(v.fetched_at.replace(' ', 'T') + 'Z').toLocaleString() }) : '—';
    return `<div class="skoda-card" data-id="${v.id}">
      ${v.has_image ? `<img class="skoda-card-img" src="/api/v1/skoda/vehicles/${v.id}/image" alt="">` : ''}
      <div class="skoda-card-head"><strong>${esc(v.name || v.model || v.vin)}</strong><span class="skoda-vin">${esc(v.vin)}</span></div>
      <div class="skoda-card-stats">
        <span>${T('skoda.vehicle.soc')}: ${s.soc ?? '—'}${s.soc != null ? '%' : ''}</span>
        <span>${T('skoda.vehicle.range')}: ${s.rangeKm ?? '—'}${s.rangeKm != null ? ' km' : ''}</span>
        <span>${lock}</span>
        <span>${T('skoda.vehicle.mileage')}: ${s.health && s.health.mileageKm != null ? s.health.mileageKm + ' km' : '—'}</span>
      </div>
      <div class="skoda-card-meta">${esc(fetched)} · ${T('skoda.vehicle.owners')}: ${esc((v.owners || []).map((o) => o.username).join(', ') || '—')}</div>
      <div class="skoda-card-actions">
        <button class="btn btn-sm" data-action="owners">${T('skoda.vehicle.owners')}</button>
        <button class="btn btn-sm" data-action="refresh">${T('skoda.vehicle.refresh')}</button>
      </div>
      <div class="skoda-cmds" data-veh="${v.id}">
        <button class="btn btn-sm" data-cmd="ac_start" data-temp="21">${T('skoda.cmd.ac_on')}</button>
        <button class="btn btn-sm" data-cmd="ac_stop">${T('skoda.cmd.ac_off')}</button>
        <label>${T('skoda.cmd.set_temp')} <input type="number" min="15.5" max="30" step="0.5" value="21" data-temp-input></label>
        <button class="btn btn-sm" data-cmd="ac_temp">${T('skoda.cmd.set_temp')}</button>
        <button class="btn btn-sm" data-cmd="charge_start">${T('skoda.cmd.charge_on')}</button>
        <button class="btn btn-sm" data-cmd="charge_stop">${T('skoda.cmd.charge_off')}</button>
        <button class="btn btn-sm" data-cmd="window_heat_start">${T('skoda.cmd.window_heat_on')}</button>
        <button class="btn btn-sm" data-cmd="window_heat_stop">${T('skoda.cmd.window_heat_off')}</button>
        <button class="btn btn-sm" data-cmd="lock">${T('skoda.cmd.lock')}</button>
        <button class="btn btn-sm btn-danger" data-cmd="unlock">${T('skoda.cmd.unlock')}</button>
        <label>${T('skoda.cmd.set_limit')} <select data-cmd="charge_limit"><option>50</option><option>60</option><option>70</option><option>80</option><option>90</option><option>100</option></select></label>
      </div>
      <details class="skoda-details-block"><summary>${T('skoda.details.title')}</summary><div class="skoda-enrich" data-veh="${v.id}"></div></details>
      ${timersBlock(v)}
    </div>`;
  }

  // Read-only enrichment (meta/equipment/connection/drivingScore) — fetched once
  // per vehicle on first <details> open, cached in skodaEnrich so re-opening or a
  // subsequent load() rebuild never re-fetches.
  function detailsHtml(d) {
    const meta = d.meta || {};
    const rows = [];
    const title = meta.title || meta.model;
    if (title != null) rows.push(`<div>${T('skoda.details.model')}: ${esc(title)}</div>`);
    if (meta.modelYear != null) rows.push(`<div>${T('skoda.details.year')}: ${esc(meta.modelYear)}</div>`);
    if (meta.manufacturingDate != null) rows.push(`<div>${T('skoda.details.made')}: ${esc(meta.manufacturingDate)}</div>`);
    if (meta.body != null) rows.push(`<div>${T('skoda.details.body')}: ${esc(meta.body)}</div>`);
    if (meta.trimLevel != null) rows.push(`<div>${T('skoda.details.trim')}: ${esc(meta.trimLevel)}</div>`);
    if (meta.powerKw != null) rows.push(`<div>${T('skoda.details.power')}: ${esc(meta.powerKw)} kW</div>`);
    if (meta.batteryKwh != null) rows.push(`<div>${T('skoda.details.battery')}: ${esc(meta.batteryKwh)} kWh</div>`);
    if (meta.maxChargingKw != null) rows.push(`<div>${T('skoda.details.max_charging')}: ${esc(meta.maxChargingKw)} kW</div>`);
    let html = rows.length ? `<div class="skoda-details-meta">${rows.join('')}</div>` : '';

    const equipment = Array.isArray(d.equipment) ? d.equipment : [];
    if (equipment.length) {
      html += `<div class="skoda-details-equipment"><strong>${T('skoda.details.equipment')}</strong> `
        + equipment.map((e) => `<span class="skoda-chip">${esc(e)}</span>`).join('') + `</div>`;
    }

    const conn = d.connection;
    if (conn) {
      const parts = [];
      if (conn.online != null) parts.push(conn.online ? T('skoda.details.online') : T('skoda.details.offline'));
      if (conn.ignitionOn != null) parts.push(conn.ignitionOn ? T('skoda.details.ignition_on') : T('skoda.details.ignition_off'));
      if (conn.inMotion) parts.push(T('skoda.details.in_motion'));
      if (parts.length) html += `<div class="skoda-details-connection"><strong>${T('skoda.details.connection')}</strong>: ${esc(parts.join(', '))}</div>`;
    }

    const score = d.drivingScore;
    if (score) {
      const parts = [];
      if (score.weekly != null) parts.push(`${T('skoda.details.score_weekly')}: ${esc(score.weekly)}`);
      if (score.monthly != null) parts.push(`${T('skoda.details.score_monthly')}: ${esc(score.monthly)}`);
      if (score.lastCalculationDate != null) parts.push(`${T('skoda.details.score_as_of')}: ${esc(score.lastCalculationDate)}`);
      if (parts.length) html += `<div class="skoda-details-score"><strong>${T('skoda.details.score')}</strong>: ${parts.join(' · ')}</div>`;
    }
    return html;
  }

  async function loadDetails(vehId, container) {
    if (skodaEnrich[vehId] != null) { container.innerHTML = skodaEnrich[vehId]; return; }
    if (skodaPending.has(vehId)) return; // a fetch is already in flight for this vehicle
    skodaPending.add(vehId);
    try {
      const res = await fetch(`/api/v1/skoda/vehicles/${vehId}/details`, { headers });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        const html = detailsHtml(json.details || {});
        skodaEnrich[vehId] = html; // cache success only
        container.innerHTML = html;
      } else {
        // Error (esp. 429) is transient — show it but do NOT cache, so reopening retries.
        container.innerHTML = `<p class="skoda-details-error">${esc(res.status === 429 ? T('skoda.details.rate_limited') : T('skoda.details.load_error'))}</p>`;
      }
    } catch (e) {
      container.innerHTML = `<p class="skoda-details-error">${esc(T('skoda.details.load_error'))}</p>`;
    } finally {
      skodaPending.delete(vehId);
    }
  }

  async function command(vehicleId, action, args, el) {
    if (action === 'unlock' && !confirm(T('skoda.cmd.confirm_unlock'))) return;
    if (el && el.disabled) return; // already in flight → no command storm
    var isBtn = el && el.tagName === 'BUTTON';
    var restore = isBtn ? el.textContent : null;
    var reset = function () { if (el) { el.disabled = false; if (isBtn && restore != null) el.textContent = restore; } };
    if (el) { el.disabled = true; if (isBtn) el.textContent = T('skoda.cmd.running'); }
    var watchdog = setTimeout(reset, 30000); // hard fallback if the request never settles
    try {
      await api('POST', `/vehicles/${vehicleId}/command`, { action, args: args || {} });
      setTimeout(load, 3000); // let the 30s post-command refresh begin; reload state
    } catch (e) {
      alert(e.code === 'SKODA_SPIN_REQUIRED' ? T('skoda.cmd.spin') + '?' : (e.message || T('skoda.cmd.failed')));
    } finally {
      clearTimeout(watchdog);
      setTimeout(reset, 3000);
    }
  }

  // Notbremse wie im Portal: Gesetzt wird `dirty` bei jeder Eingabe, entfernt nur
  // beim erfolgreichen Speichern. Ohne Ablauf blockierte eine nie gespeicherte
  // Zeile JEDEN load()-Aufrufer dauerhaft — und das sind fast alle Aktionen der
  // Seite (Konto anlegen/löschen, Passwort, Fahrzeug-Refresh, Besitzer speichern).
  // Der Admin pollt nicht, es gäbe also keine Selbstheilung außer F5.
  let _timerDirtyTimeout = null;
  function markTimerDirty(row) {
    if (!row) return;
    row.dataset.dirty = '1';
    if (_timerDirtyTimeout) clearTimeout(_timerDirtyTimeout);
    _timerDirtyTimeout = setTimeout(() => {
      el('skoda-vehicles').querySelectorAll('.skoda-timer[data-dirty]').forEach((r) => { delete r.dataset.dirty; });
      _timerDirtyTimeout = null;
    }, 600000);
  }

  async function saveTimer(row, btn) {
    if (!row || btn.disabled) return;
    const msg = row.querySelector('.skoda-timer-msg');
    const time = row.querySelector('[data-timer-time]').value;
    const days = [...row.querySelectorAll('.skoda-timer-day[aria-pressed="true"]')].map((b) => b.dataset.day);
    if (!time || !days.length) { msg.textContent = T('skoda.timers.invalid'); return; }
    const args = { id: Number(row.dataset.timer), enabled: row.querySelector('[data-timer-enabled]').checked, time, days };
    // Ganze Zeile einfrieren: sonst quittiert das grüne "Gespeichert" auch
    // Änderungen, die nach dem Absenden getippt und nie gesendet wurden.
    const fields = [...row.querySelectorAll('input, .skoda-timer-day')];
    const release = () => { btn.disabled = false; fields.forEach((f) => { f.disabled = false; }); };
    btn.disabled = true;
    fields.forEach((f) => { f.disabled = true; });
    msg.textContent = '';
    msg.classList.remove('skoda-timer-ok');
    // fetch hat kein eigenes Timeout — ohne Watchdog bliebe die Zeile nach einem
    // hängenden Request bis zum Reload gesperrt.
    const watchdog = setTimeout(() => { release(); msg.textContent = T('skoda.timers.save_failed'); }, 30000);
    try {
      await api('POST', `/vehicles/${row.dataset.veh}/command`, { action: 'timer_set', args });
      delete row.dataset.dirty;
      msg.textContent = T('skoda.timers.saved');
      msg.classList.add('skoda-timer-ok');
      setTimeout(() => { msg.textContent = ''; msg.classList.remove('skoda-timer-ok'); }, 3000);
    } catch (e) {
      // Nur übersetzte Texte — e.message wären rohe englische Serverstrings.
      msg.textContent = e.code === 'SKODA_TIMER_NOT_FOUND' ? T('skoda.timers.not_found')
        : e.code === 'SKODA_TIMER_READONLY' ? T('skoda.timers.readonly')
        : e.code === 'SKODA_VALIDATION' ? T('skoda.timers.invalid')
        : T('skoda.timers.save_failed');
    } finally {
      clearTimeout(watchdog);
      release();
    }
  }

  async function load() {
    const vehiclesEl = el('skoda-vehicles');
    // Ungespeicherte Timer-Eingabe schlägt jeden Rebuild — auch den, den
    // command() 3s nach einem Klima-/Lade-/Sperrbefehl auslöst.
    if (vehiclesEl.querySelector('.skoda-timer[data-dirty]')) return;
    // Offen-Zustand je Fahrzeug-ID merken (nicht positionsindiziert: ein
    // entferntes oder neues Fahrzeug würde sonst den falschen Block öffnen)
    // und den bereits geladenen Enrich-Inhalt wieder einsetzen.
    const wasOpen = {};
    vehiclesEl.querySelectorAll('.skoda-card').forEach((c) => {
      wasOpen[c.dataset.id] = {
        details: !!(c.querySelector('.skoda-details-block') || {}).open,
        timers: !!(c.querySelector('.skoda-timers-block') || {}).open,
      };
    });
    current = await api('GET', '');
    el('skoda-poll-interval').value = current.poll_interval_min;
    el('skoda-accounts').innerHTML = current.accounts.map(accountRow).join('') || '';
    vehiclesEl.innerHTML = current.vehicles.map(vehicleCard).join('') || `<p>${T('skoda.vehicles.empty')}</p>`;
    vehiclesEl.querySelectorAll('.skoda-card').forEach((c) => {
      const st = wasOpen[c.dataset.id];
      if (!st) return;
      const timers = c.querySelector('.skoda-timers-block');
      if (timers && st.timers) timers.open = true;
      const d = c.querySelector('.skoda-details-block');
      if (!d || !st.details) return;
      d.open = true;
      const box = d.querySelector('.skoda-enrich');
      if (!box) return;
      const vehId = Number(box.dataset.veh);
      if (skodaEnrich[vehId] != null) box.innerHTML = skodaEnrich[vehId];
    });
  }

  function fail(e) { alert(e.code === 'SKODA_REFRESH_COOLDOWN' ? T('skoda.error.cooldown') : (e.message || T('skoda.error.generic'))); }

  el('skoda-account-add-open').addEventListener('click', () => showModal('skoda-account-modal'));
  el('skoda-acc-cancel').addEventListener('click', () => hideModal('skoda-account-modal'));
  el('skoda-acc-save').addEventListener('click', async () => {
    try {
      const created = await api('POST', '/accounts', { email: el('skoda-acc-email').value, password: el('skoda-acc-password').value });
      api('POST', `/accounts/${created.account.id}/sync`).catch(() => {}); // fire and forget, status lands on the account row
      hideModal('skoda-account-modal');
      el('skoda-acc-email').value = ''; el('skoda-acc-password').value = '';
      await load();
    } catch (e) { fail(e); }
  });

  el('skoda-accounts').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const id = Number(btn.closest('.skoda-account').dataset.id);
    try {
      if (btn.dataset.action === 'remove') { await api('DELETE', `/accounts/${id}`); await load(); }
      if (btn.dataset.action === 'password') {
        const pw = prompt(T('skoda.accounts.password'));
        if (pw) {
          await api('PUT', `/accounts/${id}`, { password: pw });
          api('POST', `/accounts/${id}/sync`).catch(() => {});
          await load();
        }
      }
      if (btn.dataset.action === 'spin') {
        spinAccountId = id;
        el('skoda-spin-input').value = '';
        showModal('skoda-spin-modal');
      }
    } catch (e) { fail(e); }
  });

  el('skoda-spin-cancel').addEventListener('click', () => hideModal('skoda-spin-modal'));
  el('skoda-spin-save').addEventListener('click', async () => {
    try {
      await api('PUT', `/accounts/${spinAccountId}/spin`, { spin: el('skoda-spin-input').value });
      hideModal('skoda-spin-modal');
    } catch (e) { fail(e); }
  });

  el('skoda-vehicles').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const id = Number(btn.closest('.skoda-card').dataset.id);
    try {
      if (btn.dataset.action === 'refresh') { await api('POST', `/vehicles/${id}/refresh`); await load(); }
      if (btn.dataset.action === 'owners') {
        ownerVehicleId = id;
        const users = (await apiRoot('GET', '/users')).users || [];
        const owned = new Set(((current.vehicles.find((v) => v.id === id) || {}).owners || []).map((o) => o.id));
        el('skoda-owner-list').innerHTML = users.map((u) =>
          `<label class="skoda-owner-item"><input type="checkbox" value="${u.id}" ${owned.has(u.id) ? 'checked' : ''}> ${esc(u.username)}</label>`).join('');
        showModal('skoda-owner-modal');
      }
    } catch (e) { fail(e); }
  });

  // 'toggle' does not bubble, so bind on the capture phase to catch it from any
  // <details class="skoda-details-block"> inside the container.
  el('skoda-vehicles').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.classList || !d.classList.contains('skoda-details-block') || !d.open) return;
    const box = d.querySelector('.skoda-enrich');
    if (!box) return;
    loadDetails(Number(box.dataset.veh), box);
  }, true);

  el('skoda-vehicles').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.skoda-timer-day');
    if (chip && !chip.disabled) {
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      markTimerDirty(chip.closest('.skoda-timer'));
      return;
    }
    const save = ev.target.closest('[data-timer-save]');
    if (save) { saveTimer(save.closest('.skoda-timer'), save); return; }
    const b = ev.target.closest('button[data-cmd]'); if (!b) return;
    const box = b.closest('.skoda-cmds'); const veh = Number(box.dataset.veh);
    let args = {};
    if (b.dataset.cmd === 'ac_start' || b.dataset.cmd === 'ac_temp') {
      var inp = box.querySelector('[data-temp-input]');
      var tv = Number(inp && inp.value);
      args = { temp: (isFinite(tv) && tv) ? tv : 21 };
    } else if (b.dataset.temp) args = { temp: Number(b.dataset.temp) };
    command(veh, b.dataset.cmd, args, b);
  });
  el('skoda-vehicles').addEventListener('change', (ev) => {
    const s = ev.target.closest('select[data-cmd="charge_limit"]'); if (!s) return;
    command(Number(s.closest('.skoda-cmds').dataset.veh), 'charge_limit', { limit: Number(s.value) }, s);
  });
  ['input', 'change'].forEach((evt) => {
    el('skoda-vehicles').addEventListener(evt, (ev) => markTimerDirty(ev.target.closest('.skoda-timer')));
  });

  el('skoda-owner-cancel').addEventListener('click', () => hideModal('skoda-owner-modal'));
  el('skoda-owner-save').addEventListener('click', async () => {
    const ids = [...el('skoda-owner-list').querySelectorAll('input:checked')].map((i) => Number(i.value));
    try { await api('PUT', `/vehicles/${ownerVehicleId}/owners`, { user_ids: ids }); hideModal('skoda-owner-modal'); await load(); }
    catch (e) { fail(e); }
  });

  el('skoda-poll-interval').addEventListener('change', async (ev) => {
    try { await api('PUT', '/settings', { poll_interval_min: Number(ev.target.value) }); } catch (e) { fail(e); }
  });

  load().catch(fail);
})();
