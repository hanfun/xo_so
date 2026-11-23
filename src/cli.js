import { createCollector } from './collector.js';
import { vnClock, validDay, prevDay } from './config.js';

const args = process.argv.slice(2);
const today = vnClock().day;
const day = args.find(a => !a.startsWith('--')) || today;
if (!validDay(day)) {
  console.error('Cách dùng: npm run collect -- YYYY-MM-DD [--yesterday]');
  process.exit(1);
}
const collector = createCollector();
let fail = false;
for (const target of args.includes('--yesterday') ? [day, prevDay(day)] : [day]) {
  try {
    const r = await collector.collect(target);
    console.log(`${target}: ${r.count} đài, ${r.status}, ${r.issues.length} cảnh báo`);
  } catch (e) {
    fail = true;
    console.error(`${target}: ${e.message}`);
  }
}
if (fail) process.exitCode = 1;
