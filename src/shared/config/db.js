import 'dotenv/config';
import { Sequelize } from 'sequelize';

export const sequelize = new Sequelize(
  process.env.POSTGRES_DB,
  process.env.POSTGRES_USER,
  process.env.POSTGRES_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    logging: false,
    pool: {
      max: Number(process.env.DB_POOL_MAX || 30),   
      min: Number(process.env.DB_POOL_MIN || 5),
      acquire: 10000,     
      idle: 10000,        
      evict: 1000,        
    },
    dialectOptions: {
      application_name: 'flashsale-api',
      statement_timeout: 5000,                  
      idle_in_transaction_session_timeout: 5000, 
    },
    retry: {
      max: 3,          
    },
  }
);

export async function connectDB() {
  await sequelize.authenticate();
  console.log('✅ PostgreSQL connected');
}
