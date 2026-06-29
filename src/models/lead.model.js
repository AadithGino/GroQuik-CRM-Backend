import mongoose from 'mongoose';
import { LEAD_STATUS, REQUIREMENT, LEAD_TAG } from '../constants/crm.constants.js';

const contactNumberSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, trim: true },
    label: { type: String, default: 'Primary' },
    relation: { type: String },
    personName: { type: String },
    isPrimary: { type: Boolean, default: false },
    isDecisionMaker: { type: Boolean, default: false },
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, index: true, trim: true },
    callPhone: { type: String, trim: true, index: true },
    whatsappPhone: { type: String, trim: true, index: true },
    alternateNumbers: [contactNumberSchema],
    businessName: { type: String, trim: true },
    place: { type: String, trim: true },
    source: { type: String, default: 'MANUAL', index: true },
    campaignName: { type: String, index: true },
    adName: { type: String },
    formName: { type: String },
    metaLeadId: { type: String, index: true },
    metaCampaignId: { type: String },
    metaAdId: { type: String },
    metaFormId: { type: String },
    rawPayload: { type: mongoose.Schema.Types.Mixed },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: Object.values(LEAD_STATUS), default: LEAD_STATUS.NEW_LEAD, index: true },
    interestScore: { type: Number, min: 1, max: 10 },
    requirements: [{ type: String, enum: Object.values(REQUIREMENT) }],
    tags: [{ type: String, enum: Object.values(LEAD_TAG) }],
    failedCustomerAttempts: { type: Number, default: 0 },
    internalMissCount: { type: Number, default: 0 },
    lastActivityAt: { type: Date },
    nextActionAt: { type: Date, index: true },
    nextActionLabel: { type: String },
    lostReason: { type: String },
    invalidReason: { type: String },
    quoteStatus: { type: String },
    paymentStatus: { type: String },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    importedBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportBatch' },
  },
  { timestamps: true }
);

leadSchema.index({ phone: 1, status: 1 });
leadSchema.index({ callPhone: 1, status: 1 });
leadSchema.index({ whatsappPhone: 1, status: 1 });
leadSchema.index({ assignedTo: 1, status: 1, nextActionAt: 1 });
leadSchema.index({ source: 1, createdAt: -1 });
leadSchema.index({ businessName: 'text', name: 'text', phone: 'text', callPhone: 'text', whatsappPhone: 'text', place: 'text' });

export const Lead = mongoose.model('Lead', leadSchema);
