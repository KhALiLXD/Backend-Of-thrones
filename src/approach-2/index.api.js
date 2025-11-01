import 'dotenv/config';
import '../shared/modules/users.js';
import '../shared/modules/products.js';
import '../shared/modules/orders.js';


import express from 'express';

import {
  connectDB,
  sequelize,
} from '../shared/config/db.js';
import { redis } from '../shared/config/redis.js';
import { apiRateLimiter } from '../shared/middleware/rateLimiter.js';
import authRoutes from '../shared/routes/auth.route.js';
import orderRoutes from '../shared/routes/orders.route.js';
import productsRoute from '../shared/routes/products.route.js';
import testRouter from '../shared/routes/test.js';
const app = express();
const port = 3000;


app.use(express.json())
app.use(express.static('public'));
app.use(apiRateLimiter);
app.set("trust proxy", 1);


app.use((req, res, next) => {
  const instanceId = process.env.INSTANCE_ID || `PID-${process.pid}`;
  res.setHeader('X-Instance-ID', instanceId);
  console.log(`🧩 ${instanceId} -> ${req.method} ${req.originalUrl}`);
  next();
});

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
    // console.log(`Server running on http://localhost:${port}`);
});