import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import { convertLead, listProjects, update } from '../controllers/project.controller.js';
const router = Router();
router.use(authenticate);
router.get('/', listProjects);
router.post('/lead/:leadId/convert', convertLead);
router.patch('/:id', update);
export default router;
