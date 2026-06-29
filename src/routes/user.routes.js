import { Router } from 'express';
import { createUser, deactivateUser, listUsers, updateUser } from '../controllers/user.controller.js';
import { authenticate, requireRoles } from '../middlewares/auth.middleware.js';
import { ROLES } from '../constants/crm.constants.js';

const router = Router();
router.use(authenticate);
router.get('/', requireRoles(ROLES.ADMIN, ROLES.MANAGER), listUsers);
router.post('/', requireRoles(ROLES.ADMIN, ROLES.MANAGER), createUser);
router.patch('/:id', requireRoles(ROLES.ADMIN, ROLES.MANAGER), updateUser);
router.delete('/:id', requireRoles(ROLES.ADMIN, ROLES.MANAGER), deactivateUser);
export default router;
