import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { QUEUE_NAMES } from './queues.js';
import { markOverdueIfPending, sendTaskDueNotification } from '../services/task.service.js';
import { Task } from '../models/task.model.js';
import { TASK_STATUS, NOTIFICATION_TYPE, LEAD_STATUS, ACTIVITY_TYPE, TASK_TYPE } from '../constants/crm.constants.js';
import { notifyAssigneeAndAdmins } from '../services/notification.service.js';
import { Lead } from '../models/lead.model.js';
import { addActivity } from '../services/activity.service.js';
import { checkMeetingStatus, sendMeetingReminder } from '../services/meeting.service.js';
import { Activity } from '../models/activity.model.js';

async function isSlaAlreadySatisfied({ leadId, slaType }) {
  const lead = await Lead.findById(leadId).select('status');
  if (!lead) return true;

  if (slaType === 'WHATSAPP_NOT_SENT_15_MIN') {
    const doneInitialTask = await Task.exists({
      leadId,
      type: { $in: [TASK_TYPE.SEND_WHATSAPP, TASK_TYPE.FIRST_CALL] },
      status: TASK_STATUS.DONE,
    });
    const firstContactActivity = await Activity.exists({
      leadId,
      type: { $in: [ACTIVITY_TYPE.WHATSAPP_SENT, ACTIVITY_TYPE.CALL_OUTCOME] },
    });
    return Boolean(doneInitialTask || firstContactActivity || [LEAD_STATUS.INVALID, LEAD_STATUS.LOST, LEAD_STATUS.CONTACTED, LEAD_STATUS.WHATSAPP_SENT].includes(lead.status));
  }

  if (slaType === 'FIRST_CALL_NOT_DONE_60_MIN') {
    const doneCallTask = await Task.exists({ leadId, type: TASK_TYPE.FIRST_CALL, status: TASK_STATUS.DONE });
    const callActivity = await Activity.exists({ leadId, type: ACTIVITY_TYPE.CALL_OUTCOME });
    return Boolean(doneCallTask || callActivity || [LEAD_STATUS.INVALID, LEAD_STATUS.LOST, LEAD_STATUS.CONTACTED].includes(lead.status));
  }

  return false;
}

export function startWorkers() {
  const workersEnabled = String(process.env.ENABLE_WORKERS || '').toLowerCase() === 'true';
  if (!workersEnabled) {
    console.warn('BullMQ workers are disabled (set ENABLE_WORKERS=true to enable).');
    return [];
  }

  const workers = [];
  let disabledAfterInitError = false;
  const scriptLoadErrorText = 'The "data" argument must be of type string or an instance of Buffer';
  const shutdownWorkers = async (reason) => {
    if (disabledAfterInitError) return;
    disabledAfterInitError = true;
    console.error(`Disabling BullMQ workers: ${reason}`);
    await Promise.all(
      workers.map(async (worker) => {
        try {
          await worker.close();
        } catch {
          // best-effort shutdown
        }
      })
    );
  };

  const startWorker = (queueName, processor) => {
    try {
      const worker = new Worker(queueName, processor, { connection: redisConnection });
      worker.on('error', (err) => {
        const message = err?.message || String(err);
        if (message.includes(scriptLoadErrorText)) {
          console.error(`Worker init error on ${queueName}:`, message);
          shutdownWorkers('BullMQ command script failed to load against current Redis setup. Set DISABLE_WORKERS=true to suppress workers explicitly.').catch(() => {});
          return;
        }
        if (!disabledAfterInitError) {
          console.error(`Worker error on ${queueName}:`, message);
        }
      });
      workers.push(worker);
      return worker;
    } catch (err) {
      console.error(`Failed to start worker for ${queueName}:`, err.message || err);
      return null;
    }
  };

  startWorker(
    QUEUE_NAMES.TASK_REMINDERS,
    async (job) => {
      if (job.name === 'task-due-notification') return sendTaskDueNotification(job.data.taskId);
      if (job.name === 'task-overdue-check') return markOverdueIfPending(job.data.taskId);
      // Backward compatibility for jobs queued by the previous broken version.
      if (job.name === 'task-due-check') return sendTaskDueNotification(job.data.taskId);
      return null;
    }
  );

  startWorker(
    QUEUE_NAMES.SLA_CHECKS,
    async (job) => {
      const { taskId, leadId, slaType } = job.data;
      const task = await Task.findById(taskId);
      if (!task || task.status !== TASK_STATUS.PENDING) return null;

      if (await isSlaAlreadySatisfied({ leadId, slaType })) {
        task.metadata = { ...(task.metadata || {}), slaSatisfiedAt: new Date(), slaSatisfiedBy: 'crm_activity_or_task' };
        await task.save();
        return task;
      }

      task.status = TASK_STATUS.OVERDUE;
      task.internalMiss = true;
      task.customerAttempt = false;
      await task.save();

      await Lead.findByIdAndUpdate(leadId, { status: LEAD_STATUS.SLA_MISSED, $inc: { internalMissCount: 1 } });
      await addActivity({
        leadId,
        userId: task.assignedTo,
        type: ACTIVITY_TYPE.SLA_MISSED,
        title: `SLA missed: ${slaType}`,
        description: 'No required first-touch/call action was marked within deadline.',
        metadata: { taskId, slaType },
      });

      await notifyAssigneeAndAdmins({
        assignedTo: task.assignedTo,
        leadId,
        taskId,
        type: NOTIFICATION_TYPE.SLA_MISSED,
        title: slaType === 'WHATSAPP_NOT_SENT_15_MIN' ? 'New lead not attended in 15 minutes' : 'New lead not called in 60 minutes',
        message: `${task.title} SLA missed. This is an internal miss, not customer non-response.`,
        priority: 5,
      });
      return task;
    }
  );

  startWorker(
    QUEUE_NAMES.MEETING_REMINDERS,
    async (job) => {
      if (job.name === 'meeting-reminder') return sendMeetingReminder(job.data.meetingId, job.data.reminderType, job.data.dueAt);
      if (job.name === 'meeting-status-check') return checkMeetingStatus(job.data.meetingId, job.data.dueAt);
      return null;
    }
  );

  console.log(`BullMQ workers started: ${workers.length}/3`);
  return workers;
}
