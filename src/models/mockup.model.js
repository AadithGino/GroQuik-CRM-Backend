import mongoose from 'mongoose';
import { MOCKUP_STATUS, MOCKUP_TOPIC } from '../constants/crm.constants.js';

const mockupSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    topic: { type: String, enum: Object.values(MOCKUP_TOPIC), required: true },
    jewelleryThemeNotes: { type: String },
    logoReferenceAvailable: { type: Boolean, default: false },
    referenceLinks: [{ type: String }],
    pagesToShow: [{ type: String }],
    status: { type: String, enum: Object.values(MOCKUP_STATUS), default: MOCKUP_STATUS.NOT_STARTED, index: true },
    dueAt: { type: Date },
    sharedAt: { type: Date },
    clientFeedback: { type: String },
    fileUrls: [{ type: String }],
  },
  { timestamps: true }
);

export const Mockup = mongoose.model('Mockup', mockupSchema);
