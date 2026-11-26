import mysql from 'mysql2/promise';
import { createMysqlStore } from './mysql-store.js';
import { listHistory, readDay, writeDay } from './store.js';

const connectionErrors = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_CON_COUNT_ERROR'
]);

export function withJsonFallback(mysqlStore, dataDir) {
  async function fromMysql(operation, fallback) {
    try {
      return await operation();
    } catch (error) {
      if (!connectionErrors.has(error.code)) throw error;
      return fallback();
    }
  }

  return {
    ...mysqlStore,
    storageMode: 'mysql-with-json-fallback',
    async readDay(day) {
      const local = await readDay(day, dataDir);
      const remote = await fromMysql(() => mysqlStore.readDay(day), () => null);
      if (!remote || (local && Date.parse(local.fetched_at) > Date.parse(remote.fetched_at))) {
        return local;
      }
      return remote;
    },
    async listHistory() {
      const [remote, local] = await Promise.all([
        fromMysql(() => mysqlStore.listHistory(), () => []),
        listHistory(dataDir)
      ]);
      return [...new Set([...remote, ...local])].sort().reverse();
    },
    writeDay(day, report, payload) {
      return fromMysql(() => mysqlStore.writeDay(day, report, payload), async () => {
        await writeDay(day, report, dataDir);
        console.warn(`[JSON] Đã lưu kết quả ${day} trong thời gian MySQL gián đoạn.`);
      });
    }
  };
}

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
export async function createConfiguredStore({ jsonFallback = false } = {}) {
  const pool = mysql.createPool({
    ...mysqlConfig(), connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    waitForConnections: true, queueLimit: 0, connectTimeout: 3000
  });
  if (jsonFallback) return withJsonFallback(createMysqlStore({ pool }));
  try {
    await pool.query('SELECT 1');
    return createMysqlStore({ pool });
  } catch (e) {
    await pool.end();
    throw new Error(`Không kết nối được MySQL: ${e.message}. Hãy cấu hình .env và chạy "npm run db:init".`);
  }
}
