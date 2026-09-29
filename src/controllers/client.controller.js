import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CLIENT_BUSINESS_TYPE, CLIENT_STATUS, PAYMENT_MODE } from '../constants/crm.constants.js';
import {
  addClientDocument,
  addClientPayment,
  convertLeadToClient,
  createClient,
  getClientById,
  listClientDownloadableFiles,
  listClients,
  updateClient,
} from '../services/client.service.js';
import { applyAssignedUserScope, assertLeadAccess, isAdmin } from '../utils/permissions.js';
import { parsePagination } from '../utils/pagination.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { ApiError } from '../utils/apiError.js';
import { Client } from '../models/client.model.js';

const fileRefSchema = z.object({
  fileUrl: z.string().min(1),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
  key: z.string().optional(),
}).optional();

const documentInputSchema = z.object({
  label: z.string().min(1),
  file: z.object({
    fileUrl: z.string().min(1),
    fileName: z.string().optional(),
    contentType: z.string().optional(),
    key: z.string().optional(),
  }),
});

const paymentInputSchema = z.object({
  amount: z.number().positive(),
  paymentDate: z.string().optional(),
  paymentMode: z.nativeEnum(PAYMENT_MODE).optional(),
  note: z.string().optional(),
  screenshot: fileRefSchema,
  receipt: fileRefSchema,
});

const clientCreateSchema = z.object({
  name: z.string().min(1),
  businessName: z.string().optional(),
  businessType: z.nativeEnum(CLIENT_BUSINESS_TYPE),
  phone: z.string().optional(),
  email: z.string().email(),
  place: z.string().optional(),
  assignedTo: z.string().optional(),
  status: z.nativeEnum(CLIENT_STATUS).optional(),
  onboardedDate: z.string().optional(),
  firstPaymentDate: z.string().optional(),
  totalAmount: z.number().optional(),
  projectDeliveryDate: z.string().optional(),
  quotation: fileRefSchema,
  agreement: fileRefSchema,
  documents: z.array(documentInputSchema).optional(),
  payments: z.array(paymentInputSchema).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
});

async function assertClientAccess(user, clientId) {
  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, 'Client not found');
  if (isAdmin(user)) return client;
  if (client.leadId) {
    await assertLeadAccess(user, client.leadId);
    return client;
  }
  const scope = {};
  await applyAssignedUserScope(scope, user, 'assignedTo');
  const allowed = !scope.assignedTo || (
    scope.assignedTo.$in
      ? scope.assignedTo.$in.map(String).includes(String(client.assignedTo))
      : String(scope.assignedTo) === String(client.assignedTo)
  );
  if (!allowed && String(client.assignedTo) !== String(user._id)) {
    throw new ApiError(403, 'You do not have access to this client');
  }
  return client;
}

export const list = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
  const filter = {};
  if (isSet(req.query.status)) filter.status = req.query.status;
  if (isSet(req.query.businessType)) filter.businessType = req.query.businessType;
  if (req.query.leadId) {
    await assertLeadAccess(req.user, req.query.leadId);
    filter.leadId = req.query.leadId;
  }
  if (req.query.q) {
    const q = String(req.query.q).trim();
    if (q) {
      filter.$or = [
        { name: new RegExp(q, 'i') },
        { businessName: new RegExp(q, 'i') },
        { phone: new RegExp(q, 'i') },
        { place: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') },
      ];
    }
  }
  const dateField = ['onboardedDate', 'projectDeliveryDate', 'firstPaymentDate', 'lastUpdateDate', 'createdAt'].includes(req.query.dateField)
    ? req.query.dateField
    : 'lastUpdateDate';
  applyDateRange(filter, req.query, dateField);
  await applyAssignedUserScope(filter, req.user, 'assignedTo');
  const items = await listClients({ filter, limit });
  res.json({ items });
});

export const getOne = asyncHandler(async (req, res) => {
  await assertClientAccess(req.user, req.params.id);
  const client = await getClientById(req.params.id);
  res.json({ client });
});

export const create = asyncHandler(async (req, res) => {
  const payload = clientCreateSchema.parse(req.body || {});
  const client = await createClient({ userId: req.user._id, payload });
  res.status(201).json({ client });
});

export const convertFromLead = asyncHandler(async (req, res) => {
  await assertLeadAccess(req.user, req.params.leadId);
  const body = req.body || {};
  if (!body.email || !body.businessType) {
    throw new ApiError(400, 'Email and business type are required to convert a lead to a client.');
  }
  const client = await convertLeadToClient({
    leadId: req.params.leadId,
    userId: req.user._id,
    payload: body,
  });
  res.status(201).json({ client });
});

export const update = asyncHandler(async (req, res) => {
  await assertClientAccess(req.user, req.params.id);
  const client = await updateClient({
    clientId: req.params.id,
    userId: req.user._id,
    payload: req.body || {},
  });
  res.json({ client });
});

export const addPayment = asyncHandler(async (req, res) => {
  await assertClientAccess(req.user, req.params.id);
  const payload = paymentInputSchema.parse(req.body || {});
  const client = await addClientPayment({
    clientId: req.params.id,
    userId: req.user._id,
    payload,
  });
  res.status(201).json({ client });
});

export const addDocument = asyncHandler(async (req, res) => {
  await assertClientAccess(req.user, req.params.id);
  const payload = documentInputSchema.parse(req.body || {});
  const client = await addClientDocument({
    clientId: req.params.id,
    userId: req.user._id,
    payload,
  });
  res.status(201).json({ client });
});

export const listFiles = asyncHandler(async (req, res) => {
  await assertClientAccess(req.user, req.params.id);
  const files = await listClientDownloadableFiles(req.params.id);
  res.json({ files });
});
