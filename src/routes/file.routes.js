import { Router } from 'express';
import { uploadFile, uploadMiddleware } from '../controllers/file.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();
router.post('/upload', requireAuth, uploadMiddleware.single('file'), uploadFile);
export default router;
