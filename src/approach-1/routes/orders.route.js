import express from 'express'


import { getOrder,createOrder } from '../controllers/orders.controller.js';
import { idempotency } from '../../shared/middleware/idempotency.js';
const router = express.Router()
router.get('/:id',getOrder)
router.post('/create',idempotency,createOrder)
export default router;