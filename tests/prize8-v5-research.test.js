import test from 'node:test';
import assert from 'node:assert/strict';
import {historyFromDataset,experts,benchmark} from '../src/prize8-v5-research.js';
test('canonical station alias preserves history and rejects conflicts',()=>{
 const draw=(province,n)=>({province,region:'MN',prizes:{giai8:[n]}});
 const d={'2025-01-01':{results:[draw('tp-hcm','01')]},'2025-01-02':{results:[draw('ho-chi-minh','02')]}};
 assert.deepEqual(historyFromDataset(d).map(r=>r.code),['ho-chi-minh','ho-chi-minh']);
 d['2025-01-01'].results.push(draw('ho-chi-minh','03'));
 assert.throws(()=>historyFromDataset(d),/Conflicting/);
});
test('experts are positive normalized probability distributions',()=>{
 const h=Array.from({length:20},(_,n)=>({date:'2025-01-'+String(n+1).padStart(2,'0'),n}));
 const global=Array(100).fill(0);for(const row of h)global[row.n]++;
 for(const p of experts(h,'2025-01-21',global)){
  assert.equal(p.length,100);assert.ok(p.every(v=>v>0));
  assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-12);
 }
});
test('same-day results do not enter training or expert weights',()=>{
 const rows=[];
 for(let n=0;n<20;n++)for(const code of ['a','b'])rows.push({date:'2025-01-'+String(n+1).padStart(2,'0'),code,n});
 rows.push({date:'2025-01-21',code:'a',n:0},{date:'2025-01-21',code:'b',n:99});
 const first=benchmark(rows,'2025-01-21');
 const reversed=benchmark([...rows.slice(0,-2),...rows.slice(-2).reverse()],'2025-01-21');
 assert.deepEqual(first.models,reversed.models);
 assert.equal(first.models[0].late.n,2);
});
