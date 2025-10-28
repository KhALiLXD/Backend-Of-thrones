import express from 'express'


import { getOrder, buy } from '../controllers/orders.controller.js';
import { idempotency } from '../../shared/middleware/idempotency.js';
import { verifyToken } from '../../shared/middleware/auth.js';
const router = express.Router()
router.get('/:id',getOrder)
router.post('/buy',verifyToken,idempotency,buy)
export default router;