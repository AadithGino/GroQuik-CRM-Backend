import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';

export const QUEUE_NAMES = Object.freeze({
  TASK_REMINDERS: 'task-reminders',
  SLA_CHECKS: 'sla-checks',
  MEETING_REMINDERS: 'meeting-reminders',
  NOTIFICATION_DISPATCH: 'notification-dispatch',
});

export const taskReminderQueue = new Queue(QUEUE_NAMES.TASK_REMINDERS, { connection: redisConnection });
export const slaCheckQueue = new Queue(QUEUE_NAMES.SLA_CHECKS, { connection: redisConnection });
export const meetingReminderQueue = new Queue(QUEUE_NAMES.MEETING_REMINDERS, { connection: redisConnection });
export const notificationDispatchQueue = new Queue(QUEUE_NAMES.NOTIFICATION_DISPATCH, { connection: redisConnection });

export function delayUntil(date) {
  const delay = new Date(date).getTime() - Date.now();
  return Math.max(delay, 0);
}
