'use strict';

// Antworten von GET /api/v1/dashboard/updates für das Dashboard-Szenario
// (page.route): die drei Zustände der Karte „Updates“ mit den Zahlen des
// freigegebenen Entwurfs. Die Form ist die von services/dashboardUpdates.js
// (summary); die Unit-Tests tests/dashboard_updates*.test.js prüfen sie am
// echten Dienst.

const MIN = 60 * 1000;
const iso = (now, agoMs) => new Date(now - agoMs).toISOString();

function auto(over = {}) {
  return { status: 'active', mode: 'auto', age_s: 180, last_action: 'noop', mode_mismatch: false,
    window: { enabled: false, start: '03:00', end: '05:00' }, can_trigger: false, ...over };
}

function server(now, over = {}) {
  return { state: 'current', running_version: '1.269.1', latest_version: '1.269.1', update_available: false, release_url: null,
    checked_at: iso(now, 12 * MIN), check_failed: false, failed_at: null, auto: auto(), ...over };
}

function plugins(now, over = {}) {
  return { state: 'current', installed: 4, updates: [], checked_at: iso(now, 12 * MIN), check_failed: false, failed_at: null, error_code: null, ...over };
}

function gateways(now, over = {}) {
  return { state: 'current', total: 2, outdated: 0, unreported: 0, latest_version: '1.31.0',
    checked_at: iso(now, 12 * MIN), check_failed: false, failed_at: null,
    items: [{ id: 1, name: 'gw-home', version: '1.31.0', update_available: false }, { id: 2, name: 'gw-nas', version: '1.31.0', update_available: false }], ...over };
}

function product(now, name, latest, total, over = {}) {
  return { product: name, channel: 'stable', latest_version: latest, checked_at: iso(now, 12 * MIN), check_failed: false, failed_at: null,
    total, outdated: 0, unknown: 0, versions: [], ...over };
}

function apps(now, over = {}) {
  return { state: 'current', total: 7, outdated: 0, unknown: 0, unreported: 0, checked_at: iso(now, 12 * MIN), check_failed: false, failed_at: null,
    products: [product(now, 'android', '1.17.2', 3), product(now, 'pro', '1.9.6', 2), product(now, 'community', '1.14.0', 2)], ...over };
}

/** state: 'ok' | 'some' | 'fail' → the JSON body of the endpoint. */
function updatesAnswer(state, now = Date.now()) {
  if (state === 'some') {
    return {
      ok: true, state: 'updates', updates: 3, checked_at: iso(now, 12 * MIN), failed_at: null,
      server: server(now, { state: 'update', latest_version: '1.270.0', update_available: true,
        release_url: 'https://github.com/CallMeTechie/gatecontrol/releases/tag/v1.270.0',
        auto: auto({ last_action: 'waiting_window', window: { enabled: true, start: '03:00', end: '05:00' }, can_trigger: true }) }),
      plugins: plugins(now, { state: 'update', updates: [
        { id: 'door-camera', name: 'Tür & Kamera', from: '1.3.2', to: '1.4.0' },
        { id: 'household', name: 'Haushaltsbuch', from: '2.1.2', to: '2.1.3' }] }),
      gateways: gateways(now, { state: 'update', outdated: 1, items: [
        { id: 1, name: 'gw-home', version: '1.31.0', update_available: false },
        { id: 2, name: 'gw-nas', version: '1.30.2', update_available: true }] }),
      apps: apps(now),
    };
  }
  if (state === 'fail') {
    const yesterday = new Date(now - 24 * 60 * MIN); yesterday.setHours(21, 4, 0, 0);
    const morning = new Date(now); morning.setHours(8, 10, 0, 0);
    const morningIso = (morning.getTime() <= now ? morning : new Date(now - 30 * MIN)).toISOString();
    return {
      ok: true, state: 'unknown', updates: 1, checked_at: yesterday.toISOString(), failed_at: iso(now, 2 * MIN),
      server: server(now, { checked_at: iso(now, 3 * MIN) }),
      plugins: plugins(now, { checked_at: yesterday.toISOString(), check_failed: true, failed_at: iso(now, 2 * MIN), error_code: 'catalog_unreachable' }),
      gateways: gateways(now, { checked_at: yesterday.toISOString(), check_failed: true, failed_at: iso(now, 2 * MIN) }),
      apps: apps(now, { state: 'update', outdated: 2, unreported: 1, checked_at: morningIso, check_failed: true, failed_at: iso(now, 2 * MIN),
        products: [
          product(now, 'android', '1.17.2', 3, { outdated: 2, versions: [{ version: '1.16.0', count: 2 }], checked_at: morningIso, check_failed: true, failed_at: iso(now, 2 * MIN) }),
          product(now, 'pro', '1.9.6', 2), product(now, 'community', '1.14.0', 2)] }),
    };
  }
  return { ok: true, state: 'ok', updates: 0, checked_at: iso(now, 12 * MIN), failed_at: null,
    server: server(now), plugins: plugins(now), gateways: gateways(now), apps: apps(now) };
}

/** Answer every GET /api/v1/dashboard/updates of `page` with the state `get()` names. */
async function mockUpdates(page, get) {
  await page.route('**/api/v1/dashboard/updates*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(updatesAnswer(get())),
  }));
}

module.exports = { updatesAnswer, mockUpdates };
