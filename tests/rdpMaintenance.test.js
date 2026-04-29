'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseMaintenanceActive } = require('../src/services/rdpMaintenance');

// All these tests pin a specific Date so the wall clock can't make
// them flaky in CI. The maintenance helper accepts a 2nd-arg `now`.

function on(weekday, hours, minutes) {
  // weekday: 0=Sun, 1=Mon, ..., 6=Sat. Picks an arbitrary date that
  // lands on that weekday. 2026-04-26 was a Sunday.
  const base = new Date(2026, 3, 26); // local-time
  const d = new Date(base);
  d.setDate(base.getDate() + weekday);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

describe('rdpMaintenance: parseMaintenanceActive', () => {
  it('returns false on empty/null/undefined schedules', () => {
    assert.equal(parseMaintenanceActive('', on(1, 12, 0)), false);
    assert.equal(parseMaintenanceActive(null, on(1, 12, 0)), false);
    assert.equal(parseMaintenanceActive(undefined, on(1, 12, 0)), false);
  });

  it('matches a German weekday range — "Mo-Fr 08:00-18:00"', () => {
    const sched = 'Mo-Fr 08:00-18:00';
    assert.equal(parseMaintenanceActive(sched, on(1, 9, 0)), true,  'Mon 09:00');
    assert.equal(parseMaintenanceActive(sched, on(5, 17, 59)), true, 'Fri 17:59');
    assert.equal(parseMaintenanceActive(sched, on(5, 18, 0)), false, 'Fri 18:00 — endMin is exclusive');
    assert.equal(parseMaintenanceActive(sched, on(6, 12, 0)), false, 'Sat 12:00 — outside Mo-Fr');
    assert.equal(parseMaintenanceActive(sched, on(1, 7, 59)), false, 'Mon 07:59 — before window');
  });

  it('matches an English weekday range — "Mon-Fri 09:00-17:00"', () => {
    const sched = 'Mon-Fri 09:00-17:00';
    assert.equal(parseMaintenanceActive(sched, on(3, 12, 0)), true,  'Wed 12:00');
    assert.equal(parseMaintenanceActive(sched, on(0, 12, 0)), false, 'Sun 12:00 — outside');
  });

  it('handles wrap-around DAYS with non-wrap times — "Fr-Mo 09:00-17:00"', () => {
    // The helper supports wrap-around in the day range (Fr -> Sa -> So
    // -> Mo) but the time-of-day comparison still expects startMin <
    // endMin within a single day. So this schedule covers Fri 9–17,
    // Sat 9–17, Sun 9–17, Mon 9–17 — NOT the contiguous Fri-22 to
    // Mon-06 range a casual reader might expect. Lock that semantic
    // here so a future refactor cannot drift it without noticing.
    const sched = 'Fr-Mo 09:00-17:00';
    assert.equal(parseMaintenanceActive(sched, on(5, 12, 0)), true,  'Fri 12:00');
    assert.equal(parseMaintenanceActive(sched, on(6, 12, 0)), true,  'Sat 12:00');
    assert.equal(parseMaintenanceActive(sched, on(0, 12, 0)), true,  'Sun 12:00');
    assert.equal(parseMaintenanceActive(sched, on(1, 12, 0)), true,  'Mon 12:00');
    assert.equal(parseMaintenanceActive(sched, on(2, 12, 0)), false, 'Tue 12:00 — outside');
    assert.equal(parseMaintenanceActive(sched, on(5, 18, 0)), false, 'Fri 18:00 — past day-window');
  });

  it('overnight time wrap — "Mo 22:00-06:00" covers Mon evening + Tue early morning', () => {
    const sched = 'Mo 22:00-06:00';
    assert.equal(parseMaintenanceActive(sched, on(1, 22, 0)), true,  'Mon 22:00 — start');
    assert.equal(parseMaintenanceActive(sched, on(1, 23, 30)), true, 'Mon 23:30 — late portion');
    assert.equal(parseMaintenanceActive(sched, on(2, 0, 0)), true,   'Tue 00:00 — wrap into next day');
    assert.equal(parseMaintenanceActive(sched, on(2, 5, 59)), true,  'Tue 05:59 — last minute');
    assert.equal(parseMaintenanceActive(sched, on(2, 6, 0)), false,  'Tue 06:00 — endMin exclusive');
    assert.equal(parseMaintenanceActive(sched, on(1, 21, 59)), false, 'Mon 21:59 — before window');
    assert.equal(parseMaintenanceActive(sched, on(1, 3, 0)), false,
      'Mon 03:00 is the previous Sunday-night window, not Mon-overnight');
  });

  it('overnight time wrap combined with day wrap — "Fr-Mo 22:00-06:00"', () => {
    const sched = 'Fr-Mo 22:00-06:00';
    // Late-portion-of-today branch
    assert.equal(parseMaintenanceActive(sched, on(5, 23, 0)), true, 'Fri 23:00');
    assert.equal(parseMaintenanceActive(sched, on(6, 22, 30)), true, 'Sat 22:30');
    assert.equal(parseMaintenanceActive(sched, on(0, 23, 0)), true, 'Sun 23:00');
    assert.equal(parseMaintenanceActive(sched, on(1, 22, 30)), true, 'Mon 22:30');
    // Early-portion-of-today (yesterday-was-in-range) branch
    assert.equal(parseMaintenanceActive(sched, on(6, 3, 0)), true, 'Sat 03:00 — Fri overnight');
    assert.equal(parseMaintenanceActive(sched, on(0, 5, 0)), true, 'Sun 05:00 — Sat overnight');
    assert.equal(parseMaintenanceActive(sched, on(1, 5, 59)), true, 'Mon 05:59 — Sun overnight');
    assert.equal(parseMaintenanceActive(sched, on(2, 5, 0)), true, 'Tue 05:00 — Mon overnight');
    // Outside the window
    assert.equal(parseMaintenanceActive(sched, on(2, 23, 0)), false, 'Tue 23:00 — Tue not in day-range');
    assert.equal(parseMaintenanceActive(sched, on(2, 6, 0)), false, 'Tue 06:00 — Mon overnight ended');
    assert.equal(parseMaintenanceActive(sched, on(3, 3, 0)), false, 'Wed 03:00 — Tue not in day-range');
  });

  it('supports multiple windows separated by newline OR semicolon', () => {
    const sched = 'Mo-Fr 09:00-12:00\nMo-Fr 13:00-17:00';
    assert.equal(parseMaintenanceActive(sched, on(1, 11, 0)), true, 'morning window');
    assert.equal(parseMaintenanceActive(sched, on(1, 12, 30)), false, 'lunch gap');
    assert.equal(parseMaintenanceActive(sched, on(1, 14, 0)), true, 'afternoon window');

    const semicolon = 'Mo-Fr 09:00-12:00; Mo-Fr 13:00-17:00';
    assert.equal(parseMaintenanceActive(semicolon, on(1, 11, 0)), true);
    assert.equal(parseMaintenanceActive(semicolon, on(1, 12, 30)), false);
  });

  it('matches a single-day window — "So 10:00-12:00"', () => {
    const sched = 'So 10:00-12:00';
    assert.equal(parseMaintenanceActive(sched, on(0, 11, 0)), true);
    assert.equal(parseMaintenanceActive(sched, on(1, 11, 0)), false);
  });

  it('unwraps a JSON-quoted schedule (legacy DB rows are double-encoded)', () => {
    const sched = JSON.stringify('Mo-Fr 09:00-17:00'); // → '"Mo-Fr 09:00-17:00"'
    assert.equal(parseMaintenanceActive(sched, on(1, 12, 0)), true);
  });

  it('silently skips lines with unknown day codes', () => {
    const sched = 'Xy-Zz 09:00-17:00\nMo-Fr 09:00-17:00';
    assert.equal(parseMaintenanceActive(sched, on(1, 12, 0)), true,
      'unparseable line is skipped, valid line still matches');
  });

  it('silently skips lines that fail the regex', () => {
    const sched = 'invalid\nMo-Fr 09:00-17:00';
    assert.equal(parseMaintenanceActive(sched, on(1, 12, 0)), true);
  });
});
