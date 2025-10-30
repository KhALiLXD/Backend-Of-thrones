import { redis } from '../../shared/config/redis.js';
import Order from '../../shared/modules/orders.js';
import { Queue, QUEUES } from '../../shared/utils/queue.js';


export const buy = async (req,res) => {
    try {
        const userId = req.user.userId;
        const { productId } = req.body;

        if (!productId) return res.status(400).json({err: 'product id required'})

        // Get product data from Redis FIRST (before DECR)
        const productDataKey = `product:${productId}:data`;
        const productData = await redis.get(productDataKey);

        if (!productData) {
            return res.status(404).json({err: 'product not found'})
        }

        const product = JSON.parse(productData);
        const stockKey = `product:${productId}:stock`;

        // Atomic DECR on Redis (CRITICAL for flash sale!)
        const newStock = await redis.decr(stockKey);

        if (newStock < 0) {
            await redis.incr(stockKey);
            return res.status(400).json({err: 'product out of stock'})
        }

        // Generate order ID
        const orderId = `${Date.now()}_${userId}_${productId}`;

        // Create order data
        const orderData = {
            orderId,
            userId,
            productId,
            price: product.price,
            timestamp: Date.now()
        };

        // Add to order queue (will be processed by order worker)
        await Queue.push(QUEUES.ORDERS, orderData);

        // Immediate response! 
        const response = {
            success: true,
            orderId,
            status: 'processing',
            message: 'order is being processed',
            checkStatusUrl: `/order/${orderId}`,
            product: {
                id: productId,
                name: product.name,
                price: product.price
            }
        };

        return res.status(202).json(response);

    } catch (err) {
        console.error('Buy Error', err);
        return res.status(500).json({error: 'failed to process order'});
    }
};

export const getOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID required' });
    }

const order = await Order.findByPk(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    return res.json(order.toJSON());
    
  } catch (error) {
    console.error('Get order error:', error);
    return res.status(500).json({ error: error.message });
  }
};