import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDraw, extractSouthPayload, normalizePayload, fetchDay, adaptXosovnmPayload } from '../src/lottery.js';
import { createMysqlStore } from '../src/mysql-store.js';
import { createCollector } from '../src/collector.js';
import { createAppServer } from '../src/server.js';
import { createScheduler } from '../src/scheduler.js';
import { exportCsv, readDay, listHistory } from '../src/store.js';
import { stationDetailsForDate } from '../src/station-schedule.js';

const DAY='2026-11-23'; // Monday, 3 Southern stations
const RULES={
  giaidb:[1,6],giai1:[1,5],giai2:[1,5],giai3:[2,5],
  giai4:[7,5],giai5:[1,4],giai6:[3,4],giai7:[1,3],giai8:[1,2]
};
function draw(province,name,region='MN') {
  return {
    province,name,region,date:DAY,
    prizes:Object.fromEntries(Object.entries(RULES).map(([tier,[count,digits]])=>
      [tier,Array.from({length:count},()=> '0'.repeat(digits))]))
  };
}
function provider(){
  return {date:DAY,count:6,results:{
    'mien-bac':{province:'mien-bac',region:'MB',date:DAY,name:'Miền Bắc',prizes:{}},
    'da-nang':{province:'da-nang',region:'MT',date:DAY,name:'Đà Nẵng',prizes:{}},
    'ho-chi-minh':draw('ho-chi-minh','TP HCM'),
    'dong-thap':draw('dong-thap','Đồng Tháp'),
    'ca-mau':draw('ca-mau','Cà Mau')
  }};
}
function south(){return extractSouthPayload(DAY,provider());}

test('lọc API chỉ lấy XSMN và bỏ hoàn toàn MB/MT',()=>{
  const payload=south();
  assert.equal(payload.count,3);
  assert.equal(Object.values(payload.results).every(x=>x.region==='MN'),true);
  assert.equal(payload.results['mien-bac'],undefined);
  assert.equal(payload.results['da-nang'],undefined);
});

test('giữ chính xác các số 0 đầu trong từng giải miền Nam',()=>{
  const result=validateDraw('dong-thap',draw('dong-thap','Đồng Tháp'),DAY);
  assert.equal(result.draw.prizes.giaidb[0],'000000');
  assert.equal(result.draw.prizes.giai8[0],'00');
  assert.equal(Object.values(result.draw.prizes).reduce((n,v)=>n+v.length,0),18);
});

test('loại bỏ giải thiếu hoặc số giải có độ dài sai',()=>{
  const item=draw('ca-mau','Cà Mau');item.prizes.giai4=['12345'];
  assert.match(validateDraw('ca-mau',item,DAY).error,/chưa đủ/);
  const other=draw('ca-mau','Cà Mau');other.prizes.giaidb[0]='12345';
  assert.match(validateDraw('ca-mau',other,DAY).error,/chữ số/);
  assert.match(validateDraw('mien-bac',draw('mien-bac','Bắc','MB'),DAY).error,/miền Nam/);
});

test('đủ 3 đài miền Nam thứ Hai được đánh dấu hoàn chỉnh trong giới hạn nguồn',()=>{
  const report=normalizePayload(DAY,south(),'https://example.test/2026-11-23.json');
  assert.equal(report.status,'complete_by_provider_count');
  assert.equal(report.count,3);
  assert.equal(report.expected_count,3);
  assert.deepEqual(report.region_counts,{MN:3});
  assert.equal(report.results.every(x=>x.region==='MN'),true);
});

test('không đánh dấu hoàn chỉnh khi thiếu đài hoặc kết quả',()=>{
  const payload=south();delete payload.results['ca-mau'];
  const report=normalizePayload(DAY,payload,'https://example.test/source');
  assert.equal(report.status,'needs_review');
  assert.equal(report.count,2);
  assert.match(report.issues.join(' '),/2\/3 đài/);
});

test('giữ kết quả hợp lệ đã lưu khi dữ liệu nguồn thiếu',()=>{
  const previous=normalizePayload(DAY,south(),'https://example.test/source');
  const payload=south();delete payload.results['ca-mau'];
  const report=normalizePayload(DAY,payload,'https://example.test/source',previous);
  assert.equal(report.count,3);
  assert.equal(report.status,'needs_review');
  assert.equal(report.results.every(x=>x.region==='MN'),true);
});

test('collector lưu JSON dự phòng, throttle 5 phút, không ghi trùng',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'xsmn-test-'));
  try {
    let calls=0;
    const collector=createCollector({dataDir,fetcher:async()=>{calls++;return{
      payload:provider(),sourceUrl:'https://example.test/source'
    };}});
    const first=await collector.collect(DAY);
    const second=await collector.collect(DAY);
    assert.equal(calls,1);
    assert.equal(first.count,3);
    assert.equal(second.cached,true);
    assert.deepEqual(await listHistory(dataDir),[DAY]);
    assert.equal((await readDay(DAY,dataDir)).results[0].region,'MN');
  }finally{await rm(dataDir,{recursive:true,force:true});}
});

test('MySQL transaction lưu các giải miền Nam dưới dạng chuỗi',async()=>{
  const statements=[];let commits=0,rollbacks=0,releases=0;
  const connection={
    beginTransaction:async()=>statements.push(['BEGIN']),
    execute:async(sql,params)=>{
      statements.push([sql,params]);
      if(sql.includes('INSERT INTO provinces'))return [{insertId:7}];
      if(sql.includes('INSERT INTO draws'))return [{insertId:9}];
      return [{}];
    },
    commit:async()=>{commits++;},rollback:async()=>{rollbacks++;},release:()=>{releases++;}
  };
  const db=createMysqlStore({pool:{getConnection:async()=>connection,end:async()=>{}}});
  const report=normalizePayload(DAY,south(),'https://example.test/source');
  await db.writeDay(DAY,report,south());
  assert.equal(commits,1);assert.equal(rollbacks,0);assert.equal(releases,1);
  assert.equal(statements.filter(x=>String(x[0]).includes('INSERT INTO provinces')).length,3);
  const prizeStatements=statements.filter(x=>String(x[0]).includes('INSERT INTO prize_results'));
  assert.equal(prizeStatements.length,3);
  assert.equal(prizeStatements.every(x=>x[1].length===72),true);
  assert.equal(prizeStatements[0][1].includes('000000'),true);
  const raw=statements.find(x=>String(x[0]).includes('INSERT INTO source_snapshots'))[1][2];
  assert.equal(JSON.parse(raw).results['mien-bac'],undefined);
});

test('MySQL thống kê SQL chỉ miền Nam và có tham số lọc đài, giải, ngày',async()=>{
  const calls=[];
  const rows=[
    [{total_numbers:54,total_draws:3,total_days:1}],
    [{tail:'00',appearances:6,draw_count:3,last_seen:DAY}],
    [{month:'2026-11',prize_numbers:54,draws:3}],
    [{date:DAY,prize_numbers:54,draws:3}]
  ];
  const pool={
    execute:async(sql,params)=>{calls.push([sql,params]);return [rows[calls.length-1]];},
    end:async()=>{}
  };
  const db=createMysqlStore({pool});
  const result=await db.getStats({from:DAY,to:DAY,province:'dong-thap',prize:'giaidb'});
  assert.equal(result.frequency[0].tail,'00');
  assert.equal(result.totals.numbers,54);
  assert.equal(calls.length,4);
  assert.equal(calls.every(([sql,params])=>sql.includes("p.region='MN'")
    && sql.includes('p.code = ?') && sql.includes('r.prize_code = ?')
    && params.join(',')===`${DAY},${DAY},dong-thap,giaidb`),true);
  await assert.rejects(()=>db.getStats({from:DAY,to:DAY,province:"x' OR 1=1 --"}),/Mã đài/);
});

test('MySQL lịch sử một đài nhóm đầy đủ các giải theo ngày và phân trang',async()=>{
  const calls=[];
  const pool={execute:async(sql,params)=>{calls.push([sql,params]);return [[
    {province:'dong-thap',name:'Đồng Tháp',date:'2026-11-23',ticket_type:'K1',prize_code:'giaidb',position:1,number:'001234'},
    {province:'dong-thap',name:'Đồng Tháp',date:'2026-11-23',ticket_type:'K1',prize_code:'giai8',position:1,number:'07'}
  ]];},end:async()=>{}};
  const db=createMysqlStore({pool});
  const results=await db.getStationHistory({province:'dong-thap',before:'2026-11-24',limit:50});
  assert.equal(results.length,1);
  assert.equal(results[0].prizes.giaidb[0],'001234');
  assert.equal(results[0].prizes.giai8[0],'07');
  assert.deepEqual(calls[0][1],['dong-thap','2026-11-24',50]);
  assert.match(calls[0][0],/p0\.region='MN'/);
  await assert.rejects(()=>db.getStationHistory({province:"x' OR 1=1"}),/Mã đài/);
});

test('API local trả kết quả miền Nam, thống kê, danh sách đài và CSV',async()=>{
  const report=normalizePayload(DAY,south(),'https://example.test/source');
  const store={
    readDay:async()=>report,
    listHistory:async()=>[DAY],
    listStations:async()=>[{code:'dong-thap',name:'Đồng Tháp',draw_count:1}],
    getStats:async()=>({filters:{from:DAY,to:DAY},totals:{numbers:54,draws:3,days:1},
      frequency:[],months:[],days:[]})
  };
  const collector={collect:async()=>report,getLastError:()=>null};
  const server=createAppServer({collector,store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const day=await(await fetch(`${base}/api/day?date=${DAY}`)).json();
    assert.equal(day.region,'MN');
    assert.equal(day.results.some(x=>x.region==='MB'),false);
    const status=await(await fetch(`${base}/api/status`)).json();
    assert.equal(Array.isArray(status.today_stations),true);
    assert.ok(status.today_stations.length===3 || status.today_stations.length===4);
    assert.ok(status.today_stations.every(s=>typeof s.code==='string' && typeof s.name==='string' && s.name.length>0));
    assert.deepEqual(stationDetailsForDate('2026-11-23'),[
      {code:'ho-chi-minh',name:'TP. Hồ Chí Minh'},
      {code:'dong-thap',name:'Đồng Tháp'},
      {code:'ca-mau',name:'Cà Mau'}
    ]);
    assert.equal(stationDetailsForDate('2026-11-28').length,4);
    const stats=await(await fetch(`${base}/api/stats?from=${DAY}&to=${DAY}`)).json();
    assert.equal(stats.totals.numbers,54);
    const stations=await(await fetch(`${base}/api/stations`)).json();
    assert.equal(stations.stations[0].code,'dong-thap');
    const csv=await fetch(`${base}/api/export.csv?date=${DAY}`);
    assert.equal(csv.status,200);
    assert.match(await csv.text(),/000000/);
    assert.equal((await fetch(`${base}/api/day?date=../../etc/passwd`)).status,400);
    assert.equal((await(await fetch(`${base}/`)).text()).includes('XSMN Local'),true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('API collect chuyển lựa chọn ghi đè thành force cho collector',async()=>{
  const calls=[];
  const collector={collect:async(day,options)=>{calls.push([day,options]);return {date:day,count:0,results:[]};},getLastError:()=>null};
  const store={readDay:async()=>null,listHistory:async()=>[],listStations:async()=>[]};
  const server=createAppServer({collector,store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/collect?date=${DAY}&overwrite=false`,{method:'POST'})).status,200);
    assert.equal((await fetch(`${base}/api/collect?date=${DAY}&overwrite=true`,{method:'POST'})).status,200);
    assert.deepEqual(calls,[[DAY,{force:false}],[DAY,{force:true}]]);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('API collect không gọi nguồn khi MySQL đã có ngày và không chọn ghi đè',async()=>{
  let calls=0;
  const existing={date:DAY,count:3,status:'complete_by_provider_count',results:[]};
  const collector={collect:async()=>{calls++;return existing;},getLastError:()=>null};
  const store={readDay:async()=>existing,listHistory:async()=>[DAY],listStations:async()=>[]};
  const server=createAppServer({collector,store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(`${base}/api/collect?date=${DAY}&overwrite=false`,{method:'POST'});
    const body=await response.json();
    assert.equal(response.status,200);assert.equal(body.cached,true);assert.equal(calls,0);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('lịch tự quét một lần, 07:30 quét bù hôm qua',async()=>{
  const runs=[];
  const scheduler=createScheduler({
    run:async(day,slot)=>runs.push([day,slot.label]),
    clock:()=>({day:DAY,hour:7,minute:30}),
    onError:e=>{throw e;}
  });
  await scheduler.tick();await scheduler.tick();
  assert.equal(runs.length,1);
  assert.equal(runs[0][0],'2026-11-22');
});

test('fetchDay hỗ trợ mock HTTP không cần mạng thật',async()=>{
  const fake=async()=>new Response(JSON.stringify(provider()),{
    status:200,headers:{'content-type':'application/json'}
  });
  const result=await fetchDay(DAY,{fetchImpl:fake,baseUrl:'https://example.test/api'});
  assert.equal(result.payload.date,DAY);
});

test('nguồn phụ Xổ Số VN được chuẩn hóa theo từng đài và giữ số 0 đầu',()=>{
  const body={data:[{date:'23/11/2026',data:{
    city:['TP HCM','Đồng Tháp','Cà Mau'],
    db:['000001','000002','000003'],g1:['00001','00002','00003'],
    g2:['10001','10002','10003'],
    g3:['20001','20002','20003','20004','20005','20006'],
    g4:Array.from({length:21},(_,i)=>String(30000+i)),
    g5:['0001','0002','0003'],
    g6:['0011','0012','0013','0021','0022','0023','0031','0032','0033'],
    g7:['001','002','003'],g8:['01','02','03']
  }}]};
  const payload=adaptXosovnmPayload(DAY,body);
  assert.deepEqual(Object.keys(payload.results),['ho-chi-minh','dong-thap','ca-mau']);
  assert.equal(payload.results['ho-chi-minh'].prizes.giaidb[0],'000001');
  assert.deepEqual(payload.results['dong-thap'].prizes.giai3,['20003','20004']);
  assert.equal(payload.results['ca-mau'].prizes.giai8[0],'03');
  assert.equal(validateDraw('dong-thap',payload.results['dong-thap'],DAY).error,undefined);
});

test('fetchDay dùng nguồn phụ khi nguồn chính trả 404',async()=>{
  const calls=[];
  const fallback={data:[{date:'23/11/2026',data:{
    city:['Đồng Tháp'],db:['000001'],g1:['00001'],g2:['10001'],
    g3:['20001','20002'],g4:['30001','30002','30003','30004','30005','30006','30007'],
    g5:['0001'],g6:['0011','0012','0013'],g7:['001'],g8:['01']
  }}]};
  const fake=async url=>{
    calls.push(String(url));
    if(String(url).startsWith('https://primary.test')) return new Response('',{status:404});
    return new Response(JSON.stringify(fallback),{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await fetchDay(DAY,{fetchImpl:fake,baseUrl:'https://primary.test/api',
    fallbackBaseUrl:'https://fallback.test/api',retries:1});
  assert.equal(calls.length,2);
  assert.match(result.sourceUrl,/fallback\.test/);
  assert.equal(result.payload.results['dong-thap'].prizes.giai8[0],'01');
});

test('CSV giữ dạng text để Excel không làm mất số 0 đầu',()=>{
  const report=normalizePayload(DAY,south(),'https://example.test/api');
  const csv=exportCsv(report);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv,/000000/);
});
