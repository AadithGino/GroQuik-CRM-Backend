import mongoose from 'mongoose';
import { MEETING_MODE, MEETING_STATUS, MEETING_TYPE, REQUIREMENT } from '../constants/crm.constants.js';

const meetingSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(MEETING_TYPE), required: true },
    mode: { type: String, enum: Object.values(MEETING_MODE), required: true },
    status: { type: String, enum: Object.values(MEETING_STATUS), default: MEETING_STATUS.TIME_PENDING, index: true },
    topicRequirements: [{ type: String }],
    note: { type: String },
    location: { type: String },
    meetingAt: { type: Date, index: true },
    dateOnly: { type: Date },
    timeConfirmed: { type: Boolean, default: false },
    resultNote: { type: String },
    resultMarkedAt: { type: Date },
    rescheduleReason: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

meetingSchema.index({ assignedTo: 1, status: 1, meetingAt: 1 });

export const Meeting = mongoose.model('Meeting', meetingSchema);
