import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PUBLIC_DIR, validDay, vnClock } from './config.js';
import { exportCsv, listHistory as fileHistory, readDay as fileRead } from './store.js';
import { PRIZE_NAMES } from './lottery.js';
import { SLOTS } from './scheduler.js';

const STATIC={
  '/':['index.html','text/html; charset=utf-8'],
  '/index.html':['index.html','text/html; charset=utf-8'],
  '/style.css':['style.css','text/css; charset=utf-8'],
  '/app.js':['app.js','text/javascript; charset=utf-8']
};
function send(res,status,body,type='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{
    'Content-Type':type,'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    ...extra
  });
  res.end(body);
}
const json=(res,status,value)=>send(res,status,JSON.stringify(value));
export function createAppServer({collector,store=null,dataDir=DATA_DIR,publicDir=PUBLIC_DIR}={}) {
  if(!collector) throw new Error('collector required');
  const db=store || {
    readDay:day=>fileRead(day,dataDir),
    listHistory:()=>fileHistory(dataDir),
    listStations:async()=>[],
    getStats:async()=>{throw new Error('Chức năng phân tích cần cấu hình MySQL');}
  };
  return createHttpServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      const day=url.searchParams.get('date') || vnClock().day;
      if(url.pathname==='/api/status' && req.method==='GET') return json(res,200,{
        now:new Date().toISOString(),today:vnClock().day,
        regions:['MN'],prize_names:PRIZE_NAMES,schedule:SLOTS,
        timezone:'Asia/Ho_Chi_Minh',database:store?'mysql':'json-test'
      });
      if(url.pathname==='/api/history' && req.method==='GET')
        return json(res,200,{dates:await db.listHistory()});
      if(url.pathname==='/api/stations' && req.method==='GET')
        return json(res,200,{stations:await db.listStations()});
      if(url.pathname==='/api/stats' && req.method==='GET') {
        const from=url.searchParams.get('from');
        const to=url.searchParams.get('to');
        const province=url.searchParams.get('province')||'';
        const prize=url.searchParams.get('prize')||'';
        if(!validDay(from)||!validDay(to)||from>to || to>vnClock().day)
          return json(res,400,{error:'Khoảng ngày không hợp lệ'});
        if((Date.parse(to)-Date.parse(from))/86400000>3660)
          return json(res,400,{error:'Giới hạn thống kê tối đa 10 năm'});
        if(prize && !Object.hasOwn(PRIZE_NAMES,prize)) return json(res,400,{error:'Mã giải không hợp lệ'});
        if(province && !/^[a-zA-Z0-9_-]{1,100}$/.test(province))
          return json(res,400,{error:'Mã đài không hợp lệ'});
        return json(res,200,await db.getStats({from,to,province,prize}));
      }
      if(['/api/day','/api/collect','/api/export.csv'].includes(url.pathname)) {
        if(!validDay(day)) return json(res,400,{error:'Ngày phải có dạng YYYY-MM-DD'});
        if(url.pathname==='/api/day' && req.method==='GET') {
          const report=await db.readDay(day);
          return json(res,200,report||{
            date:day,status:'no_data',count:0,region_counts:{MN:0},issues:[],
            results:[],error:collector.getLastError(day)
          });
        }
        if(url.pathname==='/api/collect' && req.method==='POST') {
          try {return json(res,200,await collector.collect(day));}
          catch(e){return json(res,503,{error:e.message});}
        }
        if(url.pathname==='/api/export.csv' && req.method==='GET') {
          const report=await db.readDay(day);
          if(!report || !report.count) return json(res,404,{error:'Chưa có dữ liệu để xuất'});
          return send(res,200,exportCsv(report),'text/csv; charset=utf-8',{
            'Content-Disposition':`attachment; filename="xsmn-${day}.csv"`
          });
        }
      }
      if(req.method==='GET' && STATIC[url.pathname]) {
        const [file,type]=STATIC[url.pathname];
        return send(res,200,await readFile(path.join(publicDir,file)),type);
      }
      return json(res,404,{error:'Không tìm thấy đường dẫn'});
    } catch(e) {
      console.error('[HTTP]',e);
      return json(res,500,{error:'Lỗi máy chủ. Xem terminal để biết chi tiết.'});
    }
  });
}
