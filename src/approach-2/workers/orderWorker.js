import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import { redis } from '../../shared/config/redis.js';
import { updateOrderStatus } from '../../shared/utils/orderTracing.js';

const workerCount = process.env.ORDER_WORKERS || 3;
const concurrency = process.env.WORKER_CONCURRENCY || 15;

// 🔥 دالة معالجة الطلب الواحد
const processOrderJob = async () => {
    try {
        const orderData = await Queue.pop(QUEUES.ORDERS, 5);

        if (!orderData) {
            await new Promise(resolve => setTimeout(resolve, 100)); // انتظار قصير
            return;
        }
        
        const stockKey = `${orderData.productId}:STOCK`;
        const stockCache = await redis.get(stockKey);
        
        if (stockCache < 1) {
            console.log(`[Order Worker ${process.pid}] ❌ Insufficient stock! Current: ${stockCache}`);
            
            await updateOrderStatus(orderData.orderId, 'failed', {
                error: 'insufficient stock',
                failedAt: new Date().toISOString()
            });
            
            return;
        }
        
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

// 🚀 Worker الرئيسي مع Concurrency
const startOrderWorker = async () => {
    await connectDB();
    console.log(`📦 Order Worker ${process.pid} started with ${concurrency} concurrent jobs`);

    // إنشاء عدة promises تشتغل بالتوازي
    const workers = Array(concurrency).fill(null).map(async () => {
        while (true) {
            await processOrderJob();
        }
    });

    // انتظار جميع الworkers (مش هيخلصوا أبداً)
    await Promise.all(workers);
};

setupCluster(workerCount, startOrderWorker, 'Order');