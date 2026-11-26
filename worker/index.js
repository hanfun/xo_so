import { fetchDay } from '../src/lottery-core.js';
import { syncToday, vietnamClock, isCompleteReport } from '../src/pages-sync-core.js';

const OWNER_REPO = 'hanfun/xo_so';
const ORIGIN = 'https://hanfun.github.io';
const inFlight = new Map();

function encode(value) {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}
function decode(value) {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function githubStore(token) {
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  const headers = {
    Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'xo-so-sync-worker'
  };
  const path = day => 'https://api.github.com/repos/' + OWNER_REPO + '/contents/data/' + day + '.json';
  return {
    async read(day) {
      const response = await fetch(path(day) + '?ref=main', { headers, cache: 'no-store' });
      if (response.status === 404) return { report: null, sha: null };
      if (!response.ok) throw new Error('GitHub read HTTP ' + response.status);
      const file = await response.json();
      if (file.encoding !== 'base64' || !file.sha) throw new Error('Invalid GitHub file');
      return { report: JSON.parse(decode(file.content)), sha: file.sha };
    },
    async write(day, report, sha) {
      const body = { message: 'data: cập nhật XSMN ' + day, branch: 'main',
        content: encode(JSON.stringify(report, null, 2) + '\n') };
      if (sha) body.sha = sha;
      const response = await fetch(path(day), {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if ([409, 422].includes(response.status)) return false;
      if (!response.ok) throw new Error('GitHub write HTTP ' + response.status);
      return true;
    }
  };
}
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
    const now = new Date(), { day } = vietnamClock(now);
    // Cache per Cloudflare location + isolate coalescing; SHA protects concurrent writes.
    const key = new Request(url.origin + '/sync-cache?date=' + day);
    const cache = caches.default;
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      if (!inFlight.has(day)) {
        const task = syncToday({ ...githubStore(env.GITHUB_TOKEN), fetchDay, now });
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
