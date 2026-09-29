import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { env } from '../config/env.js';
import { FOLLOW_UP_TIME } from '../constants/crm.constants.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
const EXPLICIT_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

export const APP_TIMEZONE = env.DEFAULT_TIMEZONE || 'Asia/Kolkata';

export function nowInTz() {
  return dayjs().tz(APP_TIMEZONE);
}

export function parseAppDateTime(value) {
  if (!value) return undefined;
  if (value instanceof Date) return value;

  const raw = String(value).trim();
  if (!raw) return undefined;

  // Browser datetime-local inputs submit values like "2026-06-26T20:30" with no timezone.
  // Treat those as India business time, not as the server machine's local timezone.
  if (LOCAL_DATE_RE.test(raw) || (LOCAL_DATE_TIME_RE.test(raw) && !EXPLICIT_TZ_RE.test(raw))) {
    return dayjs.tz(raw, APP_TIMEZONE).toDate();
  }

  return new Date(raw);
}


export function isLocalDateOnly(value) {
  return Boolean(value && LOCAL_DATE_RE.test(String(value).trim()));
}

export function parseAppRangeStart(value) {
  if (!value) return undefined;
  return isLocalDateOnly(value) ? dayjs.tz(String(value).trim(), APP_TIMEZONE).startOf('day').toDate() : parseAppDateTime(value);
}

export function parseAppRangeEnd(value) {
  if (!value) return undefined;
  return isLocalDateOnly(value) ? dayjs.tz(String(value).trim(), APP_TIMEZONE).endOf('day').toDate() : parseAppDateTime(value);
}

export function startOfAppDay(value = new Date()) {
  return dayjs(value).tz(APP_TIMEZONE).startOf('day').toDate();
}

export function endOfAppDay(value = new Date()) {
  return dayjs(value).tz(APP_TIMEZONE).endOf('day').toDate();
}

export function addMinutes(value, minutes) {
  return dayjs(value).add(minutes, 'minute').toDate();
}

export function isWorkingHours(date = new Date()) {
  const d = dayjs(date).tz(APP_TIMEZONE);
  const minutes = d.hour() * 60 + d.minute();
  const start = env.WORK_START_HOUR * 60 + (env.WORK_START_MINUTE || 0);
  const end = env.WORK_END_HOUR * 60 + (env.WORK_END_MINUTE || 0);
  return d.day() !== 0 && minutes >= start && minutes < end;
}

/** Sunday is the only weekly off day. */
export function isBusinessDay(date = new Date()) {
  return dayjs(date).tz(APP_TIMEZONE).day() !== 0;
}

function atShiftTime(base, hour, minute = 0) {
  return base.hour(hour).minute(minute).second(0).millisecond(0);
}

/** Next day that is not Sunday, at work start (default 10:00 IST). */
export function nextBusinessDayStart(date = new Date()) {
  let d = dayjs(date).tz(APP_TIMEZONE).add(1, 'day');
  while (d.day() === 0) d = d.add(1, 'day');
  return atShiftTime(d, env.WORK_START_HOUR, env.WORK_START_MINUTE || 0).toDate();
}

/**
 * Auto-retry / call-later scheduling with EOD cap + Sunday skip + optional custom override.
 * If Current_Time + delayHours > AUTO_CALL_LATER_END (default 18:30) − Buffer → Next_Business_Day_Start.
 * Custom follow-up times are never capped.
 */
export function resolveRetryDueAt({
  now = new Date(),
  delayHours = 2,
  customFollowUpAt,
  shiftEndHour = env.AUTO_CALL_LATER_END_HOUR,
  shiftEndMinute = env.AUTO_CALL_LATER_END_MINUTE || 0,
  nextDayStartHour = env.WORK_START_HOUR,
  nextDayStartMinute = env.WORK_START_MINUTE || 0,
  bufferMinutes = env.RETRY_BUFFER_MINUTES || 0,
  timezone = APP_TIMEZONE,
} = {}) {
  if (customFollowUpAt) {
    const custom = parseAppDateTime(customFollowUpAt);
    if (custom) return custom;
  }

  const base = dayjs(now).tz(timezone);
  const candidate = base.add(Number(delayHours) || 0, 'hour');
  const shiftEnd = atShiftTime(base, shiftEndHour, shiftEndMinute).subtract(Number(bufferMinutes) || 0, 'minute');

  if (candidate.isAfter(shiftEnd)) {
    let next = base.add(1, 'day');
    while (next.day() === 0) next = next.add(1, 'day');
    return atShiftTime(next, nextDayStartHour, nextDayStartMinute).toDate();
  }

  // Candidate is same calendar day but might be Sunday (rare if agents work Sun=off only).
  if (candidate.day() === 0) {
    let next = candidate.add(1, 'day');
    while (next.day() === 0) next = next.add(1, 'day');
    return atShiftTime(next, nextDayStartHour, nextDayStartMinute).toDate();
  }

  return capAutoScheduledDueAt(candidate.toDate());
}

/**
 * System auto-schedules must never land after 18:30 IST on the same calendar day.
 * Times after that roll to the next business morning (Sunday skipped).
 * Does not apply to explicit user/admin custom follow-up times.
 */
export function capAutoScheduledDueAt(dueAt) {
  if (!dueAt) return dueAt;
  const d = dayjs(dueAt).tz(APP_TIMEZONE);
  if (d.day() === 0) return nextBusinessDayStart(d.toDate());

  const end = atShiftTime(d, env.AUTO_CALL_LATER_END_HOUR, env.AUTO_CALL_LATER_END_MINUTE || 0);
  if (d.isAfter(end)) return end.toDate();
  return d.toDate();
}

export function nextWorkingStart(date = new Date()) {
  let d = dayjs(date).tz(APP_TIMEZONE);
  const start = atShiftTime(d, env.WORK_START_HOUR, env.WORK_START_MINUTE || 0);
  const end = atShiftTime(d, env.WORK_END_HOUR, env.WORK_END_MINUTE || 0);

  if (d.day() === 0) return nextBusinessDayStart(d.startOf('day').toDate());
  if (d.isBefore(start)) return start.toDate();
  if (d.isAfter(end) || d.isSame(end)) return nextBusinessDayStart(d.toDate());
  return d.toDate();
}

export function getNewLeadDueTimes(createdAt = new Date()) {
  const d = dayjs(createdAt).tz(APP_TIMEZONE);
  const start = atShiftTime(d, env.WORK_START_HOUR, env.WORK_START_MINUTE || 0);
  const autoEnd = atShiftTime(d, env.AUTO_CALL_LATER_END_HOUR, env.AUTO_CALL_LATER_END_MINUTE || 0);

  if (d.isBefore(start)) {
    return {
      whatsappDueAt: start.toDate(),
      callDueAt: capAutoScheduledDueAt(start.add(30, 'minute').toDate()),
    };
  }

  if (d.isAfter(autoEnd) || d.isSame(autoEnd)) {
    const nextStart = nextBusinessDayStart(d.toDate());
    const next = dayjs(nextStart).tz(APP_TIMEZONE);
    return {
      whatsappDueAt: next.toDate(),
      callDueAt: capAutoScheduledDueAt(next.add(30, 'minute').toDate()),
    };
  }

  return {
    whatsappDueAt: capAutoScheduledDueAt(d.add(15, 'minute').toDate()),
    callDueAt: capAutoScheduledDueAt(d.add(60, 'minute').toDate()),
  };
}

export function resolveFollowUpDateTime({ date, timeSlot, customDateTime }) {
  if (customDateTime) return parseAppDateTime(customDateTime);
  if (!date) return nextWorkingStart();

  let d = LOCAL_DATE_RE.test(String(date)) ? dayjs.tz(String(date), APP_TIMEZONE) : dayjs(date).tz(APP_TIMEZONE);

  switch (timeSlot) {
    case FOLLOW_UP_TIME.AFTERNOON:
      d = d.hour(14).minute(30).second(0).millisecond(0);
      break;
    case FOLLOW_UP_TIME.EVENING:
      d = d.hour(env.AUTO_CALL_LATER_END_HOUR).minute(env.AUTO_CALL_LATER_END_MINUTE || 0).second(0).millisecond(0);
      break;
    case FOLLOW_UP_TIME.CUSTOM:
      return customDateTime ? parseAppDateTime(customDateTime) : d.hour(10).minute(0).toDate();
    case FOLLOW_UP_TIME.NO_SPECIFIC_TIME:
    case FOLLOW_UP_TIME.MORNING:
    default:
      d = d.hour(10).minute(0).second(0).millisecond(0);
  }

  return d.toDate();
}

export function addBusinessDelay(date, amount, unit) {
  const hours = unit === 'hour' || unit === 'hours' ? Number(amount) : Number(amount);
  if (unit === 'hour' || unit === 'hours') {
    return resolveRetryDueAt({ now: date, delayHours: hours });
  }
  const base = dayjs(date).tz(APP_TIMEZONE);
  const d = base.add(amount, unit);
  const end = atShiftTime(base, env.AUTO_CALL_LATER_END_HOUR, env.AUTO_CALL_LATER_END_MINUTE || 0);
  if (d.isAfter(end)) return nextBusinessDayStart(base.toDate());
  return capAutoScheduledDueAt(d.toDate());
}

export function nextMorning(date = new Date()) {
  return nextBusinessDayStart(date);
}

export function daysFromNowAtMorning(days = 1, date = new Date()) {
  let d = dayjs(date).tz(APP_TIMEZONE).add(Number(days), 'day');
  while (d.day() === 0) d = d.add(1, 'day');
  return atShiftTime(d, env.WORK_START_HOUR, env.WORK_START_MINUTE || 0).toDate();
}

/** Default auto call-later slot: today at AUTO_CALL_LATER_END (18:30), else next business morning. */
export function sameDayEvening(date = new Date()) {
  const base = dayjs(date).tz(APP_TIMEZONE);
  const evening = atShiftTime(base, env.AUTO_CALL_LATER_END_HOUR, env.AUTO_CALL_LATER_END_MINUTE || 0);
  if (base.isAfter(evening) || base.day() === 0) return nextBusinessDayStart(date);
  return capAutoScheduledDueAt(evening.toDate());
}

/**
 * Resolve dueAt for auto call-later. Explicit customFollowUpAt / callbackAt from user/admin are kept as-is.
 * Otherwise uses sameDayEvening (≤ 18:30).
 */
export function resolveAutoCallLaterDueAt({ customFollowUpAt, callbackAt, now = new Date() } = {}) {
  if (customFollowUpAt) {
    const custom = parseAppDateTime(customFollowUpAt);
    if (custom) return custom;
  }
  if (callbackAt) {
    const picked = parseAppDateTime(callbackAt);
    if (picked) return picked;
  }
  return sameDayEvening(now);
}
