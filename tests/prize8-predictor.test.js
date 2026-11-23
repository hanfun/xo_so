import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankPrize8, backtestPrize8, normalizeHistory, validateParameters, analyzePrize8Distribution,
  rankPrize8V2, backtestPrize8V2, validateV2Parameters, analyzeHistoryCoverage, wilsonInterval,
  V2_MODEL_VERSION, UNIFORM_LOG_LOSS
} from '../src/prize8-predictor.js';
import { createMysqlStore } from '../src/mysql-store.js';
import { createAppServer } from '../src/server.js';

function history(count, start='2020-01-01', choose=i=>i%100) {
  const origin=new Date(start+'T12:00:00.000Z');
  return Array.from({length:count},(_,i)=>{
    const d=new Date(origin);
    d.setUTCDate(d.getUTCDate()+i*7);
    return {date:d.toISOString().slice(0,10),number:String(choose(i)).padStart(2,'0')};
  });
}

test('weighted forecast ranks frequent recent prize-8 values and preserves leading zeroes',()=>{
  const rows=history(70, '2023-01-01',i=>i<40?7:42);
  const result=rankPrize8(rows,'2026-12-01',{window:52,halfLife:5,recentWeight:0.9});
  assert.equal(result.top[0].number,'42');
  assert.equal(result.top.length,10);
  assert.equal(result.trainingEnd,rows.at(-1).date);
  assert.equal(result.historyCount,70);
  assert.equal(result.status,'experimental');
  const zero=rankPrize8(history(60,'2023-01-01',()=>7),'2026-12-01',{window:52});
  assert.equal(zero.top[0].number,'07');
});

test('distribution scores all 00-99 with weekday/parity components and normalized weights',()=>{
  const rows=history(80,'2024-01-01',i=>(i*2)%100);
  const result=analyzePrize8Distribution(rows,'2026-01-05',{window:52,recent:40,long:25,weekday:25,parity:10});
  assert.equal(result.status,'experimental');
  assert.equal(result.items.length,100);
  assert.equal(result.weekdaySample,52);
  assert.ok(result.items.find(x=>x.number==='00').components.parity>
    result.items.find(x=>x.number==='01').components.parity);
  const total=result.items.reduce((sum,item)=>sum+item.scorePercent,0);
  assert.ok(Math.abs(total-100)<0.001);
  assert.throws(()=>analyzePrize8Distribution(rows,'2026-01-05',{recent:40,long:40,weekday:40,parity:10}),/100%/);
});

test('no data leakage: future draws and target draw do not alter forecast for target date',()=>{
  const rows=history(85,'2023-01-01',i=>i%10);
  const target=rows[70].date;
  const base=rankPrize8(rows.slice(0,70),target,{window:40,halfLife:8});
  const altered=[
    ...rows.slice(0,70),
    {date:target,number:'99'},
    ...rows.slice(71).map(x=>({...x,number:'99'}))
  ];
  const checked=rankPrize8(altered,target,{window:40,halfLife:8});
  assert.deepEqual(checked,base);
  assert.ok(checked.trainingEnd<target);
  const report=backtestPrize8(altered,target,{window:40,backtestDraws:40});
  const control=backtestPrize8(rows.slice(0,70),target,{window:40,backtestDraws:40});
  assert.deepEqual(report,control);
});

test('small samples do not produce ranked numbers and cannot claim backtest results',()=>{
  const rows=history(12);
  const result=rankPrize8(rows,'2021-01-01');
  assert.equal(result.status,'insufficient_history');
  assert.deepEqual(result.top,[]);
  assert.equal(backtestPrize8(rows,'2021-01-01').evaluated,0);
});

test('roll-forward backtest counts evaluated draws and keeps uniform random benchmark',()=>{
  const rows=history(100,'2021-01-01',()=> '07');
  const result=backtestPrize8(rows,'2024-01-01',{window:52,backtestDraws:60,topK:10});
  assert.equal(result.evaluated,60);
  assert.equal(result.top1.hits,60);
  assert.equal(result.topK.hits,60);
  assert.equal(result.top1.randomBaselinePercent,1);
  assert.equal(result.topK.randomBaselinePercent,10);
  // Perfect historical repetition here is synthetic and not a claim about real draws.
});

test('validation rejects conflicting duplicates and invalid weights',()=>{
  assert.throws(()=>normalizeHistory([{date:'2026-01-01',number:'02'},
    {date:'2026-01-01',number:'98'}]),/hai kết quả/);
  assert.throws(()=>validateParameters({recentWeight:1.5}),/recentWeight/);
  assert.throws(()=>validateParameters({window:8}),/window/);
});

test('MySQL prize-8 history query filters exact station and strictly earlier dates',async()=>{
  const statements=[];
  const pool={
    execute:async(sql,args)=>{
      statements.push([sql,args]);
      return [[{province:'dong-thap',name:'Đồng Tháp',date:'2026-01-08',number:'08'},
        {province:'dong-thap',name:'Đồng Tháp',date:'2026-01-01',number:'00'}]];
    },end:async()=>{}
  };
  const db=createMysqlStore({pool});
  const results=await db.getPrize8History({province:'dong-thap',before:'2026-01-15',limit:50});
  assert.deepEqual(results.map(x=>x.number),['00','08']);
  assert.match(statements[0][0],/r.prize_code='giai8'/);
  assert.match(statements[0][0],/d.draw_date < \?/);
  assert.match(statements[0][0],/p.region='MN'/);
  assert.deepEqual(statements[0][1],['dong-thap','2026-01-15',50]);
  await assert.rejects(()=>db.getPrize8History({province:"' OR 1=1",before:'2026-01-15'}),/Hãy chọn/);
});

test('GET prediction endpoint returns top-10/backtest and rejects missing station',async()=>{
  const rows=history(130,'2022-01-01',i=>i%20);
  const queried=[];
  const store={
    getPrize8History:async(args)=>{queried.push(args);
      return rows.filter(r=>r.date<args.before).map(r=>({...r,province:'dong-thap',name:'Đồng Tháp'}));}
  };
  const server=createAppServer({store,collector:{collect:async()=>{},getLastError:()=>null}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const missing=await fetch(`${base}/api/prize8/predict?date=2026-11-24`);
    assert.equal(missing.status,400);
    const invalid=await fetch(`${base}/api/prize8/predict?date=2026-11-24&province=dong-thap&recentWeight=101`);
    assert.equal(invalid.status,400);
    const good=await fetch(`${base}/api/prize8/predict?date=2026-11-24&province=dong-thap&window=52&recentWeight=70`);
    assert.equal(good.status,200);
    const data=await good.json();
    assert.equal(data.forecast.top.length,10);
    assert.equal(data.forecast.params.recentWeight,0.7);
    assert.equal(data.backtest.topK.randomBaselinePercent,10);
    assert.equal(queried[0].before,'2026-11-24');
    assert.equal(queried[0].limit,500);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('V2 ranking uses full history, digit marginals, preserves 00/99, and avoids 00-09 tie bias',()=>{
  const rows=history(80,'2023-01-02',i=>i%2===0?84:97);
  const result=rankPrize8V2(rows,'2026-12-01',{window:30,halfLife:10,topK:10});
  assert.equal(result.modelVersion,V2_MODEL_VERSION);
  assert.equal(result.status,'experimental');
  assert.equal(result.historyCount,80);
  assert.equal(result.windowUsed,30);
  assert.deepEqual(result.top.slice(0,2).map(x=>x.number).sort(),['84','97']);
  // Unseen cross-combinations 87 & 94 should beat 00 due to tens(8,9) & ones(4,7) marginals.
  const topNumbers=result.top.map(x=>x.number);
  assert.ok(topNumbers.includes('87') && topNumbers.includes('94'));
  assert.equal(topNumbers.includes('00'),false);

  // Edge cases: 0 rows, 19 rows, exactly 20 rows with 00 and 99.
  assert.equal(rankPrize8V2([],'2026-01-01').status,'insufficient_history');
  assert.equal(rankPrize8V2(history(19),'2026-01-01').status,'insufficient_history');
  const exact20=rankPrize8V2(history(20,'2024-01-01',i=>i%2===0?0:99),'2026-01-01');
  assert.equal(exact20.status,'experimental');
  assert.deepEqual(exact20.top.slice(0,2).map(x=>x.number).sort(),['00','99']);

  // Full history outside trailing window still affects V2 score.
  const olderHistory=[
    ...history(40,'2022-01-03',()=>55),
    ...history(30,'2024-01-01',i=>(i+1)%30)
  ];
  const v2Full=rankPrize8V2(olderHistory,'2026-01-01',{window:30,recentWeight:0.2,longWeight:0.6,digitWeight:0.1,uniformShrinkage:0.1});
  assert.equal(v2Full.top[0].number,'55');
  assert.equal(v2Full.top[0].observed,0);
  assert.equal(v2Full.top[0].totalObserved,40);
});

test('V2 strict no-leakage: target date and future draws never change rank, backtest, or coverage',()=>{
  const rows=history(90,'2023-01-02',i=>(i*13)%100);
  const target=rows[70].date;
  const clean=rows.slice(0,70);
  const polluted=[
    ...clean,
    {date:target,number:'00'},
    ...rows.slice(71).map(x=>({...x,number:'00'}))
  ];
  assert.deepEqual(rankPrize8V2(polluted,target),rankPrize8V2(clean,target));
  assert.deepEqual(backtestPrize8V2(polluted,target,{backtestDraws:40}),backtestPrize8V2(clean,target,{backtestDraws:40}));
  assert.deepEqual(analyzeHistoryCoverage(polluted,target,'dong-thap'),analyzeHistoryCoverage(clean,target,'dong-thap'));
});

test('V2 backtest compares V2, V1, Raw, and Uniform with Wilson CI and proper scoring rules',()=>{
  const ciZero=wilsonInterval(0,80);
  assert.equal(ciZero.low,0);
  assert.ok(ciZero.high>0 && ciZero.high<6);
  const ciTen=wilsonInterval(8,80);
  assert.ok(ciTen.low<10 && ciTen.high>10);

  // Rotating non-repeating sequence behaves like unlearnable draws: shrinkage should curb log-loss vs V1.
  const rotating=history(120,'2022-01-03',i=>i%100);
  const evalRot=backtestPrize8V2(rotating,'2026-01-01',{window:52,backtestDraws:60,topK:10});
  assert.equal(evalRot.evaluated,60);
  assert.equal(evalRot.models.uniform.topK.rate,10);
  assert.equal(evalRot.models.uniform.logLoss,Number(UNIFORM_LOG_LOSS.toFixed(5)));
  assert.equal(evalRot.comparison.v2VsUniform.isStatisticallySignificantTopK,false);
  assert.ok(evalRot.models.v2.logLoss < evalRot.models.v1.logLoss);
  assert.ok(evalRot.comparison.v2VsV1.logLossImprovement > 0);

  // Validation checks for V2 parameters.
  assert.throws(()=>validateV2Parameters({recentWeight:0.5,longWeight:0.5,digitWeight:0.2,uniformShrinkage:0}),/bằng 1/);
  assert.throws(()=>validateV2Parameters({recentWeight:-0.1,longWeight:0.5,digitWeight:0.3,uniformShrinkage:0.3}),/recentWeight/);
});

test('coverage analysis tracks missing draws for 1x/week and 2x/week XSMN stations',()=>{
  // Mondays for Dong Thap: skip 2 Mondays out of 10 weeks.
  const allMondays=history(10,'2025-01-06',()=>'07');
  const withGaps=allMondays.filter((_,i)=>i!==3 && i!==6);
  const cov=analyzeHistoryCoverage(withGaps,'2025-06-01','dong-thap');
  assert.equal(cov.totalDraws,8);
  assert.equal(cov.expectedDrawsInSpan,10);
  assert.equal(cov.missingDraws,2);
  assert.equal(cov.coveragePercent,80);
  assert.equal(cov.maxGapDays,14);
  assert.equal(cov.gapCount,2);

  // Ho Chi Minh draws Mon (1) and Sat (6): 2025-01-06 (Mon) to 2025-01-18 (Sat) = 4 draws.
  const hcm=[
    {date:'2025-01-06',number:'01'},
    {date:'2025-01-11',number:'02'},
    {date:'2025-01-13',number:'03'},
    {date:'2025-01-18',number:'04'}
  ];
  const covHcm=analyzeHistoryCoverage(hcm,'2025-02-01','ho-chi-minh');
  assert.equal(covHcm.expectedDrawsInSpan,4);
  assert.equal(covHcm.missingDraws,0);
  assert.equal(covHcm.coveragePercent,100);
});

test('GET V2 prediction endpoints return benchmark comparison while keeping V1 compatible',async()=>{
  const rows=history(120,'2022-01-03',i=>(i*7)%100);
  const store={
    getPrize8History:async(args)=>rows
      .filter(r=>r.date<args.before)
      .map(r=>({...r,province:'dong-thap',name:'Đồng Tháp'}))
  };
  const server=createAppServer({store,collector:{collect:async()=>{},getLastError:()=>null}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const v2Res=await fetch(`${base}/api/prize8/v2/predict?date=2026-11-24&province=dong-thap&recentWeight=35&longWeight=30&digitWeight=20&uniformShrinkage=15`);
    assert.equal(v2Res.status,200);
    const v2Data=await v2Res.json();
    assert.equal(v2Data.modelVersion,V2_MODEL_VERSION);
    assert.equal(v2Data.forecast.top.length,10);
    assert.equal(v2Data.backtest.evaluated,80);
    assert.ok(v2Data.backtest.models.v2 && v2Data.backtest.models.v1 && v2Data.backtest.models.raw && v2Data.backtest.models.uniform);
    assert.equal(v2Data.coverage.totalDraws,120);

    const viaParam=await fetch(`${base}/api/prize8/predict?version=v2&date=2026-11-24&province=dong-thap`);
    assert.equal(viaParam.status,200);
    assert.equal((await viaParam.json()).modelVersion,V2_MODEL_VERSION);

    const badSum=await fetch(`${base}/api/prize8/v2/predict?date=2026-11-24&province=dong-thap&recentWeight=50&longWeight=50&digitWeight=10&uniformShrinkage=0`);
    assert.equal(badSum.status,400);

    const badVersion=await fetch(`${base}/api/prize8/predict?version=v3&date=2026-11-24&province=dong-thap`);
    assert.equal(badVersion.status,400);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('MySQL savePrize8Predictions is transactional, idempotent, and never overwrites existing predictions',async()=>{
  let existingCount=0;
  const statements=[];
  const connection={
    beginTransaction:async()=>statements.push('BEGIN'),
    execute:async(sql,params)=>{
      statements.push([sql,params]);
      if(sql.includes('FROM provinces'))return [[{id:42}]];
      if(sql.includes('COUNT(*) AS existing_count'))return [[{existing_count:existingCount}]];
      if(sql.includes('INSERT INTO model_versions'))return [{insertId:7}];
      if(sql.includes('INSERT IGNORE INTO predictions'))existingCount+=1;
      return [{}];
    },
    commit:async()=>statements.push('COMMIT'),
    rollback:async()=>statements.push('ROLLBACK'),
    release:()=>{}
  };
  const db=createMysqlStore({pool:{getConnection:async()=>connection,execute:async()=>[[]],end:async()=>{}}});
  const items=[{number:'07',score:2.5,observed:4,totalObserved:10,lastSeen:'2026-11-16'}];

  const first=await db.savePrize8Predictions({
    province:'dong-thap',targetDate:'2026-11-23',trainingCutoff:'2026-11-16',
    items,modelVersion:'v2.0.0-daily-2026-11-23',parameters:{window:52}
  });
  assert.deepEqual(first,{created:true,count:1});
  assert.equal(statements.filter(x=>Array.isArray(x)&&x[0].includes('INSERT IGNORE INTO predictions')).length,1);
  assert.equal(statements.some(x=>Array.isArray(x)&&x[0].includes('FOR UPDATE')),true);

  const beforeSecond=statements.length;
  const second=await db.savePrize8Predictions({
    province:'dong-thap',targetDate:'2026-11-23',trainingCutoff:'2026-11-16',
    items:[{number:'99',score:9.9,observed:9,totalObserved:9,lastSeen:'2026-11-16'}],
    modelVersion:'v2.0.0-daily-2026-11-23',parameters:{window:52}
  });
  assert.deepEqual(second,{created:false,reason:'already_exists'});
  const secondOps=statements.slice(beforeSecond);
  assert.equal(secondOps.some(x=>Array.isArray(x)&&x[0].includes('INSERT IGNORE INTO predictions')),false);

  await assert.rejects(()=>db.savePrize8Predictions({
    province:'dong-thap',targetDate:'2026-11-23',trainingCutoff:'2026-11-23',
    items,modelVersion:'v2',parameters:{}
  }),/Mốc huấn luyện/);
  await assert.rejects(()=>db.savePrize8Predictions({
    province:'dong-thap',targetDate:'2026-11-23',trainingCutoff:'2026-11-16',
    items:[{number:'7',score:1}],modelVersion:'v2',parameters:{}
  }),/hai chữ số/);
});

test('MySQL getDailyPredictions computes actual rank and Top 1 / Top 10 status preserving leading zeroes',async()=>{
  const rows=[
    {province:'dong-thap',name:'Đồng Tháp',predicted_value:'07',training_cutoff:'2026-11-16',
      generated_at:'2026-11-23T01:00:00.000Z',metadata_json:JSON.stringify({rank:1,score:2.1}),
      model_key:'prize8-v2-daily',model_version:'v2.0.0-daily',actual:'07'},
    {province:'dong-thap',name:'Đồng Tháp',predicted_value:'09',training_cutoff:'2026-11-16',
      generated_at:'2026-11-23T01:00:00.000Z',metadata_json:JSON.stringify({rank:2,score:1.9}),
      model_key:'prize8-v2-daily',model_version:'v2.0.0-daily',actual:'07'},
    {province:'ho-chi-minh',name:'TP HCM',predicted_value:'12',training_cutoff:'2026-11-21',
      generated_at:'2026-11-23T01:00:00.000Z',metadata_json:JSON.stringify({rank:1,score:2.0}),
      model_key:'prize8-v2-daily',model_version:'v2.0.0-daily',actual:'05'},
    {province:'ho-chi-minh',name:'TP HCM',predicted_value:'05',training_cutoff:'2026-11-21',
      generated_at:'2026-11-23T01:00:00.000Z',metadata_json:JSON.stringify({rank:2,score:1.8}),
      model_key:'prize8-v2-daily',model_version:'v2.0.0-daily',actual:'05'},
    {province:'ca-mau',name:'Cà Mau',predicted_value:'01',training_cutoff:'2026-11-16',
      generated_at:'2026-11-23T01:00:00.000Z',metadata_json:JSON.stringify({rank:1,score:1.5}),
      model_key:'prize8-v2-daily',model_version:'v2.0.0-daily',actual:null}
  ];
  const db=createMysqlStore({pool:{execute:async()=>[rows],end:async()=>{}}});
  const result=await db.getDailyPredictions('2026-11-23');
  const dt=result.find(x=>x.province==='dong-thap');
  assert.equal(dt.actual,'07');
  assert.equal(dt.actualRank,1);
  assert.equal(dt.top1Hit,true);
  assert.equal(dt.top10Hit,true);
  assert.equal(dt.status,'top1_hit');

  const hcm=result.find(x=>x.province==='ho-chi-minh');
  assert.equal(hcm.actual,'05');
  assert.equal(hcm.actualRank,2);
  assert.equal(hcm.top1Hit,false);
  assert.equal(hcm.top10Hit,true);
  assert.equal(hcm.status,'top10_hit');

  const cm=result.find(x=>x.province==='ca-mau');
  assert.equal(cm.actual,null);
  assert.equal(cm.actualRank,null);
  assert.equal(cm.top1Hit,null);
  assert.equal(cm.top10Hit,null);
  assert.equal(cm.status,'pending');
});

test('daily prediction API is strictly idempotent, handles concurrency, and auto-evaluates when actual results arrive',async()=>{
  const TARGET='2026-11-23'; // Monday: ho-chi-minh, dong-thap, ca-mau
  const saved=new Map();
  // Pre-existing immutable prediction for ho-chi-minh (must NEVER be regenerated or overwritten).
  saved.set('ho-chi-minh',{
    province:'ho-chi-minh',name:'TP HCM',targetDate:TARGET,trainingCutoff:'2026-11-21',
    generatedAt:'2026-11-23T00:05:00.000Z',modelKey:'prize8-weighted-daily',modelVersion:'v1-daily-original',
    top:[
      {number:'11',rank:1,score:2.1},{number:'22',rank:2,score:1.9},{number:'03',rank:3,score:1.7}
    ]
  });
  const actuals=new Map();
  let saveCalls=0;
  const dongThapHistory=history(60,'2024-01-01',i=>i%15);
  const caMauHistory=history(10,'2026-08-03',i=>i%10);
  const store={
    listStations:async()=>[
      {code:'ho-chi-minh',name:'TP HCM',draw_count:120},
      {code:'dong-thap',name:'Đồng Tháp',draw_count:60},
      {code:'ca-mau',name:'Cà Mau',draw_count:10}
    ],
    getPrize8History:async({province,before})=>{
      const src=province==='dong-thap'?dongThapHistory:caMauHistory;
      return src.filter(r=>r.date<before).map(r=>({...r,province,name:province==='dong-thap'?'Đồng Tháp':'Cà Mau'}));
    },
    savePrize8Predictions:async({province,targetDate,trainingCutoff,items,modelKey,modelVersion})=>{
      saveCalls+=1;
      if(saved.has(province))return {created:false,reason:'already_exists'};
      saved.set(province,{
        province,name:province==='dong-thap'?'Đồng Tháp':province,targetDate,trainingCutoff,
        generatedAt:'2026-11-23T01:00:00.000Z',modelKey,modelVersion,
        top:items.map((x,idx)=>({number:x.number,rank:idx+1,score:x.score}))
      });
      return {created:true,count:items.length};
    },
    getDailyPredictions:async(targetDate)=>[...saved.values()]
      .filter(x=>x.targetDate===targetDate)
      .map(group=>{
        const actual=actuals.get(group.province)??null;
        const actualRank=actual?(group.top.find(x=>x.number===actual)?.rank??null):null;
        const top1Hit=actual?group.top[0]?.number===actual:null;
        const top10Hit=actual?group.top.some(x=>x.number===actual):null;
        const status=actual==null?'pending':(top1Hit?'top1_hit':(top10Hit?'top10_hit':'miss'));
        return {...group,actual,actualRank,top1Hit,top10Hit,status};
      })
  };
  const server=createAppServer({store,collector:{collect:async()=>{},getLastError:()=>null}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    // Concurrent first page opens: dong-thap saved strictly once; ho-chi-minh untouched; ca-mau skipped.
    const [res1,res2]=await Promise.all([
      fetch(`${base}/api/prize8/daily?date=${TARGET}`,{method:'POST'}),
      fetch(`${base}/api/prize8/daily?date=${TARGET}`,{method:'POST'})
    ]);
    assert.equal(res1.status,200);
    assert.equal(res2.status,200);
    const body1=await res1.json();
    const body2=await res2.json();
    assert.equal(saveCalls,1);
    assert.deepEqual([...body1.generated,...body2.generated],['dong-thap']);
    const originalDt=body1.predictions.find(x=>x.province==='dong-thap');
    const originalHcm=body1.predictions.find(x=>x.province==='ho-chi-minh');
    assert.equal(originalDt.top.length,10);
    assert.equal(originalDt.actual,null);
    assert.equal(originalDt.status,'pending');
    assert.equal(originalHcm.modelVersion,'v1-daily-original');

    // Actual draw results arrive later in the afternoon.
    actuals.set('dong-thap',originalDt.top[0].number); // Rank #1 hit
    actuals.set('ho-chi-minh','03'); // Rank #3 hit

    // Read-only GET returns actual numbers, ranks, and Top 1/Top 10 status without writes.
    const getRes=await fetch(`${base}/api/prize8/daily?date=${TARGET}`);
    assert.equal(getRes.status,200);
    const getBody=await getRes.json();
    assert.deepEqual(getBody.scheduled_details,[
      {code:'ho-chi-minh',name:'TP. Hồ Chí Minh'},
      {code:'dong-thap',name:'Đồng Tháp'},
      {code:'ca-mau',name:'Cà Mau'}
    ]);
    const afterDt=getBody.predictions.find(x=>x.province==='dong-thap');
    const afterHcm=getBody.predictions.find(x=>x.province==='ho-chi-minh');
    assert.equal(afterDt.actual,originalDt.top[0].number);
    assert.equal(afterDt.actualRank,1);
    assert.equal(afterDt.top1Hit,true);
    assert.equal(afterDt.top10Hit,true);
    assert.equal(afterDt.status,'top1_hit');
    assert.equal(afterHcm.actual,'03');
    assert.equal(afterHcm.actualRank,3);
    assert.equal(afterHcm.top1Hit,false);
    assert.equal(afterHcm.top10Hit,true);
    assert.equal(afterHcm.status,'top10_hit');

    // Re-opening page (POST) after actual results are known NEVER regenerates or alters saved predictions.
    const postAgain=await (await fetch(`${base}/api/prize8/daily?date=${TARGET}`,{method:'POST'})).json();
    assert.equal(saveCalls,1);
    assert.deepEqual(postAgain.generated,[]);
    assert.deepEqual(postAgain.predictions.find(x=>x.province==='dong-thap').top,originalDt.top);
    assert.deepEqual(postAgain.predictions.find(x=>x.province==='ho-chi-minh').top,originalHcm.top);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
