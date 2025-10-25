import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

const Product = sequelize.define('Product', {
  id: { type: DataTypes.BIGINT,autoIncrement:true, primaryKey: true },
  name: { type: DataTypes.STRING(255), allowNull: false },
  price: { type: DataTypes.DECIMAL(10,2), allowNull: false },
  stock: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'products',
  timestamps: false,
  indexes: [{ name: 'products_id_index', fields: ['id'] }],
});

export default Product;
