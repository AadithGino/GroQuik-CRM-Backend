import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import {
  APP_TIMEZONE,
  nextBusinessDayStart,
  resolveRetryDueAt,
} from './time.js';

dayjs.extend(utc);
dayjs.extend(timezone);

function ist(isoLocal) {
  return dayjs.tz(isoLocal, APP_TIMEZONE).toDate();
}

function formatIst(value) {
  return dayjs(value).tz(APP_TIMEZONE).format('YYYY-MM-DD HH:mm');
}

describe('resolveRetryDueAt — business hour rollover', () => {
  it('keeps same-day slot when now + 2h is before shift end 17:30', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T14:00'),
      delayHours: 2,
      shiftEndHour: 17,
      shiftEndMinute: 30,
      bufferMinutes: 0,
    });
    assert.equal(formatIst(due), '2026-08-04 16:00');
  });

  it('rolls to next business day start when now + 2h exceeds 17:30', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T16:00'),
      delayHours: 2,
      shiftEndHour: 17,
      shiftEndMinute: 30,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
      bufferMinutes: 0,
    });
    // 16:00 + 2h = 18:00 > 17:30 → Wednesday 10:00 (Aug 4 2026 is Tuesday)
    assert.equal(formatIst(due), '2026-08-05 10:00');
  });

  it('respects buffer minutes before shift end', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T15:20'),
      delayHours: 2,
      shiftEndHour: 17,
      shiftEndMinute: 30,
      bufferMinutes: 15,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
    });
    // candidate 17:20, shiftEnd-buffer = 17:15 → rollover
    assert.equal(formatIst(due), '2026-08-05 10:00');
  });

  it('skips Sunday when rolling to next business day', () => {
    // Saturday 16:00 + 2h → would be 18:00 > 17:30 → next day Sunday → Monday 10:00
    const due = resolveRetryDueAt({
      now: ist('2026-08-08T16:00'),
      delayHours: 2,
      shiftEndHour: 17,
      shiftEndMinute: 30,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
    });
    assert.equal(dayjs(due).tz(APP_TIMEZONE).day(), 1); // Monday
    assert.equal(formatIst(due), '2026-08-10 10:00');
  });

  it('customFollowUpAt bypasses auto +2h and EOD logic', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T16:00'),
      delayHours: 2,
      customFollowUpAt: '2026-08-04T20:45',
      shiftEndHour: 17,
      shiftEndMinute: 30,
    });
    assert.equal(formatIst(due), '2026-08-04 20:45');
  });

  it('treats boundary exactly at shift end as rollover (candidate after end)', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T15:30'),
      delayHours: 2,
      shiftEndHour: 17,
      shiftEndMinute: 30,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
    });
    // 17:30 isAfter 17:30 === false in dayjs; candidate === end → keep same day 17:30
    // Requirement: Current + 2h > Agent_Shift_End → rollover. Equal stays same day.
    assert.equal(formatIst(due), '2026-08-04 17:30');
  });
});

describe('nextBusinessDayStart — Sunday off only', () => {
  it('from Saturday goes to Monday', () => {
    const next = nextBusinessDayStart(ist('2026-08-08T18:00'));
    assert.equal(formatIst(next), '2026-08-10 10:00');
  });

  it('from Friday goes to Saturday (working day)', () => {
    const next = nextBusinessDayStart(ist('2026-08-07T18:00'));
    assert.equal(formatIst(next), '2026-08-08 10:00');
  });
});
