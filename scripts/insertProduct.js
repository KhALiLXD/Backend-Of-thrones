import "dotenv/config";
import { connectDB, sequelize } from "../src/shared/config/db.js";
import Product from "../src/shared/modules/products.js";

const insertProduct = async () => {
  try {
    console.log("Connecting to database...");
    await connectDB();

    console.log("Syncing database schema...");
    await sequelize.sync();

    console.log("Inserting product with stock=1000...");
    const product = await Product.create({
      name: "Sample Product",
      price: 999.99,
      stock: 1000,
    });

    console.log("Product inserted successfully:");
    console.log(JSON.stringify(product.toJSON(), null, 2));

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error("Error inserting product:", error.message);
    process.exit(1);
  }
};

insertProduct();