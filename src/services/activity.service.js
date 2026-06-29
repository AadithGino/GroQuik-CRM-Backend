import { Activity } from '../models/activity.model.js';
import { Lead } from '../models/lead.model.js';

export async function addActivity({ leadId, userId, type, title, description, metadata }) {
  const activity = await Activity.create({ leadId, userId, type, title, description, metadata });
  if (leadId) await Lead.findByIdAndUpdate(leadId, { lastActivityAt: new Date() });
  return activity;
}
