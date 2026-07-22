'use strict';

// Live spike for the MySkoda API. Usage:
//   SKODA_EMAIL=... SKODA_PASSWORD=... node scripts/skoda-spike.js [vin]
// Prints token acquisition, garage list and the raw JSON of every status
// endpoint for the first (or given) VIN. Never writes to the DB.

const auth = require('../src/services/skoda/skodaAuth');

const EMAIL = process.env.SKODA_EMAIL;
const PASSWORD = process.env.SKODA_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('set SKODA_EMAIL and SKODA_PASSWORD');
  process.exit(1);
}

async function get(tokens, path) {
  const res = await fetch(`${auth.API_BASE}${path}`, {
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
  });
  const body = await res.text();
  console.log(`\n=== GET ${path} -> ${res.status} ===`);
  try { console.log(JSON.stringify(JSON.parse(body), null, 2)); } catch { console.log(body.slice(0, 2000)); }
  return res;
}

(async () => {
  console.log('logging in…');
  const tokens = await auth.login(EMAIL, PASSWORD);
  console.log('login OK, got tokens (access token length:', tokens.accessToken.length, ')');

  console.log('testing refresh…');
  const refreshed = await auth.refresh(tokens.refreshToken);
  console.log('refresh OK');

  const garageRes = await get(refreshed, '/api/v2/garage?connectivityGenerations=MOD1&connectivityGenerations=MOD2&connectivityGenerations=MOD3&connectivityGenerations=MOD4');
  const garage = await garageRes.clone?.().json?.() ?? null;
  const vin = process.argv[2] || (garage && garage.vehicles && garage.vehicles[0] && garage.vehicles[0].vin);
  if (!vin) { console.error('no vin found — check garage output above'); process.exit(1); }

  await get(refreshed, `/api/v2/garage/vehicles/${vin}`);
  await get(refreshed, `/api/v2/vehicle-status/${vin}`);
  await get(refreshed, `/api/v2/vehicle-status/${vin}/driving-range`);
  await get(refreshed, `/api/v1/charging/${vin}`);
  await get(refreshed, `/api/v2/air-conditioning/${vin}`);
  await get(refreshed, `/api/v1/maps/positions?vin=${vin}`);
  await get(refreshed, `/api/v1/vehicle-health-report/warning-lights/${vin}`);
  await get(refreshed, `/api/v3/vehicle-maintenance/vehicles/${vin}`);
  console.log('\nSPIKE COMPLETE');
})().catch((err) => { console.error('SPIKE FAILED:', err.code || '', err.message); process.exit(1); });
