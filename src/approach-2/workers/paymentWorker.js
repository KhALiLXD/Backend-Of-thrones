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

            // Process payment (this takes 2.5 seconds!)
            const paymentResult = await processPayment({
                orderId: paymentData.orderId,
                amount: paymentData.amount,
                currency: 'USD',
                method: 'credit_card'
            });

            if (paymentResult.success) {
                // Payment successful - update order status
                await Order.update(
                    { status: 'confirmed' },
                    { where: { id: paymentData.orderId } }
                );

                console.log(`[Payment Worker ${process.pid}] ✅ Payment successful for order ${paymentData.orderId}`);

            } else {
                // Payment failed - refund stock and update order
                console.log(`[Payment Worker ${process.pid}] ❌ Payment failed for order ${paymentData.orderId}`);

                const transaction = await sequelize.transaction();

                try {
                    // Refund stock in Redis
                    const stockKey = `product:${paymentData.productId}:stock`;
                    await redis.incr(stockKey);

                    // Refund stock in database 
                    await Product.increment('stock', {
                        by: 1,
                        where: { id: paymentData.productId },
                        transaction
                    });

                    // Update order status to failed
                    await Order.update(
                        { status: 'failed' },
                        { where: { id: paymentData.orderId }, transaction }
                    );

                    await transaction.commit();

                    console.log(`[Payment Worker ${process.pid}] 🔄 Stock refunded in Redis and database for product ${paymentData.productId}`);

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