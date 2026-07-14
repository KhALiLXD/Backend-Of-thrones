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

const releaseReservation = async (productId, orderId, status, error) => {
    const stockKey = `${productId}:STOCK`;

    await sequelize.transaction(async (t) => {
        await Product.update(
            { stock: sequelize.literal('stock + 1') },
            { where: { id: productId }, transaction: t }
        );
        await Order.update(
            { status: 'failed' },
            { where: { id: orderId }, transaction: t }
        );
    });

    const available = await redis.incr(stockKey);
    await redis.publish(stockKey, String(available));

    await updateOrderStatus(orderId, status, {
        error,
        failedAt: new Date().toISOString()
    });
};

const processPaymentJob = async () => {
    const paymentData = await Queue.pop(QUEUES.PAYMENTS, 2);

    if (!paymentData) {
        await new Promise(r => setTimeout(r, 100));
        return;
    }

    const { orderId, productId } = paymentData;

    try {
        await updateOrderStatus(orderId, 'processing_payment');

        const paymentResult = await processPayment({
            orderId,
            amount: paymentData.amount,
            currency: 'USD',
            method: 'credit_card'
        });
        console.log(`[Payment ${process.pid}] Result for order ${orderId}:`, paymentResult);
        if (paymentResult.unknown) {
            console.error(`[Payment ${process.pid}] 🚨 UNKNOWN OUTCOME ${orderId} — gateway timed out`);
            await Order.update({ status: 'needs_reconciliation' }, { where: { id: orderId } });
            await updateOrderStatus(orderId, 'needs_reconciliation', {
                error: 'gateway timeout — charge status unknown',
            });
            return;
        }
      
        if (paymentResult.success) {
            await Order.update(
                { status: 'confirmed' },
                { where: { id: orderId } }
            );

            await updateOrderStatus(orderId, 'confirmed', {
                transactionId: paymentResult.transactionId,
                confirmedAt: new Date().toISOString()
            });

            console.log(`[Payment ${process.pid}] ✅ Order ${orderId} confirmed`);
            return;
        }

        console.log(`[Payment ${process.pid}] ❌ Declined: ${orderId}`);
        await releaseReservation(
            productId,
            orderId,
            'payment_failed',
            paymentResult.error || 'payment declined'
        );


    } catch (err) {
  
        console.error(`[Payment ${process.pid}] 🚨 NEEDS RECONCILIATION ${orderId}:`, err.message);

        await Order.update(
            { status: 'needs_reconciliation' },
            { where: { id: orderId } }
        ).catch(e => console.error('reconciliation flag failed:', e.message));

        await new Promise(r => setTimeout(r, 1000));
    }
};

const startPaymentWorker = async () => {
    await connectDB();
    console.log(`💳 Payment Worker ${process.pid} started · ${concurrency} concurrent`);

    await Promise.all(
        Array(concurrency).fill(null).map(async () => {
            while (true) await processPaymentJob();
        })
    );
};

setupCluster(workerCount, startPaymentWorker, 'Payment');