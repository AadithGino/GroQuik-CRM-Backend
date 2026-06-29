import mongoose from 'mongoose';
import { NOTIFICATION_TYPE } from '../constants/crm.constants.js';

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting' },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPE), required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    priority: { type: Number, default: 3, min: 1, max: 5 },
    readAt: { type: Date },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
