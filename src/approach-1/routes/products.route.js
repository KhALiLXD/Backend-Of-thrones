import express from 'express'

import { getProduct,createProduct,productStockStream,decStockCount } from '../controllers/products.controller.js';
const router = express.Router()

router.get('/:id',getProduct);
router.post('/create',createProduct)
router.get("/stock/:id/stream",productStockStream)
router.put('/stock/update',decStockCount)
export default router;