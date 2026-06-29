import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/apiError.js';

const uploadRoot = path.resolve(env.UPLOAD_DIR);
fs.mkdirSync(uploadRoot, { recursive: true });

const allowedMimeTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const kind = String(req.body.kind || 'general').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'general';
    const dir = path.join(uploadRoot, kind);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const safeOriginal = file.originalname.replace(/[^a-z0-9._-]/gi, '_');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeOriginal}`);
  },
});

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!allowedMimeTypes.has(file.mimetype)) return cb(new ApiError(400, 'Only PDF and image uploads are allowed.'));
    cb(null, true);
  },
});

export const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'File is required.');
  const relative = path.relative(uploadRoot, req.file.path).split(path.sep).join('/');
  res.status(201).json({
    fileUrl: `/uploads/${relative}`,
    filename: req.file.filename,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
});
