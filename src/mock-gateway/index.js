// mock-gateway/index.js
import express from 'express';
const app = express();
app.use(express.json());

// توزيع log-normal — بيشبه بوابة حقيقية
function latency() {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ms = Math.exp(6.5 + 0.75 * z);          // median ~665ms, p95 ~2.3s, p99 ~4s
    return Math.min(Math.max(ms, 80), 15000);
}

app.post('/charge', async (req, res) => {
    const wait = latency();

    // 1% بتعلّق — بتختبر الـ timeout handling تبعك
    if (Math.random() < 0.01) return;              // ولا رد أبداً

    await new Promise(r => setTimeout(r, wait));

    if (Math.random() < 0.02) return res.status(503).json({ error: 'gateway_unavailable' });
    if (Math.random() < 0.01) return res.status(429).json({ error: 'rate_limited' });
    if (Math.random() < 0.05) return res.status(402).json({ error: 'card_declined' });

    return res.json({
        success: true,
        transactionId: `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    });
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(4001, '0.0.0.0');    

