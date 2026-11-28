import { fetchDay, extractSouthPayload, normalizePayload } from './lottery-core.js';
import { vietnamClock, mergeReports, isCompleteReport, isPastOrToday } from './pages-sync-core.js';

const prefix = 'xskt-browser-day-v1:';
const retryMs = 300_000;
const read = (storage,key) => {
  try { return JSON.parse(storage?.getItem(key) ?? 'null'); } catch { return null; }
};
const save = (storage,key,value) => {
  try { if (!storage) return false; storage.setItem(key,JSON.stringify(value)); return true; }
  catch { return false; }
};
function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}
export async function fetchBrowserDay(day, fetchImpl = fetch) {
  return fetchDay(day, { retries: 1, fetchImpl: (url,options) => {
    // No custom User-Agent or authorization headers; use a simple CORS GET.
    return fetchImpl(url,{ method:'GET', headers:{Accept:'application/json'},
      mode:'cors', credentials:'omit', cache:'no-store', signal:options.signal });
  }});
}
export function createBrowserSync({ storage = browserStorage(), now = () => new Date(),
  fetchSource = fetchBrowserDay, fetchImpl = (...args) => fetch(...args), workerUrl = '' } = {}) {
  const pending = new Map(), lastAttempt = new Map();
  return async function sync(days, day) {
    const clock = vietnamClock(now());
    if (!isPastOrToday(day,clock.day)) return;
    const key = prefix + day;
    const published = days[day];
    if (isCompleteReport(published,day) && !['browser','memory'].includes(published.storage_mode)) return;
    const cache = read(storage,key);
    if (cache?.report?.date === day) {
      const merged = mergeReports(published,cache.report,day);
      if (merged.changed) days[day] = {...merged.report,storage_mode:'browser'};
    }
    if (!workerUrl && isCompleteReport(days[day],day)) return;
    if (day === clock.day && clock.hour < 17) return;
    if (pending.has(day)) return pending.get(day);
    const timestamp = now().getTime();
    const attempt = Math.max(lastAttempt.get(day) || 0,
      Number(cache?.attemptAt) || 0);
    if (timestamp - attempt >= 0 && timestamp - attempt < retryMs) {
      if (cache?.status === 'source_unavailable' && !isCompleteReport(days[day],day))
        days[day] = {...(days[day] ?? {date:day,count:0,results:[]}),sync_status:'source_unavailable'};
      return;
    }
    const promise = (async () => {
      let workerFailed = false;
      if (workerUrl) {
        try {
          const url = new URL('/sync',workerUrl);
          url.searchParams.set('date',day);
          const res = await fetchImpl(url, {signal:AbortSignal.timeout(45_000)});
          if (!res.ok) throw Error('Worker HTTP ' + res.status);
          const update = await res.json();
          if (update.date !== day) throw Error('Worker returned wrong date');
          if (update.report) {
            const merged = mergeReports(days[day],update.report,day);
            if (merged.changed) {
              const githubCodes = new Set(update.report.results?.map(row=>row.province) ?? []);
              const browserOnly = merged.report.results.some(row=>!githubCodes.has(row.province));
              days[day] = {...merged.report,storage_mode:browserOnly?'browser':'github'};
            }
            if (isCompleteReport(update.report,day)) {
              days[day] = {...update.report,storage_mode:'github'};
              return;
            }
          }
          workerFailed = !['updated','complete','no_change','before_opening'].includes(update.status);
        } catch { workerFailed = true; }
      }
      if (isCompleteReport(days[day],day)) return;
      // An available Worker remains authoritative. Direct fetch is a fallback.
      if (workerUrl && !workerFailed) return;
      try {
        const {payload,sourceUrl} = await fetchSource(day,fetchImpl);
        const incoming = normalizePayload(day,extractSouthPayload(day,payload),sourceUrl);
        const merged = mergeReports(days[day],incoming,day);
        if (merged.changed) days[day] = {...merged.report,storage_mode:'browser',sync_status:'updated'};
        else days[day] = {...(days[day] ?? {date:day,count:0,results:[]}),sync_status:'no_change'};
      } catch {
        days[day] = {...(days[day] ?? {date:day,count:0,results:[]}),sync_status:'source_unavailable'};
      }
    })();
    lastAttempt.set(day,timestamp);
    pending.set(day,promise);
    try { await promise; }
    finally {
      const report = days[day];
      // Never persist empty reports as valid results, only the retry metadata.
      const persisted = save(storage,key,{attemptAt:timestamp,status:report?.sync_status,
        report:report?.storage_mode === 'browser' && report.count ? report : null});
      if (report?.storage_mode === 'browser' && !persisted) report.storage_mode = 'memory';
      if (pending.get(day) === promise) pending.delete(day);
    }
  };
}
