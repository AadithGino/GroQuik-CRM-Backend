import { z } from 'zod';
import { Mockup } from '../models/mockup.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { MOCKUP_STATUS, MOCKUP_TOPIC } from '../constants/crm.constants.js';
import { createMockup, updateMockup } from '../services/mockup.service.js';
import { parseAppRangeEnd, parseAppRangeStart } from '../utils/time.js';
import { isSet } from '../utils/queryFilters.js';
import { applyLeadIdScope, assertLeadAccess, assertMockupAccess } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';

const mockupSchema = z.object({
  assignedTo: z.string().optional(),
  topic: z.nativeEnum(MOCKUP_TOPIC),
  jewelleryThemeNotes: z.string().optional(),
  logoReferenceAvailable: z.boolean().optional(),
  referenceLinks: z.array(z.string()).optional(),
  pagesToShow: z.array(z.string()).optional(),
  status: z.nativeEnum(MOCKUP_STATUS).optional(),
  dueAt: z.string().optional(),
  clientFeedback: z.string().optional(),
  fileUrls: z.array(z.string()).optional(),
});

export const listMockups = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (req.query.mockupId) filter._id = req.query.mockupId;
  if (req.query.leadId) { await assertLeadAccess(req.user, req.query.leadId); filter.leadId = req.query.leadId; }
  if (isSet(req.query.status)) {
    if (req.query.status === 'OPEN') {
      filter.status = { $in: [MOCKUP_STATUS.NOT_STARTED, MOCKUP_STATUS.IN_PROGRESS, MOCKUP_STATUS.READY, MOCKUP_STATUS.SHARED_WITH_CLIENT, MOCKUP_STATUS.CHANGES_REQUESTED] };
    } else if (req.query.status !== 'ALL') {
      filter.status = req.query.status;
    }
  }
  if (req.query.from || req.query.to) {
    filter.dueAt = {};
    if (req.query.from) filter.dueAt.$gte = parseAppRangeStart(req.query.from);
    if (req.query.to) filter.dueAt.$lte = parseAppRangeEnd(req.query.to);
  }
  await applyLeadIdScope(filter, req.user, 'leadId');
  const items = await Mockup.find(filter).populate('leadId', 'name businessName phone callPhone whatsappPhone').populate('assignedTo', 'name').sort({ dueAt: 1, createdAt: -1 }).limit(limit);
  res.json({ items });
});

export const createLeadMockup = asyncHandler(async (req, res) => {
  const body = mockupSchema.parse(req.body);
  await assertLeadAccess(req.user, req.params.leadId);
  const mockup = await createMockup({ leadId: req.params.leadId, userId: req.user._id, payload: body });
  res.status(201).json({ mockup });
});

export const update = asyncHandler(async (req, res) => {
  const body = mockupSchema.partial().parse(req.body);
  await assertMockupAccess(req.user, req.params.id);
  const mockup = await updateMockup({ mockupId: req.params.id, userId: req.user._id, payload: body });
  res.json({ mockup });
});
