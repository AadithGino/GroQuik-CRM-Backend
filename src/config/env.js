import dotenv from 'dotenv';

dotenv.config();

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5000),
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  PUBLIC_API_URL: process.env.PUBLIC_API_URL || '',
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/internal_crm',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'dev_access_secret',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret',
  JWT_ACCESS_EXPIRES: process.env.JWT_ACCESS_EXPIRES || '15m',
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES || '7d',
  REDIS_URL: process.env.REDIS_URL || '',
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: Number(process.env.REDIS_PORT || 6379),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  WORK_START_HOUR: Number(process.env.WORK_START_HOUR || 10),
  WORK_START_MINUTE: Number(process.env.WORK_START_MINUTE || 0),
  /** General agent work-hours end (e.g. SLA / isWorkingHours). Default 17:30. */
  WORK_END_HOUR: Number(process.env.WORK_END_HOUR || 17),
  WORK_END_MINUTE: Number(process.env.WORK_END_MINUTE || 30),
  /**
   * Max clock time for auto-assigned call-later / retry tasks when no custom time is set.
   * Default 18:30 — user/admin customFollowUpAt or callbackAt may exceed this.
   */
  AUTO_CALL_LATER_END_HOUR: Number(process.env.AUTO_CALL_LATER_END_HOUR || 18),
  AUTO_CALL_LATER_END_MINUTE: Number(process.env.AUTO_CALL_LATER_END_MINUTE || 30),
  /** Minutes before auto call-later end treated as past EOD for auto-retry scheduling. */
  RETRY_BUFFER_MINUTES: Number(process.env.RETRY_BUFFER_MINUTES || 0),
  TASK_OVERDUE_GRACE_MINUTES: Number(process.env.TASK_OVERDUE_GRACE_MINUTES || 15),
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'groquik_meta_verify',
  META_PAGE_ACCESS_TOKEN: process.env.META_PAGE_ACCESS_TOKEN || '',
  META_APP_SECRET: process.env.META_APP_SECRET || '',
  META_GRAPH_API_VERSION: process.env.META_GRAPH_API_VERSION || 'v21.0',
  DASHBOARD_CACHE_TTL_SECONDS: Number(process.env.DASHBOARD_CACHE_TTL_SECONDS || 30),
  NEXT_ACTION_RECOMPUTE_DEBOUNCE_MS: Number(process.env.NEXT_ACTION_RECOMPUTE_DEBOUNCE_MS || 250),
  UPLOAD_DIR: process.env.UPLOAD_DIR || 'uploads',
  AWS_REGION: process.env.AWS_REGION || '',
  AWS_S3_BUCKET: process.env.AWS_S3_BUCKET || '',
  AWS_S3_PREFIX: process.env.AWS_S3_PREFIX || '',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_S3_PUBLIC_BASE_URL: process.env.AWS_S3_PUBLIC_BASE_URL || '',
  AWS_PRESIGN_EXPIRES_SECONDS: Number(process.env.AWS_PRESIGN_EXPIRES_SECONDS || 900),
};

export function isConfigured(value) {
  return Boolean(String(value || '').trim());
}
