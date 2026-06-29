import mongoose from 'mongoose';
import { PAYMENT_MODE, PAYMENT_TYPE } from '../constants/crm.constants.js';

const paymentSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    quoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentType: { type: String, enum: Object.values(PAYMENT_TYPE), default: PAYMENT_TYPE.ADVANCE, index: true },
    paymentMode: { type: String, enum: Object.values(PAYMENT_MODE), default: PAYMENT_MODE.UPI },
    paymentDate: { type: Date, default: Date.now, index: true },
    receiptNumber: { type: String },
    receiptUrl: { type: String },
    note: { type: String },
  },
  { timestamps: true }
);

paymentSchema.index({ leadId: 1, paymentDate: -1 });

export const Payment = mongoose.model('Payment', paymentSchema);
