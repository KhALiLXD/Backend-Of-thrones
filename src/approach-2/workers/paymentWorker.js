import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import processPayment from '../../shared/utils/processPayment.js';
import { redis } from '../../shared/config/redis.js';

const workerCount = process.env.PAYMENT_WORKERS || 10;

const startPaymentWorker = async () => {
    await connectDB();
    console.log(`💳 Payment Worker ${process.pid} connected to database`);

    while (true) {
        try {
            // Block and wait for payment from queue (5 second timeout)
            const paymentData = await Queue.pop(QUEUES.PAYMENTS, 5);

            if (!paymentData) {
                // No payments in queue, continue waiting
                continue;
            }

            console.log(`[Payment Worker ${process.pid}] Processing payment:`, paymentData);

            // Define stockKey BEFORE using it
            const stockKey = `${paymentData.productId}:STOCK`;

            // Process payment (this takes 2.5 seconds!)
            const paymentResult = await processPayment({
                orderId: paymentData.orderId,
                amount: paymentData.amount,
                currency: 'USD',
                method: 'credit_card'
            });

            if (paymentResult.success) {
                // Payment successful - update order and stock
                const transaction = await sequelize.transaction();

                try {
                    // CRITICAL: Check product stock in database FIRST before committing
                    const product = await Product.findByPk(paymentData.productId, {
                        attributes: ['id', 'stock'],
                        transaction,
                        lock: transaction.LOCK.UPDATE // Row-level lock to prevent race conditions
                    });

                    if (!product) {
                        await transaction.rollback();
                        console.error(`[Payment Worker ${process.pid}] ❌ Product not found: ${paymentData.productId}`);
                        
                        // Refund stock in Redis
                        await redis.incr(stockKey);
                        
                        // Update order to failed
                        await Order.update(
                            { status: 'failed' },
                            { where: { id: paymentData.orderId } }
                        );
                        continue;
                    }

                    // Calculate new stock
                    const newStock = product.stock - 1;

                    // CRITICAL CHECK: Prevent negative stock!
                    if (newStock < 0) {
                        await transaction.rollback();
                        console.error(`[Payment Worker ${process.pid}] ❌ Insufficient stock! Current: ${product.stock}`);
                        
                        // Refund stock in Redis
                        await redis.incr(stockKey);
                        
                        // Update order to failed (oversold)
                        await Order.update(
                            { status: 'failed' },
                            { where: { id: paymentData.orderId } }
                        );
                        
                        // Sync Redis with actual database stock
                        await redis.set(stockKey, product.stock.toString());
                        await redis.publish(stockKey, product.stock.toString());
                        
                        continue;
                    }

                    // Update order status
                    await Order.update(
                        { status: 'confirmed' },
                        { where: { id: paymentData.orderId }, transaction }
                    );

                    // Update database stock (now we're sure it won't go negative)
                    await Product.update(
                        { stock: newStock },
                        {
                            where: { id: paymentData.productId },
                            transaction
                        }
                    );

                    // Update Redis cache with actual stock from database
                    await redis.set(stockKey, newStock.toString());

                    // Publish stock update for real-time updates
                    await redis.publish(stockKey, newStock.toString());

                    await transaction.commit();

                    console.log(`[Payment Worker ${process.pid}] ✅ Payment successful for order ${paymentData.orderId}, stock updated to ${newStock}`);

                } catch (err) {
                    await transaction.rollback();
                    console.error(`[Payment Worker ${process.pid}] ❌ Error updating order/stock:`, err.message);

                    // Refund stock in Redis if database update failed
                    await redis.incr(stockKey);
                    
                    // Update order to failed
                    try {
                        await Order.update(
                            { status: 'failed' },
                            { where: { id: paymentData.orderId } }
                        );
                    } catch (orderErr) {
                        console.error(`[Payment Worker ${process.pid}] ❌ Error updating order status:`, orderErr.message);
                    }
                }

            } else {
                // Payment failed - refund stock and update order
                console.log(`[Payment Worker ${process.pid}] ❌ Payment failed for order ${paymentData.orderId}`);

                const transaction = await sequelize.transaction();

                try {
                    // Refund stock in Redis
                    await redis.incr(stockKey);

                    // Update order status to failed
                    await Order.update(
                        { status: 'failed' },
                        { where: { id: paymentData.orderId }, transaction }
                    );

                    await transaction.commit();

                    console.log(`[Payment Worker ${process.pid}] 🔄 Stock refunded for product ${paymentData.productId}`);

                } catch (err) {
                    await transaction.rollback();
                    console.error(`[Payment Worker ${process.pid}] ❌ Error refunding stock:`, err.message);
                }
            }

        } catch (err) {
            console.error(`[Payment Worker ${process.pid}] ❌ Error processing payment:`, err.message);
            // Continue to next iteration
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
};

setupCluster(workerCount, startPaymentWorker, 'Payment');