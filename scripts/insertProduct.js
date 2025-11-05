import "dotenv/config";
import { connectDB, sequelize } from "../src/shared/config/db.js";
import Product from "../src/shared/modules/products.js";
import { redis } from "../src/shared/config/redis.js";

const insertProduct = async () => {
  try {
    console.log("FLASH SALE PRODUCT SETUP");
    console.log("Connecting to database...");
    await connectDB();

    console.log("Syncing database schema...");
    await sequelize.sync();

    console.log("Clearing existing products...");
    await Product.destroy({ where: {}, truncate: true });
    console.log("All products cleared");

    console.log("Creating flash sale product (iPhone 15 Pro)...");
    const product = await Product.create({
      id: 1,
      name: "iPhone 15 Pro - Flash Sale",
      price: 999.99,
      stock: 1000,
    });

    console.log("Product created successfully!");

    console.log("Loading stock into Redis...");
    const stockKey = `${product.id}:STOCK`;
    await redis.set(stockKey, product.stock.toString());

    const productDataKey = `product:${product.id}:data`;
    await redis.set(productDataKey, JSON.stringify({
      id: product.id,
      name: product.name,
      price: product.price,
      stock: product.stock
    }));
    console.log("Stock loaded into Redis");

    await redis.quit();
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error("Error inserting product:", error.message);
    process.exit(1);
  }
};

insertProduct();