import mongoose from 'mongoose';
import { PROJECT_STATUS, REQUIREMENT } from '../constants/crm.constants.js';

const checklistSchema = new mongoose.Schema(
  {
    requirementConfirmed: { type: Boolean, default: false },
    quoteAccepted: { type: Boolean, default: false },
    advanceReceived: { type: Boolean, default: false },
    clientAssetsCollected: { type: Boolean, default: false },
    domainDetailsCollected: { type: Boolean, default: false },
    deliveryOwnerAssigned: { type: Boolean, default: false },
    expectedDeliveryDateSet: { type: Boolean, default: false },
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, unique: true, index: true },
    quoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    clientName: { type: String },
    businessName: { type: String },
    products: [{ type: String }],
    deliverables: [{ type: String }],
    finalQuoteValue: { type: Number, default: 0 },
    paymentReceived: { type: Number, default: 0 },
    paymentPending: { type: Number, default: 0 },
    assignedDeveloper: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    expectedDeliveryDate: { type: Date },
    status: { type: String, enum: Object.values(PROJECT_STATUS), default: PROJECT_STATUS.REQUIREMENT_PENDING, index: true },
    handoffChecklist: { type: checklistSchema, default: () => ({}) },
    requirementSummary: { type: String },
    internalNotes: { type: String },
  },
  { timestamps: true }
);

export const Project = mongoose.model('Project', projectSchema);
