import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import { getIntegrationStatus, receiveWebhook, testLead, verifyWebhook } from '../controllers/meta.controller.js';
const router = Router();
router.get('/webhook', verifyWebhook);
router.post('/webhook', receiveWebhook);
router.get('/status', authenticate, getIntegrationStatus);
router.post('/test-lead', authenticate, testLead);
export default router;
