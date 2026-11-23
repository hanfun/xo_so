import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { DATA_DIR, vnClock } from './config.js';
import { mysqlConfig } from './database.js';

const TABLES = [
  { name: 'provinces', columns: ['id', 'region', 'code', 'name', 'created_at'], jsonCols: [] },
  { name: 'draws', columns: ['id', 'province_id', 'draw_date', 'ticket_type', 'source_url', 'collected_at'], jsonCols: [] },
  { name: 'prize_results', columns: ['id', 'draw_id', 'prize_code', 'position', 'number'], jsonCols: [] },
  { name: 'source_snapshots', columns: ['draw_date', 'source_url', 'raw_json', 'report_json', 'provider_count', 'status', 'fetched_at', 'updated_at'], jsonCols: ['raw_json', 'report_json'] },
  { name: 'model_versions', columns: ['id', 'model_key', 'version', 'description', 'parameters_json', 'training_start', 'training_end', 'created_at'], jsonCols: ['parameters_json'] },
  { name: 'features', columns: ['id', 'province_id', 'feature_date', 'cutoff_date', 'feature_key', 'feature_value', 'computed_at'], jsonCols: [] },
  { name: 'predictions', columns: ['id', 'model_version_id', 'province_id', 'target_date', 'prediction_type', 'predicted_value', 'confidence', 'training_cutoff', 'generated_at', 'metadata_json'], jsonCols: ['metadata_json'] },
  { name: 'prediction_evaluations', columns: ['prediction_id', 'actual_draw_id', 'is_hit', 'evaluation_json', 'evaluated_at'], jsonCols: ['evaluation_json'] }
];

async function exportDb(targetFile) {
  const outPath = path.resolve(targetFile || path.join(DATA_DIR, `xskt-backup-${vnClock().day}.json`));
  const conn = await mysql.createConnection(mysqlConfig());
  try {
    const tables = {};
    const counts = {};
    for (const t of TABLES) {
      const cols = t.columns.map(c => `\`${c}\``).join(', ');
      const [rows] = await conn.query(`SELECT ${cols} FROM \`${t.name}\``);
      tables[t.name] = rows;
      counts[t.name] = rows.length;
    }
    const payload = {
      format: 'xskt-db-backup-v1',
      exported_at: new Date().toISOString(),
      database: mysqlConfig().database,
      counts,
      tables
    };
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload), 'utf8');
    console.log(`Đã export toàn bộ database ra: ${outPath}`);
    for (const [name, count] of Object.entries(counts)) {
      console.log(`  - ${name}: ${count} dòng`);
    }
  } finally {
    await conn.end();
  }
}

async function importDb(sourceFile, { truncate = false } = {}) {
  if (!sourceFile) {
    throw new Error('Thiếu đường dẫn file JSON. Cách dùng: npm run db:import -- data/xskt-backup-YYYY-MM-DD.json [--replace]');
  }
  const inPath = path.resolve(sourceFile);
  const raw = await readFile(inPath, 'utf8');
  const payload = JSON.parse(raw);
  if (payload?.format !== 'xskt-db-backup-v1' || !payload.tables || typeof payload.tables !== 'object') {
    throw new Error('File JSON không đúng định dạng xskt-db-backup-v1');
  }

  const conn = await mysql.createConnection(mysqlConfig());
  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    if (truncate) {
      for (const t of [...TABLES].reverse()) {
        await conn.query(`DELETE FROM \`${t.name}\``);
      }
    }
    const BATCH = 500;
    for (const t of TABLES) {
      const rows = payload.tables[t.name] || [];
      if (!rows.length) {
        console.log(`  - ${t.name}: 0 dòng (bỏ qua)`);
        continue;
      }
      const colList = t.columns.map(c => `\`${c}\``).join(', ');
      const updateList = t.columns.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
      const rowPlaceholder = `(${t.columns.map(() => '?').join(', ')})`;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values = [];
        for (const row of chunk) {
          for (const col of t.columns) {
            let val = row[col] ?? null;
            if (val !== null && t.jsonCols.includes(col) && typeof val !== 'string') {
              val = JSON.stringify(val);
            }
            values.push(val);
          }
        }
        const placeholders = Array(chunk.length).fill(rowPlaceholder).join(', ');
        await conn.query(
          `INSERT INTO \`${t.name}\` (${colList}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updateList}`,
          values
        );
      }
      console.log(`  - ${t.name}: đã import ${rows.length} dòng`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.commit();
    console.log(`Import hoàn tất từ: ${inPath}`);
  } catch (e) {
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    await conn.end();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const replace = rest.includes('--replace');
const fileArg = rest.find(a => !a.startsWith('--'));

if (cmd === 'export') {
  await exportDb(fileArg);
} else if (cmd === 'import') {
  await importDb(fileArg, { truncate: replace });
} else {
  console.error('Cách dùng:');
  console.error('  npm run db:export -- [đường-dẫn-file.json]');
  console.error('  npm run db:import -- <đường-dẫn-file.json> [--replace]');
  process.exit(1);
}

