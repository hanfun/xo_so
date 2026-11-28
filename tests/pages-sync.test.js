import test from 'node:test';
import assert from 'node:assert/strict';
import { syncToday, syncDate, isCompleteReport } from '../src/pages-sync-core.js';
import { stationsForDate } from '../src/station-schedule.js';
const day = '2026-11-26', now = new Date(day + 'T11:00:00Z');
const codes = stationsForDate(day);
function draw(code) {
  return { province: code, name: code, date: day, region: 'MN', prizes: {
    giaidb:['000001'],giai1:['00001'],giai2:['00002'],giai3:['00003','00004'],
    giai4:Array(7).fill('00005'),giai5:['0006'],giai6:Array(3).fill('0007'),
    giai7:['008'],giai8:['09']
  }};
}
const report = list => ({date: day, results: list.map(draw), count: list.length});
const source = list => async () => ({
  sourceUrl:'https://example.test',
  payload:{date:day,results:Object.fromEntries(list.map(code=>[code,draw(code)]))}
});
test('complete day never fetches or writes', async () => {
  const r = await syncToday({ now, read: async () => ({report:report(codes),sha:'a'}),
    fetchDay: () => assert.fail('fetch'), write: () => assert.fail('write') });
  assert.equal(r.status,'complete');
});
test('missing day saves valid complete results and leading zeros', async () => {
  const r = await syncToday({ now, read: async () => ({report:null,sha:null}), fetchDay:source(codes),
    write: async (date,value,sha) => {
      assert.equal(date,day); assert.equal(sha,null); assert.equal(isCompleteReport(value,day),true);
      assert.equal(value.results[0].prizes.giai8[0],'09'); return true;
    }});
  assert.equal(r.status,'updated');
});
test('before 17h Vietnam does not call source', async () => {
  const r = await syncToday({ now:new Date(day+'T09:00:00Z'), read:async()=>({report:null,sha:null}),
    fetchDay:()=>assert.fail('fetch'),write:()=>assert.fail('write') });
  assert.equal(r.status,'before_opening');
});
test('partial data with no additions is not written', async () => {
  const r = await syncToday({ now,read:async()=>({report:report(codes.slice(0,1)),sha:'a'}),
    fetchDay:source(codes.slice(0,1)),write:()=>assert.fail('write') });
  assert.equal(r.status,'no_change');
});
test('SHA conflict re-reads and does not overwrite concurrently completed day', async () => {
  let reads=0,writes=0;
  const r = await syncToday({ now,read:async()=>++reads===1?{report:null,sha:null}:{report:report(codes),sha:'b'},
    fetchDay:source(codes),write:async()=>{writes++;return false;} });
  assert.equal(r.status,'complete'); assert.equal(writes,1);
});
test('failed provider preserves previous data', async () => {
  const prior=report(codes.slice(0,1));
  const r=await syncToday({now,read:async()=>({report:prior,sha:'a'}),fetchDay:async()=>{throw Error('offline');},write:()=>assert.fail('write')});
  assert.equal(r.status,'source_unavailable');assert.deepEqual(r.report,prior);
});

test('historical day can be persisted in morning',async()=>{
 const r=await syncDate({date:day,now:new Date('2026-11-27T03:00:00Z'),
  read:async()=>({report:null,sha:null}),fetchDay:source(codes),
  write:async(target,value)=>{assert.equal(target,day);assert.equal(isCompleteReport(value,day),true);return true;}});
 assert.equal(r.status,'updated');
});
test('future and invalid dates never read or write',async()=>{
 for(const target of ['2026-11-27','2026-02-30','bad']){
  const r=await syncDate({date:target,now,read:()=>assert.fail('read'),write:()=>assert.fail('write'),fetchDay:()=>assert.fail('fetch')});
  assert.equal(r.status,'invalid_date');
 }
});
