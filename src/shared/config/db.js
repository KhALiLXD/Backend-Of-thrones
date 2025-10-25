import 'dotenv/config';
import { Sequelize } from 'sequelize';

export const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    logging: false, 
  }
);

export async function connectDB() {
  await sequelize.authenticate();
  console.log('✅ PostgreSQL connected');
}
