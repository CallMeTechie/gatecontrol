'use strict';

// Reverse-geocode GPS coordinates to a compact address via OSM/Nominatim.
// Cache key = coordinate rounded to 3 decimals (~110 m) so a parked car always
// hits cache (that rounding IS the spec's 100 m re-resolution threshold). All
// outbound requests are pinned to the Nominatim host (SSRF guard) and carry a
// valid User-Agent per Nominatim's usage policy. Any failure yields null and is
// cached, so a slow or down geocoder never blocks or errors the portal.

const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const USER_AGENT = 'GateControl/1.0 (self-hosted vehicle address lookup; +https://github.com/CallMeTechie/gatecontrol)';

// ponytail: cache never proactively evicts expired entries — fine for a
// two-car household's bounded set of visited ~110m buckets; add periodic
// pruning if the fleet or location diversity ever grows meaningfully.
const cache = new Map(); // "lat3,lon3" -> { label: string|null, at: number }

function validCoord(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number'
    && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function labelFrom(json) {
  const a = json && json.address;
  if (a && (a.road || a.city || a.town || a.village)) {
    const line1 = [a.road, a.house_number].filter(Boolean).join(' ');
    const place = a.city || a.town || a.village || a.municipality || '';
    const line2 = [a.postcode, place].filter(Boolean).join(' ');
    const label = [line1, line2].filter(Boolean).join(', ');
    if (label) return label;
  }
  return (json && typeof json.display_name === 'string' && json.display_name) || null;
}

async function reverseGeocode(lat, lon, { fetchImpl = fetch } = {}) {
  if (!validCoord(lat, lon)) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.label;

  const url = `https://${NOMINATIM_HOST}/reverse?` + new URLSearchParams({
    format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '18', addressdetails: '1',
  }).toString();

  let label = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: ctl.signal });
    } finally { clearTimeout(timer); }
    if (res && res.status < 400) label = labelFrom(await res.json());
  } catch { label = null; }

  cache.set(key, { label, at: Date.now() });
  return label;
}

function _resetForTest() { cache.clear(); }

module.exports = { reverseGeocode, _resetForTest, NOMINATIM_HOST };
