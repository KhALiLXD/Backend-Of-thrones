// src/shared/utils/processPayment.js
const GATEWAY = process.env.PAYMENT_GATEWAY_URL || 'http://localhost:4001';
const TIMEOUT_MS = 10000;

export default async function processPayment({ orderId, amount, currency, method }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`${GATEWAY}/charge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId, amount, currency, method }),
            signal: controller.signal,
        });
        if (res.status === 402) return { success: false, error: 'card_declined' };
        if (res.status === 429) return { success: false, error: 'rate_limited', retryable: true };
        if (!res.ok)            return { success: false, error: `gateway_${res.status}`, retryable: true };

        const body = await res.json();
        return { success: true, transactionId: body.transactionId,res };

    } catch (err) {
        if (err.name === 'AbortError') {
            return { success: false, error: 'gateway_timeout', unknown: true };
        }
        return { success: false, error: err.message, retryable: true };
    } finally {
        clearTimeout(timer);
    }
}