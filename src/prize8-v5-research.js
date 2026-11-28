// Exploratory, date-ordered probability ranking benchmark; never used by production UI.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const zero = (n=100) => Array(n).fill(0);
const uniform = Array(100).fill(.01);
const prior = [.5,.1,.1,.1,.1,.1]; // uniform, V4, frequency, digits, pooling, Markov
const names = ['V4','Bayesian frequency','Digit marginals','Partial pooling','Digit Markov',
  'Fixed ensemble','Adaptive ensemble'];
function smooth(counts,alpha) {
  const den=counts.reduce((a,b)=>a+b,0)+alpha*counts.length;
  return counts.map(v=>(v+alpha)/den);
}
function mix(ps,w) {
  return uniform.map((_,n)=>ps.reduce((s,p,i)=>s+p[n]*w[i],0));
}
function digits(a,b,alpha) {
  const p=smooth(a,alpha),q=smooth(b,alpha);
  return uniform.map((_,i)=>p[Math.floor(i/10)]*q[i%10]);
}
function parts(date) {
  const d=new Date(date+'T12:00:00Z');
  return [d.getUTCDay(),d.getUTCDate(),d.getUTCMonth()+1];
}
const cyc=(a,b,n)=>Math.min(Math.abs(a-b),n-Math.abs(a-b));

export function historyFromDataset(dataset) {
  const unique=new Map();
  for(const [date,report] of Object.entries(dataset)) {
    for(const draw of report.results??[]) {
      const num=draw.prizes?.giai8?.[0];
      if(draw.region!=='MN'||typeof num!=='string'||!/^\d{2}$/.test(num)) continue;
      const code=draw.province==='tp-hcm'?'ho-chi-minh':draw.province;
      const key=date+'|'+code;
      const row={date,code,n:Number(num)};
      if(unique.has(key)&&unique.get(key).n!==row.n) throw Error('Conflicting result: '+key);
      unique.set(key,row);
    }
  }
  return [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.code.localeCompare(b.code));
}
// Replicates V4 default distribution mathematically for a common expert interface.
// Exact numerical ties use ascending number in this research script, not V4's production tie-break.
export function experts(h,date,g) {
  const l=zero(),s=zero(),m=zero(),t=zero(10),o=zero(10),lt=zero(10),lo=zero(10),
    c=zero(),ord=zero(),mt=zero(10),mo=zero(10);
  const p=parts(date),prev=h.at(-1).n;
  for(let i=0;i<h.length;i++) {
    const x=h[i],n=x.n,age=h.length-1-i,w=.5**(age/16);
    l[n]++;s[n]+=.5**(age/6);m[n]+=.5**(age/18);
    t[Math.floor(n/10)]+=w;o[n%10]+=w;lt[Math.floor(n/10)]++;lo[n%10]++;
    const q=parts(x.date),dec=.5**(age/80);
    c[n]+=dec*(.40*(p[0]===q[0]?1:.15)+.35*Math.exp(-cyc(p[1],q[1],31)/4)+.25*Math.exp(-cyc(p[2],q[2],12)/2));
    ord[n]+=dec*(.65*((i+1)%10===(h.length+1)%10?1:.10)+.35*((i+1)%4===(h.length+1)%4?1:.25));
    if(i>0) {
      if(Math.floor(h[i-1].n/10)===Math.floor(prev/10)) mt[Math.floor(n/10)]++;
      if(h[i-1].n%10===prev%10) mo[n%10]++;
    }
  }
  const v3=mix([smooth(s,1),smooth(m,1),smooth(l,1),digits(t,o,1.5),uniform],[.3,.1,.15,.3,.15]);
  const v4=mix([v3,smooth(c,2),smooth(ord,2)],[.8,.12,.08]);
  // Leave the target station out of the cross-station prior.
  const global=smooth(g.map((v,i)=>v-l[i]),5);
  const hier=l.map((v,i)=>(v+200*global[i])/(h.length+200));
  return [uniform,v4,smooth(l,2),digits(lt,lo,3),hier,digits(mt,mo,3)];
}
const fresh=()=>({n:0,h:0,rank:0,dist:0,ll:0,mrr:0});
const fmt=a=>a.n?({n:a.n,hits:a.h,rate:+(100*a.h/a.n).toFixed(2),
  rank:+(a.rank/a.n).toFixed(2),distance:+(a.dist/a.n).toFixed(2),
  logloss:+(a.ll/a.n).toFixed(5),mrr:+(a.mrr/a.n).toFixed(5)}):{n:0};
export function benchmark(rows,split='2026-06-01') {
  const logw=prior.map(Math.log),global=zero(),hist={};
  const agg={early:names.map(fresh),late:names.map(fresh)};
  let weightBefore=null;
  const weights=()=>{
    const max=Math.max(...logw),w=logw.map(x=>Math.exp(x-max)),sum=w.reduce((a,b)=>a+b,0);
    return w.map(x=>x/sum);
  };
  for(let start=0;start<rows.length;) {
    let end=start+1;
    while(end<rows.length&&rows[end].date===rows[start].date) end++;
    // Freeze all histories and weights for the entire day to prevent same-day leakage.
    const w=weights(),loss=zero(6);
    if(rows[start].date>=split&&!weightBefore) weightBefore=w;
    for(let i=start;i<end;i++) {
      const row=rows[i],h=hist[row.code]??=[];
      if(h.length<20) continue;
      const p=experts(h,row.date,global),all=[...p.slice(1),mix(p,prior),mix(p,w)];
      for(let j=0;j<all.length;j++) {
        const pr=all[j],rank=Array.from({length:100},(_,n)=>n).sort((a,b)=>pr[b]-pr[a]||a-b).indexOf(row.n)+1;
        const a=agg[row.date<split?'early':'late'][j];
        a.n++;a.h+=Number(rank<=5);a.rank+=rank;a.dist+=Math.max(0,rank-5);
        a.ll-=Math.log(pr[row.n]);a.mrr+=1/rank;
      }
      for(let j=0;j<p.length;j++) loss[j]+=Math.log(p[j][row.n]/.01);
    }
    for(let j=0;j<6;j++) logw[j]+=.25*loss[j];
    for(let i=start;i<end;i++) {const row=rows[i];(hist[row.code]??=[]).push(row);global[row.n]++;}
    start=end;
  }
  return {models:names.map((name,i)=>({name,early:fmt(agg.early[i]),late:fmt(agg.late[i])})),
    weightBefore,weightEnd:weights(),rows:rows.length,split,last:rows.at(-1)?.date};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const dataset=JSON.parse(await readFile(process.argv[2]??'data/results.json','utf8'));
  console.log(JSON.stringify(benchmark(historyFromDataset(dataset),process.argv[3]??'2026-06-01'),null,2));
}
