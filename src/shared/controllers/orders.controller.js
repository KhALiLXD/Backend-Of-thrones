import Order from '../modules/orders.js';
import Product from '../modules/products.js';
import { sequelize } from '../config/db.js';
import processPayment from '../utils/processPayment.js';
import { redis } from '../config/redis.js';
import { Queue, QUEUES } from '../utils/queue.js';
import { getOrderStatusFromCache, initializeOrderStatus } from '../utils/orderTracing.js';
import { Op } from 'sequelize';

// ============================================================================
// STOCK MODEL — read this before changing anything below.
//
// Approach 1 (buy):
//   Postgres is the ONLY authority. There is no reservation — the request
//   holds the connection through payment. Redis is a DISPLAY CACHE for SSE
//   and nothing reads it to make a decision. That is why `redis.set` is
//   allowed here and forbidden in Approach 2.
//
// Approach 2 (flashBuy):
//   Redis `{id}:STOCK` is the RESERVATION counter — "can I accept another
//   order?". It is mutated by DECR (reserve) and INCR (release) ONLY.
//   Postgres holds what actually SOLD, and lags Redis by the queue depth.
//
//   Redis <= Postgres, always, because reserved >= confirmed.
//
//   NEVER `redis.set` on {id}:STOCK after initStock. Writing the Postgres
//   value over the Redis counter wipes every pending reservation — that was
//   the original bug.
//
// NOTE: `{id}:STOCK` is used as BOTH a Redis key and a pub/sub channel name.
// These are separate namespaces in Redis. GET/SET/DECR/INCR touch the key;
// PUBLISH/SUBSCRIBE touch the channel. Same string, different things.
// ============================================================================

export const getOrder = async (req, res) => {
    try {
        const orderId = req.params.id;
        if (!orderId) return res.status(400).json({ err: 'order id required' });

        const order = await Order.findByPk(orderId);
        if (!order) return res.status(404).json({ err: 'order not found' });

        return res.json(order.toJSON());
    } catch (err) {
        console.error('[getOrder]', err.message);
        return res.status(500).json({ err: 'failed to fetch order' });
    }
};


// ============================================================================
// APPROACH 1 — SYNCHRONOUS
// The HTTP response IS the confirmation. Payment happens inside the request.
// ============================================================================

export const buy = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const userId = req.user.userId;
        const { productId } = req.body;

        if (!productId) {
            await transaction.rollback();
            return res.status(400).json({ err: 'product id required' });
        }

        const channel = `${productId}:STOCK`;

        // Atomic conditional decrement. RETURNING gives the real post-commit
        // value — not a stale in-memory snapshot read before other requests
        // committed. That snapshot was the source of the Redis/DB divergence.
        const [affected, rows] = await Product.update(
            { stock: sequelize.literal('stock - 1') },
            {
                where: { id: productId, stock: { [Op.gt]: 0 } },
                returning: true,
                transaction,
            }
        );

        if (affected === 0) {
            await transaction.rollback();

            // Distinguish "no such product" from "sold out"
            const exists = await Product.findByPk(productId, { attributes: ['id'] });
            if (!exists) return res.status(404).json({ err: 'product not found' });

            return res.status(409).json({ err: 'product out of stock' });
        }

        const newStock = rows[0].stock;
        const price = parseFloat(rows[0].price);

        const order = await Order.create({
            user_id: userId,
            product_id: productId,
            status: 'pending',
            total_price: price,
        }, { transaction });

        await transaction.commit();

        // Display cache + SSE. Safe here: nothing reads this for correctness
        // in Approach 1 (the queue limiter must NOT be on the /buy route).
        await redis.publish(channel, String(newStock));
        await redis.set(channel, String(newStock));

        const paymentResult = await processPayment({
            orderId: order.id,
            amount: price,
            currency: 'USD',
            method: 'credit_card',
        });


        console.log(`[buy] Payment result for order ${order.id}:`, paymentResult);
        

 

        // ---- Payment cleared --------------------------------------------
        if (paymentResult.success) {
            order.status = 'confirmed';
            await order.save();

            return res.status(201).json({
                message: 'purchase successful',
                order: order.toJSON(),
                payment: {
                    transactionId: paymentResult.transactionId,
                    status: 'completed',
                },
            });
        }

        //  Payment declined => refund the unit 
        const refundTx = await sequelize.transaction();
        try {
            const [, refunded] = await Product.update(
                { stock: sequelize.literal('stock + 1') },
                { where: { id: productId }, returning: true, transaction: refundTx }
            );

            order.status = 'failed';
            await order.save({ transaction: refundTx });

            await refundTx.commit();

            const restored = refunded[0].stock;
            await redis.publish(channel, String(restored));
            await redis.set(channel, String(restored));

            return res.status(402).json({
                err: 'payment failed',
                message: paymentResult.error,
                stockRefunded: true,
            });

        } catch (refundErr) {
            await refundTx.rollback().catch(() => {});
            console.error('[buy] refund failed:', refundErr.message);
            // The unit is now stranded: sold in the DB, never paid for.
            // Loud, because it needs manual reconciliation.
            console.error(`[buy] 🚨 STRANDED UNIT product=${productId} order=${order.id}`);
            return res.status(500).json({
                success: false,
                error: 'payment failed and refund failed',
            });
        }

    } catch (err) {
        await transaction.rollback().catch(() => {});
        console.error('[buy]', err.message);
        return res.status(500).json({ success: false, error: 'purchase failed' });
    }
};


// ============================================================================
// APPROACH 2 - QUEUE-BASED
// Validate => reserve atomically in Redis => enqueue => return 202.
// Fulfillment happens in the workers.
// ============================================================================

export const flashBuy = async (req, res) => {
    const { productId } = req.body;
    const stockKey = `${productId}:STOCK`;

    // True ONLY between the DECR and the successful hand-off to the queue.
    // Inside that window, any throw must release the reservation - otherwise
    // the unit is reserved in Redis, never decremented in the DB, and never
    // released. It is simply gone.
    let reserved = false;

    try {
        const userId = req.user.userId;
        if (!productId) return res.status(400).json({ err: 'product id required' });

        // Product metadata (name/price) - NOT stock 
        const productDataKey = `product:${productId}:data`;
        let productData = await redis.get(productDataKey);

        if (!productData) {
            const dbProduct = await Product.findByPk(productId);
            if (!dbProduct) return res.status(404).json({ err: 'product not found' });

            productData = dbProduct.toJSON();
            await redis.set(productDataKey, JSON.stringify(productData), 'EX', 500);
            // Deliberately NOT seeding stockKey here. initStock owns it.
            // Repopulating it from the DB would reset every pending reservation.
        } else {
            productData = JSON.parse(productData);
        }

        // ---- Fail closed if the counter was never seeded -------------------
        // DECR on a missing key CREATES it at -1, so without this check a
        // missing counter silently poisons itself instead of erroring.
        if (!(await redis.exists(stockKey))) {
            console.error(`[flashBuy] stockKey missing for product ${productId} — run initStock`);
            return res.status(503).json({ err: 'stock not initialized' });
        }

        // ---- RESERVE (atomic) ---------------------------------------------
        const remaining = await redis.decr(stockKey);

        if (remaining < 0) {
            await redis.incr(stockKey);   // compensate — never leave it negative
            return res.status(409).json({ err: 'product out of stock' });
        }

        reserved = true;

        // Available-for-reservation changed -> tell the SSE subscribers.
        await redis.publish(stockKey, String(remaining));

        const orderId = `${Date.now()}${userId}${productId}`;

        await initializeOrderStatus(
            orderId, userId, productId, productData.price, productData.name
        );

        await Queue.push(QUEUES.ORDERS, {
            orderId,
            userId,
            productId,
            price: productData.price,
            timestamp: Date.now(),
        });

        // Handed off. The order worker owns this reservation now.
        reserved = false;

        return res.status(202).json({
            success: true,
            orderId,
            status: 'queued',
            message: 'order is being processed',
            checkStatusUrl: `/order/${orderId}/status`,
            product: {
                id: productId,
                name: productData.name,
                price: productData.price,
            },
        });

    } catch (err) {
        console.error('[flashBuy]', err);

        // Reserved but never handed off -> release, or the unit leaks forever.
        if (reserved) {
            try {
                const back = await redis.incr(stockKey);
                await redis.publish(stockKey, String(back));
                console.error(`[flashBuy] released orphaned reservation, product=${productId}`);
            } catch (releaseErr) {
                console.error(`[flashBuy] 🚨 LEAKED RESERVATION product=${productId}:`, releaseErr.message);
            }
        }

        return res.status(500).json({ success: false, error: 'failed to process order' });
    }
};


export const getOrderStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        const cachedStatus = await getOrderStatusFromCache(orderId);
        if (cachedStatus) return res.json(cachedStatus);

        const order = await Order.findOne({
            where: { id: orderId },
            include: [{ model: Product, attributes: ['id', 'name', 'price'] }],
        });

        if (!order) {
            return res.status(404).json({ success: false, error: 'order not found' });
        }

        return res.json({
            success: true,
            orderId: order.id,
            userId: order.user_id,
            status: order.status,
            totalPrice: order.total_price,
            product: order.Product,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
        });

    } catch (err) {
        console.error('[getOrderStatus]', err.message);
        return res.status(500).json({ success: false, error: 'failed to get order status' });
    }
};