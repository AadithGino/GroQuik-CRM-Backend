import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import {
  APP_TIMEZONE,
  capAutoScheduledDueAt,
  getNewLeadDueTimes,
  nextBusinessDayStart,
  resolveAutoCallLaterDueAt,
  resolveRetryDueAt,
  sameDayEvening,
} from './time.js';

dayjs.extend(utc);
dayjs.extend(timezone);

function ist(isoLocal) {
  return dayjs.tz(isoLocal, APP_TIMEZONE).toDate();
}

function formatIst(value) {
  return dayjs(value).tz(APP_TIMEZONE).format('YYYY-MM-DD HH:mm');
}

describe('resolveRetryDueAt — auto call-later cap 18:30', () => {
  it('keeps same-day slot when now + 2h is before 18:30', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T14:00'),
      delayHours: 2,
      shiftEndHour: 18,
      shiftEndMinute: 30,
      bufferMinutes: 0,
    });
    assert.equal(formatIst(due), '2026-08-04 16:00');
  });

  it('allows same-day slot up to 18:30', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T16:30'),
      delayHours: 2,
      shiftEndHour: 18,
      shiftEndMinute: 30,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
      bufferMinutes: 0,
    });
    assert.equal(formatIst(due), '2026-08-04 18:30');
  });

  it('rolls to next business day start when now + 2h exceeds 18:30', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T17:00'),
      delayHours: 2,
      shiftEndHour: 18,
      shiftEndMinute: 30,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
      bufferMinutes: 0,
    });
    // 17:00 + 2h = 19:00 > 18:30 → Wednesday 10:00
    assert.equal(formatIst(due), '2026-08-05 10:00');
  });

  it('skips Sunday when rolling to next business day', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-08T17:00'),
      delayHours: 2,
      shiftEndHour: 18,
      shiftEndMinute: 30,
      nextDayStartHour: 10,
      nextDayStartMinute: 0,
    });
    assert.equal(dayjs(due).tz(APP_TIMEZONE).day(), 1); // Monday
    assert.equal(formatIst(due), '2026-08-10 10:00');
  });

  it('customFollowUpAt bypasses auto +2h and EOD cap', () => {
    const due = resolveRetryDueAt({
      now: ist('2026-08-04T17:00'),
      delayHours: 2,
      customFollowUpAt: '2026-08-04T20:45',
      shiftEndHour: 18,
      shiftEndMinute: 30,
    });
    assert.equal(formatIst(due), '2026-08-04 20:45');
  });
});

describe('sameDayEvening / resolveAutoCallLaterDueAt', () => {
  it('defaults auto call-later to 18:30 same day', () => {
    assert.equal(formatIst(sameDayEvening(ist('2026-08-04T11:00'))), '2026-08-04 18:30');
  });

  it('rolls past 18:30 to next business morning', () => {
    assert.equal(formatIst(sameDayEvening(ist('2026-08-04T19:00'))), '2026-08-05 10:00');
  });

  it('keeps explicit callbackAt even after 18:30', () => {
    const due = resolveAutoCallLaterDueAt({
      callbackAt: '2026-08-04T20:15',
      now: ist('2026-08-04T11:00'),
    });
    assert.equal(formatIst(due), '2026-08-04 20:15');
  });

  it('uses sameDayEvening when no time specified', () => {
    const due = resolveAutoCallLaterDueAt({ now: ist('2026-08-04T11:00') });
    assert.equal(formatIst(due), '2026-08-04 18:30');
  });
});

describe('capAutoScheduledDueAt — hard 18:30 ceiling', () => {
  it('clamps same-day 19:00 to 18:30', () => {
    const due = capAutoScheduledDueAt(ist('2026-08-04T19:00'));
    assert.equal(formatIst(due), '2026-08-04 18:30');
  });

  it('keeps same-day 18:30', () => {
    const due = capAutoScheduledDueAt(ist('2026-08-04T18:30'));
    assert.equal(formatIst(due), '2026-08-04 18:30');
  });
});

describe('getNewLeadDueTimes — first-touch SLA cap', () => {
  it('does not schedule first call after 18:30 when lead arrives at 18:00', () => {
    const { callDueAt } = getNewLeadDueTimes(ist('2026-08-04T18:00'));
    assert.equal(formatIst(callDueAt), '2026-08-04 18:30');
  });

  it('rolls first call to next morning when lead arrives after 18:30', () => {
    const { callDueAt } = getNewLeadDueTimes(ist('2026-08-04T19:15'));
    assert.equal(formatIst(callDueAt), '2026-08-05 10:30');
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
