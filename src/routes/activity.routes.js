import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import { listLeadActivities } from '../controllers/activity.controller.js';
const router = Router();
router.use(authenticate);
router.get('/lead/:leadId', listLeadActivities);
export default router;
