import { fetchDay } from '../src/lottery-core.js';
import { syncDate, vietnamClock, isCompleteReport, isPastOrToday } from '../src/pages-sync-core.js';

import { githubResultsStore } from '../src/github-results-store.js';

const ORIGIN = 'https://hanfun.github.io';
const inFlight = new Map();
function json(body, status = 200, ttl = 0) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ORIGIN, 'Vary': 'Origin',
    'Cache-Control': ttl ? 'public, max-age=' + ttl : 'no-store'
  }});
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.headers.get('Origin') !== ORIGIN) return json({ error: 'Forbidden' }, 403);
    if (url.pathname !== '/sync' || request.method !== 'GET') return json({ error: 'Not found' }, 404);
    const now = new Date(), { day: today } = vietnamClock(now);
    const day = url.searchParams.get('date') ?? today;
    if (!isPastOrToday(day,today)) return json({error:'Invalid date'},400);
    // Limit anonymous writes to the recent 30-day window; older dates can be read directly by the browser.
    const earliest = new Date(Date.parse(today+'T00:00:00Z')-29*86400000).toISOString().slice(0,10);
    if (day < earliest) return json({error:'Date outside sync window'},400);
    // Cache per Cloudflare location + isolate coalescing; SHA protects concurrent writes.
    const key = new Request(url.origin + '/sync-cache?date=' + day);
    const cache = caches.default;
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      if (!inFlight.has(day)) {
        const task = syncDate({ ...githubResultsStore(env.GITHUB_TOKEN), fetchDay, now, date:day });
        inFlight.set(day, task);
      }
      const result = await inFlight.get(day);
      const ttl = isCompleteReport(result.report, day) ? 3600 : 300;
      const response = json(result, 200, ttl);
      ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
      return response;
    } catch (err) {
      console.error('Sync failed:', err.message);
      return json({ date: day, status: 'sync_error' }, 502);
    } finally { inFlight.delete(day); }
  }
};
