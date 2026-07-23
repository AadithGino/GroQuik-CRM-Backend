
import dayjs from 'dayjs';
import { ACTIVITY_TYPE, LEAD_STATUS, MEETING_STATUS, MEETING_TYPE, NEXT_ACTION, NOTIFICATION_TYPE, QUOTE_STATUS, TASK_TYPE, normalizeRequirements } from '../constants/crm.constants.js';
import { Meeting } from '../models/meeting.model.js';
import { Lead } from '../models/lead.model.js';
import { addActivity } from './activity.service.js';
import { createTask } from './task.service.js';
import { cancelMeetingJobs, scheduleMeetingReminder, scheduleMeetingStatusCheck } from './scheduler.service.js';
import { notifyAssigneeAndAdmins } from './notification.service.js';
import { daysFromNowAtMorning, nextMorning, parseAppDateTime, sameDayEvening } from '../utils/time.js';
import { createOrReviseQuoteFromAction, updateQuoteStatus } from './quote.service.js';
import { createMockup } from './mockup.service.js';
import { ApiError } from '../utils/apiError.js';
import { assertNextActionPrerequisites, latestQuote, requirePaymentBeforeWon } from './businessRules.service.js';
import { recomputeLeadNextAction } from './leadWorkflow.service.js';

export const MEETING_RESULT_ACTION = Object.freeze({
  RESCHEDULE_CONFIRMED: 'RESCHEDULE_CONFIRMED',
});

const meetingNextActions = new Set([NEXT_ACTION.SCHEDULE_DEMO, NEXT_ACTION.SCHEDULE_MOCKUP_MEETING]);
const quoteNextActions = new Set([NEXT_ACTION.SEND_QUOTE, NEXT_ACTION.SEND_REVISED_QUOTE]);
const mockupNextActions = new Set([NEXT_ACTION.CREATE_MOCKUP]);
const inlineObjectActions = new Set([...meetingNextActions, ...quoteNextActions, ...mockupNextActions]);
const businessTaskOnlyActions = new Set([NEXT_ACTION.SHARE_MOCKUP, NEXT_ACTION.COLLECT_ADVANCE, NEXT_ACTION.PROJECT_HANDOFF]);

function actionToTaskType(nextAction) {
  const map = {
    [NEXT_ACTION.SEND_QUOTE]: TASK_TYPE.SEND_QUOTE,
    [NEXT_ACTION.SEND_REVISED_QUOTE]: TASK_TYPE.SEND_REVISED_QUOTE,
    [NEXT_ACTION.CREATE_MOCKUP]: TASK_TYPE.CREATE_MOCKUP,
    [NEXT_ACTION.SHARE_MOCKUP]: TASK_TYPE.SHARE_MOCKUP,
    [NEXT_ACTION.SCHEDULE_MOCKUP_MEETING]: TASK_TYPE.SCHEDULE_MOCKUP_MEETING,
    [NEXT_ACTION.COLLECT_ADVANCE]: TASK_TYPE.COLLECT_ADVANCE,
    [NEXT_ACTION.FOLLOW_UP_FOR_ADVANCE]: TASK_TYPE.FOLLOW_UP_CALL,
    [NEXT_ACTION.PROJECT_HANDOFF]: TASK_TYPE.PROJECT_HANDOFF,
    [NEXT_ACTION.SEND_WHATSAPP_DETAILS]: TASK_TYPE.SEND_WHATSAPP,
  };
  return map[nextAction] || TASK_TYPE.FOLLOW_UP_CALL;
}

function actionToTaskTitle(nextAction) {
  const map = {
    [NEXT_ACTION.CALL_AGAIN]: 'Call customer again',
    [NEXT_ACTION.CALL_DECISION_MAKER]: 'Call decision maker',
    [NEXT_ACTION.WAIT_FOR_CUSTOMER_DECISION]: 'Follow up for quote confirmation',
    [NEXT_ACTION.FOLLOW_UP_LATER]: 'Follow up after meeting',
    [NEXT_ACTION.SEND_WHATSAPP_DETAILS]: 'Send WhatsApp details',
    [NEXT_ACTION.SEND_QUOTE]: 'Send quote',
    [NEXT_ACTION.SEND_REVISED_QUOTE]: 'Send revised quote',
    [NEXT_ACTION.CREATE_MOCKUP]: 'Create mockup',
    [NEXT_ACTION.SHARE_MOCKUP]: 'Share mockup',
    [NEXT_ACTION.COLLECT_ADVANCE]: 'Follow up for advance',
    [NEXT_ACTION.FOLLOW_UP_FOR_ADVANCE]: 'Follow up for advance',
    [NEXT_ACTION.PROJECT_HANDOFF]: 'Create project handoff',
    [NEXT_ACTION.QUOTE_CONFIRMED]: 'Quote confirmed — hand over to admin',
  };
  return map[nextAction] || 'Follow up after meeting';
}

function linesToArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function normalizeQuotePayload(raw = {}, fallbackNote = '') {
  const finalAmount = Number(raw.finalAmount || 0);
  if (!finalAmount) return null;
  return {
    finalAmount,
    baseAmount: Number(raw.baseAmount || raw.finalAmount || 0),
    discountAmount: Number(raw.discountAmount || 0),
    gstMode: raw.gstMode || 'INCLUDED',
    deliverables: linesToArray(raw.deliverablesText || raw.deliverables),
    requirementSummary: raw.requirementSummary,
    note: raw.note || fallbackNote,
    status: raw.status || 'DRAFT',
  };
}

function normalizeMockupPayload(raw = {}, fallbackNote = '') {
  return {
    topic: raw.topic || 'GOLD_SCHEME_CUSTOMER_APP',
    dueAt: raw.dueAt,
    jewelleryThemeNotes: raw.jewelleryThemeNotes || fallbackNote,
    pagesToShow: linesToArray(raw.pagesText || raw.pagesToShow),
    logoReferenceAvailable: Boolean(raw.logoReferenceAvailable),
    referenceLinks: linesToArray(raw.referenceLinks),
  };
}

function normalizeMeetingPayload({ nextAction, raw = {}, requirements = [], fallbackNote = '', dueAt }) {
  const isMockupMeeting = nextAction === NEXT_ACTION.SCHEDULE_MOCKUP_MEETING;
  return {
    type: raw.type || (isMockupMeeting ? MEETING_TYPE.PRODUCT_MOCKUP_MEETING : MEETING_TYPE.PRODUCT_DEMO),
    mode: raw.mode || 'PHONE_CALL',
    meetingAt: raw.meetingAt || undefined,
    confirmTimeTaskDueAt: raw.confirmTimeTaskDueAt || dueAt,
    topicRequirements: normalizeRequirements(raw.topicRequirements || requirements || []),
    note: raw.note || fallbackNote,
    location: raw.location,
    metadata: { createdFrom: 'MEETING_RESULT_NEXT_ACTION', nextAction },
  };
}

function meetingResultDescription(payload) {
  return [payload.reason, payload.resultNote].filter(Boolean).join(' — ');
}

function meetingExceptionTaskTitle({ status, nextAction }) {
  if (status === MEETING_STATUS.CUSTOMER_MISSED) {
    if (nextAction === NEXT_ACTION.SEND_WHATSAPP_DETAILS) return 'Send WhatsApp after customer missed meeting';
    if (nextAction === NEXT_ACTION.WAIT_FOR_CUSTOMER_DECISION) return 'Follow up for quote confirmation after missed meeting';
    if (nextAction === NEXT_ACTION.FOLLOW_UP_LATER) return 'Follow up after customer missed meeting';
    return 'Call customer to reschedule meeting';
  }
  if (status === MEETING_STATUS.TEAM_MISSED) {
    if (nextAction === NEXT_ACTION.FOLLOW_UP_LATER) return 'Follow up after team missed meeting';
    if (nextAction === NEXT_ACTION.SEND_WHATSAPP_DETAILS) return 'Send apology WhatsApp after team missed meeting';
    return 'Apologise and reschedule missed meeting';
  }
  if (status === MEETING_STATUS.CANCELLED) {
    if (nextAction === NEXT_ACTION.CALL_AGAIN) return 'Call after cancelled meeting';
    if (nextAction === NEXT_ACTION.WAIT_FOR_CUSTOMER_DECISION) return 'Follow up for quote confirmation after cancellation';
    return 'Follow up after cancelled meeting';
  }
  return actionToTaskTitle(nextAction);
}

function ensureMeetingStatusActionIsLogical(status, nextAction) {
  if (!nextAction) return;
  if (status === MEETING_STATUS.RESCHEDULE_PENDING) {
    throw new ApiError(400, 'Reschedule pending creates only one Get New Meeting Time task. Do not pass another next action.');
  }
  if (status === MEETING_STATUS.CUSTOMER_MISSED && meetingNextActions.has(nextAction)) {
    throw new ApiError(400, 'Customer missed meeting cannot directly create a new meeting. First create a call/reschedule task and confirm with the customer.');
  }
  if (status === MEETING_STATUS.TEAM_MISSED && nextAction === NEXT_ACTION.MARK_LOST) {
    throw new ApiError(400, 'Team missed meeting cannot mark the lead lost. Create an apology/reschedule action.');
  }
  if (status === MEETING_STATUS.TEAM_MISSED && inlineObjectActions.has(nextAction)) {
    throw new ApiError(400, 'Team missed meeting should create an apology/reschedule task. Use Rescheduled to Confirmed Time only when a new time is confirmed.');
  }
  if (status === MEETING_STATUS.CANCELLED && meetingNextActions.has(nextAction)) {
    throw new ApiError(400, 'Cancelled means the current meeting is dead. Use Rescheduled to Confirmed Time or Reschedule Pending instead of Cancelled + Schedule Demo.');
  }
}

async function createInlineMeetingNextAction({ lead, meeting, userId, payload, dueAt }) {
  const actionDetails = payload.actionDetails || {};

  if (meetingNextActions.has(payload.nextAction)) {
    await createMeeting({
      leadId: lead._id,
      userId,
      payload: normalizeMeetingPayload({
        nextAction: payload.nextAction,
        raw: actionDetails.meeting,
        requirements: payload.requirements || lead.requirements,
        fallbackNote: payload.resultNote,
        dueAt,
      }),
    });
    return true;
  }

  if (quoteNextActions.has(payload.nextAction)) {
    const quotePayload = normalizeQuotePayload(actionDetails.quote, payload.resultNote);
    if (quotePayload) {
      await createOrReviseQuoteFromAction({ leadId: lead._id, userId, nextAction: payload.nextAction, payload: quotePayload });
      return true;
    }
  }

  if (mockupNextActions.has(payload.nextAction)) {
    await createMockup({ leadId: lead._id, userId, payload: normalizeMockupPayload(actionDetails.mockup, payload.resultNote) });
    return true;
  }

  return false;
}

async function applyMeetingResultNextAction({ lead, meeting, userId, payload, dueAt, leadStatus, priority = 4, taskType }) {
  const nextAction = payload.nextAction || NEXT_ACTION.FOLLOW_UP_LATER;
  ensureMeetingStatusActionIsLogical(payload.status, nextAction);
  await assertNextActionPrerequisites({ leadId: lead._id, nextAction });

  if (nextAction === NEXT_ACTION.MARK_WON) {
    await requirePaymentBeforeWon(lead._id);
    lead.status = LEAD_STATUS.WON;
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return false;
  }

  if (nextAction === NEXT_ACTION.MARK_LOST) {
    lead.status = LEAD_STATUS.LOST;
    lead.lostReason = payload.reason || payload.resultNote || lead.lostReason;
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return false;
  }

  if (nextAction === NEXT_ACTION.QUOTE_CONFIRMED) {
    const quote = await latestQuote(lead._id);
    if (!quote) throw new ApiError(400, 'Cannot confirm quote because no quote exists yet.');
    if (quote.status === QUOTE_STATUS.DRAFT) {
      await updateQuoteStatus({
        quoteId: quote._id,
        userId,
        status: quote.revisionNumber > 1 ? QUOTE_STATUS.REVISED_SENT : QUOTE_STATUS.SENT,
        note: payload.resultNote || 'Auto-marked sent while confirming quote',
      });
    }
    const latest = await latestQuote(lead._id);
    if (latest?.status !== QUOTE_STATUS.ACCEPTED) {
      await updateQuoteStatus({
        quoteId: latest._id,
        userId,
        status: QUOTE_STATUS.ACCEPTED,
        note: payload.resultNote || 'Quote confirmed after meeting — hand over to admin',
      });
    }
    lead.status = LEAD_STATUS.ADVANCE_PENDING;
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return true;
  }

  if (nextAction === NEXT_ACTION.ADVANCE_COLLECTED) {
    lead.status = LEAD_STATUS.ADVANCE_PENDING;
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return true;
  }

  if (inlineObjectActions.has(nextAction)) {
    await lead.save();
    const created = await createInlineMeetingNextAction({ lead, meeting, userId, payload: { ...payload, nextAction }, dueAt });
    if (!created) throw new ApiError(400, 'Required details are missing for the selected meeting next action.');
    return true;
  }

  const title = meetingExceptionTaskTitle({ status: payload.status, nextAction });
  lead.status = leadStatus;
  await lead.save();
  await createTask({
    leadId: lead._id,
    meetingId: meeting._id,
    assignedTo: meeting.assignedTo,
    type: taskType || actionToTaskType(nextAction),
    title,
    description: meetingResultDescription(payload),
    dueAt,
    priority: businessTaskOnlyActions.has(nextAction) ? 5 : priority,
    metadata: { nextAction, meetingId: meeting._id, meetingResultStatus: payload.status, reason: payload.reason, dedupeKey: `meeting-result:${meeting._id}:${payload.status}:${nextAction}` },
  });
  return false;
}

export async function createMeeting({ leadId, userId, payload }) {
  const lead = await Lead.findById(leadId);
  if (!lead) return null;

  const hasExactTime = Boolean(payload.meetingAt);
  const status = hasExactTime ? MEETING_STATUS.SCHEDULED : MEETING_STATUS.TIME_PENDING;
  const meeting = await Meeting.create({
    leadId,
    assignedTo: payload.assignedTo || lead.assignedTo,
    type: payload.type,
    mode: payload.mode,
    status,
    topicRequirements: normalizeRequirements(payload.topicRequirements || []),
    note: payload.note,
    location: payload.location,
    meetingAt: parseAppDateTime(payload.meetingAt),
    dateOnly: parseAppDateTime(payload.dateOnly),
    timeConfirmed: hasExactTime,
    metadata: payload.metadata,
  });

  await addActivity({ leadId, userId, type: ACTIVITY_TYPE.MEETING_CREATED, title: hasExactTime ? 'Meeting scheduled' : 'Meeting time pending', description: payload.note, metadata: { meetingId: meeting._id, meetingAt: meeting.meetingAt, type: meeting.type } });

  if (meeting.type === MEETING_TYPE.PRODUCT_MOCKUP_MEETING) {
    lead.tags = Array.from(new Set([...(lead.tags || []), 'PRODUCT_MOCKUP_MEETING_REQUIRED']));
  }

  if (hasExactTime) {
    lead.status = LEAD_STATUS.MEETING_SCHEDULED;
    await scheduleExactMeetingJobs(meeting);
  } else {
    lead.status = LEAD_STATUS.MEETING_TIME_PENDING;
    const dueAt = parseAppDateTime(payload.confirmTimeTaskDueAt) || nextMorning();
    await createTask({
      leadId,
      meetingId: meeting._id,
      assignedTo: meeting.assignedTo,
      type: TASK_TYPE.CONFIRM_MEETING_TIME,
      title: 'Confirm meeting time',
      description: 'Customer agreed for meeting/demo but time is not confirmed.',
      dueAt,
      priority: 4,
      metadata: { meetingId: meeting._id, dedupeKey: `confirm-meeting:${meeting._id}` },
    });
  }

  await lead.save();
  await recomputeLeadNextAction(leadId);
  return meeting;
}

export async function scheduleExactMeetingJobs(meeting) {
  const meetingAt = dayjs(meeting.meetingAt);
  await scheduleMeetingReminder({ meetingId: meeting._id, reminderType: '15_MIN', dueAt: meetingAt.subtract(15, 'minute').toDate() });
  await scheduleMeetingReminder({ meetingId: meeting._id, reminderType: '5_MIN', dueAt: meetingAt.subtract(5, 'minute').toDate() });
  await scheduleMeetingStatusCheck({ meetingId: meeting._id, dueAt: meetingAt.add(30, 'minute').toDate() });
}

export async function rescheduleMeeting({ meetingId, userId, payload }) {
  const meeting = await Meeting.findById(meetingId);
  if (!meeting) return null;
  await cancelMeetingJobs(meeting._id);

  const oldAt = meeting.meetingAt;
  meeting.rescheduleReason = payload.reason;
  meeting.note = payload.note || meeting.note;
  meeting.location = payload.location || meeting.location;
  const lead = await Lead.findById(meeting.leadId);

  if (payload.meetingAt) {
    meeting.meetingAt = parseAppDateTime(payload.meetingAt);
    meeting.status = MEETING_STATUS.SCHEDULED;
    meeting.timeConfirmed = true;
    if (lead) lead.status = LEAD_STATUS.MEETING_SCHEDULED;
    await scheduleExactMeetingJobs(meeting);
  } else {
    meeting.meetingAt = undefined;
    meeting.status = MEETING_STATUS.RESCHEDULE_PENDING;
    meeting.timeConfirmed = false;
    const dueAt = parseAppDateTime(payload.confirmTimeTaskDueAt) || nextMorning();
    if (lead) lead.status = LEAD_STATUS.MEETING_TIME_PENDING;
    await createTask({
      leadId: meeting.leadId,
      meetingId: meeting._id,
      assignedTo: meeting.assignedTo,
      type: TASK_TYPE.CONFIRM_MEETING_TIME,
      title: 'Get new meeting time',
      description: 'Meeting was rescheduled without new confirmed time.',
      dueAt,
      priority: 4,
      metadata: { meetingId: meeting._id, dedupeKey: `reschedule-pending:${meeting._id}` },
    });
  }

  if (lead) await lead.save();
  await meeting.save();
  await addActivity({ leadId: meeting.leadId, userId, type: ACTIVITY_TYPE.MEETING_UPDATED, title: payload.meetingAt ? 'Meeting rescheduled to confirmed time' : 'Meeting reschedule pending', description: payload.reason, metadata: { meetingId, oldAt, newAt: meeting.meetingAt } });
  await recomputeLeadNextAction(meeting.leadId);
  return meeting;
}

export async function markMeetingResult({ meetingId, userId, payload }) {
  const meeting = await Meeting.findById(meetingId);
  if (!meeting) return null;

  const status = payload.status;
  const requiresReason = [MEETING_STATUS.CUSTOMER_MISSED, MEETING_STATUS.TEAM_MISSED, MEETING_STATUS.RESCHEDULE_PENDING, MEETING_STATUS.CANCELLED, MEETING_RESULT_ACTION.RESCHEDULE_CONFIRMED].includes(status);
  if (requiresReason && !payload.reason) throw new ApiError(400, 'Reason is required for missed, rescheduled, pending, or cancelled meetings.');

  if (status === MEETING_RESULT_ACTION.RESCHEDULE_CONFIRMED) {
    if (!payload.meetingAt) throw new ApiError(400, 'New confirmed meeting time is required for reschedule.');
    return rescheduleMeeting({ meetingId, userId, payload: { meetingAt: payload.meetingAt, reason: payload.reason, note: payload.resultNote || payload.note, location: payload.location } });
  }

  if (status === MEETING_STATUS.RESCHEDULE_PENDING) {
    if (payload.nextAction) throw new ApiError(400, 'Reschedule pending creates only one Get New Meeting Time task. Remove nextAction.');
    if (!payload.confirmTimeTaskDueAt) throw new ApiError(400, 'Confirm-new-time task due time is required.');
    return rescheduleMeeting({ meetingId, userId, payload: { confirmTimeTaskDueAt: payload.confirmTimeTaskDueAt, reason: payload.reason, note: payload.resultNote || payload.note } });
  }

  await cancelMeetingJobs(meeting._id);
  meeting.status = status;
  meeting.resultNote = payload.resultNote;
  meeting.resultMarkedAt = new Date();
  meeting.rescheduleReason = payload.reason || meeting.rescheduleReason;
  await meeting.save();

  await addActivity({ leadId: meeting.leadId, userId, type: ACTIVITY_TYPE.MEETING_RESULT, title: `Meeting result: ${status}`, description: payload.resultNote || payload.reason, metadata: payload });

  const lead = await Lead.findById(meeting.leadId);
  if (!lead) return meeting;
  if (payload.interestScore) lead.interestScore = payload.interestScore;
  if (payload.requirements) lead.requirements = normalizeRequirements(payload.requirements);

  if (status === MEETING_STATUS.DONE) {
    lead.status = LEAD_STATUS.CONTACTED;
    const nextAction = payload.nextAction;
    if (!nextAction) throw new ApiError(400, 'Meeting done requires a next action before saving.');
    if (nextAction) {
      await assertNextActionPrerequisites({ leadId: lead._id, nextAction });
      const dueAt = parseAppDateTime(payload.nextFollowUpAt) || daysFromNowAtMorning(1);
      const handledInline = inlineObjectActions.has(nextAction)
        ? await createInlineMeetingNextAction({ lead, meeting, userId, payload, dueAt })
        : false;
      if (!handledInline) {
        await applyMeetingResultNextAction({ lead, meeting, userId, payload: { ...payload, status, nextAction }, dueAt, leadStatus: LEAD_STATUS.FOLLOW_UP_PENDING, priority: lead.interestScore >= 7 ? 5 : 3, taskType: actionToTaskType(nextAction) });
      }
    }
  }

  if (status === MEETING_STATUS.CUSTOMER_MISSED) {
    const dueAt = parseAppDateTime(payload.nextFollowUpAt) || sameDayEvening();
    await applyMeetingResultNextAction({ lead, meeting, userId, payload: { ...payload, nextAction: payload.nextAction || NEXT_ACTION.CALL_AGAIN }, dueAt, leadStatus: LEAD_STATUS.FOLLOW_UP_PENDING, priority: 5, taskType: TASK_TYPE.FOLLOW_UP_CALL });
  }

  if (status === MEETING_STATUS.TEAM_MISSED) {
    const dueAt = parseAppDateTime(payload.nextFollowUpAt) || nextMorning();
    await applyMeetingResultNextAction({ lead, meeting, userId, payload: { ...payload, nextAction: payload.nextAction || NEXT_ACTION.CALL_AGAIN }, dueAt, leadStatus: LEAD_STATUS.FOLLOW_UP_PENDING, priority: 5, taskType: TASK_TYPE.FOLLOW_UP_CALL });
  }

  if (status === MEETING_STATUS.CANCELLED) {
    const dueAt = parseAppDateTime(payload.nextFollowUpAt) || daysFromNowAtMorning(1);
    await applyMeetingResultNextAction({ lead, meeting, userId, payload: { ...payload, nextAction: payload.nextAction || NEXT_ACTION.FOLLOW_UP_LATER }, dueAt, leadStatus: LEAD_STATUS.FOLLOW_UP_PENDING, priority: 3, taskType: TASK_TYPE.FOLLOW_UP_CALL });
  }

  await lead.save();
  await recomputeLeadNextAction(lead._id);
  return meeting;
}

function isStaleMeetingJob(meeting, reminderType, jobDueAt) {
  if (!jobDueAt || !meeting.meetingAt) return false;
  const expected = reminderType === '15_MIN'
    ? dayjs(meeting.meetingAt).subtract(15, 'minute')
    : reminderType === '5_MIN'
      ? dayjs(meeting.meetingAt).subtract(5, 'minute')
      : dayjs(meeting.meetingAt).add(30, 'minute');
  return Math.abs(expected.valueOf() - new Date(jobDueAt).getTime()) > 5000;
}

export async function sendMeetingReminder(meetingId, reminderType, jobDueAt) {
  const meeting = await Meeting.findById(meetingId).populate('leadId');
  if (!meeting || meeting.status !== MEETING_STATUS.SCHEDULED) return null;
  if (isStaleMeetingJob(meeting, reminderType, jobDueAt)) return null;

  const lead = meeting.leadId;
  const title = reminderType === '5_MIN' ? 'Meeting in 5 minutes' : 'Meeting in 15 minutes';
  const message = `${lead?.businessName || lead?.name || 'Client'} — ${meeting.type}. ${meeting.note || ''}`;
  await notifyAssigneeAndAdmins({
    assignedTo: meeting.assignedTo,
    leadId: lead?._id,
    meetingId: meeting._id,
    type: reminderType === '5_MIN' ? NOTIFICATION_TYPE.MEETING_5_MIN : NOTIFICATION_TYPE.MEETING_15_MIN,
    title,
    message,
    priority: reminderType === '5_MIN' ? 5 : 4,
    metadata: { phone: lead?.phone, businessName: lead?.businessName, meetingAt: meeting.meetingAt, meetingType: meeting.type, topicRequirements: meeting.topicRequirements },
  });
  return meeting;
}

export async function checkMeetingStatus(meetingId, jobDueAt) {
  const meeting = await Meeting.findById(meetingId).populate('leadId');
  if (!meeting || meeting.status !== MEETING_STATUS.SCHEDULED) return null;
  if (isStaleMeetingJob(meeting, 'STATUS', jobDueAt)) return null;
  await notifyAssigneeAndAdmins({
    assignedTo: meeting.assignedTo,
    leadId: meeting.leadId?._id,
    meetingId: meeting._id,
    type: NOTIFICATION_TYPE.MEETING_STATUS_NOT_UPDATED,
    title: 'Meeting status not updated',
    message: `${meeting.leadId?.businessName || meeting.leadId?.name || 'Client'} meeting status is still not updated. Mark Done / Customer Missed / Team Missed / Rescheduled / Cancelled.`,
    priority: 5,
  });
  return meeting;
}
