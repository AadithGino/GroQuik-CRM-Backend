import { z } from 'zod';
import { User } from '../models/user.model.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/apiError.js';
import { ROLES } from '../constants/crm.constants.js';
import { applyDateRange, isSet } from '../utils/queryFilters.js';
import { parsePagination } from '../utils/pagination.js';

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(6),
  role: z.nativeEnum(ROLES).default(ROLES.SALES),
  managerId: z.string().optional(),
  acceptingLeads: z.boolean().optional(),
});

const updateSchema = createSchema.partial().omit({ password: true }).extend({ password: z.string().min(6).optional(), isActive: z.boolean().optional(), acceptingLeads: z.boolean().optional(), assignmentWeight: z.number().optional() });

export const listUsers = asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
  const filter = {};
  if (isSet(req.query.role)) filter.role = req.query.role;
  if (req.query.active === 'true') filter.isActive = true;
  if (req.query.active === 'false') filter.isActive = false;
  applyDateRange(filter, req.query, 'createdAt');
  const items = await User.find(filter).select('-password').sort({ createdAt: -1 }).limit(limit);
  res.json({ items });
});

export const createUser = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const exists = await User.findOne({ email: body.email });
  if (exists) throw new ApiError(409, 'User email already exists');
  const user = await User.create(body);
  res.status(201).json({ user: await User.findById(user._id).select('-password') });
});

export const updateUser = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw new ApiError(404, 'User not found');
  Object.assign(user, body);
  await user.save();
  res.json({ user: await User.findById(user._id).select('-password') });
});

export const deactivateUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isActive: false, acceptingLeads: false }, { new: true }).select('-password');
  if (!user) throw new ApiError(404, 'User not found');
  res.json({ user });
});
