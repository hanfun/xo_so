import { createCollector } from './collector.js';
import { createAppServer } from './server.js';
import { createScheduler, SLOTS } from './scheduler.js';
import { HOST, PORT, vnClock, prevDay } from './config.js';

const collector = createCollector();
const server = createAppServer({ collector });
const scheduler = createScheduler({
  run: async (day, slot) => {
    console.log(`[CRON ${slot.label}] Đang lấy kết quả ${day}`);
    const report = await collector.collect(day);
    console.log(`[CRON] ${day}: ${report.count} đài, trạng thái ${report.status}`);
  },
  onError: e => console.error('[CRON]', e.message)
});

server.listen(PORT, HOST, () => {
  console.log(`\nXSKT LOCAL đang chạy: http://${HOST}:${PORT}`);
  console.log(`Múi giờ lịch quét: Asia/Ho_Chi_Minh`);
  console.log(`Lịch: ${SLOTS.map(s => s.label).join(' | ')} (giờ VN)`);
  console.log('Bấm Ctrl+C để dừng. Dừng máy/app thì lịch quét cũng dừng.\n');
  scheduler.start();
  // Seed the latest published day, but never disguise it as today's data.
  const clock = vnClock();
  const seed = clock.hour >= 19 ? clock.day : prevDay(clock.day);
  void collector.collect(seed).then(r => {
    console.log(`[KHỞI ĐỘNG] Đã lưu ${r.count} đài ngày ${seed}`);
  }).catch(e => console.warn(`[KHỞI ĐỘNG] ${seed}: ${e.message}`));
});

function shutdown() { scheduler.stop(); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
