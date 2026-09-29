/**
 * Export leads created before a cutoff date (default: 25 Sep 2026 IST) to CSV + Excel.
 *
 * Usage (from backend/):
 *   node scripts/exportLeadsBeforeDate.js
 *   node scripts/exportLeadsBeforeDate.js --before=2026-09-25
 *   node scripts/exportLeadsBeforeDate.js --before=2026-09-25 --out=./exports
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import xlsx from 'xlsx';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { Lead } from '../src/models/lead.model.js';
import '../src/models/user.model.js';
import { APP_TIMEZONE } from '../src/utils/time.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let before = '2026-09-25';
  let outDir = path.join(__dirname, '..', 'exports');
  for (const arg of argv) {
    if (arg.startsWith('--before=')) before = arg.slice('--before='.length);
    if (arg.startsWith('--out=')) outDir = path.resolve(arg.slice('--out='.length));
  }
  return { before, outDir };
}

function formatTs(value) {
  if (!value) return '';
  return dayjs(value).tz(APP_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
}

function leadToRow(lead) {
  const owner = lead.assignedTo;
  return {
    leadId: String(lead._id),
    createdAt: formatTs(lead.createdAt),
    updatedAt: formatTs(lead.updatedAt),
    name: lead.name || '',
    businessName: lead.businessName || '',
    phone: lead.phone || '',
    callPhone: lead.callPhone || '',
    whatsappPhone: lead.whatsappPhone || '',
    place: lead.place || '',
    status: lead.status || '',
    source: lead.source || '',
    campaignName: lead.campaignName || '',
    adName: lead.adName || '',
    formName: lead.formName || '',
    assignedToName: owner?.name || '',
    assignedToEmail: owner?.email || '',
    interestScore: lead.interestScore ?? '',
    requirements: (lead.requirements || []).join('; '),
    tags: (lead.tags || []).join('; '),
    failedCustomerAttempts: lead.failedCustomerAttempts ?? 0,
    lastActivityAt: formatTs(lead.lastActivityAt),
    nextActionAt: formatTs(lead.nextActionAt),
    nextActionLabel: lead.nextActionLabel || '',
    lostReason: lead.lostReason || '',
    invalidReason: lead.invalidReason || '',
    metaLeadId: lead.metaLeadId || '',
  };
}

function escapeCsvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvCell(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

const { before, outDir } = parseArgs(process.argv.slice(2));
const cutoff = dayjs.tz(before, APP_TIMEZONE).startOf('day').toDate();

await connectDb();

const leads = await Lead.find({ createdAt: { $lt: cutoff } })
  .populate('assignedTo', 'name email')
  .sort({ createdAt: -1 })
  .lean();

const rows = leads.map(leadToRow);
const stamp = dayjs().tz(APP_TIMEZONE).format('YYYY-MM-DD_HHmm');
const baseName = `leads-before-${before}_${stamp}`;

fs.mkdirSync(outDir, { recursive: true });

const csvPath = path.join(outDir, `${baseName}.csv`);
fs.writeFileSync(csvPath, rowsToCsv(rows), 'utf8');

const xlsxPath = path.join(outDir, `${baseName}.xlsx`);
const sheet = xlsx.utils.json_to_sheet(rows);
const workbook = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(workbook, sheet, 'Leads');
xlsx.writeFile(workbook, xlsxPath);

console.log(`Cutoff: createdAt < ${before} 00:00:00 ${APP_TIMEZONE} (${cutoff.toISOString()})`);
console.log(`Exported ${rows.length} lead(s)`);
console.log(`CSV:  ${csvPath}`);
console.log(`XLSX: ${xlsxPath}`);

await mongoose.connection.close();
process.exit(0);
