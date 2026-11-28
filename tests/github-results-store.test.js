import test from 'node:test';
import assert from 'node:assert/strict';
import {githubResultsStore,validateDataset} from '../src/github-results-store.js';
import {syncDate} from '../src/pages-sync-core.js';
import {stationsForDate} from '../src/station-schedule.js';
const day='2026-11-27',other='2026-11-26',oldDay='2025-01-01';
const sha1='a'.repeat(40),sha2='b'.repeat(40);
const sample=date=>({date,count:1,results:[{date,province:'test',name:'Đài thử',prizes:{giai8:['09']}}]});
const dataset={[oldDay]:sample(oldDay)};
const encode=obj=>Buffer.from(JSON.stringify(obj),'utf8').toString('base64');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
test('single file update preserves history and leading zeros',async()=>{
 let put;const store=githubResultsStore('test',{fetchImpl:async(url,options)=>{
  assert.ok(url.includes('/contents/data/results.json'));
  if(options.method==='PUT'){put=JSON.parse(options.body);return response({});}
  return response({sha:sha1,encoding:'base64',content:encode(dataset)});
 }});
 const current=await store.read(day);assert.equal(current.report,null);
 assert.equal(await store.write(day,sample(day),current.sha),true);
 const saved=JSON.parse(Buffer.from(put.content,'base64').toString('utf8'));
 assert.equal(put.sha,sha1);assert.deepEqual(saved[oldDay],dataset[oldDay]);
 assert.equal(saved[day].results[0].prizes.giai8[0],'09');
 assert.equal(saved[day].results[0].name,'Đài thử');
});
test('large file uses immutable raw blob SHA',async()=>{
 let reads=0;const store=githubResultsStore('test',{fetchImpl:async(url,options)=>{
  reads++;if(reads===1)return response({sha:sha1,encoding:'none',content:''});
  assert.ok(url.endsWith('/git/blobs/'+sha1));
  assert.equal(options.headers.Accept,'application/vnd.github.raw+json');
  return new Response(JSON.stringify(dataset));
 }});
 const result=await store.read(oldDay);assert.deepEqual(result.report,dataset[oldDay]);assert.equal(reads,2);
});
test('missing dataset is a hard error, no destructive recreation',async()=>{
 const store=githubResultsStore('test',{fetchImpl:async()=>response({},404)});
 await assert.rejects(store.read(day),/HTTP 404/);
 await assert.rejects(store.write(day,sample(day),null),/read before writing/);
});
test('conflict retries using latest whole dataset, preserving another date',async()=>{
 const codes=stationsForDate(day);
 const draw=province=>({date:day,province,name:province,region:'MN',prizes:{
 giaidb:['000001'],giai1:['00001'],giai2:['00002'],giai3:['00003','00004'],
 giai4:Array(7).fill('00005'),giai5:['0006'],giai6:Array(3).fill('0007'),giai7:['008'],giai8:['09']}});
 let reads=0,writes=0,saved;
 const store=githubResultsStore('test',{fetchImpl:async(url,options)=>{
  if(options.method==='PUT'){
   writes++;const body=JSON.parse(options.body);
   if(writes===1){assert.equal(body.sha,sha1);return response({},409);}
   assert.equal(body.sha,sha2);saved=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));return response({});
  }
  reads++;return response({sha:reads===1?sha1:sha2,encoding:'base64',
   content:encode(reads===1?dataset:{...dataset,[other]:sample(other)})});
 }});
 const result=await syncDate({...store,date:day,now:new Date('2026-11-28T03:00:00Z'),
  fetchDay:async()=>({payload:{date:day,results:Object.fromEntries(codes.map(c=>[c,draw(c)]))},sourceUrl:'https://example.test'})});
 assert.equal(result.status,'updated');assert.equal(writes,2);
 assert.deepEqual(saved[oldDay],dataset[oldDay]);assert.deepEqual(saved[other],sample(other));
 assert.equal(saved[day].count,codes.length);
});
test('reject corrupt dataset',()=>{
 assert.throws(()=>validateDataset([]),/Invalid/);
 assert.throws(()=>validateDataset({[day]:{date:other,results:[]}}),/Invalid/);
});
