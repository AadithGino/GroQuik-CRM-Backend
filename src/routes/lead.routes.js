import { Router } from 'express';
import { addLeadNote, callOutcome, createLead, getLead, listLeads, updateLeadContacts } from '../controllers/lead.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { createLeadMeeting } from '../controllers/meeting.controller.js';

const router = Router();
router.use(requireAuth);
router.get('/', listLeads);
router.post('/', createLead);
router.get('/:id', getLead);
router.patch('/:id/contacts', updateLeadContacts);
router.post('/:id/notes', addLeadNote);
router.post('/:id/call-outcome', callOutcome);
router.post('/:leadId/meetings', createLeadMeeting);
export default router;
