import { Router } from 'express';
import { listMeetings, reschedule, result } from '../controllers/meeting.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', listMeetings);
router.patch('/:id/reschedule', reschedule);
router.patch('/:id/result', result);
export default router;
