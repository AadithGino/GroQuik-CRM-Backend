import { Router } from 'express';
import { authenticate, requireRoles } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/crm.constants.js';
import { summaryReports } from '../controllers/report.controller.js';
const router = Router();
router.use(authenticate, requireRoles(ROLES.ADMIN, ROLES.MANAGER));
router.get('/summary', summaryReports);
export default router;
