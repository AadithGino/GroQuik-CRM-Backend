import { Notification } from '../models/notification.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { parsePagination } from '../utils/pagination.js';

export const listNotifications = asyncHandler(async (req, res) => {
  const filter = { userId: req.user._id };
  if (req.query.unread === 'true') filter.readAt = null;
  if (isSet(req.query.type)) filter.type = req.query.type;
  if (isSet(req.query.priority)) filter.priority = Number(req.query.priority);
  applyDateRange(filter, req.query, 'createdAt');

  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const items = await Notification.find(filter)
    .populate('leadId', 'name businessName phone callPhone whatsappPhone status')
    .populate('taskId', 'title type dueAt status priority')
    .populate('meetingId', 'type mode meetingAt status note')
    .sort({ createdAt: -1 })
    .limit(limit);

  const unreadCount = await Notification.countDocuments({ userId: req.user._id, readAt: null });
  res.json({ items, unreadCount });
});

export const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { readAt: new Date() }, { new: true });
  res.json({ notification });
});

export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, readAt: null }, { readAt: new Date() });
  res.json({ ok: true });
});
