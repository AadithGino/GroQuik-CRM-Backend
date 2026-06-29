import { ROLES } from '../constants/crm.constants.js';
import { ApiError } from './apiError.js';
import { Lead } from '../models/lead.model.js';
import { User } from '../models/user.model.js';
import { Task } from '../models/task.model.js';
import { Meeting } from '../models/meeting.model.js';
import { Mockup } from '../models/mockup.model.js';
import { Quote } from '../models/quote.model.js';
import { Payment } from '../models/payment.model.js';
import { Project } from '../models/project.model.js';

export function isAdmin(user) {
  return user?.role === ROLES.ADMIN;
}

export function isManager(user) {
  return user?.role === ROLES.MANAGER;
}

export function isSales(user) {
  return user?.role === ROLES.SALES;
}

export function isDeveloper(user) {
  return user?.role === ROLES.DEVELOPER;
}

export function isAdminLike(user) {
  return [ROLES.ADMIN, ROLES.MANAGER].includes(user?.role);
}

export function requireAdminLike(user) {
  return isAdminLike(user);
}

const permissionScopeCache = new Map();
const PERMISSION_SCOPE_TTL_MS = 30_000;

function cachedScope(key) {
  const hit = permissionScopeCache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit.value;
}

function setCachedScope(key, value) {
  permissionScopeCache.set(key, { value, expiresAt: Date.now() + PERMISSION_SCOPE_TTL_MS });
  return value;
}

export async function managedUserIds(user) {
  if (isAdmin(user)) return null;
  const key = `managed:${user._id}:${user.role}`;
  const cached = cachedScope(key);
  if (cached) return cached;
  if (isManager(user)) {
    const ids = await User.find({ managerId: user._id, isActive: true }).distinct('_id');
    return setCachedScope(key, [user._id, ...ids]);
  }
  return setCachedScope(key, [user._id]);
}

export async function leadScopeFilter(user) {
  if (isAdmin(user)) return {};
  if (isDeveloper(user)) {
    const [mockupLeadIds, projectLeadIds] = await Promise.all([
      Mockup.find({ assignedTo: user._id }).distinct('leadId'),
      Project.find({ assignedDeveloper: user._id }).distinct('leadId'),
    ]);
    return { _id: { $in: [...mockupLeadIds, ...projectLeadIds] } };
  }
  const ids = await managedUserIds(user);
  return { assignedTo: { $in: ids } };
}

export async function accessibleLeadIds(user) {
  if (isAdmin(user)) return null;
  const key = `leadIds:${user._id}:${user.role}`;
  const cached = cachedScope(key);
  if (cached) return cached;
  const filter = await leadScopeFilter(user);
  const ids = await Lead.find(filter).distinct('_id');
  return setCachedScope(key, ids);
}

function asString(value) {
  return value?._id ? value._id.toString() : value?.toString?.();
}

export function restrictFieldToIds(filter, field, allowedIds) {
  if (!allowedIds) return filter;
  const allowed = new Set(allowedIds.map((id) => id.toString()));
  const existing = filter[field];
  if (existing) {
    if (typeof existing === 'object' && existing.$in) {
      filter[field] = { $in: existing.$in.filter((id) => allowed.has(id.toString())) };
    } else if (!allowed.has(existing.toString())) {
      filter[field] = { $in: [] };
    }
  } else {
    filter[field] = { $in: allowedIds };
  }
  return filter;
}

export async function applyAssignedUserScope(filter, user, field = 'assignedTo') {
  if (isAdmin(user)) return filter;
  const ids = await managedUserIds(user);
  return restrictFieldToIds(filter, field, ids);
}

export async function applyLeadIdScope(filter, user, field = 'leadId') {
  const ids = await accessibleLeadIds(user);
  return restrictFieldToIds(filter, field, ids);
}

export async function assertLeadAccess(user, leadOrId) {
  const lead = leadOrId?.assignedTo ? leadOrId : await Lead.findById(leadOrId);
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (isAdmin(user)) return lead;

  if (isManager(user)) {
    const ids = await managedUserIds(user);
    const allowed = new Set(ids.map((id) => id.toString()));
    if (allowed.has(asString(lead.assignedTo))) return lead;
  }

  if (isSales(user) && asString(lead.assignedTo) === asString(user._id)) return lead;

  if (isDeveloper(user)) {
    const [mockup, project] = await Promise.all([
      Mockup.exists({ leadId: lead._id, assignedTo: user._id }),
      Project.exists({ leadId: lead._id, assignedDeveloper: user._id }),
    ]);
    if (mockup || project) return lead;
  }

  throw new ApiError(403, 'You do not have access to this lead');
}

export async function assertTaskAccess(user, taskOrId) {
  const task = taskOrId?.assignedTo ? taskOrId : await Task.findById(taskOrId);
  if (!task) throw new ApiError(404, 'Task not found');
  if (isAdmin(user)) return task;
  const ids = await managedUserIds(user);
  const allowed = new Set(ids.map((id) => id.toString()));
  if (allowed.has(asString(task.assignedTo))) return task;
  if (task.leadId) await assertLeadAccess(user, task.leadId);
  return task;
}

export async function assertMeetingAccess(user, meetingOrId) {
  const meeting = meetingOrId?.assignedTo ? meetingOrId : await Meeting.findById(meetingOrId);
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  if (isAdmin(user)) return meeting;
  const ids = await managedUserIds(user);
  const allowed = new Set(ids.map((id) => id.toString()));
  if (allowed.has(asString(meeting.assignedTo))) return meeting;
  await assertLeadAccess(user, meeting.leadId);
  return meeting;
}

export async function assertMockupAccess(user, mockupOrId) {
  const mockup = mockupOrId?.leadId ? mockupOrId : await Mockup.findById(mockupOrId);
  if (!mockup) throw new ApiError(404, 'Mockup not found');
  if (isAdmin(user)) return mockup;
  if (isDeveloper(user) && asString(mockup.assignedTo) === asString(user._id)) return mockup;
  await assertLeadAccess(user, mockup.leadId);
  return mockup;
}

export async function assertQuoteAccess(user, quoteOrId) {
  const quote = quoteOrId?.leadId ? quoteOrId : await Quote.findById(quoteOrId);
  if (!quote) throw new ApiError(404, 'Quote not found');
  await assertLeadAccess(user, quote.leadId);
  return quote;
}

export async function assertPaymentAccess(user, paymentOrId) {
  const payment = paymentOrId?.leadId ? paymentOrId : await Payment.findById(paymentOrId);
  if (!payment) throw new ApiError(404, 'Payment not found');
  await assertLeadAccess(user, payment.leadId);
  return payment;
}

export async function assertProjectAccess(user, projectOrId) {
  const project = projectOrId?.leadId ? projectOrId : await Project.findById(projectOrId);
  if (!project) throw new ApiError(404, 'Project not found');
  if (isAdmin(user)) return project;
  if (isDeveloper(user) && asString(project.assignedDeveloper) === asString(user._id)) return project;
  await assertLeadAccess(user, project.leadId);
  return project;
}
