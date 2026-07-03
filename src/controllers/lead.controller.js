import { z } from 'zod';
import { Lead } from '../models/lead.model.js';
import { User } from '../models/user.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/apiError.js';
import { createInitialLeadTasks } from '../services/leadAutomation.service.js';
import { applyCallOutcome } from '../services/callOutcome.service.js';
import { ACTIVITY_TYPE, CALL_RESULT, GST_MODE, LEAD_STATUS, LOST_REASON, MEETING_MODE, MEETING_TYPE, MOCKUP_TOPIC, REQUIREMENT, ROLES } from '../constants/crm.constants.js';
import { addActivity } from '../services/activity.service.js';
import { resolveAssignee } from '../services/assignment.service.js';
import { normalizePhone } from '../utils/phone.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { assertLeadAccess, leadScopeFilter } from '../utils/permissions.js';
import { getLeadActionState } from '../services/businessRules.service.js';
import { parsePagination } from '../utils/pagination.js';
import { applyLeadSearchFilter } from '../utils/fuzzySearch.js';


const stringArrayOrText = z.union([z.array(z.string()), z.string()]).optional();
const optionalUrlOrPath = z.union([z.string().url(), z.string().startsWith('/uploads/'), z.literal('')]).optional();

const quoteActionDetailsSchema = z.object({
  finalAmount: z.coerce.number().positive().optional(),
  baseAmount: z.coerce.number().nonnegative().optional(),
  discountAmount: z.coerce.number().nonnegative().optional(),
  gstMode: z.nativeEnum(GST_MODE).optional(),
  deliverables: stringArrayOrText,
  deliverablesText: z.string().optional(),
  requirementSummary: z.string().optional(),
  fileUrl: optionalUrlOrPath,
  note: z.string().optional(),
}).strict();

const meetingActionDetailsSchema = z.object({
  type: z.nativeEnum(MEETING_TYPE).optional(),
  mode: z.nativeEnum(MEETING_MODE).optional(),
  meetingAt: z.string().optional(),
  confirmTimeTaskDueAt: z.string().optional(),
  topicRequirements: z.array(z.nativeEnum(REQUIREMENT)).optional(),
  note: z.string().optional(),
  location: z.string().optional(),
}).strict();

const mockupActionDetailsSchema = z.object({
  topic: z.nativeEnum(MOCKUP_TOPIC).optional(),
  dueAt: z.string().optional(),
  jewelleryThemeNotes: z.string().optional(),
  pagesToShow: stringArrayOrText,
  pagesText: z.string().optional(),
  logoReferenceAvailable: z.boolean().optional(),
  referenceLinks: stringArrayOrText,
  fileUrls: z.array(z.union([z.string().url(), z.string().startsWith('/uploads/')])).optional(),
}).passthrough();

const actionDetailsSchema = z.object({
  quote: quoteActionDetailsSchema.optional(),
  meeting: meetingActionDetailsSchema.optional(),
  mockup: mockupActionDetailsSchema.optional(),
}).strict();

const createLeadSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  callPhone: z.string().optional(),
  whatsappPhone: z.string().optional(),
  businessName: z.string().optional(),
  place: z.string().optional(),
  source: z.string().default('MANUAL'),
  campaignName: z.string().optional(),
  formName: z.string().optional(),
  assignedTo: z.string().optional(),
  requirements: z.array(z.nativeEnum(REQUIREMENT)).optional(),
});


const updateLeadContactsSchema = z.object({
  phone: z.string().optional(),
  callPhone: z.string().optional(),
  whatsappPhone: z.string().optional(),
  alternateNumbers: z.array(z.object({
    number: z.string().min(1),
    label: z.string().optional(),
    relation: z.string().optional(),
    personName: z.string().optional(),
    isPrimary: z.boolean().optional(),
    isDecisionMaker: z.boolean().optional(),
  })).optional(),
});

const callOutcomeSchema = z.object({
  result: z.nativeEnum(CALL_RESULT),
  taskId: z.string().optional(),
  interestScore: z.number().min(1).max(10).optional(),
  requirements: z.array(z.nativeEnum(REQUIREMENT)).optional(),
  note: z.string().optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: z.string().optional(),
  nextFollowUpTime: z.string().optional(),
  customFollowUpAt: z.string().optional(),
  nextFollowUpAt: z.string().optional(),
  callbackAt: z.string().optional(),
  notDoneReason: z.string().optional(),
  rescheduleAt: z.string().optional(),
  lostReason: z.nativeEnum(LOST_REASON).optional(),
  nurtureAfterDays: z.number().optional(),
  alternateNumber: z.string().optional(),
  personName: z.string().optional(),
  relation: z.string().optional(),
  isDecisionMaker: z.boolean().optional(),
  setAsPrimary: z.boolean().optional(),
  canHandleNow: z.boolean().optional(),
  actionDetails: actionDetailsSchema.optional(),
});

export const createLead = asyncHandler(async (req, res) => {
  const body = req.body || {};
  body.phone = normalizePhone(body.phone);
  body.callPhone = normalizePhone(body.callPhone) || body.phone;
  body.whatsappPhone = normalizePhone(body.whatsappPhone) || body.phone;
  if (!body.phone && body.callPhone) body.phone = body.callPhone;
  const assignedTo = await resolveAssignee({ requestedAssignee: body.assignedTo, currentUser: req.user, source: body.source, campaignName: body.campaignName });

  let duplicate = null;
  if (body.phone) duplicate = await Lead.findOne({ phone: body.phone, status: { $nin: [LEAD_STATUS.INVALID] } });

  if (duplicate && !req.body.forceCreate) {
    return res.status(409).json({
      message: 'Possible duplicate lead found',
      duplicate,
    });
  }

  const lead = await Lead.create({ ...body, assignedTo, status: LEAD_STATUS.NEW_LEAD });
  await addActivity({ leadId: lead._id, userId: req.user._id, type: ACTIVITY_TYPE.LEAD_CREATED, title: 'Lead created', metadata: { source: lead.source } });
  await createInitialLeadTasks(lead);

  res.status(201).json({ lead });
});

export const listLeads = asyncHandler(async (req, res) => {
  const { q, status, assignedTo, source } = req.query;
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = await leadScopeFilter(req.user);

  if (isSet(status)) filter.status = status;
  if (isSet(source)) filter.source = source;
  if (assignedTo && req.user.role !== ROLES.SALES) {
    const scopedAssignees = filter.assignedTo?.$in?.map((id) => id.toString());
    if (scopedAssignees && !scopedAssignees.includes(assignedTo.toString())) filter.assignedTo = { $in: [] };
    else filter.assignedTo = assignedTo;
  }
  applyDateRange(filter, req.query, 'createdAt');
  const queryFilter = applyLeadSearchFilter(filter, q);

  const [items, total] = await Promise.all([
    Lead.find(queryFilter).populate('assignedTo', 'name email role').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Lead.countDocuments(queryFilter),
  ]);

  res.json({ items, total, page, limit });
});

export const getLead = asyncHandler(async (req, res) => {
  const rawLead = await assertLeadAccess(req.user, req.params.id);
  const lead = await Lead.findById(rawLead._id).populate('assignedTo', 'name email role');
  const actionState = await getLeadActionState(lead._id);
  res.json({ lead, actionState });
});


export const updateLeadContacts = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const lead = await assertLeadAccess(req.user, req.params.id);

  const nextPhone = normalizePhone(body.phone ?? lead.phone);
  const nextCallPhone = normalizePhone(body.callPhone ?? lead.callPhone) || nextPhone;
  const nextWhatsappPhone = normalizePhone(body.whatsappPhone ?? lead.whatsappPhone) || nextPhone;

  lead.phone = nextPhone;
  lead.callPhone = nextCallPhone;
  lead.whatsappPhone = nextWhatsappPhone;
  if (body.alternateNumbers) {
    lead.alternateNumbers = body.alternateNumbers.map((item) => ({
      ...item,
      number: normalizePhone(item.number),
    })).filter((item) => item.number);
  }

  await lead.save();
  await addActivity({
    leadId: lead._id,
    userId: req.user._id,
    type: ACTIVITY_TYPE.NOTE,
    title: 'Contact numbers updated',
    description: `Primary: ${lead.phone || '-'} · Call: ${lead.callPhone || '-'} · WhatsApp: ${lead.whatsappPhone || '-'}`,
  });
  res.json({ lead });
});

export const addLeadNote = asyncHandler(async (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (!note) throw new ApiError(400, 'Note is required');
  const lead = await assertLeadAccess(req.user, req.params.id);
  await addActivity({ leadId: lead._id, userId: req.user._id, type: ACTIVITY_TYPE.NOTE, title: 'Note added', description: note });
  res.json({ message: 'Note added' });
});

export const callOutcome = asyncHandler(async (req, res) => {
  const body = req.body || {};
  await assertLeadAccess(req.user, req.params.id);
  const lead = await applyCallOutcome({ leadId: req.params.id, userId: req.user._id, taskId: body.taskId, payload: body });
  if (!lead) throw new ApiError(404, 'Lead not found');
  res.json({ lead });
});
