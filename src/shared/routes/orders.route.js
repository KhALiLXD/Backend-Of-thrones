import express from 'express'


import { getOrder, buy, flashBuy } from '../controllers/orders.controller.js';
import { idempotency } from '../middleware/idempotency.js';
import { verifyToken } from '../middleware/auth.js';
import { processHandlerLimit } from '../middleware/processHandlerLimit.js';
const router = express.Router()
router.get('/:id',getOrder)
router.post('/buy',verifyToken,processHandlerLimit,idempotency,buy)
router.post('/buy-flash',verifyToken,idempotency,flashBuy)
export default router;