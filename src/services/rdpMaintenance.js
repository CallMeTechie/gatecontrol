'use strict';

const { getDb } = require('../db/connection');

/**
 * Maintenance-window helpers for RDP routes.
 *
 * Schedule format: "Mo-Fr 08:00-18:00", multiple windows separated by
 * newline or semicolon. Day codes: Mo, Di, Mi, Do, Fr, Sa, So (German)
 * or Mon, Tue, Wed, Thu, Fri, Sat, Sun (English). The week wraps so
 * "Fr-Mo 22:00-06:00" covers Friday → Sunday → Monday.
 *
 * Activation is decided live in node-local time — there is no
 * timezone field today; the ops team accepts that and schedules in
 * server time.
 */

const DAY_MAP = {
  'Mo': 1, 'Di': 2, 'Mi': 3, 'Do': 4, 'Fr': 5, 'Sa': 6, 'So': 0,
  'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6, 'Sun': 0,
};

const SCHEDULE_LINE_RE = /^(\w{2,3})(?:-(\w{2,3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

/**
 * Returns true when the named RDP route's maintenance flag is on AND
 * its schedule covers the current moment. False on missing route, on
 * disabled maintenance, on empty schedule.
 */
function isInMaintenanceWindow(routeId) {
  const db = getDb();
  const route = db.prepare(
    'SELECT maintenance_enabled, maintenance_schedule FROM rdp_routes WHERE id = ?'
  ).get(routeId);
  if (!route || !route.maintenance_enabled || !route.maintenance_schedule) return false;
  return parseMaintenanceActive(route.maintenance_schedule);
}

/**
 * Returns true when `schedule` covers `now` (defaults to live wall
 * clock; the caller can pass a Date to make this deterministic in
 * tests).
 */
function parseMaintenanceActive(schedule, now = new Date()) {
  if (!schedule) return false;

  // Backwards compatibility: older rows were JSON.stringify'd, so the string
  // is wrapped in double-quotes. Unwrap it so the regex parses cleanly.
  if (typeof schedule === 'string' && schedule.startsWith('"') && schedule.endsWith('"')) {
    try { schedule = JSON.parse(schedule); } catch {}
  }

  const dayIndex = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const lines = schedule.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(SCHEDULE_LINE_RE);
    if (!match) continue;

    const [, dayStart, dayEnd, h1, m1, h2, m2] = match;
    const startDay = DAY_MAP[dayStart];
    if (startDay === undefined) continue;
    const endDay = dayEnd !== undefined ? DAY_MAP[dayEnd] : startDay;
    if (endDay === undefined) continue;

    const startMin = parseInt(h1, 10) * 60 + parseInt(m1, 10);
    const endMin = parseInt(h2, 10) * 60 + parseInt(m2, 10);

    let dayInRange;
    if (startDay <= endDay) {
      dayInRange = dayIndex >= startDay && dayIndex <= endDay;
    } else {
      dayInRange = dayIndex >= startDay || dayIndex <= endDay;
    }

    if (dayInRange && currentMinutes >= startMin && currentMinutes < endMin) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isInMaintenanceWindow,
  parseMaintenanceActive,
};
