
import { TASK_STATUS, ACTIVITY_TYPE, NOTIFICATION_TYPE } from '../constants/crm.constants.js';
import { Task } from '../models/task.model.js';
import { addActivity } from './activity.service.js';
import { scheduleTaskDueCheck } from './scheduler.service.js';
import { notifyAssigneeAndAdmins } from './notification.service.js';
import { scheduleLeadNextActionRecompute } from './leadWorkflow.service.js';

function buildTaskDedupeFilter({ leadId, meetingId, type, metadata = {} }) {
  if (!metadata?.dedupeKey) return null;
  const filter = {
    type,
    status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] },
    'metadata.dedupeKey': metadata.dedupeKey,
  };
  if (leadId) filter.leadId = leadId;
  if (meetingId) filter.meetingId = meetingId;
  return filter;
}

export async function createTask({ leadId, meetingId, assignedTo, type, title, description, dueAt, priority = 3, metadata = {} }) {
  const dedupeFilter = buildTaskDedupeFilter({ leadId, meetingId, type, metadata });
  if (dedupeFilter) {
    const existing = await Task.findOne(dedupeFilter).sort({ dueAt: 1 });
    if (existing) return existing;
  }

  const task = await Task.create({ leadId, meetingId, assignedTo, type, title, description, dueAt, priority, metadata });
  if (leadId) {
    await addActivity({ leadId, userId: assignedTo, type: ACTIVITY_TYPE.TASK_CREATED, title: `Task created: ${title}`, metadata: { taskId: task._id, dueAt, dedupeKey: metadata?.dedupeKey } });
    scheduleLeadNextActionRecompute(leadId);
  }
  if (!metadata?.slaType) await scheduleTaskDueCheck(task);
  return task;
}

export async function completeOpenTasksByMetadata({ leadId, type, metadataKey, metadataValue, userId, metadata = {} }) {
  const tasks = await Task.find({
    ...(leadId ? { leadId } : {}),
    ...(type ? { type } : {}),
    status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] },
    [`metadata.${metadataKey}`]: metadataValue,
  });
  for (const task of tasks) {
    await completeTask({ taskId: task._id, userId, metadata });
  }
  return tasks;
}

export async function completeTask({ taskId, userId, customerAttempt = false, metadata = {} }) {
  const existing = await Task.findById(taskId);
  if (!existing) return null;
  if (existing.status === TASK_STATUS.DONE) return existing;
  const task = await Task.findByIdAndUpdate(
    taskId,
    { status: TASK_STATUS.DONE, completedAt: new Date(), customerAttempt, internalMiss: false, metadata: { ...(existing.metadata || {}), ...(metadata || {}) } },
    { new: true }
  );

  if (!task) return null;
  if (task.leadId) {
    await addActivity({ leadId: task.leadId, userId, type: ACTIVITY_TYPE.TASK_DONE, title: `Task completed: ${task.title}`, metadata: { taskId: task._id } });
    scheduleLeadNextActionRecompute(task.leadId);
  }

  return task;
}

export async function markTaskNotDone({ taskId, userId, reason, rescheduleAt }) {
  const existing = await Task.findById(taskId);
  if (!existing) return null;
  if (existing.status === TASK_STATUS.NOT_DONE) return existing;
  const task = await Task.findByIdAndUpdate(
    taskId,
    { status: TASK_STATUS.NOT_DONE, internalMiss: true, customerAttempt: false, completedAt: new Date(), notDoneReason: reason },
    { new: true }
  );

  if (task.leadId) {
    await addActivity({
      leadId: task.leadId,
      userId,
      type: ACTIVITY_TYPE.TASK_NOT_DONE,
      title: `Task not done: ${task.title}`,
      description: reason,
      metadata: { taskId: task._id, rescheduleAt },
    });
  }

  await notifyAssigneeAndAdmins({
    assignedTo: task.assignedTo,
    leadId: task.leadId,
    taskId: task._id,
    type: NOTIFICATION_TYPE.FOLLOW_UP_NOT_DONE,
    title: 'Follow-up not done',
    message: `${task.title} was marked as not done. Reason: ${reason || 'Not specified'}`,
    priority: 4,
  });

  if (rescheduleAt) {
    await createTask({
      leadId: task.leadId,
      meetingId: task.meetingId,
      assignedTo: task.assignedTo,
      type: task.type,
      title: task.title,
      description: task.description,
      dueAt: rescheduleAt,
      priority: task.priority,
      metadata: { rescheduledFromTaskId: task._id, dedupeKey: `reschedule:${task._id}` },
    });
  } else if (task.leadId) {
    scheduleLeadNextActionRecompute(task.leadId);
  }

  return task;
}

export async function sendTaskDueNotification(taskId) {
  const task = await Task.findById(taskId);
  if (!task || task.status !== TASK_STATUS.PENDING) return null;

  await notifyAssigneeAndAdmins({
    assignedTo: task.assignedTo,
    leadId: task.leadId,
    taskId: task._id,
    type: NOTIFICATION_TYPE.TASK_DUE,
    title: 'Task due now',
    message: `${task.title} is due now. Complete it, reschedule it, or mark Not Done with a reason.`,
    priority: task.priority || 3,
  });

  return task;
}

export async function markOverdueIfPending(taskId) {
  const task = await Task.findById(taskId);
  if (!task || ![TASK_STATUS.PENDING, TASK_STATUS.OVERDUE].includes(task.status)) return null;
  if (task.status === TASK_STATUS.OVERDUE) return task;

  task.status = TASK_STATUS.OVERDUE;
  task.internalMiss = true;
  task.customerAttempt = false;
  await task.save();

  if (task.leadId) {
    await addActivity({
      leadId: task.leadId,
      userId: task.assignedTo,
      type: ACTIVITY_TYPE.TASK_OVERDUE,
      title: `Task overdue: ${task.title}`,
      description: 'No call/contact was marked within the allowed grace period.',
      metadata: { taskId: task._id, dueAt: task.dueAt },
    });
    scheduleLeadNextActionRecompute(task.leadId);
  }

  await notifyAssigneeAndAdmins({
    assignedTo: task.assignedTo,
    leadId: task.leadId,
    taskId: task._id,
    type: NOTIFICATION_TYPE.TASK_OVERDUE,
    title: 'Task overdue',
    message: `${task.title} is overdue. No call/contact was marked.`,
    priority: 4,
  });

  return task;
}
