import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createMeeting, markMeetingResult, rescheduleMeeting } from '../services/meeting.service.js';
import { Meeting } from '../models/meeting.model.js';
import { GST_MODE, MEETING_MODE, MEETING_STATUS, MEETING_TYPE, MOCKUP_TOPIC, NEXT_ACTION, REQUIREMENT } from '../constants/crm.constants.js';
import { parseAppRangeEnd, parseAppRangeStart } from '../utils/time.js';
import { isSet } from '../utils/queryFilters.js';
import { applyAssignedUserScope, assertLeadAccess, assertMeetingAccess } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';


const stringArrayOrText = z.union([z.array(z.string()), z.string()]).optional();
const optionalUrlOrPath = z.union([z.string().url(), z.string().startsWith('/uploads/'), z.literal('')]).optional();
const actionDetailsSchema = z.object({
  quote: z.object({
    finalAmount: z.coerce.number().positive().optional(),
    baseAmount: z.coerce.number().nonnegative().optional(),
    discountAmount: z.coerce.number().nonnegative().optional(),
    gstMode: z.nativeEnum(GST_MODE).optional(),
    deliverables: stringArrayOrText,
    deliverablesText: z.string().optional(),
    requirementSummary: z.string().optional(),
    fileUrl: optionalUrlOrPath,
    note: z.string().optional(),
  }).strict().optional(),
  meeting: z.object({
    type: z.nativeEnum(MEETING_TYPE).optional(),
    mode: z.nativeEnum(MEETING_MODE).optional(),
    meetingAt: z.string().optional(),
    confirmTimeTaskDueAt: z.string().optional(),
    topicRequirements: z.array(z.nativeEnum(REQUIREMENT)).optional(),
    note: z.string().optional(),
    location: z.string().optional(),
  }).strict().optional(),
  mockup: z.object({
    topic: z.nativeEnum(MOCKUP_TOPIC).optional(),
    dueAt: z.string().optional(),
    jewelleryThemeNotes: z.string().optional(),
    pagesToShow: stringArrayOrText,
    pagesText: z.string().optional(),
    logoReferenceAvailable: z.boolean().optional(),
    referenceLinks: stringArrayOrText,
    fileUrls: z.array(z.union([z.string().url(), z.string().startsWith('/uploads/')])).optional(),
  }).passthrough().optional(),
}).strict();

const createMeetingSchema = z.object({
  type: z.nativeEnum(MEETING_TYPE),
  mode: z.nativeEnum(MEETING_MODE),
  topicRequirements: z.array(z.nativeEnum(REQUIREMENT)).optional(),
  note: z.string().optional(),
  location: z.string().optional(),
  meetingAt: z.string().optional(),
  dateOnly: z.string().optional(),
  confirmTimeTaskDueAt: z.string().optional(),
  assignedTo: z.string().optional(),
  metadata: z.any().optional(),
});

export const createLeadMeeting = asyncHandler(async (req, res) => {
  const body = createMeetingSchema.parse(req.body);
  await assertLeadAccess(req.user, req.params.leadId);
  const meeting = await createMeeting({ leadId: req.params.leadId, userId: req.user._id, payload: body });
  res.status(201).json({ meeting });
});

export const listMeetings = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (req.query.meetingId) filter._id = req.query.meetingId;
  if (req.query.leadId) {
    await assertLeadAccess(req.user, req.query.leadId);
    filter.leadId = req.query.leadId;
  }
  if (isSet(req.query.status)) {
    if (req.query.status === 'OPEN') {
      filter.status = { $in: [MEETING_STATUS.TIME_PENDING, MEETING_STATUS.SCHEDULED, MEETING_STATUS.REMINDER_SENT, MEETING_STATUS.RESCHEDULE_PENDING] };
    } else if (req.query.status !== 'ALL') {
      filter.status = req.query.status;
    }
  }
  await applyAssignedUserScope(filter, req.user, 'assignedTo');
  if (req.query.from || req.query.to) {
    filter.meetingAt = {};
    if (req.query.from) filter.meetingAt.$gte = parseAppRangeStart(req.query.from);
    if (req.query.to) filter.meetingAt.$lte = parseAppRangeEnd(req.query.to);
  }
  const items = await Meeting.find(filter).populate('leadId', 'name businessName phone callPhone whatsappPhone interestScore').populate('assignedTo', 'name').sort({ meetingAt: 1, createdAt: -1 }).limit(limit);
  res.json({ items });
});

export const reschedule = asyncHandler(async (req, res) => {
  const body = z.object({ meetingAt: z.string().optional(), confirmTimeTaskDueAt: z.string().optional(), reason: z.string().optional(), note: z.string().optional(), location: z.string().optional() }).parse(req.body);
  await assertMeetingAccess(req.user, req.params.id);
  const meeting = await rescheduleMeeting({ meetingId: req.params.id, userId: req.user._id, payload: body });
  res.json({ meeting });
});

export const result = asyncHandler(async (req, res) => {
  const body = z.object({
    status: z.nativeEnum(MEETING_STATUS),
    resultNote: z.string().optional(),
    reason: z.string().optional(),
    interestScore: z.number().min(1).max(10).optional(),
    requirements: z.array(z.nativeEnum(REQUIREMENT)).optional(),
    nextAction: z.nativeEnum(NEXT_ACTION).optional(),
    nextFollowUpAt: z.string().optional(),
    meetingAt: z.string().optional(),
    location: z.string().optional(),
    confirmTimeTaskDueAt: z.string().optional(),
    actionDetails: actionDetailsSchema.optional(),
  }).parse(req.body);
  await assertMeetingAccess(req.user, req.params.id);
  const meeting = await markMeetingResult({ meetingId: req.params.id, userId: req.user._id, payload: body });
  res.json({ meeting });
});
