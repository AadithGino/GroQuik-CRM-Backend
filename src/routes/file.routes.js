import { Router } from 'express';
import { createPresign, createSignedGet, uploadFile, uploadMiddleware } from '../controllers/file.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();
router.post('/upload', requireAuth, uploadMiddleware.single('file'), uploadFile);
router.post('/presign', requireAuth, createPresign);
router.post('/signed-get', requireAuth, createSignedGet);
export default router;
