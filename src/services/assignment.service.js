import { User } from '../models/user.model.js';
import { AssignmentSetting } from '../models/assignmentSetting.model.js';
import { Lead } from '../models/lead.model.js';
import { ASSIGNMENT_MODE, ROLES, ACTIVITY_TYPE, NOTIFICATION_TYPE } from '../constants/crm.constants.js';
import { addActivity } from './activity.service.js';
import { createNotification, notifyAdmins } from './notification.service.js';

async function getSetting() {
  let setting = await AssignmentSetting.findOne({ singletonKey: 'default' });
  if (!setting) setting = await AssignmentSetting.create({ singletonKey: 'default', mode: ASSIGNMENT_MODE.ROUND_ROBIN });
  return setting;
}

async function firstActiveAdminOrUser(currentUser) {
  if (currentUser?._id) return currentUser._id;
  const admin = await User.findOne({ role: ROLES.ADMIN, isActive: true }).sort({ createdAt: 1 }).select('_id');
  return admin?._id;
}

async function pickRoundRobinAssignee(setting) {
  const salesQuery = { role: ROLES.SALES, isActive: true, acceptingLeads: true };
  if (setting.activeSalesUsers?.length) salesQuery._id = { $in: setting.activeSalesUsers };

  const users = await User.find(salesQuery).sort({ lastAssignedAt: 1, createdAt: 1 }).select('_id name email');
  const assignee = users[0]?._id;
  if (assignee) await User.findByIdAndUpdate(assignee, { lastAssignedAt: new Date() });
  return assignee;
}

export async function resolveAssignee({ requestedAssignee, currentUser, source, campaignName }) {
  if (requestedAssignee && [ROLES.ADMIN, ROLES.MANAGER].includes(currentUser?.role)) {
    const requested = await User.findOne({ _id: requestedAssignee, isActive: true }).select('_id acceptingLeads role');
    if (requested) return requested._id;
  }

  if (currentUser?.role === ROLES.SALES && currentUser.acceptingLeads !== false) return currentUser._id;

  const setting = await getSetting();

  if (setting.mode === ASSIGNMENT_MODE.MANUAL) {
    return firstActiveAdminOrUser(currentUser);
  }

  if (setting.mode === ASSIGNMENT_MODE.SOURCE_CAMPAIGN) {
    const rule = setting.sourceCampaignRules.find((item) => {
      const sourceOk = !item.source || item.source === source;
      const campaignOk = !item.campaignName || item.campaignName === campaignName;
      return sourceOk && campaignOk;
    });
    if (rule?.assignedTo) {
      const ruleUser = await User.findOne({ _id: rule.assignedTo, isActive: true, acceptingLeads: true }).select('_id');
      if (ruleUser) return ruleUser._id;
    }
  }

  const roundRobinUser = await pickRoundRobinAssignee(setting);
  return roundRobinUser || firstActiveAdminOrUser(currentUser);
}

export async function updateAssignmentSettings(payload) {
  return AssignmentSetting.findOneAndUpdate(
    { singletonKey: 'default' },
    { $set: { ...payload, singletonKey: 'default' } },
    { new: true, upsert: true }
  ).populate('activeSalesUsers', 'name email role acceptingLeads');
}

export async function reassignLead({ leadId, assignedTo, userId, note, actor }) {
  const assignee = await User.findOne({ _id: assignedTo, isActive: true }).select('_id name email role managerId');
  if (actor?.role === ROLES.MANAGER && String(assignee?.managerId || '') !== String(actor._id) && String(assignee?._id || '') !== String(actor._id)) return null;
  if (!assignee) return null;

  const lead = await Lead.findByIdAndUpdate(leadId, { assignedTo: assignee._id }, { new: true }).populate('assignedTo', 'name email role');
  if (!lead) return null;
  await addActivity({ leadId, userId, type: ACTIVITY_TYPE.LEAD_ASSIGNED, title: 'Lead reassigned', description: note, metadata: { assignedTo } });
  await createNotification({ userId: assignedTo, leadId, type: NOTIFICATION_TYPE.LEAD_REASSIGNED, title: 'Lead reassigned to you', message: `${lead.businessName || lead.name || lead.phone || 'Lead'} was assigned to you.`, priority: 4 });
  await notifyAdmins({ leadId, type: NOTIFICATION_TYPE.LEAD_REASSIGNED, title: 'Lead reassigned', message: `${lead.businessName || lead.name || lead.phone || 'Lead'} reassigned.`, priority: 3, metadata: { assignedTo } });
  return lead;
}
