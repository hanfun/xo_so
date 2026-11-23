import { fetchDay, normalizePayload, extractSouthPayload } from './lottery.js';
import { readDay as readJsonDay, writeDay as writeJsonDay } from './store.js';
import { validDay } from './config.js';

function fileStore(dataDir) {
  return {
    readDay: day => readJsonDay(day, dataDir),
    writeDay: (day, report) => writeJsonDay(day, report, dataDir)
  };
}
export function createCollector({
  store = null, dataDir, fetcher = fetchDay, minIntervalMs = 5 * 60_000,
  backupJson = Boolean(store)
} = {}) {
  const db = store || fileStore(dataDir);
  const inFlight = new Map();
  const lastAttempt = new Map();
  const lastErrors = new Map();
  async function collect(day, { force = false } = {}) {
    if (!validDay(day)) throw new Error('Ngày không hợp lệ');
    if (inFlight.has(day)) return inFlight.get(day);
    const existing = await db.readDay(day);
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
        const southPayload = extractSouthPayload(day, payload);
        const report = normalizePayload(day, southPayload, sourceUrl, existing);
        await db.writeDay(day, report, southPayload);
        // Local JSON is an optional backup only; the MySQL transaction is authoritative.
        if (backupJson) {
          try { await writeJsonDay(day, report, dataDir); }
          catch (e) { console.warn(`[BACKUP] ${day}: ${e.message}`); }
        }
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
