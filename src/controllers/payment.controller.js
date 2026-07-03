import { z } from 'zod';
import { Payment } from '../models/payment.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PAYMENT_MODE, PAYMENT_TYPE } from '../constants/crm.constants.js';
import { recordPayment } from '../services/payment.service.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { applyLeadIdScope, assertLeadAccess } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';

const paymentSchema = z.object({
  quoteId: z.string().optional(),
  amount: z.number().positive(),
  paymentType: z.nativeEnum(PAYMENT_TYPE).optional(),
  paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
  paymentDate: z.string().optional(),
  receiptNumber: z.string().optional(),
  receiptUrl: z.string().optional(),
  note: z.string().optional(),
});

export const listPayments = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (req.query.leadId) { await assertLeadAccess(req.user, req.query.leadId); filter.leadId = req.query.leadId; }
  if (isSet(req.query.paymentType)) filter.paymentType = req.query.paymentType;
  if (isSet(req.query.paymentMode)) filter.paymentMode = req.query.paymentMode;
  applyDateRange(filter, req.query, 'paymentDate');
  await applyLeadIdScope(filter, req.user, 'leadId');
  const items = await Payment.find(filter).populate('leadId', 'name businessName phone callPhone whatsappPhone').populate('receivedBy', 'name').sort({ paymentDate: -1 }).limit(limit);
  res.json({ items });
});

export const createLeadPayment = asyncHandler(async (req, res) => {
  await assertLeadAccess(req.user, req.params.leadId);
  const result = await recordPayment({ leadId: req.params.leadId, userId: req.user._id, payload: req.body || {} });
  res.status(201).json(result);
});
