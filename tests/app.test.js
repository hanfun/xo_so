import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDraw, normalizePayload, fetchDay } from '../src/lottery.js';
import { createCollector } from '../src/collector.js';
import { createAppServer } from '../src/server.js';
import { createScheduler } from '../src/scheduler.js';
import { exportCsv, readDay, listHistory } from '../src/store.js';

const DAY = '2026-11-22';
function fakeDraw(region, province, name) {
  const spec = region === 'MB' ? {
    giaidb:[1,5],giai1:[1,5],giai2:[2,5],giai3:[6,5],giai4:[4,4],giai5:[6,4],giai6:[3,3],giai7:[4,2]
  } : {
    giaidb:[1,6],giai1:[1,5],giai2:[1,5],giai3:[2,5],giai4:[7,5],giai5:[1,4],giai6:[3,4],giai7:[1,3],giai8:[1,2]
  };
  return { province, name, region, date: DAY, prizes: Object.fromEntries(
    Object.entries(spec).map(([tier,[count,digits]]) => [tier, Array.from({length:count}, () => '0'.repeat(digits))])
  ) };
}
function samplePayload() {
  return { date:DAY,count:3,results:{
    'mien-bac':fakeDraw('MB','mien-bac','Miền Bắc'),
    'da-nang':fakeDraw('MT','da-nang','Đà Nẵng'),
    'da-lat':fakeDraw('MN','da-lat','Đà Lạt')
  } };
}

test('validateDraw keeps exact leading zeroes and correct prize counts', () => {
  const draw = samplePayload().results['mien-bac'];
  const result = validateDraw('mien-bac', draw, DAY);
  assert.equal(result.draw.prizes.giaidb[0], '00000');
  assert.equal(result.draw.prizes.giai7[0], '00');
});

test('validateDraw rejects incomplete / malformed data', () => {
  const draw = fakeDraw('MN','da-lat','Đà Lạt');
  draw.prizes.giai4 = ['12345'];
  assert.match(validateDraw('da-lat',draw,DAY).error, /chưa đủ/);
  const draw2 = fakeDraw('MB','mien-bac','Miền Bắc');
  draw2.prizes.giaidb[0] = '123';
  assert.match(validateDraw('mien-bac',draw2,DAY).error, /chữ số/);
});

test('normalizePayload sets completion based only on validated provider count', () => {
  const report = normalizePayload(DAY,samplePayload(),'https://example.test/x.json');
  assert.equal(report.status,'complete_by_provider_count');
  assert.deepEqual(report.region_counts,{MB:1, MT:1, MN:1});
  const broken = samplePayload();
  broken.results['da-lat'].prizes.giaidb[0] = 'notnum';
  const partial = normalizePayload(DAY,broken,'https://example.test/x.json');
  assert.equal(partial.status,'needs_review');
  assert.equal(partial.count,2);
  assert.equal(partial.issues.length,1);
});

test('previously verified results remain when provider returns partial data', () => {
  const old = normalizePayload(DAY,samplePayload(),'https://example.test/x.json');
  const payload = samplePayload();
  delete payload.results['da-nang'];
  payload.count = 2;
  const merged = normalizePayload(DAY,payload,'https://example.test/x.json',old);
  assert.equal(merged.count,3);
  assert.equal(merged.status,'needs_review');
});

test('collector stores JSON and throttles repeat fetches for 5 minutes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'xskt-test-'));
  try {
    let called = 0;
    const collector = createCollector({dataDir,fetcher:async () => {
      called++;
      return {payload:samplePayload(),sourceUrl:'https://example.test/source'};
    }});
    const first = await collector.collect(DAY);
    const second = await collector.collect(DAY);
    assert.equal(called,1);
    assert.equal(first.count,3);
    assert.equal(second.cached,true);
    assert.deepEqual(await listHistory(dataDir),[DAY]);
    assert.equal((await readDay(DAY,dataDir)).results[0].prizes.giaidb[0],'00000');
  } finally { await rm(dataDir,{recursive:true,force:true}); }
});

test('CSV download retains leading zeros in spreadsheet-friendly formula', () => {
  const result = normalizePayload(DAY,samplePayload(),'https://example.test/x.json');
  const csv = exportCsv(result);
  assert.match(csv, /"=""00000"""/);
  assert.ok(csv.startsWith('\uFEFF'));
});

test('scheduler executes once at slot and backfills previous date', async () => {
  const runs = [];
  const scheduler = createScheduler({
    run:async (day,slot) => {runs.push([day,slot.label]);},
    clock:()=>({day:'2026-11-23',hour:7,minute:30}),
    onError:e => {throw e;}
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(runs, [['2026-11-22','07:30 (quét bù hôm qua)']]);
});

test('HTTP API serves the stored report and CSV without external internet', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'xskt-server-test-'));
  const collector = createCollector({dataDir,fetcher:async () => ({
    payload:samplePayload(),sourceUrl:'https://example.test/source'
  })});
  const server = createAppServer({collector,dataDir});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await (await fetch(`${base}/api/day?date=${DAY}`)).json();
    assert.equal(before.status,'no_data');
    const created = await (await fetch(`${base}/api/collect?date=${DAY}`,{method:'POST'})).json();
    assert.equal(created.count,3);
    const saved = await (await fetch(`${base}/api/day?date=${DAY}`)).json();
    assert.equal(saved.count,3);
    const csv = await fetch(`${base}/api/export.csv?date=${DAY}`);
    assert.equal(csv.status,200);
    assert.match(csv.headers.get('content-disposition'), /xskt-2026-11-22.csv/);
    assert.equal((await (await fetch(`${base}/`)).text()).includes('XSKT Local'),true);
    assert.equal((await fetch(`${base}/api/day?date=../../etc/passwd`)).status,400);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('fetchDay validates responses using injected fetch', async () => {
  const fetchImpl = async () => new Response(JSON.stringify(samplePayload()), {status:200,headers:{'content-type':'application/json'}});
  const {payload} = await fetchDay(DAY,{fetchImpl,baseUrl:'https://example.test/api'});
  assert.equal(payload.count,3);
});
