import express from 'express'


import { getOrder,createOrder } from '../controllers/orders.controller.js'
const router = express.Router()
router.get('/:id',getOrder)
router.post('/create',createOrder)
export default router;