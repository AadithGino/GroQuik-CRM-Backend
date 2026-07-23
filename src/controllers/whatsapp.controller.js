import { z } from 'zod';
import { WhatsAppTemplate } from '../models/whatsappTemplate.model.js';
import { Lead } from '../models/lead.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/apiError.js';
import { toWhatsAppPhone } from '../utils/phone.js';
import { addActivity } from '../services/activity.service.js';
import { completeTask, createTask } from '../services/task.service.js';
import { ACTIVITY_TYPE, LEAD_STATUS, TASK_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { nextMorning, parseAppDateTime } from '../utils/time.js';
import { applyDateRange } from '../utils/queryFilters.js';
import { Task } from '../models/task.model.js';
import { assertLeadAccess } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';

function renderTemplate(template, lead) {
  return template
    .replaceAll('{{name}}', lead.name || '')
    .replaceAll('{{businessName}}', lead.businessName || '')
    .replaceAll('{{phone}}', lead.phone || '')
    .replaceAll('{{callPhone}}', lead.callPhone || lead.phone || '')
    .replaceAll('{{whatsappPhone}}', lead.whatsappPhone || lead.phone || '')
    .replaceAll('{{place}}', lead.place || '');
}

export const listTemplates = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  applyDateRange(filter, req.query, 'createdAt');
  const items = await WhatsAppTemplate.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json({ items });
});

export const saveTemplate = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const template = await WhatsAppTemplate.findOneAndUpdate({ name: body.name }, body, { new: true, upsert: true });
  res.status(201).json({ template });
});

export const generateLink = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const lead = await assertLeadAccess(req.user, req.params.leadId);
  let message = body.message || '';
  if (body.templateId) {
    const template = await WhatsAppTemplate.findById(body.templateId);
    if (template) message = renderTemplate(template.body, lead);
  }
  const whatsappPhone = lead.whatsappPhone || lead.phone;
  const whatsappTarget = toWhatsAppPhone(whatsappPhone);
  if (!whatsappTarget) throw new ApiError(400, 'WhatsApp number is missing for this lead');
  const url = `https://wa.me/${whatsappTarget}?text=${encodeURIComponent(message)}`;
  res.json({ url, message });
});

export const markSent = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const lead = await assertLeadAccess(req.user, req.params.leadId);
  if (![LEAD_STATUS.WON, LEAD_STATUS.LOST, LEAD_STATUS.INVALID, LEAD_STATUS.PROJECT_CREATED].includes(lead.status)) {
    lead.status = LEAD_STATUS.WHATSAPP_SENT;
    await lead.save();
  }
  const pendingWhatsappTask = await Task.findOne({ leadId: lead._id, type: TASK_TYPE.SEND_WHATSAPP, status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] } }).sort({ dueAt: 1 });
  if (pendingWhatsappTask) {
    await completeTask({ taskId: pendingWhatsappTask._id, userId: req.user._id, customerAttempt: false, metadata: { whatsappSent: true } });
  }
  await addActivity({ leadId: lead._id, userId: req.user._id, type: ACTIVITY_TYPE.WHATSAPP_SENT, title: 'WhatsApp details sent', description: body.message });

  const createFollowUp = body.createFollowUp === true || body.createFollowUp === 'true' || body.createFollowUp === 1;
  if (!createFollowUp) {
    return res.json({ lead, task: null, reusedExistingFollowUp: false });
  }

  const requestedFollowUpAt = parseAppDateTime(body.followUpAt);
  let task = await Task.findOne({
    leadId: lead._id,
    type: TASK_TYPE.FOLLOW_UP_CALL,
    status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] },
  }).sort({ dueAt: 1 });

  const reusedExistingFollowUp = Boolean(task);
  if (task) {
    if (requestedFollowUpAt) task.dueAt = requestedFollowUpAt;
    task.metadata = { ...(task.metadata || {}), whatsappFollowUp: true, whatsappSentAt: new Date() };
    await task.save();
  } else {
    const followUpAt = requestedFollowUpAt || nextMorning();
    task = await createTask({
      leadId: lead._id,
      assignedTo: lead.assignedTo,
      type: TASK_TYPE.FOLLOW_UP_CALL,
      title: 'Follow up after WhatsApp',
      description: 'WhatsApp sent. Call and confirm interest.',
      dueAt: followUpAt,
      priority: 4,
      metadata: { whatsappFollowUp: true, dedupeKey: `whatsapp-follow-up:${lead._id}` },
    });
  }
  res.json({ lead, task, reusedExistingFollowUp });
});
