import express from 'express'


import { getOrder, buy, flashBuy, getOrderStatus } from '../controllers/orders.controller.js';
import { idempotency } from '../middleware/idempotency.js';
import { verifyToken } from '../middleware/auth.js';
import { queueLimiterMiddleware } from '../middleware/processHandlerLimit.js';
const router = express.Router()
router.get('/:id',getOrder)
router.post('/buy',verifyToken,queueLimiterMiddleware,idempotency,buy)
router.post('/buy-flash',verifyToken,queueLimiterMiddleware,idempotency,flashBuy)
router.get('/:orderId/status',getOrderStatus)
export default router;