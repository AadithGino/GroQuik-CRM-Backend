import dayjs from 'dayjs';
import { endOfAppDay, parseAppDateTime, startOfAppDay } from '../utils/time.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Lead } from '../models/lead.model.js';
import { Task } from '../models/task.model.js';
import { Meeting } from '../models/meeting.model.js';
import { Quote } from '../models/quote.model.js';
import { Payment } from '../models/payment.model.js';
import { Mockup } from '../models/mockup.model.js';
import { ACTIVITY_TYPE, LEAD_STATUS, MEETING_STATUS, MOCKUP_STATUS, QUOTE_STATUS, TASK_STATUS } from '../constants/crm.constants.js';
import { Activity } from '../models/activity.model.js';
import { accessibleLeadIds, leadScopeFilter } from '../utils/permissions.js';

function dateFilter(query) {
  const from = query.from ? startOfAppDay(parseAppDateTime(query.from)) : startOfAppDay(dayjs().subtract(30, 'day').toDate());
  const to = query.to ? endOfAppDay(parseAppDateTime(query.to)) : endOfAppDay();
  return { from, to };
}

function scopedMatch(field, ids) {
  return ids ? { [field]: { $in: ids } } : {};
}

export const summaryReports = asyncHandler(async (req, res) => {
  const { from, to } = dateFilter(req.query);
  const createdAt = { $gte: from, $lte: to };
  const leadFilter = await leadScopeFilter(req.user);
  const scopedLeadIds = await accessibleLeadIds(req.user);
  const leadScopeById = scopedMatch('leadId', scopedLeadIds);

  const [leadsBySource, leadsBySalesperson, lostReasons, quoteStats, paymentAgg, taskStats, meetingStats, staffActivities] = await Promise.all([
    Lead.aggregate([{ $match: { ...leadFilter, createdAt } }, { $group: { _id: '$source', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Lead.aggregate([{ $match: { ...leadFilter, createdAt } }, { $group: { _id: '$assignedTo', count: { $sum: 1 } } }]),
    Lead.aggregate([{ $match: { ...leadFilter, createdAt, status: LEAD_STATUS.LOST, lostReason: { $exists: true, $ne: null } } }, { $group: { _id: '$lostReason', count: { $sum: 1 } } }]),
    Quote.aggregate([{ $match: { ...leadScopeById, createdAt } }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$finalAmount' } } }]),
    Payment.aggregate([{ $match: { ...leadScopeById, paymentDate: { $gte: from, $lte: to } } }, { $group: { _id: '$paymentType', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    Task.aggregate([{ $match: { ...leadScopeById, dueAt: { $gte: from, $lte: to } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Meeting.aggregate([{ $match: { ...leadScopeById, $or: [{ resultMarkedAt: { $gte: from, $lte: to } }, { meetingAt: { $gte: from, $lte: to } }] } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Activity.aggregate([{ $match: { ...(scopedLeadIds ? { leadId: { $in: scopedLeadIds } } : {}), createdAt, type: { $in: [ACTIVITY_TYPE.CALL_OUTCOME, ACTIVITY_TYPE.TASK_DONE, ACTIVITY_TYPE.TASK_NOT_DONE, ACTIVITY_TYPE.MEETING_RESULT, ACTIVITY_TYPE.QUOTE_CREATED, ACTIVITY_TYPE.PAYMENT_RECEIVED] } } }, { $group: { _id: { userId: '$userId', type: '$type' }, count: { $sum: 1 } } }]),
  ]);

  const noActionFilter = {
    ...leadFilter,
    status: { $nin: [LEAD_STATUS.WON, LEAD_STATUS.LOST, LEAD_STATUS.INVALID, LEAD_STATUS.COLD, LEAD_STATUS.NOT_REACHABLE, LEAD_STATUS.PROJECT_CREATED] },
    $or: [{ nextActionAt: { $exists: false } }, { nextActionAt: null }],
  };

  const [
    overdueTasks,
    notDoneTasks,
    teamMissedMeetings,
    customerMissedMeetings,
    advancePendingLeads,
    noActionLeads,
    highIntentNoActionLeads,
    quoteFollowupsPending,
    mockupsReadyNotShared,
    paymentPendingAgg,
  ] = await Promise.all([
    Task.countDocuments({ ...leadScopeById, status: TASK_STATUS.OVERDUE, dueAt: { $gte: from, $lte: to } }),
    Task.countDocuments({ ...leadScopeById, status: TASK_STATUS.NOT_DONE, completedAt: { $gte: from, $lte: to } }),
    Meeting.countDocuments({ ...leadScopeById, status: MEETING_STATUS.TEAM_MISSED, resultMarkedAt: { $gte: from, $lte: to } }),
    Meeting.countDocuments({ ...leadScopeById, status: MEETING_STATUS.CUSTOMER_MISSED, resultMarkedAt: { $gte: from, $lte: to } }),
    Lead.countDocuments({ ...leadFilter, status: LEAD_STATUS.ADVANCE_PENDING }),
    Lead.countDocuments(noActionFilter),
    Lead.countDocuments({ ...noActionFilter, interestScore: { $gte: 7 } }),
    Quote.countDocuments({ ...leadScopeById, status: { $in: [QUOTE_STATUS.SENT, QUOTE_STATUS.REVISED_SENT] } }),
    Mockup.countDocuments({ ...leadScopeById, status: MOCKUP_STATUS.READY }),
    Payment.aggregate([{ $match: { ...leadScopeById } }, { $group: { _id: '$leadId', amount: { $sum: '$amount' } } }]),
  ]);

  res.json({
    from,
    to,
    leadsBySource,
    leadsBySalesperson,
    lostReasons,
    quoteStats,
    paymentAgg,
    taskStats,
    meetingStats,
    staffActivities,
    paymentPendingAgg,
    leakage: {
      overdueTasks,
      notDoneTasks,
      teamMissedMeetings,
      customerMissedMeetings,
      advancePendingLeads,
      noActionLeads,
      highIntentNoActionLeads,
      quoteFollowupsPending,
      mockupsReadyNotShared,
    },
  });
});
