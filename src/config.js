import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.XSKT_DATA_DIR || path.join(root, 'data'));
export const PUBLIC_DIR = path.join(root, 'public');
export const TIMEZONE = 'Asia/Ho_Chi_Minh';
export const API_BASE = (process.env.XSKT_API_BASE_URL || 'https://doveso.submit69.com/api').replace(/\/+$/, '');
export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
export function vnClock(at = new Date()) {
  const parts = Object.fromEntries(fmt.formatToParts(at).map(p => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}
export function prevDay(day) {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
export function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}
