'use strict';

const owners = require('./skodaOwners');
const vehicles = require('./skodaVehicles');
const geocode = require('./skodaGeocode');

function pick(obj, keys) {
  const out = {};
  if (obj) for (const k of keys) out[k] = obj[k];
  return out;
}

// Build the portal-facing, owner-scoped, redacted vehicle list. Read-only: the
// state comes straight from the DB cache the 15-min poller writes, no cloud
// calls here. Drops account_id and vin; resolves position to an address.
async function portalVehiclesFor(ownerId, { fetchImpl, includePosition = true } = {}) {
  if (ownerId == null) return [];
  const ownedIds = new Set(owners.vehiclesOwnedBy(ownerId));
  if (!ownedIds.size) return [];

  // Geocode all owned vehicles in parallel: each reverseGeocode is bounded by
  // its own timeout, so the whole response never waits longer than one lookup.
  return Promise.all(
    vehicles.listRedacted()
      .filter((v) => ownedIds.has(v.id))
      .map(async (v) => ({
        id: v.id,
        name: v.name,
        model: v.model,
        fetched_at: v.fetched_at,
        has_image: v.has_image,
        state: await redactState(v.state, fetchImpl, includePosition),
      })),
  );
}

async function redactState(state, fetchImpl, loggedIn) {
  if (!state) return null;
  let position = null;
  // GPS + home address only for a real login; device-trust reads never see it.
  if (loggedIn && state.position && typeof state.position.lat === 'number' && typeof state.position.lon === 'number') {
    const address = await geocode.reverseGeocode(state.position.lat, state.position.lon, { fetchImpl });
    position = { lat: state.position.lat, lon: state.position.lon, address };
  }
  // Explicit allowlist down to the leaf fields (not a spread): a future TP1
  // field added anywhere in state_json — including inside charging/climate/… —
  // must never auto-leak into the portal. Exactly the spec's MVP display fields.
  const h = state.health || {};
  return {
    capturedAt: state.capturedAt, locked: state.locked,
    doorsOpen: state.doorsOpen, windowsOpen: state.windowsOpen,
    detail: pick(state.detail, ['bonnet', 'trunk', 'sunroof']),
    lightsOn: state.lightsOn,
    soc: state.soc, rangeKm: state.rangeKm,
    charging: pick(state.charging, ['state', 'powerKw', 'remainingMin', 'targetPercent', 'mode', 'cableConnected']),
    // pick() ist eine Leaf-Allowlist und greift nicht in Arrays — die Timer
    // werden deshalb einzeln durch dieselbe Allowlist geschickt, damit ein
    // künftig von Skoda ergänztes Feld das Portal nicht ungeprüft erreicht.
    // Abfahrtszeiten sind ein Anwesenheitsprofil: dieselbe Sensitivitätsklasse
    // wie GPS, also nur bei echtem Login (routes/api/portal.js:318).
    climate: {
      ...pick(state.climate, ['state', 'targetC', 'remainingMin', 'windowHeating']),
      timers: loggedIn && state.climate && Array.isArray(state.climate.timers)
        ? state.climate.timers.map((t) => pick(t, ['id', 'enabled', 'time', 'type', 'days']))
        : [],
    },
    position,
    health: { mileageKm: h.mileageKm, warnings: Array.isArray(h.warnings) ? h.warnings : [] },
    maintenance: pick(state.maintenance, ['dueInDays', 'dueInKm', 'partner']),
  };
}

module.exports = { portalVehiclesFor };
