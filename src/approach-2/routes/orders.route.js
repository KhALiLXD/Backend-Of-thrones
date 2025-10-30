import express from 'express'
import { buy } from '../controllers/orders.controller.js'
import { verifyToken } from '../../shared/middleware/auth.js'
import { idempotency } from '../../shared/middleware/idempotency.js'

const router = express.Router()

router.post('/buy',verifyToken,idempotency,buy)

export default router;