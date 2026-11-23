import { createConfiguredStore } from './database.js';
import { createCollector } from './collector.js';
import { vnClock, validDay, prevDay } from './config.js';

const args = process.argv.slice(2);
const day = args.find(a => !a.startsWith('--')) || vnClock().day;
if (!validDay(day)) {
  console.error('Cách dùng: npm run collect -- YYYY-MM-DD [--yesterday]');
  process.exit(1);
}
const store = await createConfiguredStore();
try {
  const collector = createCollector({ store });
  let failed = false;
  for (const target of args.includes('--yesterday') ? [day, prevDay(day)] : [day]) {
    try {
      const r = await collector.collect(target, { force: args.includes('--force') });
      console.log(`${target}: ${r.count} đài XSMN, ${r.status}`);
    } catch (e) {
      console.error(`${target}: ${e.message}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
} finally { await store.close(); }
