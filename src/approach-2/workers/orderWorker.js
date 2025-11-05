import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import { redis } from '../../shared/config/redis.js';
import { updateOrderStatus } from '../../shared/utils/orderTracing.js';

const workerCount = process.env.ORDER_WORKERS || 4;
const concurrency = process.env.WORKER_CONCURRENCY || 15;

const processOrderJob = async () => {
    try {
        const orderData = await Queue.pop(QUEUES.ORDERS, 5);

        if (!orderData) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return;
        }

        // CRITICAL FIX: Do NOT check stock here!
        // The API already atomically reserved stock with redis.decr()
        // If order is in queue, stock is already reserved for it 
        // Checking stock here causes false rejections because stock is already decremented

        await updateOrderStatus(orderData.orderId, 'processing');
        
        console.log(`[Order Worker ${process.pid}] Processing order:`, orderData);
        
        const transaction = await sequelize.transaction();

        try {
            const order = await Order.create({
                id: orderData.orderId,
                user_id: orderData.userId,
                product_id: orderData.productId,
                status: 'pending',
                total_price: orderData.price
            }, { transaction });

            await transaction.commit();

            console.log(`[Order Worker ${process.pid}] ✅ Order ${order.id} saved to database`);
            console.log(`[Order Worker ${process.pid}] 📉 Product ${orderData.productId} stock decremented in database`);

            await updateOrderStatus(orderData.orderId, 'awaiting_payment', {
                savedAt: new Date().toISOString()
            });

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
            
            await updateOrderStatus(orderData.orderId, 'failed', {
                error: err.message,
                failedAt: new Date().toISOString()
            });
        }

    } catch (err) {
        console.error(`[Order Worker ${process.pid}] ❌ Error processing:`, err.message);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
};

const startOrderWorker = async () => {
    await connectDB();
    console.log(`📦 Order Worker ${process.pid} started with ${concurrency} concurrent jobs`);

    const workers = Array(concurrency).fill(null).map(async () => {
        while (true) {
            await processOrderJob();
        }
    });

    await Promise.all(workers);
};

setupCluster(workerCount, startOrderWorker, 'Order');