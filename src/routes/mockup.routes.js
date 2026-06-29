import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import { createLeadMockup, listMockups, update } from '../controllers/mockup.controller.js';
const router = Router();
router.use(authenticate);
router.get('/', listMockups);
router.post('/lead/:leadId', createLeadMockup);
router.patch('/:id', update);
export default router;
