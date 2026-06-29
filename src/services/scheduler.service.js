import { env } from '../config/env.js';
import { meetingReminderQueue, slaCheckQueue, taskReminderQueue, delayUntil } from '../jobs/queues.js';
import { addMinutes } from '../utils/time.js';

export async function scheduleTaskDueCheck(task) {
  await taskReminderQueue.add(
    'task-due-notification',
    { taskId: task._id.toString(), dueAt: task.dueAt },
    { delay: delayUntil(task.dueAt), jobId: `task-due-${task._id}`, removeOnComplete: true, removeOnFail: 100 }
  );

  const overdueAt = addMinutes(task.dueAt, env.TASK_OVERDUE_GRACE_MINUTES);
  await taskReminderQueue.add(
    'task-overdue-check',
    { taskId: task._id.toString(), overdueAt },
    { delay: delayUntil(overdueAt), jobId: `task-overdue-${task._id}`, removeOnComplete: true, removeOnFail: 100 }
  );
}

export async function scheduleSlaCheck({ leadId, taskId, slaType, dueAt }) {
  await slaCheckQueue.add(
    'sla-check',
    { leadId: leadId.toString(), taskId: taskId.toString(), slaType, dueAt },
    { delay: delayUntil(dueAt), jobId: `sla-${slaType}-${taskId}`, removeOnComplete: true, removeOnFail: 100 }
  );
}

export async function scheduleMeetingReminder({ meetingId, reminderType, dueAt }) {
  await meetingReminderQueue.add(
    'meeting-reminder',
    { meetingId: meetingId.toString(), reminderType, dueAt },
    { delay: delayUntil(dueAt), jobId: `meeting-${reminderType}-${meetingId}`, removeOnComplete: true, removeOnFail: 100 }
  );
}

export async function scheduleMeetingStatusCheck({ meetingId, dueAt }) {
  await meetingReminderQueue.add(
    'meeting-status-check',
    { meetingId: meetingId.toString(), dueAt },
    { delay: delayUntil(dueAt), jobId: `meeting-status-${meetingId}`, removeOnComplete: true, removeOnFail: 100 }
  );
}

export async function cancelMeetingJobs(meetingId) {
  const id = meetingId.toString();
  const jobIds = [`meeting-15_MIN-${id}`, `meeting-5_MIN-${id}`, `meeting-status-${id}`];
  await Promise.all(jobIds.map(async (jobId) => {
    try { await meetingReminderQueue.remove(jobId); } catch (_) { /* already processed or absent */ }
  }));
}
