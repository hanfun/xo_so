import { fetchDay, extractSouthPayload, normalizePayload } from './lottery-core.js';
import { vietnamClock, mergeReports, isCompleteReport } from './pages-sync-core.js';

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
  let pending, lastAttempt;
  return async function sync(days, today) {
    const clock = vietnamClock(now());
    if (clock.day !== today) return;
    const key = prefix + today;
    const published = days[today];
    if (isCompleteReport(published,today) && published.storage_mode !== 'browser') return;
    const cache = read(storage,key);
    if (cache?.report?.date === today) {
      const merged = mergeReports(published,cache.report,today);
      if (merged.changed) days[today] = {...merged.report,storage_mode:'browser'};
    }
    if (!workerUrl && isCompleteReport(days[today],today)) return;
    if (clock.hour < 17) return;
    if (pending?.date === today) return pending.promise;
    const timestamp = now().getTime();
    const attempt = Math.max(lastAttempt?.date === today ? lastAttempt.at : 0,
      Number(cache?.attemptAt) || 0);
    if (timestamp - attempt >= 0 && timestamp - attempt < retryMs) {
      if (cache?.status === 'source_unavailable' && !isCompleteReport(days[today],today))
        days[today] = {...(days[today] ?? {date:today,count:0,results:[]}),sync_status:'source_unavailable'};
      return;
    }
    const promise = (async () => {
      let workerFailed = false;
      if (workerUrl) {
        try {
          const res = await fetchImpl(new URL('/sync',workerUrl), {signal:AbortSignal.timeout(45_000)});
          if (!res.ok) throw Error('Worker HTTP ' + res.status);
          const update = await res.json();
          if (update.date !== today) throw Error('Worker returned wrong date');
          if (update.report) {
            const merged = mergeReports(days[today],update.report,today);
            if (merged.changed) days[today] = {...merged.report,storage_mode:'github'};
            if (isCompleteReport(update.report,today)) {
              days[today] = {...update.report,storage_mode:'github'};
              return;
            }
          }
          workerFailed = !['updated','complete','no_change','before_opening'].includes(update.status);
        } catch { workerFailed = true; }
      }
      if (isCompleteReport(days[today],today)) return;
      // An available Worker remains authoritative. Direct fetch is a fallback.
      if (workerUrl && !workerFailed) return;
      try {
        const {payload,sourceUrl} = await fetchSource(today,fetchImpl);
        const incoming = normalizePayload(today,extractSouthPayload(today,payload),sourceUrl);
        const merged = mergeReports(days[today],incoming,today);
        if (merged.changed) days[today] = {...merged.report,storage_mode:'browser',sync_status:'updated'};
        else days[today] = {...(days[today] ?? {date:today,count:0,results:[]}),sync_status:'no_change'};
      } catch {
        days[today] = {...(days[today] ?? {date:today,count:0,results:[]}),sync_status:'source_unavailable'};
      }
    })();
    lastAttempt = {date:today,at:timestamp};
    pending = {date:today,promise};
    try { await promise; }
    finally {
      const report = days[today];
      // Never persist empty reports as valid results, only the retry metadata.
      const persisted = save(storage,key,{attemptAt:timestamp,status:report?.sync_status,
        report:report?.storage_mode === 'browser' && report.count ? report : null});
      if (report?.storage_mode === 'browser' && !persisted) report.storage_mode = 'memory';
      if (pending?.promise === promise) pending = null;
    }
  };
}
