import Order from '../modules/orders.js';
import Product from '../modules/products.js';
import { sequelize } from '../config/db.js';
import processPayment from '../utils/processPayment.js';
import { redis } from '../config/redis.js';
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
            return res.status(400).json({err: 'product out of stock'})
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