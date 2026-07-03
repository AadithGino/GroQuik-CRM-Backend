import { z } from 'zod';
import { Project } from '../models/project.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PROJECT_STATUS, REQUIREMENT } from '../constants/crm.constants.js';
import { convertLeadToProject, updateProject } from '../services/project.service.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { applyLeadIdScope, assertLeadAccess, assertProjectAccess } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';

const projectSchema = z.object({
  quoteId: z.string().optional(),
  clientName: z.string().optional(),
  businessName: z.string().optional(),
  products: z.array(z.nativeEnum(REQUIREMENT)).optional(),
  deliverables: z.array(z.string()).optional(),
  finalQuoteValue: z.number().optional(),
  assignedDeveloper: z.string().optional(),
  expectedDeliveryDate: z.string().optional(),
  status: z.nativeEnum(PROJECT_STATUS).optional(),
  requirementSummary: z.string().optional(),
  internalNotes: z.string().optional(),
  handoffChecklist: z.any().optional(),
});

export const listProjects = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (req.query.leadId) { await assertLeadAccess(req.user, req.query.leadId); filter.leadId = req.query.leadId; }
  if (isSet(req.query.status)) filter.status = req.query.status;
  const dateField = req.query.dateField === 'expectedDeliveryDate' ? 'expectedDeliveryDate' : 'createdAt';
  applyDateRange(filter, req.query, dateField);
  await applyLeadIdScope(filter, req.user, 'leadId');
  const items = await Project.find(filter).populate('leadId', 'name businessName phone callPhone whatsappPhone').populate('assignedDeveloper', 'name').sort({ createdAt: -1 }).limit(limit);
  res.json({ items });
});

export const convertLead = asyncHandler(async (req, res) => {
  await assertLeadAccess(req.user, req.params.leadId);
  const project = await convertLeadToProject({ leadId: req.params.leadId, userId: req.user._id, payload: req.body || {} });
  res.status(201).json({ project });
});

export const update = asyncHandler(async (req, res) => {
  await assertProjectAccess(req.user, req.params.id);
  const project = await updateProject({ projectId: req.params.id, userId: req.user._id, payload: req.body || {} });
  res.json({ project });
});
