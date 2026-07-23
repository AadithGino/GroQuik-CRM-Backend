import { Queue } from 'bullmq';
import { getBullmqConnectionOptions } from '../config/redis.js';

export const QUEUE_NAMES = Object.freeze({
  TASK_REMINDERS: 'task-reminders',
  SLA_CHECKS: 'sla-checks',
  MEETING_REMINDERS: 'meeting-reminders',
  NOTIFICATION_DISPATCH: 'notification-dispatch',
});

const SCRIPT_LOAD_ERROR = 'The "data" argument must be of type string or an instance of Buffer';

let bullmqDisabled = false;
const queues = new Map();

function markBullmqDisabled(reason) {
  if (bullmqDisabled) return;
  bullmqDisabled = true;
  console.error(`BullMQ disabled: ${reason}`);
}

function attachQueueGuards(queue, name) {
  queue.on('error', (err) => {
    const message = err?.message || String(err);
    if (message.includes(SCRIPT_LOAD_ERROR) || message.includes('ERR_INVALID_ARG_TYPE')) {
      markBullmqDisabled(message);
      return;
    }
    if (!bullmqDisabled) console.error(`Queue error on ${name}:`, message);
  });
  return queue;
}

function createQueue(name) {
  if (bullmqDisabled) return null;
  try {
    const queue = new Queue(name, {
      connection: getBullmqConnectionOptions(),
      // Avoid blocking the process if Redis/BullMQ scripts fail later.
      skipVersionCheck: true,
    });
    return attachQueueGuards(queue, name);
  } catch (err) {
    markBullmqDisabled(err?.message || String(err));
    return null;
  }
}

function getQueue(name) {
  if (bullmqDisabled) return null;
  if (!queues.has(name)) {
    queues.set(name, createQueue(name));
  }
  return queues.get(name);
}

async function safeQueueCall(queueName, method, ...args) {
  const queue = getQueue(queueName);
  if (!queue) return null;
  try {
    return await queue[method](...args);
  } catch (err) {
    const message = err?.message || String(err);
    if (message.includes(SCRIPT_LOAD_ERROR) || message.includes('ERR_INVALID_ARG_TYPE')) {
      markBullmqDisabled(message);
      return null;
    }
    console.warn(`Queue ${queueName}.${method} failed:`, message);
    return null;
  }
}

/** Lazy proxies so imports never crash the API if BullMQ/Redis is incompatible. */
function queueProxy(name) {
  return {
    add: (...args) => safeQueueCall(name, 'add', ...args),
    remove: (...args) => safeQueueCall(name, 'remove', ...args),
    close: async () => {
      const queue = queues.get(name);
      if (!queue) return;
      try { await queue.close(); } catch { /* ignore */ }
      queues.delete(name);
    },
  };
}

export const taskReminderQueue = queueProxy(QUEUE_NAMES.TASK_REMINDERS);
export const slaCheckQueue = queueProxy(QUEUE_NAMES.SLA_CHECKS);
export const meetingReminderQueue = queueProxy(QUEUE_NAMES.MEETING_REMINDERS);
export const notificationDispatchQueue = queueProxy(QUEUE_NAMES.NOTIFICATION_DISPATCH);

export function isBullmqDisabled() {
  return bullmqDisabled;
}

export function delayUntil(date) {
  const delay = new Date(date).getTime() - Date.now();
  return Math.max(delay, 0);
}
