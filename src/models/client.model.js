import mongoose from 'mongoose';
import { CLIENT_BUSINESS_TYPE, CLIENT_STATUS, PAYMENT_MODE } from '../constants/crm.constants.js';

const fileRefSchema = new mongoose.Schema(
  {
    fileUrl: { type: String, required: true },
    fileName: { type: String },
    contentType: { type: String },
    key: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const clientPaymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    paymentDate: { type: Date, required: true, index: true },
    paymentMode: { type: String, enum: Object.values(PAYMENT_MODE), default: PAYMENT_MODE.UPI },
    note: { type: String },
    screenshot: { type: fileRefSchema },
    receipt: { type: fileRefSchema },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const clientDocumentSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    file: { type: fileRefSchema, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const clientUpdateSchema = new mongoose.Schema(
  {
    note: { type: String },
    changes: { type: mongoose.Schema.Types.Mixed },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const clientSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', sparse: true, unique: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, trim: true, required: true },
    businessName: { type: String, trim: true },
    businessType: { type: String, enum: Object.values(CLIENT_BUSINESS_TYPE), required: true, index: true },
    phone: { type: String, trim: true, index: true },
    email: { type: String, trim: true, required: true, index: true },
    place: { type: String, trim: true },
    status: { type: String, enum: Object.values(CLIENT_STATUS), default: CLIENT_STATUS.ACTIVE, index: true },
    onboardedDate: { type: Date, index: true },
    firstPaymentDate: { type: Date },
    totalAmount: { type: Number, default: 0, min: 0 },
    projectDeliveryDate: { type: Date },
    lastUpdateDate: { type: Date, default: Date.now, index: true },
    quotation: { type: fileRefSchema },
    agreement: { type: fileRefSchema },
    documents: { type: [clientDocumentSchema], default: [] },
    payments: { type: [clientPaymentSchema], default: [] },
    updateHistory: { type: [clientUpdateSchema], default: [] },
    notes: { type: String },
    internalNotes: { type: String },
  },
  { timestamps: true }
);

clientSchema.virtual('paymentReceived').get(function paymentReceived() {
  return (this.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
});

clientSchema.virtual('paymentPending').get(function paymentPending() {
  return Math.max(Number(this.totalAmount || 0) - this.paymentReceived, 0);
});

clientSchema.set('toJSON', { virtuals: true });
clientSchema.set('toObject', { virtuals: true });

clientSchema.index({ businessName: 'text', name: 'text', phone: 'text', place: 'text', email: 'text' });
clientSchema.index({ assignedTo: 1, status: 1, lastUpdateDate: -1 });

export const Client = mongoose.model('Client', clientSchema);
