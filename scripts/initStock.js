import 'dotenv/config';
import { connectDB, sequelize } from '../src/shared/config/db.js';
import Product from '../src/shared/modules/products.js';
import { redis } from '../src/shared/config/redis.js';

const initStock = async () => {
    try {
        console.log('Initializing stock in Redis...');

        await connectDB();
        console.log('Database connected');

        const products = await Product.findAll();
        console.log(`Found ${products.length} products in database`);

        if (products.length === 0) {
            console.log('No products found! Please add products first.');
            process.exit(0);
        }

        let loadedCount = 0;

        for (const product of products) {
            const stockKey = `${product.id}:STOCK`;

            await redis.set(stockKey, product.stock.toString());

            const productDataKey = `product:${product.id}:data`;
            await redis.set(productDataKey, JSON.stringify({
                id: product.id,
                name: product.name,
                price: product.price
            }));

            loadedCount++;
            console.log(`Loaded product ${product.id}: ${product.name} (stock: ${product.stock})`);
        }

        console.log(`Successfully loaded ${loadedCount} products into Redis`);

        await redis.quit();
        await sequelize.close();

        console.log('Stock initialization complete!');
        process.exit(0);
    } catch (err) {
        console.error('Error initializing stock:', err);
        process.exit(1);
    }
};

initStock();