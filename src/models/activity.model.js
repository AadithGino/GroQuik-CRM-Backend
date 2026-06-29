import mongoose from 'mongoose';
import { ACTIVITY_TYPE } from '../constants/crm.constants.js';

const activitySchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: Object.values(ACTIVITY_TYPE), required: true },
    title: { type: String, required: true },
    description: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const Activity = mongoose.model('Activity', activitySchema);
