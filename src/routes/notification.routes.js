import { Router } from 'express';
import { listNotifications, markAllRead, markRead } from '../controllers/notification.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', listNotifications);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', markRead);
export default router;
