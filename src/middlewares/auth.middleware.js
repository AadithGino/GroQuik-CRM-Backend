import { User } from '../models/user.model.js';
import { ApiError } from '../utils/apiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyAccessToken } from '../utils/token.js';

export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Authentication required');

  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub).select('-password');
  if (!user || !user.isActive) throw new ApiError(401, 'Invalid or inactive user');

  req.user = user;
  next();
});

export const requireRoles = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (!roles.includes(req.user.role)) return next(new ApiError(403, 'Forbidden'));
  next();
};

export const authenticate = requireAuth;
