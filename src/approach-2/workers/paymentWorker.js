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
                    // Update order status
                    await Order.update(
                        { status: 'confirmed' },
                        { where: { id: paymentData.orderId }, transaction }
                    );

                    // Get current cache stock and convert to number
                    const cacheStock = await redis.get(stockKey);
                    const newStock = parseInt(cacheStock || '0') - 1;

                    // Update database stock
                    const [affectedRows, updatedRows] = await Product.update(
                        { stock: newStock },
                        {
                            where: { id: paymentData.productId },
                            returning: true,
                            transaction
                        }
                    );

                    if (affectedRows === 0) {
                        await transaction.rollback();
                        console.error(`[Payment Worker ${process.pid}] ❌ Product not found: ${paymentData.productId}`);
                        continue;
                    }

                    // Get the actual stock from database after update
                    const finalStock = updatedRows[0].dataValues.stock;

                    // Update Redis cache with new stock
                    await redis.set(stockKey, finalStock.toString());

                    // Publish stock update for real-time updates
                    await redis.publish(stockKey, finalStock.toString());

                    await transaction.commit();

                    console.log(`[Payment Worker ${process.pid}] ✅ Payment successful for order ${paymentData.orderId}, stock updated to ${finalStock}`);

                } catch (err) {
                    await transaction.rollback();
                    console.error(`[Payment Worker ${process.pid}] ❌ Error updating order/stock:`, err.message);

                    // Refund stock in Redis if database update failed
                    await redis.incr(stockKey);
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