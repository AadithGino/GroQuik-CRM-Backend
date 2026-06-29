import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import { createLeadPayment, listPayments } from '../controllers/payment.controller.js';
const router = Router();
router.use(authenticate);
router.get('/', listPayments);
router.post('/lead/:leadId', createLeadPayment);
export default router;
