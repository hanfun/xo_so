import { vnClock, prevDay } from './config.js';

export const SLOTS = [
  { hour: 17, minute: 0, offset: 0, label: '17:00' },
  { hour: 18, minute: 0, offset: 0, label: '18:00' },
  { hour: 19, minute: 0, offset: 0, label: '19:00' },
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
