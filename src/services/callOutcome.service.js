
import {
  ACTIVITY_TYPE,
  CALL_RESULT,
  LEAD_STATUS,
  LEAD_TAG,
  LOST_REASON,
  MEETING_MODE,
  MEETING_TYPE,
  MOCKUP_TOPIC,
  NEXT_ACTION,
  NOT_DONE_REASON,
  QUOTE_STATUS,
  TASK_STATUS,
  TASK_TYPE,
  normalizeRequirements,
} from '../constants/crm.constants.js';
import { Lead } from '../models/lead.model.js';
import { Task } from '../models/task.model.js';
import { Activity } from '../models/activity.model.js';
import { ApiError } from '../utils/apiError.js';
import { addActivity } from './activity.service.js';
import { completeTask, createTask, markTaskNotDone, upsertOpenFollowUpCallTask } from './task.service.js';
import { daysFromNowAtMorning, nextMorning, parseAppDateTime, resolveAutoCallLaterDueAt, resolveFollowUpDateTime, resolveRetryDueAt, sameDayEvening } from '../utils/time.js';
import { createMeeting } from './meeting.service.js';
import { createMockup } from './mockup.service.js';
import { createOrReviseQuoteFromAction, updateQuoteStatus } from './quote.service.js';
import { assertNextActionPrerequisites, latestQuote, requirePaymentBeforeWon } from './businessRules.service.js';
import { recomputeLeadNextAction } from './leadWorkflow.service.js';

const CALL_OUTCOME_PAYLOAD_KEYS = [
  'result', 'interestScore', 'requirements', 'note', 'nextAction',
  'nextFollowUpDate', 'nextFollowUpTime', 'customFollowUpAt', 'nextFollowUpAt',
  'callbackAt', 'notDoneReason', 'rescheduleAt', 'lostReason', 'nurtureAfterDays',
  'alternateNumber', 'personName', 'relation', 'isDecisionMaker', 'setAsPrimary',
  'canHandleNow', 'actionDetails', 'taskId',
];

export function sanitizeCallOutcomePayload(payload = {}) {
  const cleaned = {};
  for (const key of CALL_OUTCOME_PAYLOAD_KEYS) {
    if (payload[key] !== undefined) cleaned[key] = payload[key];
  }
  if (cleaned.requirements) cleaned.requirements = normalizeRequirements(cleaned.requirements);
  return cleaned;
}

function getRetryDueAt(attemptsBeforeThisResult, result, payload = {}) {
  // callbackAt is for busy/partner flows only — do not treat it as a retry override.
  const customFollowUpAt = payload.customFollowUpAt || payload.nextFollowUpAt;
  if (result === CALL_RESULT.SWITCHED_OFF) {
    if (attemptsBeforeThisResult === 0) return resolveRetryDueAt({ delayHours: 3, customFollowUpAt });
    if (attemptsBeforeThisResult === 1) {
      return customFollowUpAt ? parseAppDateTime(customFollowUpAt) : nextMorning();
    }
  }
  if (attemptsBeforeThisResult === 0) return resolveRetryDueAt({ delayHours: 2, customFollowUpAt });
  if (attemptsBeforeThisResult === 1) {
    return customFollowUpAt ? parseAppDateTime(customFollowUpAt) : sameDayEvening();
  }
  if (attemptsBeforeThisResult === 2) {
    return customFollowUpAt ? parseAppDateTime(customFollowUpAt) : nextMorning();
  }
  if (attemptsBeforeThisResult === 3) {
    return customFollowUpAt ? parseAppDateTime(customFollowUpAt) : sameDayEvening();
  }
  if (attemptsBeforeThisResult === 4) {
    return customFollowUpAt ? parseAppDateTime(customFollowUpAt) : daysFromNowAtMorning(1);
  }
  return null;
}

const openCallTaskFilter = {
  type: { $in: [TASK_TYPE.FIRST_CALL, TASK_TYPE.FOLLOW_UP_CALL] },
  status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] },
};

/** Complete the linked call task and clear other open call tasks for this lead (they are superseded by this outcome). */
async function completeOpenCallTasksForOutcome({ leadId, taskId, userId, result, outcomePayload }) {
  const isCustomerAttempt = [CALL_RESULT.NOT_ANSWERED, CALL_RESULT.SWITCHED_OFF].includes(result);
  const completedIds = new Set();
  const snapshot = sanitizeCallOutcomePayload(outcomePayload || {});

  const markDone = async (id, metadata = {}) => {
    if (!id || completedIds.has(String(id))) return;
    await completeTask({
      taskId: id,
      userId,
      customerAttempt: Boolean(metadata.customerAttempt),
      metadata: { callResult: result, ...metadata },
    });
    completedIds.add(String(id));
  };

  if (taskId) {
    await markDone(taskId, {
      customerAttempt: isCustomerAttempt,
      callOutcomePayload: { ...snapshot, taskId: String(taskId) },
    });
  } else {
    const open = await Task.findOne({ leadId, ...openCallTaskFilter }).sort({ dueAt: 1 });
    if (open) {
      await markDone(open._id, {
        customerAttempt: isCustomerAttempt,
        completedWithoutTaskLink: true,
        callOutcomePayload: { ...snapshot, taskId: String(open._id) },
      });
    }
  }

  // Any other open call tasks are superseded by this logged session.
  const leftovers = await Task.find({
    leadId,
    ...openCallTaskFilter,
    ...(completedIds.size ? { _id: { $nin: [...completedIds] } } : {}),
  });
  for (const task of leftovers) {
    await markDone(task._id, { customerAttempt: false, supersededByCallOutcome: true });
  }
}

async function amendCallOutcome({ lead, userId, taskId, payload }) {
  const task = await Task.findById(taskId);
  if (!task) throw new ApiError(404, 'Call task not found');
  if (String(task.leadId) !== String(lead._id)) throw new ApiError(400, 'Task does not belong to this lead');
  if (![TASK_STATUS.DONE, TASK_STATUS.NOT_DONE].includes(task.status)) {
    throw new ApiError(400, 'Only completed call outcomes can be amended this way. Use Update Call for open tasks.');
  }

  const cleaned = sanitizeCallOutcomePayload({ ...payload, taskId: String(taskId) });
  const result = cleaned.result || task.metadata?.callResult || CALL_RESULT.CONNECTED;

  task.metadata = {
    ...(task.metadata || {}),
    callResult: result,
    callOutcomePayload: cleaned,
    amendedAt: new Date().toISOString(),
    amendedBy: userId,
  };
  await task.save();

  let activity = await Activity.findOne({
    leadId: lead._id,
    type: ACTIVITY_TYPE.CALL_OUTCOME,
    $or: [
      { 'metadata.taskId': String(taskId) },
      { 'metadata.taskId': taskId },
    ],
  }).sort({ createdAt: -1 });

  if (!activity && task.completedAt) {
    const windowStart = new Date(new Date(task.completedAt).getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(new Date(task.completedAt).getTime() + 5 * 60 * 1000);
    activity = await Activity.findOne({
      leadId: lead._id,
      type: ACTIVITY_TYPE.CALL_OUTCOME,
      createdAt: { $gte: windowStart, $lte: windowEnd },
    }).sort({ createdAt: -1 });
  }

  if (activity) {
    activity.title = `Call outcome: ${result}`;
    activity.description = cleaned.note || activity.description;
    activity.metadata = { ...(activity.metadata || {}), ...cleaned, amended: true };
    await activity.save();
  } else {
    await addActivity({
      leadId: lead._id,
      userId,
      type: ACTIVITY_TYPE.CALL_OUTCOME,
      title: `Call outcome amended: ${result}`,
      description: cleaned.note,
      metadata: { ...cleaned, amended: true },
    });
  }

  if (cleaned.interestScore != null) lead.interestScore = cleaned.interestScore;
  if (cleaned.requirements?.length) lead.requirements = normalizeRequirements(cleaned.requirements);
  await lead.save();
  await recomputeLeadNextAction(lead._id);
  return lead;
}

function actionToTaskType(nextAction) {
  const map = {
    [NEXT_ACTION.SEND_WHATSAPP_DETAILS]: TASK_TYPE.SEND_WHATSAPP,
    [NEXT_ACTION.SEND_QUOTE]: TASK_TYPE.SEND_QUOTE,
    [NEXT_ACTION.SEND_REVISED_QUOTE]: TASK_TYPE.SEND_REVISED_QUOTE,
    [NEXT_ACTION.CREATE_MOCKUP]: TASK_TYPE.CREATE_MOCKUP,
    [NEXT_ACTION.SHARE_MOCKUP]: TASK_TYPE.SHARE_MOCKUP,
    [NEXT_ACTION.COLLECT_ADVANCE]: TASK_TYPE.COLLECT_ADVANCE,
    [NEXT_ACTION.FOLLOW_UP_FOR_ADVANCE]: TASK_TYPE.FOLLOW_UP_CALL,
    [NEXT_ACTION.PROJECT_HANDOFF]: TASK_TYPE.PROJECT_HANDOFF,
  };
  return map[nextAction] || TASK_TYPE.FOLLOW_UP_CALL;
}

function actionToTaskTitle(nextAction) {
  const map = {
    [NEXT_ACTION.CALL_AGAIN]: 'Call customer again',
    [NEXT_ACTION.CALL_DECISION_MAKER]: 'Call decision maker',
    [NEXT_ACTION.WAIT_FOR_CUSTOMER_DECISION]: 'Follow up for quote confirmation',
    [NEXT_ACTION.FOLLOW_UP_LATER]: 'Follow up later',
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
  return map[nextAction] || 'Follow up';
}

const meetingActions = new Set([NEXT_ACTION.SCHEDULE_DEMO, NEXT_ACTION.SCHEDULE_MOCKUP_MEETING]);
const quoteActions = new Set([NEXT_ACTION.SEND_QUOTE, NEXT_ACTION.SEND_REVISED_QUOTE]);
const mockupActions = new Set([NEXT_ACTION.CREATE_MOCKUP]);
const inlineObjectActions = new Set([...meetingActions, ...quoteActions, ...mockupActions]);
const noScheduleNextActions = new Set([
  NEXT_ACTION.MARK_LOST,
  NEXT_ACTION.MARK_WON,
  NEXT_ACTION.PROJECT_HANDOFF,
  NEXT_ACTION.QUOTE_CONFIRMED,
  NEXT_ACTION.ADVANCE_COLLECTED,
]);

async function handleQuoteConfirmed({ lead, userId, note }) {
  const quote = await latestQuote(lead._id);
  if (!quote) throw new ApiError(400, 'Cannot confirm quote because no quote exists yet.');
  if (quote.status === QUOTE_STATUS.DRAFT) {
    const sentStatus = quote.revisionNumber > 1 ? QUOTE_STATUS.REVISED_SENT : QUOTE_STATUS.SENT;
    await updateQuoteStatus({ quoteId: quote._id, userId, status: sentStatus, note: note || 'Auto-marked sent while confirming quote' });
  }
  const latest = await latestQuote(lead._id);
  if (latest?.status !== QUOTE_STATUS.ACCEPTED) {
    await updateQuoteStatus({
      quoteId: latest._id,
      userId,
      status: QUOTE_STATUS.ACCEPTED,
      note: note || 'Quote confirmed on call — hand over to admin for advance/project',
    });
  }
  lead.status = LEAD_STATUS.ADVANCE_PENDING;
  await lead.save();
  await recomputeLeadNextAction(lead._id);
  return Lead.findById(lead._id);
}

async function handleAdvanceCollectedRedirect({ lead }) {
  lead.status = LEAD_STATUS.ADVANCE_PENDING;
  await lead.save();
  await recomputeLeadNextAction(lead._id);
  return Lead.findById(lead._id);
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
    status: raw.status || QUOTE_STATUS.DRAFT,
  };
}

function normalizeMockupPayload(raw = {}, fallbackNote = '') {
  return {
    topic: raw.topic || MOCKUP_TOPIC.GOLD_SCHEME_CUSTOMER_APP,
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
    mode: raw.mode || MEETING_MODE.PHONE_CALL,
    meetingAt: raw.meetingAt || undefined,
    confirmTimeTaskDueAt: raw.confirmTimeTaskDueAt || dueAt,
    topicRequirements: normalizeRequirements(raw.topicRequirements || requirements || []),
    note: raw.note || fallbackNote,
    location: raw.location,
    metadata: { createdFrom: 'CALL_OUTCOME_NEXT_ACTION', nextAction },
  };
}

async function createInlineNextAction({ lead, userId, payload, dueAt }) {
  const actionDetails = payload.actionDetails || {};
  if (meetingActions.has(payload.nextAction)) {
    await lead.save();
    await createMeeting({ leadId: lead._id, userId, payload: normalizeMeetingPayload({ nextAction: payload.nextAction, raw: actionDetails.meeting, requirements: payload.requirements || lead.requirements, fallbackNote: payload.note, dueAt }) });
    return true;
  }
  if (quoteActions.has(payload.nextAction)) {
    const quotePayload = normalizeQuotePayload(actionDetails.quote, payload.note);
    if (quotePayload) {
      await lead.save();
      await createOrReviseQuoteFromAction({ leadId: lead._id, userId, nextAction: payload.nextAction, payload: quotePayload });
      return true;
    }
  }
  if (mockupActions.has(payload.nextAction)) {
    await lead.save();
    await createMockup({ leadId: lead._id, userId, payload: normalizeMockupPayload(actionDetails.mockup, payload.note) });
    return true;
  }
  return false;
}

export async function applyCallOutcome({ leadId, userId, taskId, payload }) {
  const lead = await Lead.findById(leadId);
  if (!lead) return null;
  const result = payload.result;
  const linkedTaskId = taskId || payload?.taskId || null;

  if (payload.amendExisting && linkedTaskId) {
    return amendCallOutcome({ lead, userId, taskId: linkedTaskId, payload });
  }

  const activityPayload = sanitizeCallOutcomePayload({ ...payload, taskId: linkedTaskId ? String(linkedTaskId) : payload?.taskId });
  await addActivity({ leadId, userId, type: ACTIVITY_TYPE.CALL_OUTCOME, title: `Call outcome: ${result}`, description: payload.note, metadata: activityPayload });

  if (result === CALL_RESULT.NOT_DONE) {
    if (linkedTaskId) await markTaskNotDone({ taskId: linkedTaskId, userId, reason: payload.notDoneReason || NOT_DONE_REASON.OTHER, rescheduleAt: parseAppDateTime(payload.rescheduleAt) || nextMorning() });
    lead.status = LEAD_STATUS.FOLLOW_UP_NOT_DONE;
    lead.internalMissCount += 1;
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if ([CALL_RESULT.NOT_ANSWERED, CALL_RESULT.SWITCHED_OFF].includes(result)) {
    const attemptsBeforeThisResult = lead.failedCustomerAttempts || 0;
    const nextDue = getRetryDueAt(attemptsBeforeThisResult, result, payload);
    lead.failedCustomerAttempts = attemptsBeforeThisResult + 1;

    if (!nextDue || lead.failedCustomerAttempts >= 6) {
      await completeOpenCallTasksForOutcome({ leadId: lead._id, taskId: linkedTaskId, userId, result, outcomePayload: activityPayload });
      lead.status = LEAD_STATUS.NOT_REACHABLE;
    } else {
      lead.status = LEAD_STATUS.FOLLOW_UP_PENDING;
      // UPSERT: keep a single open follow-up call and move its dueAt (no duplicate inserts).
      await upsertOpenFollowUpCallTask({
        leadId: lead._id,
        assignedTo: lead.assignedTo,
        title: 'Retry follow-up call',
        description: payload.note || `Retry after ${result} (attempt ${lead.failedCustomerAttempts}).`,
        dueAt: nextDue,
        priority: 4,
        userId,
        metadata: {
          customerAttemptNumber: lead.failedCustomerAttempts,
          previousResult: result,
          autoAssignedRetry: true,
          allowEarlyOutcome: true,
          callResult: result,
          callOutcomePayload: activityPayload,
          customFollowUp: Boolean(payload.customFollowUpAt || payload.callbackAt || payload.nextFollowUpAt),
        },
      });
    }
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  await completeOpenCallTasksForOutcome({ leadId: lead._id, taskId: linkedTaskId, userId, result, outcomePayload: activityPayload });

  if (result === CALL_RESULT.BUSY_CALL_LATER) {
    const dueAt = resolveAutoCallLaterDueAt({
      customFollowUpAt: payload.customFollowUpAt,
      callbackAt: payload.callbackAt,
    });
    lead.status = LEAD_STATUS.CALLBACK_SCHEDULED;
    await lead.save();
    await upsertOpenFollowUpCallTask({
      leadId: lead._id,
      assignedTo: lead.assignedTo,
      title: 'Call back customer',
      description: payload.note || 'Customer was busy / asked to call later.',
      dueAt,
      priority: 4,
      userId,
      metadata: {
        autoAssignedRetry: true,
        allowEarlyOutcome: true,
        manualFollowUp: true,
        callOutcomePayload: activityPayload,
        customFollowUp: Boolean(payload.customFollowUpAt || payload.callbackAt),
      },
    });
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if (result === CALL_RESULT.WRONG_NUMBER) {
    lead.status = LEAD_STATUS.INVALID;
    lead.invalidReason = 'Wrong number';
    lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.WRONG_NUMBER]));
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if (result === CALL_RESULT.NUMBER_NOT_AVAILABLE) {
    lead.status = LEAD_STATUS.INVALID;
    lead.invalidReason = 'Number not available';
    lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.NUMBER_NOT_AVAILABLE]));
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if (result === CALL_RESULT.NORTH_INDIAN_LEAD) {
    lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.NORTH_INDIAN_LEAD]));

    if (!payload.canHandleNow) {
      lead.status = LEAD_STATUS.COLD;
      lead.lostReason = LOST_REASON.NORTH_INDIAN_OUTSIDE_SERVICE_AREA;
      await lead.save();
      await recomputeLeadNextAction(lead._id);
      return lead;
    }

    lead.status = LEAD_STATUS.CONTACTED;
    lead.interestScore = payload.interestScore ?? lead.interestScore;
    lead.requirements = normalizeRequirements(payload.requirements || lead.requirements);
    lead.failedCustomerAttempts = 0;
    if (lead.interestScore >= 7) lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.HIGH_INTENT]));
    if (lead.interestScore <= 3) lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.LOW_INTENT]));

    if (!payload.nextAction) throw new ApiError(400, 'Handled North Indian lead requires a next action.');
    const dueAt = payload.nextFollowUpAt ? parseAppDateTime(payload.nextFollowUpAt) : payload.nextFollowUpDate ? resolveFollowUpDateTime({ date: payload.nextFollowUpDate, timeSlot: payload.nextFollowUpTime, customDateTime: payload.customFollowUpAt }) : undefined;
    await assertNextActionPrerequisites({ leadId: lead._id, nextAction: payload.nextAction });

    if (payload.nextAction === NEXT_ACTION.MARK_LOST) {
      lead.status = LEAD_STATUS.LOST;
      lead.lostReason = payload.lostReason || LOST_REASON.NOT_TARGET_MARKET;
      await lead.save();
      await recomputeLeadNextAction(lead._id);
      return lead;
    }

    const inlineActionCreated = inlineObjectActions.has(payload.nextAction) ? await createInlineNextAction({ lead, userId, payload, dueAt }) : false;
    if (inlineActionCreated) return Lead.findById(lead._id);

    if (!dueAt) throw new ApiError(400, 'Next follow-up date/time is required for handled North Indian lead.');
    await lead.save();
    await createTask({ leadId: lead._id, assignedTo: lead.assignedTo, type: actionToTaskType(payload.nextAction), title: actionToTaskTitle(payload.nextAction), description: payload.note, dueAt, priority: lead.interestScore >= 7 ? 5 : 3, metadata: { nextAction: payload.nextAction, dedupeKey: `north-indian-next:${lead._id}:${payload.nextAction}:${Number(new Date(dueAt))}` } });
    return lead;
  }

  if (result === CALL_RESULT.PARTNER_PICKED) {
    lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.PARTNER_NUMBER, LEAD_TAG.OWNER_NUMBER_REQUIRED]));
    if (payload.alternateNumber) {
      lead.alternateNumbers.push({ number: payload.alternateNumber, label: payload.personName || 'Alternate', relation: payload.relation, isPrimary: Boolean(payload.setAsPrimary), isDecisionMaker: Boolean(payload.isDecisionMaker) });
    }
    const dueAt = parseAppDateTime(payload.callbackAt) || parseAppDateTime(payload.nextFollowUpAt) || sameDayEvening();
    lead.status = LEAD_STATUS.FOLLOW_UP_PENDING;
    await lead.save();
    await createTask({ leadId: lead._id, assignedTo: lead.assignedTo, type: TASK_TYPE.FOLLOW_UP_CALL, title: 'Contact owner / decision maker', dueAt, priority: 4, metadata: { dedupeKey: `decision-maker:${lead._id}:${Number(new Date(dueAt))}` } });
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if (result === CALL_RESULT.NOT_INTERESTED) {
    if (payload.nurtureAfterDays) {
      // Temporary disinterest should stay active/nurture, not pollute lost-reason reports.
      lead.lostReason = undefined;
      lead.status = LEAD_STATUS.FOLLOW_UP_PENDING;
      await lead.save();
      const dueAt = daysFromNowAtMorning(Number(payload.nurtureAfterDays));
      await createTask({ leadId: lead._id, assignedTo: lead.assignedTo, type: TASK_TYPE.FOLLOW_UP_CALL, title: 'Nurture follow-up', dueAt, priority: 2, metadata: { nurtureReason: payload.lostReason, dedupeKey: `nurture:${lead._id}:${Number(new Date(dueAt))}` } });
    } else {
      lead.lostReason = payload.lostReason || LOST_REASON.NOT_REQUIRED_NOW;
      lead.status = LEAD_STATUS.LOST;
      await lead.save();
      await recomputeLeadNextAction(lead._id);
    }
    return lead;
  }

  if ([CALL_RESULT.CONNECTED, CALL_RESULT.INTERESTED].includes(result)) {
    lead.status = LEAD_STATUS.CONTACTED;
    lead.interestScore = payload.interestScore ?? lead.interestScore;
    lead.requirements = normalizeRequirements(payload.requirements || lead.requirements);
    lead.failedCustomerAttempts = 0;
    if (lead.interestScore >= 7) lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.HIGH_INTENT]));
    if (lead.interestScore <= 3) lead.tags = Array.from(new Set([...(lead.tags || []), LEAD_TAG.LOW_INTENT]));

    const dueAt = payload.nextFollowUpAt ? parseAppDateTime(payload.nextFollowUpAt) : payload.nextFollowUpDate ? resolveFollowUpDateTime({ date: payload.nextFollowUpDate, timeSlot: payload.nextFollowUpTime, customDateTime: payload.customFollowUpAt }) : undefined;
    if (payload.nextAction) await assertNextActionPrerequisites({ leadId: lead._id, nextAction: payload.nextAction });

    if (payload.nextAction === NEXT_ACTION.MARK_WON) {
      await requirePaymentBeforeWon(lead._id);
      lead.status = LEAD_STATUS.WON;
      await lead.save();
      await recomputeLeadNextAction(lead._id);
      return lead;
    }
    if (payload.nextAction === NEXT_ACTION.MARK_LOST) {
      lead.status = LEAD_STATUS.LOST;
      await lead.save();
      await recomputeLeadNextAction(lead._id);
      return lead;
    }
    if (payload.nextAction === NEXT_ACTION.QUOTE_CONFIRMED) {
      await lead.save();
      return handleQuoteConfirmed({ lead, userId, note: payload.note });
    }
    if (payload.nextAction === NEXT_ACTION.ADVANCE_COLLECTED) {
      await lead.save();
      return handleAdvanceCollectedRedirect({ lead });
    }

    const inlineActionCreated = inlineObjectActions.has(payload.nextAction) ? await createInlineNextAction({ lead, userId, payload, dueAt }) : false;
    if (inlineActionCreated) return Lead.findById(lead._id);

    if (payload.nextAction && !dueAt && !noScheduleNextActions.has(payload.nextAction)) {
      throw new ApiError(400, 'Next follow-up date/time is required for the selected next action.');
    }

    if (dueAt && payload.nextAction) {
      const quote = await latestQuote(lead._id);
      await lead.save();
      await createTask({
        leadId: lead._id,
        assignedTo: lead.assignedTo,
        type: actionToTaskType(payload.nextAction),
        title: actionToTaskTitle(payload.nextAction),
        description: payload.note,
        dueAt,
        priority: lead.interestScore >= 7 ? 5 : 3,
        metadata: {
          nextAction: payload.nextAction,
          quoteId: quote?._id,
          finalAmount: quote?.finalAmount,
          advanceFollowUp: payload.nextAction === NEXT_ACTION.FOLLOW_UP_FOR_ADVANCE,
          quoteConfirmationFollowUp: [NEXT_ACTION.FOLLOW_UP_LATER, NEXT_ACTION.WAIT_FOR_CUSTOMER_DECISION].includes(payload.nextAction) && Boolean(quote),
          allowEarlyOutcome: true,
          manualFollowUp: true,
          dedupeKey: `call-next:${lead._id}:${payload.nextAction}:${Number(new Date(dueAt))}`,
        },
      });
      await recomputeLeadNextAction(lead._id);
    } else {
      await lead.save();
      await recomputeLeadNextAction(lead._id);
    }
    return lead;
  }

  await lead.save();
  await recomputeLeadNextAction(lead._id);
  return lead;
}
