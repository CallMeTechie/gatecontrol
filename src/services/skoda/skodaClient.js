'use strict';

const skodaAuth = require('./skodaAuth');
const { API_BASE } = skodaAuth;

class SkodaApiError extends Error {
  constructor(message, code, status) { super(message); this.name = 'SkodaApiError'; this.code = code; this.status = status; }
}

// Hosts observed serving compositeRenders images; confirm/extend via Task-3 spike.
// Hosts observed serving compositeRenders images (live-confirmed). iprenders is
// Skoda's public Azure blob bucket — pinned to the exact host (not all of
// *.blob.core.windows.net, which any Azure tenant can use).
const RENDER_HOST_ALLOWLIST = [/\.azureedge\.net$/, /\.skoda-auto\.cz$/, /^iprenders\.blob\.core\.windows\.net$/];

class SkodaClient {
  constructor({ getSession, saveSession, fetchImpl = fetch }) {
    this.getSession = getSession;
    this.saveSession = saveSession;
    this.fetchImpl = fetchImpl;
  }

  async _request(method, path, body, { retried = false } = {}) {
    const session = this.getSession();
    const opts = { method, headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await this.fetchImpl(`${API_BASE}${path}`, opts);
    if (res.status === 401 && !retried) {
      let tokens;
      try {
        tokens = await skodaAuth.refresh(session.refreshToken, { fetchImpl: this.fetchImpl });
      } catch (e) {
        if (e.code === 'SKODA_RATE_LIMITED') throw e; // account-level, abort as-is
        throw new SkodaApiError('token refresh failed', 'SKODA_UNAUTHORIZED', 401);
      }
      this.saveSession(tokens);
      return this._request(method, path, body, { retried: true });
    }
    if (res.status === 401) throw new SkodaApiError('unauthorized', 'SKODA_UNAUTHORIZED', 401);
    if (res.status === 429) throw new SkodaApiError('rate limited', 'SKODA_RATE_LIMITED', 429);
    if (res.status >= 400) throw new SkodaApiError(`api error ${res.status} for ${path}`, 'SKODA_API_ERROR', res.status);
    return res;
  }

  async _get(path) {
    return (await this._request('GET', path)).json();
  }

  garage() { return this._get('/api/v2/garage?connectivityGenerations=MOD1&connectivityGenerations=MOD2&connectivityGenerations=MOD3&connectivityGenerations=MOD4'); }
  vehicleInfo(vin) { return this._get(`/api/v2/garage/vehicles/${vin}`); }
  vehicleStatus(vin) { return this._get(`/api/v2/vehicle-status/${vin}`); }
  drivingRange(vin) { return this._get(`/api/v2/vehicle-status/${vin}/driving-range`); }
  charging(vin) { return this._get(`/api/v1/charging/${vin}`); }
  airConditioning(vin) { return this._get(`/api/v2/air-conditioning/${vin}`); }
  position(vin) { return this._get(`/api/v1/maps/positions?vin=${vin}`); }
  health(vin) { return this._get(`/api/v1/vehicle-health-report/warning-lights/${vin}`); }
  maintenance(vin) { return this._get(`/api/v3/vehicle-maintenance/vehicles/${vin}`); }

  async renderImage(url) {
    // The url comes from the Skoda API response — never fetch it unvalidated,
    // and never send our bearer token to an arbitrary host (SSRF/token leak).
    let parsed;
    try { parsed = new URL(url); } catch { throw new SkodaApiError('invalid render url', 'SKODA_API_ERROR', 0); }
    if (parsed.protocol !== 'https:' || !RENDER_HOST_ALLOWLIST.some((re) => re.test(parsed.hostname))) {
      throw new SkodaApiError(`render url host not allowed: ${parsed.hostname}`, 'SKODA_API_ERROR', 0);
    }
    // No auth header: the render is a public blob (live-confirmed 200 without
    // it), and sending the Skoda access token to a third-party CDN would leak it.
    const res = await this.fetchImpl(parsed.toString());
    if (res.status >= 400) throw new SkodaApiError(`image fetch failed ${res.status}`, 'SKODA_API_ERROR', res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  async fetchFullState(vin) {
    const parts = {};
    const jobs = {
      status: () => this.vehicleStatus(vin),
      drivingRange: () => this.drivingRange(vin),
      charging: () => this.charging(vin),
      airConditioning: () => this.airConditioning(vin),
      position: () => this.position(vin),
      health: () => this.health(vin),
      maintenance: () => this.maintenance(vin),
    };
    for (const [key, job] of Object.entries(jobs)) {
      try { parts[key] = await job(); } catch (e) {
        if (e.code === 'SKODA_RATE_LIMITED' || e.code === 'SKODA_UNAUTHORIZED') throw e; // account-level, abort
        parts[key] = null;
      }
    }
    return { parts, state: normalizeVehicleState(parts) };
  }

  startAc(vin, temp) {
    return this._request('POST', `/api/v2/air-conditioning/${vin}/start`,
      { heaterSource: 'ELECTRIC', targetTemperature: { temperatureValue: Math.round(temp * 2) / 2, unitInCar: 'CELSIUS' } });
  }
  stopAc(vin) { return this._request('POST', `/api/v2/air-conditioning/${vin}/stop`); }
  setAcTemp(vin, temp) {
    return this._request('POST', `/api/v2/air-conditioning/${vin}/settings/target-temperature`,
      { temperatureValue: Math.round(temp * 2) / 2, unitInCar: 'CELSIUS' });
  }
  startWindowHeating(vin) { return this._request('POST', `/api/v2/air-conditioning/${vin}/start-window-heating`); }
  stopWindowHeating(vin) { return this._request('POST', `/api/v2/air-conditioning/${vin}/stop-window-heating`); }
  startCharging(vin) { return this._request('POST', `/api/v1/charging/${vin}/start`); }
  stopCharging(vin) { return this._request('POST', `/api/v1/charging/${vin}/stop`); }
  setChargeLimit(vin, pct) { return this._request('PUT', `/api/v1/charging/${vin}/set-charge-limit`, { targetSOCInPercent: pct }); }
  lock(vin, spin) { return this._request('POST', `/api/v1/vehicle-access/${vin}/lock`, { currentSpin: spin }); }
  unlock(vin, spin) { return this._request('POST', `/api/v1/vehicle-access/${vin}/unlock`, { currentSpin: spin }); }
}

const YES = (v) => (v == null ? null : String(v).toUpperCase() === 'YES');
const OPEN = (v) => (v == null ? null : String(v).toUpperCase() === 'OPEN');
const ON = (v) => (v == null ? null : String(v).toUpperCase() === 'ON');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeVehicleState({ status, drivingRange, charging, airConditioning, position, health, maintenance }) {
  const chStatus = charging && charging.status;
  const per = drivingRange && drivingRange.primaryEngineRange;
  const pos = position && Array.isArray(position.positions)
    ? position.positions.find((p) => p && p.type === 'VEHICLE') : null;
  const windowHeating = airConditioning && airConditioning.windowHeatingState;
  return {
    capturedAt: (status && status.carCapturedTimestamp) || (health && health.capturedAt) || null,
    locked: status ? YES(status.overall && status.overall.locked) : null,
    doorsOpen: status ? OPEN(status.overall && status.overall.doors) : null,
    windowsOpen: status ? OPEN(status.overall && status.overall.windows) : null,
    detail: {
      bonnet: (status && status.detail && status.detail.bonnet) || null,
      trunk: (status && status.detail && status.detail.trunk) || null,
      sunroof: (status && status.detail && status.detail.sunroof) || null,
    },
    lightsOn: status ? ON(status.overall && status.overall.lights) : null,
    soc: per ? num(per.currentSoCInPercent)
      : (chStatus && chStatus.battery ? num(chStatus.battery.stateOfChargeInPercent) : null),
    rangeKm: drivingRange ? num(drivingRange.totalRangeInKm) : null,
    charging: {
      state: (chStatus && chStatus.state) || null,
      powerKw: chStatus ? num(chStatus.chargePowerInKw) : null,
      remainingMin: chStatus ? num(chStatus.remainingTimeToFullyChargedInMinutes) : null,
      targetPercent: charging && charging.settings ? num(charging.settings.targetStateOfChargeInPercent) : null,
      mode: (charging && charging.settings && charging.settings.chargingCareMode) || null,
      cableConnected: charging && charging.plug && charging.plug.connectionState != null
        ? String(charging.plug.connectionState).toUpperCase() === 'CONNECTED' : null,
    },
    climate: {
      state: (airConditioning && airConditioning.state) || null,
      targetC: airConditioning && airConditioning.targetTemperature ? num(airConditioning.targetTemperature.temperatureValue) : null,
      remainingMin: (() => {
        if (!airConditioning) return null;
        const direct = num(airConditioning.remainingTimeToReachTargetTemperatureInMinutes);
        if (direct != null) return direct;
        const ts = Date.parse(airConditioning.estimatedDateTimeToReachTargetTemperature || '');
        return Number.isFinite(ts) ? Math.max(0, Math.round((ts - Date.now()) / 60000)) : null;
      })(),
      windowHeating: windowHeating ? (ON(windowHeating.front) || ON(windowHeating.rear)) : null,
    },
    position: pos && pos.gpsCoordinates
      ? { lat: num(pos.gpsCoordinates.latitude), lon: num(pos.gpsCoordinates.longitude) } : null,
    health: {
      mileageKm: health ? num(health.mileageInKm) : null,
      warnings: (health && Array.isArray(health.warningLights) ? health.warningLights : [])
        .map((w) => (typeof w === 'string' ? w : (w && (w.category || w.type)) || 'UNKNOWN')),
    },
    maintenance: {
      dueInDays: maintenance && maintenance.maintenanceReport ? num(maintenance.maintenanceReport.inspectionDueInDays) : null,
      dueInKm: maintenance && maintenance.maintenanceReport ? num(maintenance.maintenanceReport.inspectionDueInKm) : null,
      partner: (maintenance && maintenance.preferredServicePartner && maintenance.preferredServicePartner.name) || null,
    },
  };
}

module.exports = { SkodaClient, SkodaApiError, normalizeVehicleState };
