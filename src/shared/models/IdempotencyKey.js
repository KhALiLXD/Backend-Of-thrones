import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';
import User from './users.js';

const IdempotencyKey = sequelize.define('IdempotencyKey', {
  id: { type: DataTypes.STRING(255), primaryKey: true }, 
  user_id: { type: DataTypes.BIGINT, allowNull: false },
  status: { type: DataTypes.ENUM('processing', 'succeeded', 'failed'), allowNull: false },
  result: { type: DataTypes.JSONB, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  tableName: 'IdempotencyKeys',
  timestamps: false,
  indexes: [{ name: 'idempotencykeys_id_index', fields: ['id'] }],
});

IdempotencyKey.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(IdempotencyKey, { foreignKey: 'user_id' });

export default IdempotencyKey;
