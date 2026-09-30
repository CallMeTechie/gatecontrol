'use strict';

/**
 * Zählt die vom Bot-Blocker abgewiesenen Requests (Status 403) je Route aus
 * Caddys access.log und addiert sie auf routes.bot_blocker_count.
 *
 * Früher wurde die komplette Datei jede Minute synchron gelesen (bis zu
 * roll_size_mb = 10 MB, Event-Loop blockiert). Jetzt liest utils/logTail
 * nur die seit dem letzten Tick angehängten Bytes, asynchron. Die Zählung
 * bleibt dieselbe: nur 403er mit ts > letztem gesehenem 403-ts, Host ohne
 * Port, nur Routen mit aktiviertem Bot-Blocker.
 */

const path = require('node:path');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { createLogTail } = require('../utils/logTail');

const INTERVAL_MS = 60000;

function accessLogPath() {
  return path.join(config.caddy.dataDir || '/data/caddy', 'access.log');
}

/**
 * Reine Zählfunktion. `state.lastTs` wird fortgeschrieben.
 * @returns {Map<number, number>} routeId → Anzahl
 */
function countBlocked(lines, domainMap, state) {
  const counts = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.status !== 403) continue;
      const ts = entry.ts || 0;
      if (ts <= state.lastTs) continue;
      state.lastTs = ts;

      const host = (entry.request?.host || '').split(':')[0].toLowerCase();
      const routeId = domainMap.get(host);
      if (!routeId) continue;
      counts.set(routeId, (counts.get(routeId) || 0) + 1);
    } catch { /* skip */ }
  }
  return counts;
}

function createCounter({ file = accessLogPath(), getDb = () => require('../db/connection').getDb() } = {}) {
  const tail = createLogTail(file);
  const state = { lastTs: 0 };
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const db = getDb();
      const enabledRoutes = db.prepare(
        'SELECT id, domain FROM routes WHERE bot_blocker_enabled = 1'
      ).all();
      // Ohne aktivierte Route nichts lesen — der Offset bleibt stehen, wie
      // früher der ts-Stand (spätere Aktivierung zählt den Rückstand mit).
      if (enabledRoutes.length === 0) return;

      const domainMap = new Map();
      for (const r of enabledRoutes) domainMap.set(r.domain.toLowerCase(), r.id);

      const lines = await tail.readNewLines();
      if (lines.length === 0) return;
      const counts = countBlocked(lines, domainMap, state);

      const update = db.prepare(
        'UPDATE routes SET bot_blocker_count = bot_blocker_count + ? WHERE id = ?'
      );
      for (const [routeId, count] of counts) update.run(count, routeId);
    } catch (err) {
      logger.warn('Bot counter error: ' + err.message);
    } finally {
      busy = false;
    }
  }

  return { tick, tail, state };
}

let _timer = null;

function start() {
  if (_timer) return;
  const counter = createCounter();
  _timer = setInterval(() => { counter.tick(); }, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, createCounter, countBlocked, accessLogPath };
