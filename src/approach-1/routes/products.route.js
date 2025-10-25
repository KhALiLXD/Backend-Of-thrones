import express from 'express'

import { getProduct,createProduct } from '../controllers/products.controller.js';
const router = express.Router()

router.get('/:id',getProduct);
router.post('/create',createProduct)

export default router;