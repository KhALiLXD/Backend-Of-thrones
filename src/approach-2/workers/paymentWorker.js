import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import processPayment from '../../shared/utils/processPayment.js';
import { redis } from '../../shared/config/redis.js';
import { updateOrderStatus } from '../../shared/utils/orderTracing.js';

const workerCount = process.env.PAYMENT_WORKERS || 6;
const concurrency = process.env.WORKER_CONCURRENCY || 20;

const processPaymentJob = async () => {
    try {
        const paymentData = await Queue.pop(QUEUES.PAYMENTS, 2);

        if (!paymentData) {
            await new Promise(resolve => setTimeout(resolve, 100)); 
            return;
        }

        console.log(`[Payment Worker ${process.pid}] Processing payment:`, paymentData);

        // IMPORTANT: Do NOT check stock here!
        // The API already atomically reserved stock via Redis DECR.
        // If the order is in this queue, stock was already validated and reserved.
        // Double-checking here causes false rejections because Redis stock is now 0.

        const stockKey = `${paymentData.productId}:STOCK`;

        await updateOrderStatus(paymentData.orderId, 'processing_payment');

        const paymentResult = await processPayment({
            orderId: paymentData.orderId,
            amount: paymentData.amount,
            currency: 'USD',
            method: 'credit_card'
        });

        if (paymentResult.success) {
            const transaction = await sequelize.transaction();

            try {
                const product = await Product.findByPk(paymentData.productId, {
                    attributes: ['id', 'stock'],
                    transaction,
                    lock: transaction.LOCK.UPDATE
                });

                if (!product) {
                    await transaction.rollback();
                    console.error(`[Payment Worker ${process.pid}] ❌ Product not found: ${paymentData.productId}`);
                    
                    await redis.incr(stockKey);
                    await Order.update(
                        { status: 'failed' },
                        { where: { id: paymentData.orderId } }
                    );
                    
                    await updateOrderStatus(paymentData.orderId, 'failed', {
                        error: 'product not found',
                        failedAt: new Date().toISOString()
                    });
                    
                    return;
                }

                const newStock = product.stock - 1;

                if (newStock < 0) {
                    await transaction.rollback();
                    console.error(`[Payment Worker ${process.pid}] ❌ Insufficient stock! Current: ${product.stock}`);
                    
                    await redis.incr(stockKey);
                    await Order.update(
                        { status: 'failed' },
                        { where: { id: paymentData.orderId } }
                    );
                    
                    await redis.set(stockKey, product.stock.toString());
                    await redis.publish(stockKey, product.stock.toString());
                    
                    await updateOrderStatus(paymentData.orderId, 'failed', {
                        error: 'oversold - insufficient stock',
                        failedAt: new Date().toISOString()
                    });
                    
                    return;
                }

                await Order.update(
                    { status: 'confirmed' },
                    { where: { id: paymentData.orderId }, transaction }
                );

                await Product.update(
                    { stock: newStock },
                    { where: { id: paymentData.productId }, transaction }
                );
                  
                await redis.set(stockKey, newStock.toString());
                await redis.publish(stockKey, newStock.toString());

                await transaction.commit();

                await updateOrderStatus(paymentData.orderId, 'confirmed', {
                    transactionId: paymentResult.transactionId,
                    confirmedAt: new Date().toISOString()
                }).catch(err => console.error("err: ", err));
                
                console.log(`[Payment Worker ${process.pid}] ✅ Payment successful for order ${paymentData.orderId}, stock updated to ${newStock}`);

            } catch (err) {
                await transaction.rollback();
                console.error(`[Payment Worker ${process.pid}] ❌ Error updating order/stock:`, err.message);

                await redis.incr(stockKey);
                
                try {
                    await Order.update(
                        { status: 'failed' },
                        { where: { id: paymentData.orderId } }
                    );
                    
                    await updateOrderStatus(paymentData.orderId, 'failed', {
                        error: err.message,
                        failedAt: new Date().toISOString()
                    });
                } catch (orderErr) {
                    console.error(`[Payment Worker ${process.pid}] ❌ Error updating order status:`, orderErr.message);
                }
            }

        } else {
            console.log(`[Payment Worker ${process.pid}] ❌ Payment failed for order ${paymentData.orderId}`);

            const transaction = await sequelize.transaction();

            try {
                await redis.incr(stockKey);

                await Order.update(
                    { status: 'failed' },
                    { where: { id: paymentData.orderId }, transaction }
                );

                await transaction.commit();

                await updateOrderStatus(paymentData.orderId, 'payment_failed', {
                    error: paymentResult.error || 'payment processing failed',
                    failedAt: new Date().toISOString()
                });

                console.log(`[Payment Worker ${process.pid}] 🔄 Stock refunded for product ${paymentData.productId}`);

            } catch (err) {
                await transaction.rollback();
                console.error(`[Payment Worker ${process.pid}] ❌ Error refunding stock:`, err.message);
            }
        }

    } catch (err) {
        console.error(`[Payment Worker ${process.pid}] ❌ Error processing payment:`, err.message);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
};

const startPaymentWorker = async () => {
    await connectDB();
    console.log(`💳 Payment Worker ${process.pid} started with ${concurrency} concurrent jobs`);

    const workers = Array(concurrency).fill(null).map(async () => {
        while (true) {
            await processPaymentJob();
        }
    });

    await Promise.all(workers);
};

setupCluster(workerCount, startPaymentWorker, 'Payment');