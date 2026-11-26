import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withJsonFallback } from '../src/database.js';

test('JSON results survive an outage and remain visible after MySQL reconnects', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'xskt-fallback-'));
  const day = '2026-11-26';
  const report = { date: day, results: [{ prizes: { giai8: ['07'] } }] };
  let online = false;
  const rows = new Map();
  function checkConnection() {
    if (!online) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  }
  const store = withJsonFallback({
    readDay(day) { checkConnection(); return rows.get(day) ?? null; },
    listHistory() { checkConnection(); return [...rows.keys()]; },
    writeDay(day, report) { checkConnection(); rows.set(day, report); }
  }, dataDir);
  try {
    await store.writeDay(day, report);
    assert.deepEqual(await store.readDay(day), report);
    assert.deepEqual(await store.listHistory(), [day]);
    online = true;
    const nextDay = '2026-11-27';
    await store.writeDay(nextDay, { date: nextDay, results: [] });
    assert.ok(rows.has(nextDay));
    assert.deepEqual(await store.readDay(day), report);
    assert.deepEqual(await store.listHistory(), [nextDay, day]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
