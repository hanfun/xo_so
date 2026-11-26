import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSync, fetchBrowserDay } from '../src/pages-browser-sync.js';
import { stationsForDate } from '../src/station-schedule.js';
const day='2026-11-26', date=new Date(day+'T11:00:00Z'), codes=stationsForDate(day);
const draw=province=>({province,name:province,region:'MN',date:day,prizes:{
 giaidb:['000001'],giai1:['00001'],giai2:['00002'],giai3:['00003','00004'],
 giai4:Array(7).fill('00005'),giai5:['0006'],giai6:Array(3).fill('0007'),giai7:['008'],giai8:['09']}});
const payload={date:day,results:Object.fromEntries(codes.map(code=>[code,draw(code)]))};
const storage=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,v)=>map.set(key,v)};};
const provider=async()=>({payload,sourceUrl:'https://example.test'});
test('fetch once and reuse browser JSON after page reload',async()=>{
 const store=storage(), days={};let calls=0;
 const options={storage:store,now:()=>date,fetchSource:async()=>{calls++;return provider();}};
 await createBrowserSync(options)(days,day);
 assert.equal(days[day].count,3);assert.equal(days[day].storage_mode,'browser');
 assert.equal(days[day].results[0].prizes.giai8[0],'09');
 const reload={};await createBrowserSync(options)(reload,day);
 assert.equal(reload[day].count,3);assert.equal(calls,1);
});
test('complete published data skips all fetching',async()=>{
 const days={[day]:{date:day,count:3,results:codes.map(draw)}};
 await createBrowserSync({storage:storage(),now:()=>date,fetchSource:()=>assert.fail('fetch')})(days,day);
});
test('before 17h no provider call',async()=>{
 await createBrowserSync({storage:storage(),now:()=>new Date(day+'T09:59:00Z'),fetchSource:()=>assert.fail('fetch')})({},day);
});
test('unavailable source retains data and throttles across reload',async()=>{
 const store=storage();let calls=0;const options={storage:store,now:()=>date,fetchSource:async()=>{calls++;throw Error('CORS');}};
 const days={[day]:{date:day,count:1,results:[draw(codes[0])]}};
 await createBrowserSync(options)(days,day);
 assert.equal(days[day].count,1);assert.equal(days[day].sync_status,'source_unavailable');
 await createBrowserSync(options)(days,day);assert.equal(calls,1);
});
test('browser requests omit non-simple headers',async()=>{
 let calls=0;
 const result=await fetchBrowserDay(day,async (url,opts)=>{
  calls++;assert.equal(opts.mode,'cors');assert.equal(opts.credentials,'omit');
  assert.deepEqual(Object.keys(opts.headers),['Accept']);return new Response(JSON.stringify(payload));
 });
 assert.equal(calls,1);assert.equal(result.payload.date,day);
});
test('Worker can persist a complete browser cache later',async()=>{
 const store=storage(),days={};await createBrowserSync({storage:store,now:()=>date,fetchSource:provider})(days,day);
 const later=new Date(date.getTime()+301000);let calls=0;
 await createBrowserSync({storage:store,now:()=>later,workerUrl:'https://example.test',fetchImpl:async()=>{
  calls++;return new Response(JSON.stringify({date:day,status:'updated',report:{date:day,count:3,results:codes.map(draw)}}));
 }})(days,day);
 assert.equal(calls,1);assert.equal(days[day].storage_mode,'github');
});
