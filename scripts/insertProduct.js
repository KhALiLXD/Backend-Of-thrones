import "dotenv/config";
import { connectDB, sequelize } from "../src/shared/config/db.js";
import Product from "../src/shared/modules/products.js";
import Order from "../src/shared/modules/orders.js";
import { redis } from "../src/shared/config/redis.js";

const insertProduct = async () => {
  try {
    console.log("=".repeat(60));
    console.log("FLASH SALE PRODUCT SETUP");
    console.log("=".repeat(60));

    console.log("\nConnecting to database...");
    await connectDB();

    console.log("Syncing database schema...");
    await sequelize.sync();

    console.log("Clearing existing data...");
    await Order.destroy({ where: {}, truncate: { cascade: true } });
    await Product.destroy({ where: {}, truncate: { cascade: true } });
    console.log("   ✅ All orders and products cleared");

    console.log("\nCreating flash sale product (iPhone 15 Pro)...");
    const product = await Product.create({
      id: 1,
      name: "iPhone 15 Pro - Flash Sale",
      price: 999.99,
      stock: 1000,
    });

    console.log("   ✅ Product created successfully!");
    console.log("\n" + "=".repeat(60));
    console.log("📦 PRODUCT DETAILS:");
    console.log("=".repeat(60));
    console.log(`   ID:    ${product.id}`);
    console.log(`   Name:  ${product.name}`);
    console.log(`   Price: $${product.price}`);
    console.log(`   Stock: ${product.stock}`);
    console.log("=".repeat(60));

    console.log("\nLoading stock into Redis...");
    const stockKey = `${product.id}:STOCK`;
    await redis.set(stockKey, product.stock.toString());

    const productDataKey = `product:${product.id}:data`;
    await redis.set(productDataKey, JSON.stringify({
      id: product.id,
      name: product.name,
      price: product.price,
      stock: product.stock
    }));
    console.log("   ✅ Stock loaded into Redis");
    console.log("=".repeat(60) + "\n");

    await redis.quit();
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error("Error inserting product:", error.message);
    process.exit(1);
  }
};

insertProduct();