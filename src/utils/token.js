import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name, email: user.email },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES }
  );
}

export function signRefreshToken(user, options = {}) {
  const jti = options.jti || crypto.randomUUID();
  const token = jwt.sign({ sub: user._id.toString(), jti }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES,
  });
  const decoded = jwt.decode(token);
  return { token, jti, expiresAt: new Date(decoded.exp * 1000) };
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
