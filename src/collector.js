import { fetchDay, normalizePayload } from './lottery.js';
import { readDay, writeDay } from './store.js';
import { validDay } from './config.js';

export function createCollector({ dataDir, fetcher = fetchDay, minIntervalMs = 5 * 60_000 } = {}) {
  const inFlight = new Map();
  const lastAttempt = new Map();
  const lastErrors = new Map();
  async function collect(day, { force = false } = {}) {
    if (!validDay(day)) throw new Error('Ngày không hợp lệ');
    if (inFlight.has(day)) return inFlight.get(day);
    const existing = await readDay(day, dataDir);
    const lastFetch = existing?.fetched_at ? Date.parse(existing.fetched_at) : 0;
    const sinceLast = Date.now() - Math.max(lastAttempt.get(day) || 0, lastFetch || 0);
    if (!force && sinceLast >= 0 && sinceLast < minIntervalMs) {
      if (existing) return { ...existing, cached: true };
      throw new Error(`Vừa thử cập nhật. Vui lòng thử lại sau ${Math.ceil((minIntervalMs - sinceLast) / 1000)} giây.`);
    }
    const promise = (async () => {
      lastAttempt.set(day, Date.now());
      try {
        const { payload, sourceUrl } = await fetcher(day);
        const report = normalizePayload(day, payload, sourceUrl, existing);
        await writeDay(day, report, dataDir);
        lastErrors.delete(day);
        return report;
      } catch (e) {
        lastErrors.set(day, e.message);
        throw e;
      }
    })();
    inFlight.set(day, promise);
    try { return await promise; }
    finally { inFlight.delete(day); }
  }
  return { collect, getLastError: day => lastErrors.get(day) || null };
}
