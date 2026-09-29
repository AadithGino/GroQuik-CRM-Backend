import { Client } from '../models/client.model.js';
import { Lead } from '../models/lead.model.js';
import { Quote } from '../models/quote.model.js';
import { Payment } from '../models/payment.model.js';
import { ACTIVITY_TYPE, CLIENT_BUSINESS_TYPE, CLIENT_STATUS, LEAD_STATUS, QUOTE_STATUS } from '../constants/crm.constants.js';
import { addActivity } from './activity.service.js';
import { ApiError } from '../utils/apiError.js';
import { parseAppDateTime } from '../utils/time.js';
import { createPresignedDownload } from './s3.service.js';
import { env } from '../config/env.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asDate(value) {
  if (!value) return undefined;
  return parseAppDateTime(value) || new Date(value);
}

function requireEmail(email) {
  const cleaned = String(email || '').trim().toLowerCase();
  if (!cleaned || !EMAIL_RE.test(cleaned)) throw new ApiError(400, 'A valid client email is required.');
  return cleaned;
}

function requireBusinessType(value) {
  if (!value || !Object.values(CLIENT_BUSINESS_TYPE).includes(value)) {
    throw new ApiError(400, 'Select business type (sole prop, partnership, Pvt Ltd, LLP, etc.).');
  }
  return value;
}

function fileRefFromPayload(file, userId) {
  if (!file?.fileUrl) return undefined;
  return {
    fileUrl: file.fileUrl,
    fileName: file.fileName || undefined,
    contentType: file.contentType || undefined,
    key: file.key || undefined,
    uploadedAt: new Date(),
    uploadedBy: userId,
  };
}

function mapDocuments(documents, userId) {
  if (!Array.isArray(documents)) return [];
  return documents
    .map((doc) => {
      const label = String(doc?.label || '').trim();
      const file = fileRefFromPayload(doc.file || doc, userId);
      if (!label || !file) return null;
      return { label, file, createdBy: userId };
    })
    .filter(Boolean);
}

function pushHistory(client, { userId, note, changes }) {
  client.updateHistory.unshift({
    note: note || 'Client updated',
    changes: changes || {},
    changedBy: userId,
    changedAt: new Date(),
  });
  if (client.updateHistory.length > 200) client.updateHistory = client.updateHistory.slice(0, 200);
  client.lastUpdateDate = new Date();
}

function syncFirstPaymentDate(client) {
  if (!client.payments?.length) return;
  const earliest = client.payments
    .map((p) => new Date(p.paymentDate).getTime())
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)[0];
  if (earliest && !client.firstPaymentDate) client.firstPaymentDate = new Date(earliest);
}

function absoluteFileUrl(fileUrl) {
  if (!fileUrl) return null;
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  const base = String(env.PUBLIC_API_URL || env.CLIENT_URL || '').replace(/\/$/, '');
  if (!base) return fileUrl;
  return `${base}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
}

function collectClientFileEntries(client) {
  const files = [];
  const push = (label, file, category) => {
    if (!file?.fileUrl && !file?.key) return;
    files.push({
      label,
      category,
      fileName: file.fileName || label,
      fileUrl: file.fileUrl,
      key: file.key || null,
      contentType: file.contentType || null,
    });
  };

  push('Quotation', client.quotation, 'quotation');
  push('Agreement', client.agreement, 'agreement');
  for (const doc of client.documents || []) {
    push(doc.label || 'Document', doc.file, 'document');
  }
  (client.payments || []).forEach((payment, index) => {
    const tag = `Payment ${index + 1} (₹${Number(payment.amount || 0).toLocaleString('en-IN')})`;
    push(`${tag} — screenshot`, payment.screenshot, 'payment-screenshot');
    push(`${tag} — receipt`, payment.receipt, 'payment-receipt');
  });
  return files;
}

export async function listClients({ filter = {}, limit = 100 } = {}) {
  return Client.find(filter)
    .populate('leadId', 'name businessName phone callPhone whatsappPhone status')
    .populate('assignedTo', 'name email')
    .sort({ lastUpdateDate: -1, createdAt: -1 })
    .limit(limit);
}

export async function getClientById(clientId) {
  return Client.findById(clientId)
    .populate('leadId', 'name businessName phone callPhone whatsappPhone status')
    .populate('assignedTo', 'name email')
    .populate('updateHistory.changedBy', 'name')
    .populate('payments.createdBy', 'name')
    .populate('documents.createdBy', 'name');
}

export async function createClient({ userId, payload }) {
  if (!payload?.name?.trim()) throw new ApiError(400, 'Client name is required.');
  const email = requireEmail(payload.email);
  const businessType = requireBusinessType(payload.businessType);
  const assignedTo = payload.assignedTo || userId;
  const payments = Array.isArray(payload.payments)
    ? payload.payments.map((payment) => ({
      amount: Number(payment.amount),
      paymentDate: asDate(payment.paymentDate) || new Date(),
      paymentMode: payment.paymentMode,
      note: payment.note,
      screenshot: fileRefFromPayload(payment.screenshot, userId),
      receipt: fileRefFromPayload(payment.receipt, userId),
      createdBy: userId,
    })).filter((p) => p.amount > 0)
    : [];

  const client = await Client.create({
    assignedTo,
    name: payload.name.trim(),
    businessName: payload.businessName,
    businessType,
    phone: payload.phone,
    email,
    place: payload.place,
    status: payload.status || CLIENT_STATUS.ACTIVE,
    onboardedDate: asDate(payload.onboardedDate) || new Date(),
    firstPaymentDate: asDate(payload.firstPaymentDate),
    totalAmount: Number(payload.totalAmount || 0),
    projectDeliveryDate: asDate(payload.projectDeliveryDate),
    lastUpdateDate: new Date(),
    quotation: fileRefFromPayload(payload.quotation, userId),
    agreement: fileRefFromPayload(payload.agreement, userId),
    documents: mapDocuments(payload.documents, userId),
    payments,
    notes: payload.notes,
    internalNotes: payload.internalNotes,
    updateHistory: [{
      note: 'Client created',
      changes: { source: 'manual', businessType },
      changedBy: userId,
      changedAt: new Date(),
    }],
  });

  syncFirstPaymentDate(client);
  await client.save();
  return getClientById(client._id);
}

export async function convertLeadToClient({ leadId, userId, payload = {} }) {
  const existing = await Client.findOne({ leadId });
  if (existing) return getClientById(existing._id);

  const lead = await Lead.findById(leadId);
  if (!lead) throw new ApiError(404, 'Lead not found');

  const email = requireEmail(payload.email);
  const businessType = requireBusinessType(payload.businessType);

  const quote = payload.quoteId
    ? await Quote.findById(payload.quoteId)
    : await Quote.findOne({ leadId, status: { $in: [QUOTE_STATUS.ACCEPTED, QUOTE_STATUS.SENT, QUOTE_STATUS.REVISED_SENT] } }).sort({ revisionNumber: -1, createdAt: -1 });

  const leadPayments = await Payment.find({ leadId }).sort({ paymentDate: 1 });
  const mappedPayments = leadPayments.map((payment) => ({
    amount: payment.amount,
    paymentDate: payment.paymentDate,
    paymentMode: payment.paymentMode,
    note: payment.note || payment.receiptNumber || 'Imported from lead payment',
    receipt: payment.receiptUrl ? { fileUrl: payment.receiptUrl, fileName: 'lead-receipt', uploadedAt: payment.createdAt, uploadedBy: userId } : undefined,
    createdBy: payment.receivedBy || userId,
  }));

  if (Array.isArray(payload.payments)) {
    for (const payment of payload.payments) {
      if (!payment?.amount) continue;
      mappedPayments.push({
        amount: Number(payment.amount),
        paymentDate: asDate(payment.paymentDate) || new Date(),
        paymentMode: payment.paymentMode,
        note: payment.note,
        screenshot: fileRefFromPayload(payment.screenshot, userId),
        receipt: fileRefFromPayload(payment.receipt, userId),
        createdBy: userId,
      });
    }
  }

  const totalFromQuote = quote?.finalAmount;
  const client = await Client.create({
    leadId: lead._id,
    assignedTo: payload.assignedTo || lead.assignedTo || userId,
    name: payload.name || lead.name || lead.businessName || 'Client',
    businessName: payload.businessName || lead.businessName,
    businessType,
    phone: payload.phone || lead.callPhone || lead.phone || lead.whatsappPhone,
    email,
    place: payload.place || lead.place,
    status: payload.status || CLIENT_STATUS.ACTIVE,
    onboardedDate: asDate(payload.onboardedDate) || new Date(),
    firstPaymentDate: asDate(payload.firstPaymentDate) || mappedPayments[0]?.paymentDate,
    totalAmount: Number(payload.totalAmount ?? totalFromQuote ?? 0),
    projectDeliveryDate: asDate(payload.projectDeliveryDate),
    lastUpdateDate: new Date(),
    quotation: fileRefFromPayload(payload.quotation, userId) || (quote?.fileUrl ? {
      fileUrl: quote.fileUrl,
      fileName: 'lead-quote',
      uploadedAt: quote.updatedAt || quote.createdAt,
      uploadedBy: userId,
    } : undefined),
    agreement: fileRefFromPayload(payload.agreement, userId),
    documents: mapDocuments(payload.documents, userId),
    payments: mappedPayments,
    notes: payload.notes,
    internalNotes: payload.internalNotes,
    updateHistory: [{
      note: 'Converted from lead',
      changes: { leadId: String(lead._id), quoteId: quote?._id ? String(quote._id) : undefined, businessType },
      changedBy: userId,
      changedAt: new Date(),
    }],
  });

  syncFirstPaymentDate(client);
  await client.save();

  lead.status = LEAD_STATUS.CLIENT;
  lead.clientId = client._id;
  await lead.save();

  await addActivity({
    leadId: lead._id,
    userId,
    type: ACTIVITY_TYPE.CLIENT_CREATED,
    title: 'Lead converted to client',
    description: payload.notes || payload.internalNotes,
    metadata: { clientId: client._id, businessType },
  });

  return getClientById(client._id);
}

export async function updateClient({ clientId, userId, payload }) {
  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, 'Client not found');

  const changes = {};
  const scalarFields = ['name', 'businessName', 'phone', 'place', 'status', 'notes', 'internalNotes', 'assignedTo'];
  for (const field of scalarFields) {
    if (payload[field] !== undefined && payload[field] !== client[field]) {
      changes[field] = { from: client[field], to: payload[field] };
      client[field] = payload[field];
    }
  }

  if (payload.email !== undefined) {
    const email = requireEmail(payload.email);
    if (email !== client.email) {
      changes.email = { from: client.email, to: email };
      client.email = email;
    }
  }
  if (payload.businessType !== undefined) {
    const businessType = requireBusinessType(payload.businessType);
    if (businessType !== client.businessType) {
      changes.businessType = { from: client.businessType, to: businessType };
      client.businessType = businessType;
    }
  }

  if (payload.totalAmount !== undefined) {
    changes.totalAmount = { from: client.totalAmount, to: Number(payload.totalAmount) };
    client.totalAmount = Number(payload.totalAmount);
  }
  if (payload.onboardedDate !== undefined) {
    client.onboardedDate = asDate(payload.onboardedDate);
    changes.onboardedDate = client.onboardedDate;
  }
  if (payload.firstPaymentDate !== undefined) {
    client.firstPaymentDate = asDate(payload.firstPaymentDate);
    changes.firstPaymentDate = client.firstPaymentDate;
  }
  if (payload.projectDeliveryDate !== undefined) {
    client.projectDeliveryDate = asDate(payload.projectDeliveryDate);
    changes.projectDeliveryDate = client.projectDeliveryDate;
  }
  if (payload.quotation?.fileUrl) {
    client.quotation = fileRefFromPayload(payload.quotation, userId);
    changes.quotation = client.quotation?.fileUrl;
  }
  if (payload.agreement?.fileUrl) {
    client.agreement = fileRefFromPayload(payload.agreement, userId);
    changes.agreement = client.agreement?.fileUrl;
  }
  if (Array.isArray(payload.documentsAppend) && payload.documentsAppend.length) {
    const added = mapDocuments(payload.documentsAppend, userId);
    client.documents.push(...added);
    changes.documentsAdded = added.map((d) => d.label);
  }

  pushHistory(client, {
    userId,
    note: payload.updateNote || 'Client details updated',
    changes,
  });

  await client.save();

  if (client.leadId) {
    await addActivity({
      leadId: client.leadId,
      userId,
      type: ACTIVITY_TYPE.CLIENT_UPDATED,
      title: 'Client updated',
      description: payload.updateNote || payload.notes,
      metadata: { clientId: client._id, changes },
    });
  }

  return getClientById(client._id);
}

export async function addClientPayment({ clientId, userId, payload }) {
  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, 'Client not found');
  const amount = Number(payload.amount);
  if (!(amount > 0)) throw new ApiError(400, 'Payment amount must be greater than 0.');

  const payment = {
    amount,
    paymentDate: asDate(payload.paymentDate) || new Date(),
    paymentMode: payload.paymentMode,
    note: payload.note,
    screenshot: fileRefFromPayload(payload.screenshot, userId),
    receipt: fileRefFromPayload(payload.receipt, userId),
    createdBy: userId,
  };

  client.payments.push(payment);
  syncFirstPaymentDate(client);
  pushHistory(client, {
    userId,
    note: payload.note || `Payment of ₹${amount.toLocaleString('en-IN')} recorded`,
    changes: { paymentAdded: { amount, paymentDate: payment.paymentDate } },
  });
  await client.save();

  if (client.leadId) {
    await addActivity({
      leadId: client.leadId,
      userId,
      type: ACTIVITY_TYPE.CLIENT_PAYMENT_ADDED,
      title: `Client payment ₹${amount.toLocaleString('en-IN')}`,
      description: payload.note,
      metadata: { clientId: client._id, amount },
    });
  }

  return getClientById(client._id);
}

export async function addClientDocument({ clientId, userId, payload }) {
  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, 'Client not found');
  const label = String(payload?.label || '').trim();
  const file = fileRefFromPayload(payload?.file, userId);
  if (!label) throw new ApiError(400, 'Document name/label is required.');
  if (!file) throw new ApiError(400, 'Upload a document file first.');

  client.documents.push({ label, file, createdBy: userId });
  pushHistory(client, {
    userId,
    note: `Document added: ${label}`,
    changes: { documentAdded: label },
  });
  await client.save();
  return getClientById(client._id);
}

export async function listClientDownloadableFiles(clientId) {
  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, 'Client not found');

  const entries = collectClientFileEntries(client);
  const files = [];
  for (const entry of entries) {
    if (entry.key) {
      const signed = await createPresignedDownload(entry.key, {
        fileName: entry.fileName,
        download: true,
      });
      files.push({ ...entry, url: signed.url, downloadable: true });
    } else {
      files.push({
        ...entry,
        url: absoluteFileUrl(entry.fileUrl),
        downloadable: Boolean(entry.fileUrl),
      });
    }
  }
  return files;
}
