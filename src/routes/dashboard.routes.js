import { Router } from 'express';
import { dashboard } from '../controllers/dashboard.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', dashboard);
export default router;
