
import { Payment } from '../models/payment.model.js';
import { Quote } from '../models/quote.model.js';
import { Lead } from '../models/lead.model.js';
import { ACTIVITY_TYPE, LEAD_STATUS, NOTIFICATION_TYPE, PAYMENT_TYPE, QUOTE_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { addActivity } from './activity.service.js';
import { completeOpenTasksByMetadata, createTask } from './task.service.js';
import { notifyAssigneeAndAdmins } from './notification.service.js';
import { nextMorning, parseAppDateTime } from '../utils/time.js';
import { ApiError } from '../utils/apiError.js';
import { recomputeLeadNextAction } from './leadWorkflow.service.js';

const ADVANCE_ELIGIBLE_QUOTE_STATUSES = [
  QUOTE_STATUS.ACCEPTED,
  QUOTE_STATUS.SENT,
  QUOTE_STATUS.REVISED_SENT,
];

async function resolveAdvanceQuote(leadId, quoteId) {
  if (quoteId) {
    const quote = await Quote.findById(quoteId);
    if (!quote) throw new ApiError(400, 'Linked quote was not found.');
    if (String(quote.leadId) !== String(leadId)) throw new ApiError(400, 'Quote does not belong to this lead.');
    return quote;
  }
  return Quote.findOne({
    leadId,
    status: { $in: ADVANCE_ELIGIBLE_QUOTE_STATUSES },
  }).sort({ revisionNumber: -1, updatedAt: -1 });
}

export async function recordPayment({ leadId, userId, payload }) {
  const amount = Number(payload.amount || 0);
  if (amount <= 0) throw new ApiError(400, 'Payment amount must be greater than zero.');

  const paymentType = payload.paymentType || PAYMENT_TYPE.ADVANCE;
  let linkedQuote = null;

  if (paymentType === PAYMENT_TYPE.ADVANCE) {
    linkedQuote = await resolveAdvanceQuote(leadId, payload.quoteId);
    if (!linkedQuote) {
      throw new ApiError(400, 'Advance payment needs a sent or accepted quote. Accept/send the quote first, then record advance.');
    }
    // Recording advance implies the commercial decision is done — accept the quote if still only sent.
    if (linkedQuote.status !== QUOTE_STATUS.ACCEPTED) {
      linkedQuote.status = QUOTE_STATUS.ACCEPTED;
      linkedQuote.acceptedAt = linkedQuote.acceptedAt || new Date();
      await linkedQuote.save();
      await Lead.findByIdAndUpdate(leadId, {
        quoteStatus: QUOTE_STATUS.ACCEPTED,
        status: LEAD_STATUS.ADVANCE_PENDING,
      });
      await addActivity({
        leadId,
        userId,
        type: ACTIVITY_TYPE.QUOTE_STATUS_UPDATED,
        title: 'Quote accepted while recording advance',
        description: payload.note,
        metadata: { quoteId: linkedQuote._id, status: QUOTE_STATUS.ACCEPTED, autoAcceptedOnPayment: true },
      });
    }
  } else if (payload.quoteId) {
    linkedQuote = await Quote.findById(payload.quoteId);
  } else {
    linkedQuote = await Quote.findOne({ leadId, status: QUOTE_STATUS.ACCEPTED }).sort({ revisionNumber: -1 });
  }

  const payment = await Payment.create({
    ...payload,
    amount,
    paymentType,
    quoteId: linkedQuote?._id || payload.quoteId,
    paymentDate: parseAppDateTime(payload.paymentDate) || undefined,
    leadId,
    receivedBy: userId,
  });
  const payments = await Payment.find({ leadId });
  const totalReceived = payments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const quoteValue = linkedQuote?.finalAmount || 0;
  const pending = quoteValue ? Math.max(quoteValue - totalReceived, 0) : 0;
  const leadPatch = { paymentStatus: quoteValue && pending <= 0 ? 'FULLY_PAID' : 'PARTIALLY_PAID' };
  if (paymentType === PAYMENT_TYPE.ADVANCE) leadPatch.status = LEAD_STATUS.ADVANCE_RECEIVED;

  await Lead.findByIdAndUpdate(leadId, leadPatch);
  await addActivity({
    leadId,
    userId,
    type: ACTIVITY_TYPE.PAYMENT_RECEIVED,
    title: `Payment received: ₹${payment.amount}`,
    description: payload.note,
    metadata: { paymentId: payment._id, totalReceived, pending, paymentType },
  });
  const lead = await Lead.findById(leadId);

  if (paymentType === PAYMENT_TYPE.ADVANCE && linkedQuote) {
    await completeOpenTasksByMetadata({
      leadId,
      type: TASK_TYPE.COLLECT_ADVANCE,
      metadataKey: 'quoteId',
      metadataValue: linkedQuote._id,
      userId,
      metadata: { advanceRecorded: true, paymentId: payment._id },
    });
    await completeOpenTasksByMetadata({
      leadId,
      type: TASK_TYPE.FOLLOW_UP_CALL,
      metadataKey: 'quoteId',
      metadataValue: linkedQuote._id,
      userId,
      metadata: { advanceRecorded: true, paymentId: payment._id },
    });
    await createTask({
      leadId,
      assignedTo: lead.assignedTo,
      type: TASK_TYPE.PROJECT_HANDOFF,
      title: 'Handoff to project/delivery',
      description: 'Advance received against accepted quote. Create project handoff.',
      dueAt: nextMorning(),
      priority: 5,
      metadata: { paymentId: payment._id, quoteId: linkedQuote._id, dedupeKey: `project-handoff:${leadId}:${linkedQuote._id}` },
    });
    await notifyAssigneeAndAdmins({
      assignedTo: lead.assignedTo,
      leadId,
      type: NOTIFICATION_TYPE.PROJECT_HANDOFF,
      title: 'Project handoff required',
      message: 'Advance received against accepted quote. Convert this lead to a project.',
      priority: 5,
    });
  } else {
    await recomputeLeadNextAction(leadId);
  }

  return { payment, totalReceived, pending };
}
