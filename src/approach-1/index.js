import 'dotenv/config'; 
import express from 'express'
import testRouter  from './routes/test.js';

import { connectDB, sequelize } from '../shared/config/db.js';
import '../shared/modules/users.js';
import '../shared/modules/products.js';
import '../shared/modules/orders.js';
import '../shared/modules/IdempotencyKey.js';

import { redis } from '../shared/config/redis.js';
import orderRoutes from './routes/orders.route.js';
import productsRoute from './routes/products.route.js';
import userRoutes from './routes/user.route.js';
const app = express();
const port = 2525;


app.use(express.json())
app.use(express.static('public'));


await connectDB();
await sequelize.sync({ alter: true });

// routes
app.use('/',testRouter )
app.use('/order',orderRoutes)
app.use('/products',productsRoute)
app.use('/user',userRoutes)
app.get("/health/redis", async (_req, res) => {
    const pong = await redis.ping();
    res.json({ ok: pong === "PONG" });
});


app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});