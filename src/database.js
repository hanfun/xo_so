import mysql from 'mysql2/promise';
import { createMysqlStore } from './mysql-store.js';

export function mysqlConfig({ withDatabase = true } = {}) {
  const name = process.env.DB_DATABASE || 'xskt';
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('DB_DATABASE chỉ được chứa chữ cái, chữ số và dấu gạch dưới.');
  }
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z'
  };
  if (withDatabase) config.database = name;
  return config;
}
export async function createConfiguredStore() {
  const pool = mysql.createPool({
    ...mysqlConfig(), connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    waitForConnections: true, queueLimit: 0
  });
  try {
    await pool.query('SELECT 1');
    return createMysqlStore({ pool });
  } catch (e) {
    await pool.end();
    throw new Error(`Không kết nối được MySQL: ${e.message}. Hãy cấu hình .env và chạy "npm run db:init".`);
  }
}
