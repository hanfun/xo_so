import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, validDay } from './config.js';

export function dayPath(day, dataDir = DATA_DIR) {
  if (!validDay(day)) throw new Error('Ngày phải là YYYY-MM-DD');
  return path.join(dataDir, `${day}.json`);
}
export async function readDay(day, dataDir = DATA_DIR) {
  try { return JSON.parse(await readFile(dayPath(day, dataDir), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeDay(day, report, dataDir = DATA_DIR) {
  await mkdir(dataDir, { recursive: true });
  const target = dayPath(day, dataDir);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
}
export async function listHistory(dataDir = DATA_DIR) {
  let files;
  try { files = await readdir(dataDir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files.filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse();
}
function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function exportCsv(report) {
  const rows = [['date', 'region', 'province', 'name', 'prize', 'position', 'number', 'source']];
  for (const draw of report.results || []) {
    for (const [tier, numbers] of Object.entries(draw.prizes)) {
      numbers.forEach((number, i) => rows.push([
        draw.date, draw.region, draw.province, draw.name, tier, i + 1, `="${number}"`, draw.source || report.source_url
      ]));
    }
  }
  // UTF-8 BOM for Excel; formula-like numbers preserve leading zeroes when opened in Excel.
  // Values originate from strict numeric validation; they cannot contain executable formulas.
  return '\uFEFF' + rows.map(fields => fields.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}
