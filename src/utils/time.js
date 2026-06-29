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
  const hour = d.hour();
  return hour >= env.WORK_START_HOUR && hour < env.WORK_END_HOUR;
}

export function nextWorkingStart(date = new Date()) {
  let d = dayjs(date).tz(APP_TIMEZONE);
  const start = d.hour(env.WORK_START_HOUR).minute(0).second(0).millisecond(0);
  const end = d.hour(env.WORK_END_HOUR).minute(0).second(0).millisecond(0);

  if (d.isBefore(start)) return start.toDate();
  if (d.isAfter(end) || d.isSame(end)) return start.add(1, 'day').toDate();
  return d.toDate();
}

export function getNewLeadDueTimes(createdAt = new Date()) {
  const d = dayjs(createdAt).tz(APP_TIMEZONE);
  const start = d.hour(env.WORK_START_HOUR).minute(0).second(0).millisecond(0);
  const end = d.hour(env.WORK_END_HOUR).minute(0).second(0).millisecond(0);

  if (d.isBefore(start)) {
    return {
      whatsappDueAt: start.toDate(),
      callDueAt: start.add(30, 'minute').toDate(),
    };
  }

  if (d.isSame(end) || d.isAfter(end)) {
    const nextStart = start.add(1, 'day');
    return {
      whatsappDueAt: nextStart.toDate(),
      callDueAt: nextStart.add(30, 'minute').toDate(),
    };
  }

  const whatsapp = d.add(15, 'minute');
  const call = d.add(60, 'minute');

  return {
    whatsappDueAt: whatsapp.isAfter(end) ? end.toDate() : whatsapp.toDate(),
    callDueAt: call.isAfter(end) ? start.add(1, 'day').add(30, 'minute').toDate() : call.toDate(),
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
      d = d.hour(17).minute(30).second(0).millisecond(0);
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
  const d = dayjs(date).tz(APP_TIMEZONE).add(amount, unit);
  const end = d.hour(env.WORK_END_HOUR).minute(0).second(0).millisecond(0);
  if (d.isAfter(end)) {
    return dayjs(d).add(1, 'day').hour(env.WORK_START_HOUR).minute(30).second(0).millisecond(0).toDate();
  }
  return d.toDate();
}

export function nextMorning(date = new Date()) {
  return dayjs(date).tz(APP_TIMEZONE).add(1, 'day').hour(10).minute(0).second(0).millisecond(0).toDate();
}

export function daysFromNowAtMorning(days = 1, date = new Date()) {
  return dayjs(date).tz(APP_TIMEZONE).add(Number(days), 'day').hour(10).minute(0).second(0).millisecond(0).toDate();
}

export function sameDayEvening(date = new Date()) {
  const d = dayjs(date).tz(APP_TIMEZONE).hour(17).minute(30).second(0).millisecond(0);
  if (dayjs(date).tz(APP_TIMEZONE).isAfter(d)) return nextMorning(date);
  return d.toDate();
}
