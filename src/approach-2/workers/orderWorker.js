import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import { redis } from '../../shared/config/redis.js';
import { updateOrderStatus } from '../../shared/utils/orderTracing.js';
import { Op } from 'sequelize';
const workerCount = process.env.ORDER_WORKERS || 4;
const concurrency = process.env.WORKER_CONCURRENCY || 15;

const processOrderJob = async () => {
    try {
            const orderData = await Queue.pop(QUEUES.ORDERS, 5);

            if (!orderData) {
                await new Promise(resolve => setTimeout(resolve, 100));
                return;
            }


            await updateOrderStatus(orderData.orderId, 'processing');
            
            console.log(`[Order Worker ${process.pid}] Processing order:`, orderData);
                        
            const stockKey = `${orderData.productId}:STOCK`;   
            const transaction = await sequelize.transaction();

            try {
                const [affected] = await Product.update(
                    { stock: sequelize.literal('stock - 1') },
                    { where: { id: orderData.productId, stock: { [Op.gt]: 0 } }, transaction }
                );

                if (affected === 0) {
                    await transaction.rollback();
                    console.error(`[FATAL] Redis/DB divergence on order ${orderData.orderId}`);
                    const back = await redis.incr(stockKey);
                    await redis.publish(stockKey, String(back));         
                    await updateOrderStatus(orderData.orderId, 'failed', { error: 'stock unavailable' });
                    return;
                }

                const order = await Order.create({  
                    id: orderData.orderId,
                    user_id: orderData.userId,
                    product_id: orderData.productId,
                    status: 'pending',
                    total_price: orderData.price
                }, { transaction });
                await transaction.commit();

                await updateOrderStatus(orderData.orderId, 'awaiting_payment', { savedAt: new Date().toISOString() });
                await Queue.push(QUEUES.PAYMENTS, { orderId: order.id, userId: orderData.userId, productId: orderData.productId, amount: orderData.price, timestamp: Date.now() });

            } catch (err) {
                await transaction.rollback().catch(() => {});   
                console.error(`[Order ${process.pid}] ❌`, err.message);

                // release the reserved stock in Redis
                const back = await redis.incr(stockKey);
                await redis.publish(stockKey, String(back));

                await updateOrderStatus(orderData.orderId, 'failed', { error: err.message, failedAt: new Date().toISOString() });
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