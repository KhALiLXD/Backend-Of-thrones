import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';
import User from './users.js';
import Product from './products.js';

const Order = sequelize.define('Order', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  user_id: { type: DataTypes.BIGINT, allowNull: false },
  product_id: { type: DataTypes.BIGINT, allowNull: false },
  status: { 
    type: DataTypes.ENUM('pending', 'canceled', 'failed'), 
    allowNull: false 
  },
  total_price: { type: DataTypes.DECIMAL(10,2), allowNull: false },
}, {
  tableName: 'Orders',
  timestamps: false,
  indexes: [{ name: 'orders_id_index', fields: ['id'] }],
});

Order.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(Order, { foreignKey: 'user_id' });

Order.belongsTo(Product, { foreignKey: 'product_id' });
Product.hasMany(Order, { foreignKey: 'product_id' });

export default Order;
