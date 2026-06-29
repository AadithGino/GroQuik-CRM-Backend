
import { Quote } from '../models/quote.model.js';
import { Lead } from '../models/lead.model.js';
import { Task } from '../models/task.model.js';
import { ACTIVITY_TYPE, LEAD_STATUS, NOTIFICATION_TYPE, QUOTE_STATUS, TASK_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { addActivity } from './activity.service.js';
import { completeTask, completeOpenTasksByMetadata, createTask } from './task.service.js';
import { notifyAssigneeAndAdmins } from './notification.service.js';
import { nextMorning } from '../utils/time.js';
import { recomputeLeadNextAction } from './leadWorkflow.service.js';
import { hasAnyQuote } from './businessRules.service.js';
import { ApiError } from '../utils/apiError.js';

async function completeQuoteSendTask({ leadId, quoteId, userId, revised = false }) {
  const type = revised ? TASK_TYPE.SEND_REVISED_QUOTE : TASK_TYPE.SEND_QUOTE;
  const task = await Task.findOne({ leadId, type, status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] }, 'metadata.quoteId': quoteId }).sort({ dueAt: 1 });
  if (task) await completeTask({ taskId: task._id, userId, customerAttempt: false, metadata: { quoteSent: true, quoteId } });
}

async function createQuoteFollowUp({ quote, lead, revised = false }) {
  return createTask({
    leadId: quote.leadId,
    assignedTo: lead.assignedTo,
    type: TASK_TYPE.FOLLOW_UP_CALL,
    title: revised ? 'Follow up on revised quote' : 'Follow up on quote',
    description: revised ? 'Revised quote sent. Follow up tomorrow morning.' : 'Quote sent. Follow up tomorrow morning.',
    dueAt: nextMorning(),
    priority: 5,
    metadata: { quoteId: quote._id, revisionNumber: quote.revisionNumber, quoteFollowUp: true, dedupeKey: `quote-follow-up:${quote._id}` },
  });
}

export async function createQuote({ leadId, userId, payload }) {
  const count = await Quote.countDocuments({ leadId });
  const isAllowedRevisionDraft = Boolean(payload.parentQuoteId || payload.allowRevisionDraft);
  if (count > 0 && !isAllowedRevisionDraft) {
    throw new ApiError(400, 'A quote already exists for this lead. Create a revised quote instead.');
  }
  const quote = await Quote.create({ ...payload, status: payload.status || QUOTE_STATUS.DRAFT, leadId, createdBy: userId, revisionNumber: count + 1 });
  const lead = await Lead.findById(leadId);
  const isRevision = quote.revisionNumber > 1;

  lead.status = LEAD_STATUS.QUOTE_REQUIRED;
  lead.quoteStatus = quote.status;
  await lead.save();

  await addActivity({
    leadId,
    userId,
    type: isRevision ? ACTIVITY_TYPE.QUOTE_REVISED : ACTIVITY_TYPE.QUOTE_CREATED,
    title: isRevision ? 'Revised quote draft created' : 'Quote draft created',
    description: payload.note,
    metadata: { quoteId: quote._id, finalAmount: quote.finalAmount, revisionNumber: quote.revisionNumber },
  });

  await createTask({
    leadId,
    assignedTo: lead.assignedTo,
    type: isRevision ? TASK_TYPE.SEND_REVISED_QUOTE : TASK_TYPE.SEND_QUOTE,
    title: isRevision ? 'Send revised quote' : 'Send quote',
    description: payload.note,
    dueAt: new Date(),
    priority: 4,
    metadata: { quoteId: quote._id, revisionNumber: quote.revisionNumber, dedupeKey: `send-quote:${quote._id}` },
  });
  return quote;
}

export async function reviseQuote({ quoteId, userId, payload }) {
  const previous = await Quote.findById(quoteId);
  if (!previous) return null;
  await Quote.findByIdAndUpdate(previous._id, { status: QUOTE_STATUS.REVISION_REQUIRED });
  return createQuote({
    leadId: previous.leadId,
    userId,
    payload: {
      requirementSummary: payload.requirementSummary ?? previous.requirementSummary,
      deliverables: payload.deliverables ?? previous.deliverables,
      baseAmount: payload.baseAmount ?? previous.baseAmount,
      discountAmount: payload.discountAmount ?? previous.discountAmount,
      finalAmount: payload.finalAmount ?? previous.finalAmount,
      gstMode: payload.gstMode ?? previous.gstMode,
      fileUrl: payload.fileUrl,
      note: payload.note,
      parentQuoteId: previous._id,
      allowRevisionDraft: true,
      status: QUOTE_STATUS.DRAFT,
    },
  });
}

export async function updateQuoteStatus({ quoteId, userId, status, note, fileUrl }) {
  const existing = await Quote.findById(quoteId);
  if (!existing) return null;
  const previousStatus = existing.status;
  const patch = { status };
  if (fileUrl) patch.fileUrl = fileUrl;
  if ([QUOTE_STATUS.SENT, QUOTE_STATUS.REVISED_SENT].includes(status) && previousStatus !== status) patch.sentAt = new Date();
  if (status === QUOTE_STATUS.ACCEPTED && previousStatus !== status) patch.acceptedAt = new Date();
  if (status === QUOTE_STATUS.REJECTED && previousStatus !== status) patch.rejectedAt = new Date();
  const quote = await Quote.findByIdAndUpdate(quoteId, patch, { new: true });
  const lead = await Lead.findById(quote.leadId);
  const revised = status === QUOTE_STATUS.REVISED_SENT || quote.revisionNumber > 1;
  const leadPatch = { quoteStatus: status };

  if (status === QUOTE_STATUS.ACCEPTED) leadPatch.status = LEAD_STATUS.ADVANCE_PENDING;
  if (status === QUOTE_STATUS.REJECTED) leadPatch.status = LEAD_STATUS.LOST;
  if (status === QUOTE_STATUS.SENT) leadPatch.status = LEAD_STATUS.QUOTE_SENT;
  if (status === QUOTE_STATUS.REVISED_SENT) leadPatch.status = LEAD_STATUS.REVISED_QUOTE_SENT;

  await Lead.findByIdAndUpdate(quote.leadId, leadPatch);
  await addActivity({ leadId: quote.leadId, userId, type: ACTIVITY_TYPE.QUOTE_STATUS_UPDATED, title: `Quote status updated: ${status}`, description: note, metadata: { quoteId, status, previousStatus } });

  const isNewTransition = previousStatus !== status;

  if ([QUOTE_STATUS.SENT, QUOTE_STATUS.REVISED_SENT].includes(status)) {
    await completeQuoteSendTask({ leadId: quote.leadId, quoteId: quote._id, userId, revised });
    if (isNewTransition) {
      await createQuoteFollowUp({ quote, lead, revised });
      await notifyAssigneeAndAdmins({ assignedTo: lead.assignedTo, leadId: quote.leadId, type: NOTIFICATION_TYPE.QUOTE_PENDING, title: revised ? 'Revised quote sent' : 'Quote sent', message: 'Quote follow-up created for tomorrow morning.', priority: 4, metadata: { quoteId: quote._id } });
    }
  }

  if (status === QUOTE_STATUS.ACCEPTED) {
    if (isNewTransition) {
      await completeOpenTasksByMetadata({ leadId: quote.leadId, type: TASK_TYPE.FOLLOW_UP_CALL, metadataKey: 'quoteId', metadataValue: quote._id, userId, metadata: { quoteAccepted: true } });
      await createTask({ leadId: quote.leadId, assignedTo: lead.assignedTo, type: TASK_TYPE.COLLECT_ADVANCE, title: 'Collect advance payment', description: 'Quote accepted. Collect advance before onboarding.', dueAt: nextMorning(), priority: 5, metadata: { quoteId, dedupeKey: `collect-advance:${quote._id}` } });
      await notifyAssigneeAndAdmins({ assignedTo: lead.assignedTo, leadId: quote.leadId, type: NOTIFICATION_TYPE.ADVANCE_PENDING, title: 'Advance pending', message: 'Quote accepted. Advance should be collected before project handoff.', priority: 5, metadata: { quoteId } });
    }
  }

  await recomputeLeadNextAction(quote.leadId);
  return quote;
}
