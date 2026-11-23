import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPrize8, backtestPrize8, normalizeHistory, validateParameters } from '../src/prize8-predictor.js';
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
