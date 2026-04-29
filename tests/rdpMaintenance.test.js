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

  it('handles a wrap-around range — "Fr-Mo 22:00-06:00" covers Fri/Sat/Sun/Mon', () => {
    const sched = 'Fr-Mo 22:00-06:00';
    assert.equal(parseMaintenanceActive(sched, on(5, 23, 0)), true,  'Fri 23:00');
    assert.equal(parseMaintenanceActive(sched, on(6, 3, 0)), true,   'Sat 03:00');
    assert.equal(parseMaintenanceActive(sched, on(0, 5, 0)), true,   'Sun 05:00');
    assert.equal(parseMaintenanceActive(sched, on(1, 5, 59)), true,  'Mon 05:59');
    assert.equal(parseMaintenanceActive(sched, on(2, 23, 0)), false, 'Tue 23:00 — outside');
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
