import { vnClock, prevDay } from './config.js';

// Cron-like recurring slots in Vietnam local time. One scheduler remains active
// while the Node process runs; you never need to recreate a cron every day.
export const SLOTS = [
  { hour: 19, minute: 15, offset: 0, label: '19:15' },
  { hour: 20, minute: 0, offset: 0, label: '20:00' },
  { hour: 21, minute: 0, offset: 0, label: '21:00' },
  { hour: 7, minute: 30, offset: -1, label: '07:30 (quét bù hôm qua)' }
];

export function createScheduler({ run, clock = vnClock, onError = console.error, slots = SLOTS }) {
  const fired = new Set();
  let timer;
  async function tick() {
    const { day, hour, minute } = clock();
    for (const key of fired) if (!key.startsWith(day)) fired.delete(key);
    for (const slot of slots) {
      if (hour !== slot.hour || minute !== slot.minute) continue;
      const key = `${day}-${slot.hour}:${slot.minute}-${slot.offset}`;
      if (fired.has(key)) continue;
      fired.add(key);
      const target = slot.offset === -1 ? prevDay(day) : day;
      try { await run(target, slot); }
      catch (e) { onError(e); }
    }
  }
  return {
    start() { if (!timer) { void tick(); timer = setInterval(() => void tick(), 20_000); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    tick
  };
}
