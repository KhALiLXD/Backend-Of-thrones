import Order from '../modules/orders.js';
import Product from '../modules/products.js';
import { sequelize } from '../config/db.js';
import processPayment from '../utils/processPayment.js';
import { redis } from '../config/redis.js';
import { Queue, QUEUES } from '../utils/queue.js';
import { getOrderStatusFromCache, initializeOrderStatus } from '../utils/orderTracing.js';

export const getOrder = async (req,res) =>{
    const orderId = req.params.id;
    if (!orderId) return res.status(404).json({err:"order not found"})

    const order = await Order.findByPk(orderId);

    res.json(order.toJSON())
}


export const buy = async (req,res) => {
    const transaction = await sequelize.transaction();

    try {
        const userId = req.user.userId;
        if (!userId) return res.status(401).json({err: "Not Authorized"})
        const { productId } = req.body;

        if (!productId) return res.status(400).json({err: 'product id required'})
        const channel = `${productId}:STOCK`;

        const product = await Product.findByPk(productId, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        if (!product) {
            await transaction.rollback();
            return res.status(404).json({err: 'product not found'})
        }

        if (product.stock < 1) {
            await transaction.rollback();
            return res.status(409).json({err: 'product out of stock'})
        }

        product.stock -= 1;
        await product.save({ transaction });

        const totalPrice = parseFloat(product.price);

        const order = await Order.create({
            user_id: userId,
            product_id: productId,
            status: 'pending',
            total_price: totalPrice
        }, { transaction });

        await transaction.commit();

        const paymentResult = await processPayment({
            orderId: order.id,
            amount: totalPrice,
            currency: 'USD',
            method: 'credit_card'
        });

        if (paymentResult.success) {
            order.status = 'confirmed';
            await order.save();
            await redis.publish(channel,product.stock);
            await redis.set(channel,product.stock)

            return res.status(201).json({
                message: 'purchase successful',
                order: order.toJSON(),
                payment: {
                    transactionId: paymentResult.transactionId,
                    status: 'completed'
                }
            });
        } else {
            const refundTransaction = await sequelize.transaction();

            try {
                const productToRefund = await Product.findByPk(productId, {
                    transaction: refundTransaction,
                    lock: refundTransaction.LOCK.UPDATE
                });

                productToRefund.stock += 1;
                await productToRefund.save({ transaction: refundTransaction });

                order.status = 'failed';
                await order.save({ transaction: refundTransaction });

                await refundTransaction.commit();

                return res.status(402).json({
                    err: 'payment failed',
                    message: paymentResult.error,
                    stockRefunded: true
                });
            } catch (refundErr) {
                await refundTransaction.rollback();
                return res.status(500).json({error: 'payment failed and refund error: ' + refundErr.message});
            }
        }
    } catch (err) {
        await transaction.rollback();
        return res.status(500).json({error: err.message});
    }
}

export const flashBuy = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { productId } = req.body;

        if (!productId) return res.status(400).json({ err: 'product id required' });
        
        const productDataKey = `product:${productId}:data`;
        const stockKey = `${productId}:STOCK`;
        
        let productData = await redis.get(productDataKey);
        
        if (!productData) {
            const dbProduct = await Product.findByPk(productId);
            if (!dbProduct) return res.status(404).json({ err: 'product not found' });
            productData = dbProduct.toJSON();
            await redis.set(productDataKey, JSON.stringify(productData), 'EX', 500);
            await redis.set(stockKey, String(productData.stock));
        } else {
            productData = JSON.parse(productData);
        }

        const currentStock = await redis.get(stockKey);
        if (!currentStock || parseInt(currentStock) < 1) {
            return res.status(409).json({ err: 'product out of stock' });
        }

        const orderId = `${Date.now()}${userId}${productId}`;
        
        // NEW - Initialize order status tracking
        await initializeOrderStatus(
            orderId, 
            userId, 
            productId, 
            productData.price,
            productData.name
        );

        const orderData = {
            orderId,
            userId,
            productId,
            price: productData.price,
            timestamp: Date.now()
        };

        await Queue.push(QUEUES.ORDERS, orderData);

        return res.status(202).json({
            success: true,
            orderId,
            status: 'queued',
            message: 'order is being processed',
            checkStatusUrl: `/order/${orderId}/status`, // NEW
            product: {
                id: productId,
                name: productData.name,
                price: productData.price
            }
        });
    } catch (err) {
        console.error('Buy Error', err);
        return res.status(500).json({ 
            success: false,
            error: 'failed to process order' 
        });
    }
};

export const getOrderStatus = async (req, res) => {
    try {
        const { orderId } = req.params;
        console.log(orderId)
        // Try cache first
        const cachedStatus = await getOrderStatusFromCache(orderId);
        console.log("cachedStatus",cachedStatus);
        if (cachedStatus) {
            return res.json(cachedStatus);
        }
        
        // Fallback to database
        const order = await Order.findOne({
            where: { id: orderId },
            include: [{
                model: Product,
                attributes: ['id', 'name', 'price']
            }]
        });
        
        if (!order) {
            return res.status(404).json({ 
                success: false,
                error: 'order not found' 
            });
        }
        
        const statusData = {
            success: true,
            orderId: order.id,
            userId: order.user_id,
            status: order.status,
            totalPrice: order.total_price,
            product: order.Product,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt
        };
        
        return res.json(statusData);
        
    } catch (err) {
        console.error('Get Order Status Error:', err);
        return res.status(500).json({ 
            success: false,
            error: 'failed to get order status' 
        });
    }
};

