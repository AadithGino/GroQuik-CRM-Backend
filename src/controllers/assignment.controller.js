import { z } from 'zod';
import { AssignmentSetting } from '../models/assignmentSetting.model.js';
import { Lead } from '../models/lead.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ASSIGNMENT_MODE } from '../constants/crm.constants.js';
import { reassignLead, updateAssignmentSettings } from '../services/assignment.service.js';
import { assertLeadAccess } from '../utils/permissions.js';
import { ApiError } from '../utils/apiError.js';

export const getAssignmentSettings = asyncHandler(async (req, res) => {
  let setting = await AssignmentSetting.findOne({ singletonKey: 'default' }).populate('activeSalesUsers', 'name email role acceptingLeads');
  if (!setting) setting = await AssignmentSetting.create({ singletonKey: 'default' });
  res.json({ setting });
});

export const saveAssignmentSettings = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const setting = await updateAssignmentSettings(body);
  res.json({ setting });
});

export const reassign = asyncHandler(async (req, res) => {
  const body = req.body || {};
  await assertLeadAccess(req.user, req.params.id);
  const lead = await reassignLead({ leadId: req.params.id, assignedTo: body.assignedTo, userId: req.user._id, note: body.note, actor: req.user });
  if (!lead) throw new ApiError(400, 'Target assignee is invalid or outside your team.');
  res.json({ lead });
});

export const bulkReassign = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const leadIds = Array.isArray(body.leadIds) ? body.leadIds : [];
  await Promise.all(leadIds.map((id) => assertLeadAccess(req.user, id)));
  const result = await Promise.all(leadIds.map((id) => reassignLead({ leadId: id, assignedTo: body.assignedTo, userId: req.user._id, note: body.note, actor: req.user }))); 
  if (result.some((item) => !item)) throw new ApiError(400, 'One or more leads could not be assigned to the selected user. Check team scope.');
  res.json({ updated: result.filter(Boolean).length });
});
