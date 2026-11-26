import { createConfiguredStore } from './database.js';
import { createCollector } from './collector.js';
import { createAppServer } from './server.js';
import { createScheduler, SLOTS } from './scheduler.js';
import { HOST, PORT, vnClock, prevDay } from './config.js';

async function main() {
  const store = await createConfiguredStore({ jsonFallback: true });
  const collector = createCollector({ store });
  const server = createAppServer({ collector, store });
  const scheduler = createScheduler({
    run: async (day, slot) => {
      console.log(`[CRON ${slot.label}] XSMN ${day}`);
      const report = await collector.collect(day);
      console.log(`[CRON] ${day}: ${report.count} đài, ${report.status}`);
    },
    onError: e => console.error('[CRON]', e.message)
  });
  server.listen(PORT, HOST, () => {
    console.log(`XSMN: http://${HOST}:${PORT} | MySQL + JSON fallback`);
    console.log(`Lưu MySQL local | giờ Việt Nam | lịch ${SLOTS.map(s => s.label).join(', ')}`);
    scheduler.start();
    const clock = vnClock();
    // South draws finish in the afternoon; before 17:00 use yesterday.
    const seed = clock.hour >= 17 ? clock.day : prevDay(clock.day);
    void collector.collect(seed).catch(e => console.warn('[KHỞI ĐỘNG]', e.message));
  });
  async function shutdown() {
    scheduler.stop();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  }
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
