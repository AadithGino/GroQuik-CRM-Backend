import { LEAD_STATUS, MEETING_STATUS, MOCKUP_STATUS, TASK_STATUS } from '../constants/crm.constants.js';
import { Lead } from '../models/lead.model.js';
import { Task } from '../models/task.model.js';
import { Meeting } from '../models/meeting.model.js';
import { Mockup } from '../models/mockup.model.js';
import { env } from '../config/env.js';

export const CLOSED_LEAD_STATUSES = new Set([
  LEAD_STATUS.WON,
  LEAD_STATUS.LOST,
  LEAD_STATUS.INVALID,
  LEAD_STATUS.COLD,
  LEAD_STATUS.NOT_REACHABLE,
  LEAD_STATUS.PROJECT_CREATED,
]);


const pendingNextActionRecomputes = new Map();

export function scheduleLeadNextActionRecompute(leadId) {
  if (!leadId) return;
  const key = leadId.toString();
  const existing = pendingNextActionRecomputes.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingNextActionRecomputes.delete(key);
    recomputeLeadNextAction(key).catch((error) => {
      console.error(`Failed to recompute next action for lead ${key}`, error);
    });
  }, env.NEXT_ACTION_RECOMPUTE_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingNextActionRecomputes.set(key, timer);
}

function asCandidate(at, label, weight = 3) {
  if (!at) return null;
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return null;
  return { at: time, label, weight };
}

export async function recomputeLeadNextAction(leadId) {
  if (!leadId) return null;
  const lead = await Lead.findById(leadId);
  if (!lead) return null;

  if (CLOSED_LEAD_STATUSES.has(lead.status)) {
    lead.nextActionAt = undefined;
    lead.nextActionLabel = undefined;
    await lead.save();
    return lead;
  }

  const [tasks, meetings, mockups] = await Promise.all([
    Task.find({ leadId, status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] } }).sort({ dueAt: 1, priority: -1 }).limit(20),
    Meeting.find({ leadId, status: { $in: [MEETING_STATUS.SCHEDULED, MEETING_STATUS.REMINDER_SENT, MEETING_STATUS.TIME_PENDING, MEETING_STATUS.RESCHEDULE_PENDING] } }).sort({ meetingAt: 1, updatedAt: -1 }).limit(20),
    Mockup.find({ leadId, status: { $nin: [MOCKUP_STATUS.APPROVED, MOCKUP_STATUS.REJECTED] }, dueAt: { $ne: null } }).sort({ dueAt: 1 }).limit(10),
  ]);

  const candidates = [];
  tasks.forEach((task) => {
    const priorityWeight = Number(task.priority || 3);
    candidates.push(asCandidate(task.dueAt, task.title, task.type === 'MEETING_REMINDER' ? 6 : priorityWeight));
  });
  meetings.forEach((meeting) => {
    if (meeting.status === MEETING_STATUS.TIME_PENDING || meeting.status === MEETING_STATUS.RESCHEDULE_PENDING) return;
    candidates.push(asCandidate(meeting.meetingAt, 'Meeting scheduled', 7));
  });
  mockups.forEach((mockup) => candidates.push(asCandidate(mockup.dueAt, 'Mockup due', 4)));

  const filtered = candidates.filter(Boolean);
  filtered.sort((a, b) => {
    const timeDiff = a.at.getTime() - b.at.getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.weight - a.weight;
  });

  const next = filtered[0];
  if (next) {
    lead.nextActionAt = next.at;
    lead.nextActionLabel = next.label;
  } else {
    lead.nextActionAt = undefined;
    lead.nextActionLabel = undefined;
  }
  await lead.save();
  return lead;
}
