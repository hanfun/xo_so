import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { mysqlConfig } from './database.js';

const conf = mysqlConfig({ withDatabase: false });
const dbName = process.env.DB_DATABASE || 'xskt';
const admin = await mysql.createConnection(conf);
try {
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
} finally { await admin.end(); }

const client = await mysql.createConnection(mysqlConfig());
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations/001_initial.sql');
try {
  const sql = await readFile(file, 'utf8');
  // SQL migration consists of independent CREATE TABLE IF NOT EXISTS statements.
  const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean);
  for (const statement of statements) await client.query(statement);
  console.log(`MySQL database ${dbName} đã sẵn sàng: ${statements.length} câu lệnh schema.`);
} finally { await client.end(); }
