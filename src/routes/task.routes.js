import { Router } from 'express';
import { createManualTask, listTasks, markDone, notDone } from '../controllers/task.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', listTasks);
router.post('/', createManualTask);
router.patch('/:id/done', markDone);
router.patch('/:id/not-done', notDone);
export default router;
