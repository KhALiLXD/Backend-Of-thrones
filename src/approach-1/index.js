import 'dotenv/config'; 
import express from 'express'
import testRouter  from './routes/test.js';

import { connectDB, sequelize } from '../shared/config/db.js';
import User from '../shared/models/users.js';
import Product from '../shared/models/products.js';
import Order from '../shared/models/orders.js';
import IdempotencyKey from '../shared/models/IdempotencyKey.js';

import { redis } from '../shared/config/redis.js';

const app = express();
const port = 2525;


app.use(express.json())
app.use(express.static('public'));


// routes
app.use('/',testRouter )
await connectDB();
await sequelize.sync({ alter: true });


app.get("/health/redis", async (_req, res) => {
    const pong = await redis.ping();
    res.json({ ok: pong === "PONG" });
});


app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});