import { z } from 'zod';
import { User } from '../models/user.model.js';
import { RefreshToken } from '../models/refreshToken.model.js';
import { ApiError } from '../utils/apiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/token.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

function safeUser(user) {
  return { _id: user._id, name: user.name, email: user.email, role: user.role };
}

async function persistRefreshToken({ user, refresh, req }) {
  await RefreshToken.create({
    userId: user._id,
    jti: refresh.jti,
    tokenHash: hashToken(refresh.token),
    expiresAt: refresh.expiresAt,
    createdByIp: req.ip,
    userAgent: req.get('user-agent'),
  });
}

async function issueTokenPair(user, req) {
  const refresh = signRefreshToken(user);
  await persistRefreshToken({ user, refresh, req });
  return { accessToken: signAccessToken(user), refreshToken: refresh.token };
}

export const login = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const user = await User.findOne({ email: body.email }).select('+password');
  if (!user || !(await user.comparePassword(body.password))) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) throw new ApiError(403, 'User is inactive');

  const tokens = await issueTokenPair(user, req);
  res.json({ user: safeUser(user), ...tokens });
});

export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken;
  if (!refreshToken) throw new ApiError(401, 'Refresh token required');
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new ApiError(401, 'Invalid refresh token');
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await RefreshToken.findOne({ jti: payload.jti, userId: payload.sub });
  if (!stored || stored.revokedAt || stored.expiresAt <= new Date() || stored.tokenHash !== tokenHash) {
    if (payload?.sub) {
      await RefreshToken.updateMany({ userId: payload.sub, revokedAt: null }, { revokedAt: new Date(), revokeReason: 'refresh_reuse_or_invalid_token' });
    }
    throw new ApiError(401, 'Refresh token expired or revoked');
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw new ApiError(401, 'Invalid or inactive user');

  const nextRefresh = signRefreshToken(user);
  stored.revokedAt = new Date();
  stored.revokeReason = 'rotated';
  stored.replacedByJti = nextRefresh.jti;
  await stored.save();
  await persistRefreshToken({ user, refresh: nextRefresh, req });

  res.json({ user: safeUser(user), accessToken: signAccessToken(user), refreshToken: nextRefresh.token });
});

export const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken;
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await RefreshToken.findOneAndUpdate(
        { jti: payload.jti, tokenHash: hashToken(refreshToken), revokedAt: null },
        { revokedAt: new Date(), revokeReason: 'logout' }
      );
    } catch {
      // Logout should be idempotent. Invalid token still results in local client logout.
    }
  }
  res.json({ ok: true });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});
