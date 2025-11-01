import express from 'express'

import { productStockStream } from "../../controllers/products.controller.js"
const router = express.Router()

router.get("/products/stock/:id/",productStockStream)

export default router;