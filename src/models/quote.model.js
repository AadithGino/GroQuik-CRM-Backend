import mongoose from 'mongoose';
import { GST_MODE, QUOTE_STATUS } from '../constants/crm.constants.js';

const quoteSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    parentQuoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    revisionNumber: { type: Number, default: 1 },
    requirementSummary: { type: String },
    deliverables: [{ type: String }],
    baseAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    finalAmount: { type: Number, required: true },
    gstMode: { type: String, enum: Object.values(GST_MODE), default: GST_MODE.INCLUDED },
    status: { type: String, enum: Object.values(QUOTE_STATUS), default: QUOTE_STATUS.DRAFT, index: true },
    sentAt: { type: Date },
    acceptedAt: { type: Date },
    rejectedAt: { type: Date },
    fileUrl: { type: String },
    note: { type: String },
  },
  { timestamps: true }
);

quoteSchema.index({ leadId: 1, revisionNumber: -1 });

export const Quote = mongoose.model('Quote', quoteSchema);
