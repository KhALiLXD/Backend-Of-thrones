import 'dotenv/config'; 
import express from 'express'
import testRouter  from './routes/test.js';

import { connectDB, sequelize } from '../shared/config/db.js';
import '../shared/modules/users.js';
import '../shared/modules/products.js';
import '../shared/modules/orders.js';
import '../shared/modules/IdempotencyKey.js';

import { redis } from '../shared/config/redis.js';
import { apiRateLimiter } from '../shared/middleware/rateLimiter.js';

import orderRoutes from './routes/orders.route.js'
import productsRoute from './routes/products.route.js'
import authRoutes from './routes/auth.route.js'

const app = express();
const port = 2525;


app.use(express.json())
app.use(express.static('public'));
app.use(apiRateLimiter);


await connectDB();
await sequelize.sync({ alter: true });

// routes
app.use('/',testRouter )
app.use('/auth',authRoutes)
app.use('/order',orderRoutes)
app.use('/products',productsRoute)
app.get("/health/redis", async (_req, res) => {
    const pong = await redis.ping();
    res.json({ ok: pong === "PONG" });
});


app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});