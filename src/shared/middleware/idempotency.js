import { redis } from "../config/redis.js";

const TTL = 300;

export const idempotency = async (req, res, next) => {
    const clientKey = req.headers['idempotency-key'];

    // بلا مفتاح = بلا ضمان. مرّرها.
    if (!clientKey) return next();

    const userId = req.user?.userId || 'anon';
    const key = `idem:${userId}:${clientKey}`;

    // حجز ذرّي — واحد بس بيفوز
    const claimed = await redis.set(
        key, JSON.stringify({ state: 'PENDING' }), 'NX', 'EX', TTL
    );

    if (!claimed) {
        const stored = JSON.parse(await redis.get(key));

        if (stored.state === 'PENDING') {
            // الأصلية لسا شغالة — جرّب بعد شوي
            res.set('Retry-After', '1');
            return res.status(425).json({ error: 'idempotent_in_progress' });
        }

        // أعِد الرد الأصلي — نجاح كان أو فشل
        console.log(`[idem] replay ${key} → ${stored.status}`);
        return res.status(stored.status).json(stored.response);
    }

    // فزنا بالحجز. خزّن أي رد رح نطلّعه.
    const sendJson = res.json.bind(res);

    res.json = function (body) {
        const status = res.statusCode;

        // 🔑 الأخطاء العابرة مش أجوبة نهائية — حرّر المفتاح
        //    عشان الـ retry ياخد محاولة حقيقية، مش إعادة خطأ.
        if (status >= 500 || status === 429 || status === 503) {
            redis.del(key).catch(e => console.error('[idem] del failed:', e.message));
        } else {
            // 2xx و 4xx = أجوبة نهائية. خزّنها للإعادة.
            redis.set(key, JSON.stringify({
                state: 'DONE', status, response: body,
            }), 'EX', TTL).catch(e => console.error('[idem] cache failed:', e.message));
        }

        return sendJson(body);   // ⚠️ مش async، وما بننتظر Redis
    };

    next();
};