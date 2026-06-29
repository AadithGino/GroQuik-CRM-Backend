
import { Mockup } from '../models/mockup.model.js';
import { Lead } from '../models/lead.model.js';
import { ACTIVITY_TYPE, LEAD_STATUS, MOCKUP_STATUS, NOTIFICATION_TYPE, TASK_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { addActivity } from './activity.service.js';
import { completeOpenTasksByMetadata, createTask } from './task.service.js';
import { notifyAssigneeAndAdmins } from './notification.service.js';
import { daysFromNowAtMorning, nextMorning, parseAppDateTime } from '../utils/time.js';
import { recomputeLeadNextAction } from './leadWorkflow.service.js';

export async function createMockup({ leadId, userId, payload }) {
  const lead = await Lead.findById(leadId);
  const mockup = await Mockup.create({ ...payload, dueAt: parseAppDateTime(payload.dueAt) || undefined, leadId, assignedTo: payload.assignedTo || lead.assignedTo });
  lead.status = LEAD_STATUS.MOCKUP_REQUIRED;
  await lead.save();
  await addActivity({ leadId, userId, type: ACTIVITY_TYPE.MOCKUP_CREATED, title: 'Mockup created', description: payload.jewelleryThemeNotes, metadata: { mockupId: mockup._id } });
  await createTask({ leadId, assignedTo: mockup.assignedTo, type: TASK_TYPE.CREATE_MOCKUP, title: 'Create product mockup', description: payload.jewelleryThemeNotes, dueAt: mockup.dueAt || nextMorning(), priority: 4, metadata: { mockupId: mockup._id, dedupeKey: `create-mockup:${mockup._id}` } });
  return mockup;
}

export async function updateMockup({ mockupId, userId, payload }) {
  const existing = await Mockup.findById(mockupId);
  if (!existing) return null;
  const previousStatus = existing.status;
  const patch = { ...payload };
  if (payload.dueAt) patch.dueAt = parseAppDateTime(payload.dueAt);
  if (payload.status === MOCKUP_STATUS.SHARED_WITH_CLIENT && previousStatus !== MOCKUP_STATUS.SHARED_WITH_CLIENT) patch.sharedAt = new Date();
  const mockup = await Mockup.findByIdAndUpdate(mockupId, patch, { new: true });

  const lead = await Lead.findById(mockup.leadId);
  const dueTomorrow = daysFromNowAtMorning(1);
  const statusChanged = Boolean(payload.status && payload.status !== previousStatus);

  if (statusChanged && payload.status === MOCKUP_STATUS.READY) {
    lead.status = LEAD_STATUS.MOCKUP_REQUIRED;
    await completeOpenTasksByMetadata({ leadId: mockup.leadId, type: TASK_TYPE.CREATE_MOCKUP, metadataKey: 'mockupId', metadataValue: mockup._id, userId, metadata: { mockupReady: true } });
    await createTask({ leadId: mockup.leadId, assignedTo: lead.assignedTo, type: TASK_TYPE.SHARE_MOCKUP, title: 'Share mockup with client', description: 'Mockup is ready but not shared. Share it and update status.', dueAt: new Date(), priority: 5, metadata: { mockupId: mockup._id, dedupeKey: `share-mockup:${mockup._id}` } });
    await notifyAssigneeAndAdmins({ assignedTo: lead.assignedTo, leadId: mockup.leadId, type: NOTIFICATION_TYPE.MOCKUP_READY, title: 'Mockup ready to share', message: 'Mockup is ready. Share it with the client and create the next follow-up.', priority: 4, metadata: { mockupId: mockup._id } });
  }

  if (statusChanged && payload.status === MOCKUP_STATUS.SHARED_WITH_CLIENT) {
    lead.status = LEAD_STATUS.MOCKUP_SHARED;
    await completeOpenTasksByMetadata({ leadId: mockup.leadId, type: TASK_TYPE.SHARE_MOCKUP, metadataKey: 'mockupId', metadataValue: mockup._id, userId, metadata: { mockupShared: true } });
    await createTask({ leadId: mockup.leadId, assignedTo: lead.assignedTo, type: TASK_TYPE.FOLLOW_UP_CALL, title: 'Follow up after mockup shared', description: 'Mockup shared. Ask feedback and move to quote/advance.', dueAt: dueTomorrow, priority: 5, metadata: { mockupId: mockup._id, dedupeKey: `mockup-follow-up:${mockup._id}` } });
  }

  if (statusChanged && payload.status === MOCKUP_STATUS.APPROVED) {
    lead.status = LEAD_STATUS.ADVANCE_PENDING;
    await createTask({ leadId: mockup.leadId, assignedTo: lead.assignedTo, type: TASK_TYPE.COLLECT_ADVANCE, title: 'Collect advance after mockup approval', description: 'Client approved mockup. Push quote/revised quote and collect advance.', dueAt: dueTomorrow, priority: 5, metadata: { mockupId: mockup._id, dedupeKey: `mockup-approved-advance:${mockup._id}` } });
  }

  if (statusChanged && payload.status === MOCKUP_STATUS.CHANGES_REQUESTED) {
    const dueAt = mockup.dueAt || dueTomorrow;
    lead.status = LEAD_STATUS.MOCKUP_REQUIRED;
    await createTask({ leadId: mockup.leadId, assignedTo: mockup.assignedTo || lead.assignedTo, type: TASK_TYPE.CREATE_MOCKUP, title: 'Revise mockup changes', description: payload.clientFeedback || 'Client requested changes in mockup.', dueAt, priority: 5, metadata: { mockupId: mockup._id, dedupeKey: `mockup-changes:${mockup._id}:${Number(new Date(dueAt))}` } });
  }

  if (lead) await lead.save();
  await addActivity({ leadId: mockup.leadId, userId, type: ACTIVITY_TYPE.MOCKUP_UPDATED, title: `Mockup updated: ${mockup.status}`, description: payload.clientFeedback, metadata: { mockupId: mockup._id, previousStatus } });
  await recomputeLeadNextAction(mockup.leadId);
  return mockup;
}
