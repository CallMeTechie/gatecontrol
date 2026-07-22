'use strict';

const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');

function upsertVehicle(accountId, garageEntry) {
  const db = getDb();
  const vin = garageEntry.vin;
  const name = garageEntry.name || garageEntry.title || vin;
  const model = (garageEntry.specification && garageEntry.specification.model) || null;
  // account_id only on insert: with vehicle sharing the same VIN can appear in
  // two account garages — first assignment wins, no flapping between accounts.
  db.prepare(`INSERT INTO skoda_vehicles (account_id, vin, name, model) VALUES (?, ?, ?, ?)
    ON CONFLICT(vin) DO UPDATE SET name = excluded.name, model = excluded.model`)
    .run(accountId, vin, name, model);
  return db.prepare('SELECT id, image, image_url FROM skoda_vehicles WHERE vin = ?').get(vin);
}

function saveState(vehicleId, state) {
  getDb().prepare("UPDATE skoda_vehicles SET state_json = ?, fetched_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(state), vehicleId);
}

function saveImage(vehicleId, image, url) {
  getDb().prepare('UPDATE skoda_vehicles SET image = ?, image_url = ? WHERE id = ?').run(image, url, vehicleId);
}

function listRedacted() {
  return getDb().prepare('SELECT id, account_id, vin, name, model, state_json, fetched_at, image IS NOT NULL AS has_image FROM skoda_vehicles ORDER BY id').all()
    .map((r) => {
      let state = null;
      if (r.state_json) {
        try { state = JSON.parse(r.state_json); } catch { logger.warn({ vin: r.vin }, 'skoda corrupt state_json'); }
      }
      return {
        id: r.id, account_id: r.account_id, vin: r.vin, name: r.name, model: r.model,
        state, fetched_at: r.fetched_at, has_image: Boolean(r.has_image),
      };
    });
}

function getImage(vehicleId) {
  const row = getDb().prepare('SELECT image, vin FROM skoda_vehicles WHERE id = ?').get(vehicleId);
  if (!row || !row.image) return null;
  return { image: row.image, vin: row.vin };
}

function accountIdOf(vehicleId) {
  const row = getDb().prepare('SELECT account_id FROM skoda_vehicles WHERE id = ?').get(vehicleId);
  return row ? row.account_id : null;
}

module.exports = { upsertVehicle, saveState, saveImage, listRedacted, getImage, accountIdOf };
