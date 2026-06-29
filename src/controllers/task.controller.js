
import { z } from 'zod';
import { Task } from '../models/task.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseAppDateTime, parseAppRangeEnd, parseAppRangeStart } from '../utils/time.js';
import { createTask, completeTask, markTaskNotDone } from '../services/task.service.js';
import { TASK_STATUS, TASK_TYPE, QUOTE_STATUS, MOCKUP_STATUS } from '../constants/crm.constants.js';
import { applyAssignedUserScope, assertLeadAccess, assertTaskAccess } from '../utils/permissions.js';
import { updateQuoteStatus } from '../services/quote.service.js';
import { updateMockup } from '../services/mockup.service.js';
import { rescheduleMeeting } from '../services/meeting.service.js';
import { ApiError } from '../utils/apiError.js';
import { parsePagination } from '../utils/pagination.js';

const createTaskSchema = z.object({
  leadId: z.string().optional(),
  meetingId: z.string().optional(),
  assignedTo: z.string().optional(),
  type: z.nativeEnum(TASK_TYPE),
  title: z.string().min(1),
  description: z.string().optional(),
  dueAt: z.string(),
  priority: z.number().min(1).max(5).optional(),
});

const doneSchema = z.object({
  customerAttempt: z.boolean().optional(),
  metadata: z.object({ note: z.string().optional(), fileUrl: z.union([z.string().url(), z.string().startsWith('/uploads/'), z.literal('')]).optional(), fileUrls: z.array(z.union([z.string().url(), z.string().startsWith('/uploads/')])).optional() }).passthrough().optional(),
  meetingAt: z.string().optional(),
  nextConfirmTimeAt: z.string().optional(),
  reason: z.string().optional(),
});

export const listTasks = asyncHandler(async (req, res) => {
  const { status = TASK_STATUS.PENDING, from, to, leadId, taskId, type } = req.query;
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (taskId) filter._id = taskId;
  if (leadId) {
    await assertLeadAccess(req.user, leadId);
    filter.leadId = leadId;
  }
  if (type && type !== 'ALL') filter.type = type;
  if (status !== 'ALL') {
    if (status === 'OPEN') filter.status = { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] };
    else filter.status = status;
  }
  await applyAssignedUserScope(filter, req.user, 'assignedTo');
  if (from || to) {
    filter.dueAt = {};
    if (from) filter.dueAt.$gte = parseAppRangeStart(from);
    if (to) filter.dueAt.$lte = parseAppRangeEnd(to);
  }

  const items = await Task.find(filter)
    .populate('leadId', 'name businessName phone callPhone whatsappPhone status interestScore failedCustomerAttempts')
    .populate('meetingId', 'type mode meetingAt status note')
    .populate('assignedTo', 'name email role')
    .sort({ dueAt: 1, createdAt: -1 })
    .limit(limit);

  res.json({ items });
});

export const createManualTask = asyncHandler(async (req, res) => {
  const body = createTaskSchema.parse(req.body);
  let assignedTo = body.assignedTo || req.user._id;
  if (body.leadId) {
    const lead = await assertLeadAccess(req.user, body.leadId);
    assignedTo = body.assignedTo || lead.assignedTo;
  }
  const task = await createTask({ ...body, assignedTo, dueAt: parseAppDateTime(body.dueAt) });
  res.status(201).json({ task });
});

async function completeBusinessTask(task, userId, body) {
  if ([TASK_TYPE.FIRST_CALL, TASK_TYPE.FOLLOW_UP_CALL].includes(task.type)) {
    return completeTask({ taskId: task._id, userId, customerAttempt: Boolean(body.customerAttempt), metadata: body.metadata });
  }

  if ([TASK_TYPE.SEND_QUOTE, TASK_TYPE.SEND_REVISED_QUOTE].includes(task.type)) {
    const quoteId = task.metadata?.quoteId;
    if (!quoteId) throw new ApiError(400, 'This quote task is missing quote reference. Open the lead/quote and update the quote directly.');
    const status = task.type === TASK_TYPE.SEND_REVISED_QUOTE ? QUOTE_STATUS.REVISED_SENT : QUOTE_STATUS.SENT;
    await updateQuoteStatus({ quoteId, userId, status, note: body.metadata?.note || 'Quote sent from task completion.', fileUrl: body.metadata?.fileUrl });
    return Task.findById(task._id);
  }

  if ([TASK_TYPE.CREATE_MOCKUP, TASK_TYPE.SHARE_MOCKUP].includes(task.type)) {
    const mockupId = task.metadata?.mockupId;
    if (!mockupId) throw new ApiError(400, 'This mockup task is missing mockup reference. Open the lead/mockup and update it directly.');
    const status = task.type === TASK_TYPE.CREATE_MOCKUP ? MOCKUP_STATUS.READY : MOCKUP_STATUS.SHARED_WITH_CLIENT;
    await updateMockup({ mockupId, userId, payload: { status, clientFeedback: body.metadata?.note, ...(body.metadata?.fileUrl ? { fileUrls: [body.metadata.fileUrl] } : {}), ...(body.metadata?.fileUrls ? { fileUrls: body.metadata.fileUrls } : {}) } });
    return Task.findById(task._id);
  }

  if (task.type === TASK_TYPE.CONFIRM_MEETING_TIME) {
    if (!task.meetingId) throw new ApiError(400, 'This confirm-time task is missing meeting reference.');
    if (body.meetingAt) {
      await completeTask({ taskId: task._id, userId, metadata: { meetingTimeConfirmed: true } });
      await rescheduleMeeting({ meetingId: task.meetingId, userId, payload: { meetingAt: body.meetingAt, reason: body.reason || 'Meeting time confirmed from task.' } });
      return Task.findById(task._id);
    }
    if (body.nextConfirmTimeAt) {
      await completeTask({ taskId: task._id, userId, metadata: { meetingStillPending: true } });
      await rescheduleMeeting({ meetingId: task.meetingId, userId, payload: { confirmTimeTaskDueAt: body.nextConfirmTimeAt, reason: body.reason || 'Customer has not confirmed a new time yet.' } });
      return Task.findById(task._id);
    }
    throw new ApiError(400, 'Confirm meeting time tasks require either a confirmed meetingAt or a nextConfirmTimeAt. Do not mark them as generic Done.');
  }

  if (task.type === TASK_TYPE.COLLECT_ADVANCE) {
    throw new ApiError(400, 'Collect Advance tasks cannot be marked Done directly. Record the payment in the Payments section.');
  }

  if (task.type === TASK_TYPE.PROJECT_HANDOFF) {
    throw new ApiError(400, 'Project Handoff tasks cannot be marked Done directly. Convert the lead to a project and complete the handoff checklist.');
  }

  if (task.type === TASK_TYPE.SCHEDULE_MOCKUP_MEETING) {
    throw new ApiError(400, 'Schedule Mockup Meeting tasks require creating/updating a meeting, not generic Done.');
  }

  return completeTask({ taskId: task._id, userId, customerAttempt: Boolean(body.customerAttempt), metadata: body.metadata });
}

export const markDone = asyncHandler(async (req, res) => {
  const task = await assertTaskAccess(req.user, req.params.id);
  const body = doneSchema.parse(req.body || {});
  const updated = await completeBusinessTask(task, req.user._id, body);
  res.json({ task: updated });
});

export const notDone = asyncHandler(async (req, res) => {
  await assertTaskAccess(req.user, req.params.id);
  const body = z.object({ reason: z.string().optional(), rescheduleAt: z.string().optional() }).parse(req.body);
  const task = await markTaskNotDone({ taskId: req.params.id, userId: req.user._id, reason: body.reason, rescheduleAt: parseAppDateTime(body.rescheduleAt) });
  res.json({ task });
});
