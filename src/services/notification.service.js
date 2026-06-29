import { ROLES } from '../constants/crm.constants.js';
import { Notification } from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { Lead } from '../models/lead.model.js';
import { Task } from '../models/task.model.js';
import { Meeting } from '../models/meeting.model.js';
import { emitToUser } from '../sockets/socket.js';
import { APP_TIMEZONE } from '../utils/time.js';

function formatIst(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: APP_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function pickClientName(lead) {
  if (!lead) return undefined;
  return lead.businessName || lead.name || lead.phone || 'Client';
}

async function buildNotificationContext({ leadId, taskId, meetingId, metadata = {} }) {
  const [lead, task, meeting] = await Promise.all([
    leadId ? Lead.findById(leadId).select('name businessName phone callPhone whatsappPhone status').lean() : null,
    taskId ? Task.findById(taskId).select('title type dueAt status priority').lean() : null,
    meetingId ? Meeting.findById(meetingId).select('type mode meetingAt status note').lean() : null,
  ]);

  const clientName = metadata.clientName || pickClientName(lead);
  const taskDueAt = metadata.taskDueAt || task?.dueAt;
  const meetingAt = metadata.meetingAt || meeting?.meetingAt;

  let targetUrl = metadata.targetUrl;
  if (!targetUrl) {
    if (taskId) targetUrl = `/tasks?taskId=${taskId}`;
    else if (meetingId) targetUrl = `/meetings?meetingId=${meetingId}`;
    else if (leadId) targetUrl = `/leads/${leadId}`;
  }

  return {
    ...metadata,
    targetUrl,
    clientName,
    clientPhone: metadata.clientPhone || lead?.callPhone || lead?.phone,
    clientCallPhone: metadata.clientCallPhone || lead?.callPhone || lead?.phone,
    clientWhatsappPhone: metadata.clientWhatsappPhone || lead?.whatsappPhone || lead?.phone,
    clientBusinessName: metadata.clientBusinessName || lead?.businessName,
    leadStatus: metadata.leadStatus || lead?.status,
    taskTitle: metadata.taskTitle || task?.title,
    taskType: metadata.taskType || task?.type,
    taskStatus: metadata.taskStatus || task?.status,
    taskDueAt,
    taskDueAtDisplay: metadata.taskDueAtDisplay || formatIst(taskDueAt),
    meetingType: metadata.meetingType || meeting?.type,
    meetingMode: metadata.meetingMode || meeting?.mode,
    meetingStatus: metadata.meetingStatus || meeting?.status,
    meetingAt,
    meetingAtDisplay: metadata.meetingAtDisplay || formatIst(meetingAt),
  };
}

function withContextMessage(message, context) {
  const parts = [];
  if (context.clientName) parts.push(`Client: ${context.clientName}`);
  if (context.taskTitle) parts.push(`Task: ${context.taskTitle}`);
  if (context.taskDueAtDisplay) parts.push(`Due: ${context.taskDueAtDisplay}`);
  if (!parts.length) return message;
  return `${parts.join(' · ')}. ${message || ''}`.trim();
}

export async function createNotification({ userId, leadId, taskId, meetingId, type, title, message, priority = 3, metadata }) {
  if (!userId) return null;
  const enrichedMetadata = await buildNotificationContext({ leadId, taskId, meetingId, metadata });
  const notification = await Notification.create({
    userId,
    leadId,
    taskId,
    meetingId,
    type,
    title,
    message: withContextMessage(message, enrichedMetadata),
    priority,
    metadata: enrichedMetadata,
  });
  emitToUser(userId, 'notification:new', notification);
  return notification;
}

export async function notifyAdmins(payload) {
  const admins = await User.find({ role: { $in: [ROLES.ADMIN, ROLES.MANAGER] }, isActive: true }).select('_id');
  const uniqueIds = [...new Set(admins.map((admin) => admin._id.toString()))];
  await Promise.all(uniqueIds.map((userId) => createNotification({ ...payload, userId })));
}

export async function notifyAssigneeAndAdmins({ assignedTo, ...payload }) {
  const admins = await User.find({ role: { $in: [ROLES.ADMIN, ROLES.MANAGER] }, isActive: true }).select('_id');
  const uniqueIds = new Set(admins.map((admin) => admin._id.toString()));
  if (assignedTo) uniqueIds.add(assignedTo.toString());
  await Promise.all([...uniqueIds].map((userId) => createNotification({ ...payload, userId })));
}
