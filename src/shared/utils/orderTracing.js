
import { redis } from "../config/redis.js";
export const updateOrderStatus = async (orderId, status, additionalData = {}) => {
    try {
        const cacheKey = `order:${orderId}:status`;
        const currentData = await redis.get(cacheKey);
        
        let orderData = currentData ? JSON.parse(currentData) : {};
        
        orderData = {
            ...orderData,
            orderId,
            status,
            updatedAt: new Date().toISOString(),
            ...additionalData
        };
        
        await redis.set(cacheKey, JSON.stringify(orderData), 'EX', 600);
        
        console.log(`[Status Tracker] Order ${orderId} → ${status}`);
        
    } catch (err) {
        console.error(`[Status Tracker] Error updating status:`, err.message);
    }
};

export const getOrderStatusFromCache = async (orderId) => {
    try {
        const cacheKey = `order:${orderId}:status`;
        const data = await redis.get(cacheKey);
        return data ? JSON.parse(data) : null;
    } catch (err) {
        console.error(`[Status Tracker] Error getting status:`, err.message);
        return null;
    }
};

export const initializeOrderStatus = async (orderId, userId, productId, price, productName) => {
    await updateOrderStatus(orderId, 'queued', {
        userId,
        productId,
        totalPrice: price,
        product: {
            id: productId,
            name: productName,
            price
        },
        createdAt: new Date().toISOString()
    });
};
