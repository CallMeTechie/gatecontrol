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

function isDayInRange(dayIndex, startDay, endDay) {
  if (startDay <= endDay) {
    return dayIndex >= startDay && dayIndex <= endDay;
  }
  // Wrap-around day range, e.g. "Fr-Mo" = Fri | Sat | Sun | Mon.
  return dayIndex >= startDay || dayIndex <= endDay;
}

/**
 * Returns true when `schedule` covers `now` (defaults to live wall
 * clock; the caller can pass a Date to make this deterministic in
 * tests).
 *
 * Supports two kinds of wrap-around independently:
 *
 *   - DAY range wraps the week: "Fr-Mo 09:00-17:00" → Fri/Sat/Sun/Mon
 *     each from 09:00 to 17:00.
 *   - TIME range wraps midnight: "Mo 22:00-06:00" → Mon 22:00 through
 *     Tue 06:00. Implemented by checking BOTH "today is in day-range
 *     and we're in the late portion (>= startMin)" AND "yesterday was
 *     in day-range and we're in the early portion (< endMin)".
 *
 * Both can wrap at once: "Fr-Mo 22:00-06:00" covers Fri evening
 * through Tuesday morning.
 */
function parseMaintenanceActive(schedule, now = new Date()) {
  if (!schedule) return false;

  // Backwards compatibility: older rows were JSON.stringify'd, so the string
  // is wrapped in double-quotes. Unwrap it so the regex parses cleanly.
  if (typeof schedule === 'string' && schedule.startsWith('"') && schedule.endsWith('"')) {
    try { schedule = JSON.parse(schedule); } catch {}
  }

  const dayIndex = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const yesterdayIndex = (dayIndex + 6) % 7; // -1 mod 7
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

    if (startMin <= endMin) {
      // Same-day window: today must be in day-range AND time in [start, end).
      if (isDayInRange(dayIndex, startDay, endDay)
          && currentMinutes >= startMin && currentMinutes < endMin) {
        return true;
      }
    } else {
      // Overnight window splits into two cases:
      //   1. Today is in day-range and we're in the late portion (>= startMin).
      //   2. Yesterday was in day-range and we're in the early-morning
      //      portion of today (< endMin).
      if (isDayInRange(dayIndex, startDay, endDay) && currentMinutes >= startMin) {
        return true;
      }
      if (isDayInRange(yesterdayIndex, startDay, endDay) && currentMinutes < endMin) {
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  isInMaintenanceWindow,
  parseMaintenanceActive,
};
