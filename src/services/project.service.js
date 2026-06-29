import { Project } from '../models/project.model.js';
import { Lead } from '../models/lead.model.js';
import { Quote } from '../models/quote.model.js';
import { Payment } from '../models/payment.model.js';
import { ACTIVITY_TYPE, LEAD_STATUS, QUOTE_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { addActivity } from './activity.service.js';
import { ApiError } from '../utils/apiError.js';
import { parseAppDateTime } from '../utils/time.js';
import { completeOpenTasksByMetadata } from './task.service.js';

function requireHandoffReady({ quote, received, payload }) {
  if (!quote) throw new ApiError(400, 'Cannot create project handoff without a linked quote.');
  if (quote.status !== QUOTE_STATUS.ACCEPTED) throw new ApiError(400, 'Cannot create project handoff before quote is accepted.');
  if (received <= 0) throw new ApiError(400, 'Cannot create project handoff before recording advance/payment.');
  if (!payload.assignedDeveloper) throw new ApiError(400, 'Assign a developer before project handoff.');
  if (!payload.expectedDeliveryDate) throw new ApiError(400, 'Set expected delivery date before project handoff.');
  if (!payload.requirementSummary && !quote.requirementSummary) throw new ApiError(400, 'Confirm requirement summary before project handoff.');
}

export async function convertLeadToProject({ leadId, userId, payload }) {
  let project = await Project.findOne({ leadId });
  if (project) return project;
  const lead = await Lead.findById(leadId);
  const quote = payload.quoteId ? await Quote.findById(payload.quoteId) : await Quote.findOne({ leadId, status: QUOTE_STATUS.ACCEPTED }).sort({ revisionNumber: -1 });
  const totalPaid = await Payment.aggregate([{ $match: { leadId: lead._id } }, { $group: { _id: '$leadId', total: { $sum: '$amount' } } }]);
  const received = totalPaid[0]?.total || 0;
  requireHandoffReady({ quote, received, payload });

  const finalQuoteValue = payload.finalQuoteValue ?? quote.finalAmount ?? 0;
  const expectedDeliveryDate = parseAppDateTime(payload.expectedDeliveryDate);
  project = await Project.create({
    leadId,
    quoteId: quote._id,
    clientName: payload.clientName || lead.name,
    businessName: payload.businessName || lead.businessName,
    products: payload.products || lead.requirements,
    deliverables: payload.deliverables || quote.deliverables || [],
    finalQuoteValue,
    paymentReceived: received,
    paymentPending: Math.max(finalQuoteValue - received, 0),
    assignedDeveloper: payload.assignedDeveloper,
    expectedDeliveryDate,
    requirementSummary: payload.requirementSummary || quote.requirementSummary,
    internalNotes: payload.internalNotes,
    handoffChecklist: {
      ...(payload.handoffChecklist || {}),
      requirementConfirmed: Boolean(payload.requirementSummary || quote.requirementSummary || payload.handoffChecklist?.requirementConfirmed),
      quoteAccepted: true,
      advanceReceived: true,
      expectedDeliveryDateSet: Boolean(expectedDeliveryDate),
      deliveryOwnerAssigned: Boolean(payload.assignedDeveloper),
    },
  });
  await Lead.findByIdAndUpdate(leadId, { status: LEAD_STATUS.PROJECT_CREATED, projectId: project._id });
  await completeOpenTasksByMetadata({ leadId, type: TASK_TYPE.PROJECT_HANDOFF, metadataKey: 'quoteId', metadataValue: quote._id, userId, metadata: { projectCreated: true, projectId: project._id } });
  await addActivity({ leadId, userId, type: ACTIVITY_TYPE.PROJECT_CREATED, title: 'Project created / handoff done', description: payload.internalNotes, metadata: { projectId: project._id } });
  return project;
}

export async function updateProject({ projectId, userId, payload }) {
  const patch = { ...payload };
  if (payload.expectedDeliveryDate) patch.expectedDeliveryDate = parseAppDateTime(payload.expectedDeliveryDate);
  const project = await Project.findByIdAndUpdate(projectId, patch, { new: true });
  if (!project) return null;
  await addActivity({ leadId: project.leadId, userId, type: ACTIVITY_TYPE.PROJECT_UPDATED, title: `Project updated: ${project.status}`, description: payload.internalNotes, metadata: { projectId } });
  return project;
}
