import { createConfiguredStore } from './database.js';
import { createCollector } from './collector.js';
import { validDay, nextDay, vnClock } from './config.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [from, to] = args;
if (!validDay(from) || !validDay(to) || from > to || to > vnClock().day) {
  console.error('Cách dùng: npm run history:import -- YYYY-MM-DD YYYY-MM-DD [--force]');
  process.exit(1);
}
const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
if (days > 366) {
  console.error('Mỗi lần chỉ nhập tối đa 366 ngày để hạn chế áp lực lên nguồn.');
  process.exit(1);
}
const force = process.argv.includes('--force');
const store = await createConfiguredStore();
const collector = createCollector({ store, minIntervalMs: 5 * 60_000 });
let ok = 0, skipped = 0, errors = 0;
try {
  for (let day = from; day <= to; day = nextDay(day)) {
    if (!force && await store.readDay(day)) {
      console.log(`${day}: đã có dữ liệu — bỏ qua (dùng --force để quét lại)`);
      skipped++;
      continue;
    }
    try {
      const report = await collector.collect(day, { force });
      console.log(`${day}: đã lưu ${report.count} đài, ${report.status}`);
      ok++;
    } catch (e) {
      errors++;
      console.warn(`${day}: ${e.message}`);
    }
    // Avoid rapidly requesting many different dates from the free provider.
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
} finally { await store.close(); }
console.log(`Tổng kết: ${ok} ngày lưu, ${skipped} bỏ qua, ${errors} lỗi.`);
if (errors) process.exitCode = 1;
