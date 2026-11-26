// Smoke-test the exact built Pages module graph before publishing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../pages-dist/', import.meta.url);
const html = await readFile(new URL('today.html',root),'utf8');
const entry = html.match(/src="(\.\/today\.js\?v=[a-f0-9]+)"/)?.[1];
assert.ok(entry,'today.html must have a cache-versioned entry');
const script = await readFile(new URL(entry,root),'utf8');
const apiPath = script.match(/import\('(\.\/pages-api\.js\?v=[a-f0-9]+)'\)/)?.[1];
assert.ok(apiPath,'today.js must import matching version of pages-api.js');
globalThis.location = { origin:'https://hanfun.github.io' };
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const resource = new URL(url);
  // Mock unavailable external sources; CI never depends on live provider/CORS.
  if (resource.protocol === 'https:') return new Response('',{status:503});
  assert.equal(resource.protocol,'file:');
  return new Response(await readFile(fileURLToPath(resource)), {status:200});
};
try {
  const { pagesApi } = await import(new URL(apiPath,root));
  const status = await pagesApi('/api/status');
  assert.match(status.today,/^\d{4}-\d{2}-\d{2}$/);
  assert.ok(status.today_stations.length>=3);
  const report=await pagesApi('/api/day?date='+status.today);
  assert.equal(report.date,status.today);
  assert.ok(Array.isArray(report.results));
  const history=await pagesApi('/api/history');
  assert.ok(history.dates.length>0,'published JSON contains history');
  const old=await pagesApi('/api/day?date='+history.dates[0]);
  assert.ok(Array.isArray(old.results));
  const daily=await pagesApi('/api/prize8/daily?date='+status.today);
  assert.ok(daily.scheduled_details.length>=3);
  console.log('Pages smoke test passed: today.html entry, module graph, status, JSON, daily ranking.');
} finally { globalThis.fetch = originalFetch; }
