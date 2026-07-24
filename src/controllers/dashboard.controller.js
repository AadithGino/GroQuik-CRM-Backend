import dayjs from 'dayjs';
import { startOfAppDay, endOfAppDay, parseAppRangeEnd, parseAppRangeStart } from '../utils/time.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Lead } from '../models/lead.model.js';
import { Task } from '../models/task.model.js';
import { Meeting } from '../models/meeting.model.js';
import { Mockup } from '../models/mockup.model.js';
import { Payment } from '../models/payment.model.js';
import { Quote } from '../models/quote.model.js';
import { LEAD_STATUS, MEETING_MODE, MEETING_TYPE, MOCKUP_STATUS, QUOTE_STATUS, TASK_STATUS, TASK_TYPE } from '../constants/crm.constants.js';
import { accessibleLeadIds, applyAssignedUserScope, leadScopeFilter } from '../utils/permissions.js';
import { redisConnection } from '../config/redis.js';
import { env } from '../config/env.js';

async function scopedLeadMatch(user, extra = {}) {
  return { ...(await leadScopeFilter(user)), ...extra };
}

export const dashboard = asyncHandler(async (req, res) => {
  const start = req.query.from ? parseAppRangeStart(req.query.from) : startOfAppDay();
  const end = req.query.to ? parseAppRangeEnd(req.query.to) : endOfAppDay();
  const now = new Date();
  const cacheKey = `dashboard:v3:${req.user._id}:${req.user.role}:${start.toISOString()}:${end.toISOString()}`;
  if (req.query.noCache !== 'true' && env.DASHBOARD_CACHE_TTL_SECONDS > 0) {
    try {
      const cached = await redisConnection.get(cacheKey);
      if (cached) {
        res.set('X-CRM-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch {
      // Dashboard must keep working if Redis is temporarily unavailable.
    }
  }

  const leadFilter = await scopedLeadMatch(req.user);
  const scopedLeadIds = await accessibleLeadIds(req.user);

  const meetingFilter = { meetingAt: { $gte: start, $lte: end } };
  await applyAssignedUserScope(meetingFilter, req.user, 'assignedTo');
  const physicalMeetingFilter = { ...meetingFilter, mode: MEETING_MODE.PHYSICAL_VISIT };
  const productMockupMeetingFilter = { ...meetingFilter, type: MEETING_TYPE.PRODUCT_MOCKUP_MEETING };
  const demoMeetingFilter = { ...meetingFilter, type: { $ne: MEETING_TYPE.PRODUCT_MOCKUP_MEETING } };

  const todayTaskFilter = { status: TASK_STATUS.PENDING, dueAt: { $gte: start, $lte: end } };
  await applyAssignedUserScope(todayTaskFilter, req.user, 'assignedTo');
  const overdueTaskFilter = { status: TASK_STATUS.OVERDUE };
  await applyAssignedUserScope(overdueTaskFilter, req.user, 'assignedTo');
  const notDoneTaskFilter = { status: TASK_STATUS.NOT_DONE };
  await applyAssignedUserScope(notDoneTaskFilter, req.user, 'assignedTo');
  const earlyCallOutcomeFilter = {
    status: { $in: [TASK_STATUS.PENDING, TASK_STATUS.OVERDUE] },
    type: { $in: [TASK_TYPE.FIRST_CALL, TASK_TYPE.FOLLOW_UP_CALL] },
    dueAt: { $gt: end },
    createdAt: { $gte: start },
    $or: [
      { 'metadata.allowEarlyOutcome': true },
      { 'metadata.autoAssignedRetry': true },
      { title: /Retry follow-up call|Call back customer/i },
    ],
  };
  await applyAssignedUserScope(earlyCallOutcomeFilter, req.user, 'assignedTo');

  let mockupFilter = { dueAt: { $gte: start, $lte: end }, status: { $nin: [MOCKUP_STATUS.APPROVED, MOCKUP_STATUS.REJECTED] } };
  if (scopedLeadIds) mockupFilter.leadId = { $in: scopedLeadIds };

  const advanceLeadFilter = await scopedLeadMatch(req.user, { status: LEAD_STATUS.ADVANCE_PENDING });
  const noActionLeadFilter = await scopedLeadMatch(req.user, {
    status: { $nin: [LEAD_STATUS.WON, LEAD_STATUS.LOST, LEAD_STATUS.INVALID, LEAD_STATUS.COLD, LEAD_STATUS.NOT_REACHABLE, LEAD_STATUS.PROJECT_CREATED] },
    $or: [{ nextActionAt: { $exists: false } }, { nextActionAt: null }],
  });
  const highIntentNoActionFilter = await scopedLeadMatch(req.user, {
    interestScore: { $gte: 7 },
    status: { $nin: [LEAD_STATUS.WON, LEAD_STATUS.LOST, LEAD_STATUS.INVALID, LEAD_STATUS.PROJECT_CREATED] },
    $or: [{ nextActionAt: { $exists: false } }, { nextActionAt: null }],
  });

  const quoteFilter = { status: { $in: [QUOTE_STATUS.SENT, QUOTE_STATUS.REVISED_SENT] } };
  if (scopedLeadIds) quoteFilter.leadId = { $in: scopedLeadIds };

  const [
    newLeads,
    slaMissed,
    todayFollowups,
    overdueFollowups,
    followupNotDone,
    meetingsToday,
    meetingsNextHour,
    mockupsToday,
    advancePending,
    noActionLeads,
    highIntentNoActionLeads,
    todayTasksList,
    overdueTasksList,
    earlyCallOutcomeTasksList,
    todayMeetingsList,
    physicalMeetingsTodayList,
    productMockupMeetingsTodayList,
    demoMeetingsTodayList,
    todayMockupsList,
    advancePendingList,
    noActionLeadsList,
    highIntentNoActionList,
    quoteLeakageList,
    mockupsReadyNotSharedList,
  ] = await Promise.all([
    Lead.countDocuments({ ...leadFilter, status: LEAD_STATUS.FIRST_TOUCH_PENDING }),
    Lead.countDocuments({ ...leadFilter, status: LEAD_STATUS.SLA_MISSED }),
    Task.countDocuments(todayTaskFilter),
    Task.countDocuments(overdueTaskFilter),
    Task.countDocuments(notDoneTaskFilter),
    Meeting.countDocuments(meetingFilter),
    Meeting.countDocuments({ ...meetingFilter, meetingAt: { $gte: now, $lte: dayjs(now).add(1, 'hour').toDate() } }),
    Mockup.countDocuments(mockupFilter),
    Lead.countDocuments(advanceLeadFilter),
    Lead.countDocuments(noActionLeadFilter),
    Lead.countDocuments(highIntentNoActionFilter),
    Task.find(todayTaskFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone status interestScore failedCustomerAttempts').populate('assignedTo', 'name').sort({ dueAt: 1 }).limit(12),
    Task.find(overdueTaskFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone status interestScore failedCustomerAttempts').populate('assignedTo', 'name').sort({ dueAt: 1 }).limit(12),
    Task.find(earlyCallOutcomeFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone status interestScore failedCustomerAttempts').populate('assignedTo', 'name').sort({ dueAt: 1 }).limit(12),
    Meeting.find(meetingFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone interestScore').populate('assignedTo', 'name').sort({ mode: 1, meetingAt: 1 }).limit(20),
    Meeting.find(physicalMeetingFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone interestScore').populate('assignedTo', 'name').sort({ meetingAt: 1 }).limit(10),
    Meeting.find(productMockupMeetingFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone interestScore').populate('assignedTo', 'name').sort({ meetingAt: 1 }).limit(10),
    Meeting.find(demoMeetingFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone interestScore').populate('assignedTo', 'name').sort({ meetingAt: 1 }).limit(10),
    Mockup.find(mockupFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone').populate('assignedTo', 'name').sort({ dueAt: 1, createdAt: -1 }).limit(12),
    Lead.find(advanceLeadFilter).populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(12),
    Lead.find(noActionLeadFilter).populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(12),
    Lead.find(highIntentNoActionFilter).populate('assignedTo', 'name').sort({ interestScore: -1, updatedAt: -1 }).limit(12),
    Quote.find(quoteFilter).populate('leadId', 'name businessName phone callPhone whatsappPhone status').sort({ updatedAt: -1 }).limit(12),
    Mockup.find({ ...(scopedLeadIds ? { leadId: { $in: scopedLeadIds } } : {}), status: MOCKUP_STATUS.READY }).populate('leadId', 'name businessName phone callPhone whatsappPhone').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(12),
  ]);

  const advanceLeadIds = advancePendingList.map((lead) => lead._id);
  const advancePayments = advanceLeadIds.length
    ? await Payment.aggregate([{ $match: { leadId: { $in: advanceLeadIds } } }, { $group: { _id: '$leadId', total: { $sum: '$amount' } } }])
    : [];

  const payload = {
    from: start,
    to: end,
    newLeads,
    slaMissed,
    todayFollowups,
    overdueFollowups,
    followupNotDone,
    meetingsToday,
    meetingsNextHour,
    mockupsToday,
    advancePending,
    noActionLeads,
    highIntentNoActionLeads,
    todayTasksList,
    overdueTasksList,
    earlyCallOutcomeTasksList,
    todayMeetingsList,
    physicalMeetingsTodayList,
    productMockupMeetingsTodayList,
    demoMeetingsTodayList,
    todayMockupsList,
    advancePendingList,
    noActionLeadsList,
    highIntentNoActionList,
    quoteLeakageList,
    mockupsReadyNotSharedList,
    advancePayments,
  };

  if (req.query.noCache !== 'true' && env.DASHBOARD_CACHE_TTL_SECONDS > 0) {
    try {
      await redisConnection.set(cacheKey, JSON.stringify(payload), 'EX', env.DASHBOARD_CACHE_TTL_SECONDS);
      res.set('X-CRM-Cache', 'MISS');
    } catch {
      // Cache write failures should not break dashboard responses.
    }
  }

  res.json(payload);
});
