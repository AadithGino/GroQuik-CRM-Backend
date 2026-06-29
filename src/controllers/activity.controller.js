import { Activity } from '../models/activity.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { assertLeadAccess } from '../utils/permissions.js';

export const listLeadActivities = asyncHandler(async (req, res) => {
  await assertLeadAccess(req.user, req.params.leadId);
  const sortDirection = req.query.order === 'desc' ? -1 : 1;
  const items = await Activity.find({ leadId: req.params.leadId })
    .populate('userId', 'name email role')
    .sort({ createdAt: sortDirection, _id: sortDirection })
    .limit(500);

  res.json({ items });
});
