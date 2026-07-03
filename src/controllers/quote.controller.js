import { z } from 'zod';
import { Quote } from '../models/quote.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { GST_MODE, QUOTE_STATUS } from '../constants/crm.constants.js';
import { createQuote, reviseQuote, updateQuoteStatus } from '../services/quote.service.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { applyLeadIdScope, assertLeadAccess, assertQuoteAccess } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';

const quoteSchema = z.object({
  requirementSummary: z.string().optional(),
  deliverables: z.array(z.string()).optional(),
  baseAmount: z.number().optional(),
  discountAmount: z.number().optional(),
  finalAmount: z.number().min(0),
  gstMode: z.nativeEnum(GST_MODE).optional(),
  status: z.nativeEnum(QUOTE_STATUS).optional(),
  fileUrl: z.string().optional(),
  note: z.string().optional(),
});

export const listQuotes = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (req.query.leadId) { await assertLeadAccess(req.user, req.query.leadId); filter.leadId = req.query.leadId; }
  if (isSet(req.query.status)) filter.status = req.query.status;
  applyDateRange(filter, req.query, 'createdAt');
  await applyLeadIdScope(filter, req.user, 'leadId');
  const items = await Quote.find(filter).populate('leadId', 'name businessName phone callPhone whatsappPhone').populate('createdBy', 'name').sort({ createdAt: -1 }).limit(limit);
  res.json({ items });
});

export const createLeadQuote = asyncHandler(async (req, res) => {
  await assertLeadAccess(req.user, req.params.leadId);
  const quote = await createQuote({ leadId: req.params.leadId, userId: req.user._id, payload: req.body || {} });
  res.status(201).json({ quote });
});

export const revise = asyncHandler(async (req, res) => {
  await assertQuoteAccess(req.user, req.params.id);
  const quote = await reviseQuote({ quoteId: req.params.id, userId: req.user._id, payload: req.body || {} });
  res.status(201).json({ quote });
});

export const updateStatus = asyncHandler(async (req, res) => {
  const body = req.body || {};
  await assertQuoteAccess(req.user, req.params.id);
  const quote = await updateQuoteStatus({ quoteId: req.params.id, userId: req.user._id, status: body.status, note: body.note, fileUrl: body.fileUrl });
  res.json({ quote });
});
