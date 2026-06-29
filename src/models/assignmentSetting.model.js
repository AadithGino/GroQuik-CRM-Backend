import mongoose from 'mongoose';
import { ASSIGNMENT_MODE } from '../constants/crm.constants.js';

const assignmentRuleSchema = new mongoose.Schema(
  {
    source: { type: String },
    campaignName: { type: String },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false }
);

const assignmentSettingSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: 'default', unique: true },
    mode: { type: String, enum: Object.values(ASSIGNMENT_MODE), default: ASSIGNMENT_MODE.ROUND_ROBIN },
    activeSalesUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    sourceCampaignRules: [assignmentRuleSchema],
    lastAssignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const AssignmentSetting = mongoose.model('AssignmentSetting', assignmentSettingSchema);
