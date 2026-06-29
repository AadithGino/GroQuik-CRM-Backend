
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
  TASK_TYPE,
} from '../constants/crm.constants.js';
import { Lead } from '../models/lead.model.js';
import { ApiError } from '../utils/apiError.js';
import { addActivity } from './activity.service.js';
import { completeTask, createTask, markTaskNotDone } from './task.service.js';
import { addBusinessDelay, daysFromNowAtMorning, nextMorning, parseAppDateTime, resolveFollowUpDateTime, sameDayEvening } from '../utils/time.js';
import { createMeeting } from './meeting.service.js';
import { createMockup } from './mockup.service.js';
import { createQuote } from './quote.service.js';
import { assertNextActionPrerequisites, requirePaymentBeforeWon } from './businessRules.service.js';
import { recomputeLeadNextAction } from './leadWorkflow.service.js';

function getRetryDueAt(attemptsBeforeThisResult, result) {
  const now = new Date();
  if (result === CALL_RESULT.SWITCHED_OFF) {
    if (attemptsBeforeThisResult === 0) return addBusinessDelay(now, 3, 'hour');
    if (attemptsBeforeThisResult === 1) return nextMorning(now);
  }
  if (attemptsBeforeThisResult === 0) return addBusinessDelay(now, 2, 'hour');
  if (attemptsBeforeThisResult === 1) return sameDayEvening(now);
  if (attemptsBeforeThisResult === 2) return nextMorning(now);
  if (attemptsBeforeThisResult === 3) return sameDayEvening(now);
  if (attemptsBeforeThisResult === 4) return daysFromNowAtMorning(1, now);
  return null;
}

function actionToTaskType(nextAction) {
  const map = {
    [NEXT_ACTION.SEND_WHATSAPP_DETAILS]: TASK_TYPE.SEND_WHATSAPP,
    [NEXT_ACTION.SEND_QUOTE]: TASK_TYPE.SEND_QUOTE,
    [NEXT_ACTION.SEND_REVISED_QUOTE]: TASK_TYPE.SEND_REVISED_QUOTE,
    [NEXT_ACTION.CREATE_MOCKUP]: TASK_TYPE.CREATE_MOCKUP,
    [NEXT_ACTION.SHARE_MOCKUP]: TASK_TYPE.SHARE_MOCKUP,
    [NEXT_ACTION.COLLECT_ADVANCE]: TASK_TYPE.COLLECT_ADVANCE,
    [NEXT_ACTION.PROJECT_HANDOFF]: TASK_TYPE.PROJECT_HANDOFF,
  };
  return map[nextAction] || TASK_TYPE.FOLLOW_UP_CALL;
}

function actionToTaskTitle(nextAction) {
  const map = {
    [NEXT_ACTION.CALL_AGAIN]: 'Call customer again',
    [NEXT_ACTION.CALL_DECISION_MAKER]: 'Call decision maker',
    [NEXT_ACTION.WAIT_FOR_CUSTOMER_DECISION]: 'Check customer decision',
    [NEXT_ACTION.FOLLOW_UP_LATER]: 'Follow up later',
    [NEXT_ACTION.SEND_WHATSAPP_DETAILS]: 'Send WhatsApp details',
    [NEXT_ACTION.SEND_QUOTE]: 'Send quote',
    [NEXT_ACTION.SEND_REVISED_QUOTE]: 'Send revised quote',
    [NEXT_ACTION.CREATE_MOCKUP]: 'Create mockup',
    [NEXT_ACTION.SHARE_MOCKUP]: 'Share mockup',
    [NEXT_ACTION.COLLECT_ADVANCE]: 'Collect advance',
    [NEXT_ACTION.PROJECT_HANDOFF]: 'Create project handoff',
  };
  return map[nextAction] || 'Follow up';
}

const meetingActions = new Set([NEXT_ACTION.SCHEDULE_DEMO, NEXT_ACTION.SCHEDULE_MOCKUP_MEETING]);
const quoteActions = new Set([NEXT_ACTION.SEND_QUOTE, NEXT_ACTION.SEND_REVISED_QUOTE]);
const mockupActions = new Set([NEXT_ACTION.CREATE_MOCKUP]);
const inlineObjectActions = new Set([...meetingActions, ...quoteActions, ...mockupActions]);

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
    topicRequirements: raw.topicRequirements || requirements || [],
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
      await createQuote({ leadId: lead._id, userId, payload: quotePayload });
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

  await addActivity({ leadId, userId, type: ACTIVITY_TYPE.CALL_OUTCOME, title: `Call outcome: ${result}`, description: payload.note, metadata: payload });

  if (taskId && result !== CALL_RESULT.NOT_DONE) {
    const isCustomerAttempt = [CALL_RESULT.NOT_ANSWERED, CALL_RESULT.SWITCHED_OFF].includes(result);
    await completeTask({ taskId, userId, customerAttempt: isCustomerAttempt, metadata: { callResult: result } });
  }

  if (result === CALL_RESULT.NOT_DONE) {
    if (taskId) await markTaskNotDone({ taskId, userId, reason: payload.notDoneReason || NOT_DONE_REASON.OTHER, rescheduleAt: parseAppDateTime(payload.rescheduleAt) || nextMorning() });
    lead.status = LEAD_STATUS.FOLLOW_UP_NOT_DONE;
    lead.internalMissCount += 1;
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if ([CALL_RESULT.NOT_ANSWERED, CALL_RESULT.SWITCHED_OFF].includes(result)) {
    const attemptsBeforeThisResult = lead.failedCustomerAttempts || 0;
    const nextDue = getRetryDueAt(attemptsBeforeThisResult, result);
    lead.failedCustomerAttempts = attemptsBeforeThisResult + 1;
    if (!nextDue || lead.failedCustomerAttempts >= 6) {
      lead.status = LEAD_STATUS.NOT_REACHABLE;
    } else {
      lead.status = LEAD_STATUS.FOLLOW_UP_PENDING;
      await createTask({ leadId: lead._id, assignedTo: lead.assignedTo, type: TASK_TYPE.FOLLOW_UP_CALL, title: 'Retry follow-up call', description: `Auto-created after ${result}. This counts as customer non-response attempt ${lead.failedCustomerAttempts}.`, dueAt: nextDue, priority: 4, metadata: { customerAttemptNumber: lead.failedCustomerAttempts, previousResult: result, dedupeKey: `retry:${lead._id}:${lead.failedCustomerAttempts}` } });
    }
    await lead.save();
    await recomputeLeadNextAction(lead._id);
    return lead;
  }

  if (result === CALL_RESULT.BUSY_CALL_LATER) {
    const dueAt = parseAppDateTime(payload.callbackAt) || sameDayEvening();
    lead.status = LEAD_STATUS.CALLBACK_SCHEDULED;
    await lead.save();
    await createTask({ leadId: lead._id, assignedTo: lead.assignedTo, type: TASK_TYPE.FOLLOW_UP_CALL, title: 'Call back customer', description: 'Customer was busy / asked to call later. Not counted as failed attempt.', dueAt, priority: 4, metadata: { dedupeKey: `callback:${lead._id}:${Number(new Date(dueAt))}` } });
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
    lead.requirements = payload.requirements || lead.requirements;
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
    lead.requirements = payload.requirements || lead.requirements;
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

    const inlineActionCreated = inlineObjectActions.has(payload.nextAction) ? await createInlineNextAction({ lead, userId, payload, dueAt }) : false;
    if (inlineActionCreated) return Lead.findById(lead._id);

    if (payload.nextAction && !dueAt) {
      throw new ApiError(400, 'Next follow-up date/time is required for the selected next action.');
    }

    if (dueAt && payload.nextAction) {
      await lead.save();
      await createTask({ leadId: lead._id, assignedTo: lead.assignedTo, type: actionToTaskType(payload.nextAction), title: actionToTaskTitle(payload.nextAction), description: payload.note, dueAt, priority: lead.interestScore >= 7 ? 5 : 3, metadata: { nextAction: payload.nextAction, dedupeKey: `call-next:${lead._id}:${payload.nextAction}:${Number(new Date(dueAt))}` } });
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
