import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import {
  addDocument,
  addPayment,
  convertFromLead,
  create,
  getOne,
  list,
  listFiles,
  update,
} from '../controllers/client.controller.js';

const router = Router();
router.use(authenticate);
router.get('/', list);
router.post('/', create);
router.post('/from-lead/:leadId', convertFromLead);
router.get('/:id', getOne);
router.get('/:id/files', listFiles);
router.patch('/:id', update);
router.post('/:id/payments', addPayment);
router.post('/:id/documents', addDocument);

export default router;
