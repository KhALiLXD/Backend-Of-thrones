import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import { redis } from '../../shared/config/redis.js';
const workerCount = process.env.ORDER_WORKERS || 4;

const startOrderWorker = async () => {
    await connectDB();
    console.log(`📦 Order Worker ${process.pid} connected to database`);

    while (true) {
        try {
            const orderData = await Queue.pop(QUEUES.ORDERS, 5);

            if (!orderData) {
                continue;
            }
            
            console.log(`[Order Worker ${process.pid}] Processing order:`, orderData);
            
            const transaction = await sequelize.transaction();

            try {
                // Decrement product stock in database
                await Product.decrement('stock', {
                    by: 1,
                    where: { id: orderData.productId },
                    transaction
                });

                // Save order to database
                const order = await Order.create({
                    user_id: orderData.userId,
                    product_id: orderData.productId,
                    status: 'pending',
                    total_price: orderData.price
                }, { transaction });

                await transaction.commit();

                console.log(`[Order Worker ${process.pid}] ✅ Order ${order.id} saved to database`);
                console.log(`[Order Worker ${process.pid}] 📉 Product ${orderData.productId} stock decremented in database`);

                // Add to payment queue
                const paymentData = {
                    orderId: order.id,
                    userId: orderData.userId,
                    productId: orderData.productId,
                    amount: orderData.price,
                    timestamp: Date.now()
                };

                await Queue.push(QUEUES.PAYMENTS, paymentData);
                console.log(`[Order Worker ${process.pid}] 💳 Order ${order.id} added to payment queue`);

            } catch (err) {
                await transaction.rollback();
                console.error(`[Order Worker ${process.pid}] ❌ Error saving order:`, err.message);
            }

        } catch (err) {
            console.error(`[Order Worker ${process.pid}] ❌ Error processing:`, err.message);
            // Continue to next iteration
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
};

setupCluster(workerCount, startOrderWorker, 'Order');