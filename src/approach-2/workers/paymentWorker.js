
import 'dotenv/config';
import { connectDB, sequelize } from '../../shared/config/db.js';
import Order from '../../shared/modules/orders.js';
import Product from '../../shared/modules/products.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';
import { setupCluster } from '../../shared/config/cluster.js';
import processPayment from '../../shared/utils/processPayment.js';
import { redis } from '../../shared/config/redis.js';
import { updateOrderStatus } from '../../shared/utils/orderTracing.js';

const workerCount = process.env.PAYMENT_WORKERS || 10;

const startPaymentWorker = async () => {
    await connectDB();
    console.log(`💳 Payment Worker ${process.pid} connected to database`);

    while (true) {
        try {
            const paymentData = await Queue.pop(QUEUES.PAYMENTS, 5);

            if (!paymentData) {
                continue;
            }

            console.log(`[Payment Worker ${process.pid}] Processing payment:`, paymentData);

            const stockKey = `${paymentData.productId}:STOCK`;
            const stockCache = await redis.get(stockKey);
            
            if (stockCache < 1) {
                console.log(`[Payment Worker ${process.pid}] ❌ Insufficient stock! Current: ${stockCache}`);
                
                await updateOrderStatus(paymentData.orderId, 'failed', {
                    error: 'insufficient stock at payment',
                    failedAt: new Date().toISOString()
                });
                
                continue;
            }

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
                        
                        // NEW - Track failure
                        await updateOrderStatus(paymentData.orderId, 'failed', {
                            error: 'product not found',
                            failedAt: new Date().toISOString()
                        });
                        
                        continue;
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
                        
                        // NEW - Track oversold failure
                        await updateOrderStatus(paymentData.orderId, 'failed', {
                            error: 'oversold - insufficient stock',
                            failedAt: new Date().toISOString()
                        });
                        
                        continue;
                    }

                    await Order.update(
                        { status: 'confirmed' },
                        { where: { id: paymentData.orderId }, transaction }
                    );

                    await Product.update(
                        { stock: newStock },
                        {
                            where: { id: paymentData.productId },
                            transaction
                        }
                    );
                      
                    await redis.set(stockKey, newStock.toString());
                    await redis.publish(stockKey, newStock.toString());

                    await transaction.commit();

                    // NEW - Track success (AFTER commit to ensure DB is updated)
                    await updateOrderStatus(paymentData.orderId, 'confirmed', {
                        transactionId: paymentResult.transactionId,
                        confirmedAt: new Date().toISOString()
                    }).catch(err =>console.error("err: ",err));
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
                        
                        // NEW - Track database error
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

                    // NEW - Track payment failure
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
    }
};

setupCluster(workerCount, startPaymentWorker, 'Payment');