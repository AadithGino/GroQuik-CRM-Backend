import mongoose from 'mongoose';
import { TASK_STATUS, TASK_TYPE } from '../constants/crm.constants.js';

const taskSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(TASK_TYPE), required: true, index: true },
    title: { type: String, required: true },
    description: { type: String },
    dueAt: { type: Date, required: true, index: true },
    status: { type: String, enum: Object.values(TASK_STATUS), default: TASK_STATUS.PENDING, index: true },
    priority: { type: Number, default: 3, min: 1, max: 5 },
    customerAttempt: { type: Boolean, default: false },
    internalMiss: { type: Boolean, default: false },
    completedAt: { type: Date },
    notDoneReason: { type: String },
    rescheduledFrom: { type: Date },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

taskSchema.index({ assignedTo: 1, status: 1, dueAt: 1 });
taskSchema.index({ leadId: 1, status: 1 });
taskSchema.index({ leadId: 1, status: 1, dueAt: 1 });
taskSchema.index({ meetingId: 1, status: 1, dueAt: 1 });
taskSchema.index({ type: 1, status: 1, dueAt: 1 });

export const Task = mongoose.model('Task', taskSchema);
