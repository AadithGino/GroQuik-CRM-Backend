import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { env, isConfigured } from '../config/env.js';
import { ApiError } from '../utils/apiError.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

let s3Client;

function requireS3Config() {
  if (!isConfigured(env.AWS_REGION) || !isConfigured(env.AWS_S3_BUCKET) || !isConfigured(env.AWS_ACCESS_KEY_ID) || !isConfigured(env.AWS_SECRET_ACCESS_KEY)) {
    throw new ApiError(503, 'S3 uploads are not configured. Set AWS_REGION, AWS_S3_BUCKET, and credentials.');
  }
}

function getS3() {
  requireS3Config();
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

function sanitizeSegment(value, fallback = 'file') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function buildObjectKey({ kind = 'general', fileName }) {
  const prefix = sanitizeSegment(env.AWS_S3_PREFIX || 'crm', 'crm');
  const folder = sanitizeSegment(kind, 'general').toLowerCase();
  const safeName = sanitizeSegment(fileName, 'upload');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${prefix}/clients/${folder}/${stamp}/${randomUUID()}-${safeName}`;
}

export function publicUrlForKey(key) {
  if (isConfigured(env.AWS_S3_PUBLIC_BASE_URL)) {
    return `${String(env.AWS_S3_PUBLIC_BASE_URL).replace(/\/$/, '')}/${key}`;
  }
  return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

export async function createPresignedUpload({ kind, fileName, contentType }) {
  if (!fileName) throw new ApiError(400, 'fileName is required.');
  if (!contentType || !ALLOWED_MIME.has(contentType)) {
    throw new ApiError(400, 'Only PDF and image uploads are allowed (png, jpeg, webp).');
  }

  const key = buildObjectKey({ kind, fileName });
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(getS3(), command, {
    expiresIn: env.AWS_PRESIGN_EXPIRES_SECONDS || 900,
  });

  return {
    uploadUrl,
    fileUrl: publicUrlForKey(key),
    key,
    bucket: env.AWS_S3_BUCKET,
    contentType,
    expiresIn: env.AWS_PRESIGN_EXPIRES_SECONDS || 900,
  };
}

export async function createPresignedDownload(key, { expiresIn = 3600, fileName, download = true } = {}) {
  if (!key) throw new ApiError(400, 'key is required.');
  requireS3Config();
  const safeName = String(fileName || key.split('/').pop() || 'download')
    .replace(/["\r\n]/g, '_')
    .slice(0, 180);
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    ...(download ? { ResponseContentDisposition: `attachment; filename="${safeName}"` } : {}),
  });
  const url = await getSignedUrl(getS3(), command, { expiresIn });
  return { url, key, expiresIn, fileName: safeName };
}
