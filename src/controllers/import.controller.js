import xlsx from 'xlsx';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ImportBatch } from '../models/importBatch.model.js';
import { Lead } from '../models/lead.model.js';
import { normalizePhone } from '../utils/phone.js';
import { resolveAssignee } from '../services/assignment.service.js';
import { createInitialLeadTasks } from '../services/leadAutomation.service.js';
import { addActivity } from '../services/activity.service.js';
import { ACTIVITY_TYPE, LEAD_TAG } from '../constants/crm.constants.js';
import { applyDateRange } from '../utils/queryFilters.js';
import { parsePagination } from '../utils/pagination.js';

const FIELD_ALIASES = {
  name: ['name', 'full name', 'customer name', 'client name'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'contact', 'number'],
  callPhone: ['call phone', 'call number', 'calling number', 'phone for call'],
  whatsappPhone: ['whatsapp', 'whatsapp phone', 'whatsapp number', 'wa number'],
  businessName: ['business name', 'company', 'company name', 'shop', 'shop name', 'jewellery name'],
  place: ['place', 'location', 'city', 'district'],
  status: ['status', 'lead status'],
  note: ['note', 'notes', 'remarks', 'last update'],
};

function pick(row, field) {
  const aliases = FIELD_ALIASES[field];
  const key = Object.keys(row).find((k) => aliases.includes(String(k).toLowerCase().trim()));
  return key ? row[key] : undefined;
}

export const importExcel = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Excel file required' });
  const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
  const previewOnly = req.body.preview === 'true' || req.body.preview === true;
  const batch = previewOnly ? null : await ImportBatch.create({ uploadedBy: req.user._id, filename: req.file.originalname, sourceTag: req.body.sourceTag || 'Excel Import' });
  const previewRows = [];
  let totalRows = 0;
  let createdLeads = 0;
  let updatedLeads = 0;
  let invalidRows = 0;
  const errors = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    for (let i = 0; i < rows.length; i += 1) {
      totalRows += 1;
      const row = rows[i];
      const phone = normalizePhone(pick(row, 'phone'));
      const callPhone = normalizePhone(pick(row, 'callPhone')) || phone;
      const whatsappPhone = normalizePhone(pick(row, 'whatsappPhone')) || phone;
      if (!phone) {
        invalidRows += 1;
        errors.push({ row: i + 2, reason: `Missing phone in sheet ${sheetName}` });
        continue;
      }
      const data = {
        name: pick(row, 'name'),
        phone,
        callPhone,
        whatsappPhone,
        businessName: pick(row, 'businessName'),
        place: pick(row, 'place'),
        source: req.body.sourceTag || `Imported: ${sheetName}`,
        ...(batch ? { importedBatchId: batch._id } : {}),
        tags: [LEAD_TAG.IMPORTED],
      };
      let lead = await Lead.findOne({ phone });
      if (lead) {
        updatedLeads += 1;
        if (previewOnly) {
          if (previewRows.length < 50) previewRows.push({ row: i + 2, sheetName, action: 'ADD_ACTIVITY_TO_EXISTING_LEAD', existingLeadId: lead._id, phone, name: data.name, businessName: data.businessName });
          continue;
        }
        await addActivity({ leadId: lead._id, userId: req.user._id, type: ACTIVITY_TYPE.EXCEL_IMPORTED, title: 'Excel row added to existing lead', description: pick(row, 'note'), metadata: { sheetName, row } });
        continue;
      }
      createdLeads += 1;
      if (previewOnly) {
        if (previewRows.length < 50) previewRows.push({ row: i + 2, sheetName, action: 'CREATE_NEW_LEAD', phone, name: data.name, businessName: data.businessName });
        continue;
      }
      const assignedTo = await resolveAssignee({ currentUser: req.user, source: data.source });
      lead = await Lead.create({ ...data, assignedTo });
      await addActivity({ leadId: lead._id, userId: req.user._id, type: ACTIVITY_TYPE.LEAD_CREATED, title: 'Lead created', description: 'Created from Excel import.', metadata: { source: data.source, sheetName } });
      await addActivity({ leadId: lead._id, userId: req.user._id, type: ACTIVITY_TYPE.EXCEL_IMPORTED, title: 'Lead imported from Excel', description: pick(row, 'note'), metadata: { sheetName, row } });
      await createInitialLeadTasks(lead);
    }
  }

  if (previewOnly) return res.json({ preview: true, summary: { totalRows, createdLeads, updatedLeads, invalidRows }, rows: previewRows, errors });
  Object.assign(batch, { totalRows, createdLeads, updatedLeads, invalidRows, errors });
  await batch.save();
  res.status(201).json({ batch });
});

export const listImportBatches = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  applyDateRange(filter, req.query, 'createdAt');
  const items = await ImportBatch.find(filter).populate('uploadedBy', 'name').sort({ createdAt: -1 }).limit(limit);
  res.json({ items });
});
