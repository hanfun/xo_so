import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PUBLIC_DIR, validDay, vnClock } from './config.js';
import { exportCsv, listHistory as fileHistory, readDay as fileRead } from './store.js';
import { PRIZE_NAMES } from './lottery.js';
import { SLOTS } from './scheduler.js';
import { rankPrize8, backtestPrize8, validateParameters, analyzePrize8Distribution } from './prize8-predictor.js';
import { stationsForDate, XSMN_SCHEDULE_VERSION } from './station-schedule.js';

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
      if(url.pathname==='/api/prize8/daily' && req.method==='POST') {
        const targetDate=url.searchParams.get('date')||vnClock().day;
        if(!validDay(targetDate)||targetDate>vnClock().day)return json(res,400,{error:'Ngày dự đoán không hợp lệ'});
        if(typeof db.getDailyPredictions!=='function'||typeof db.savePrize8Predictions!=='function')
          return json(res,503,{error:'Cần MySQL để lưu dự đoán hằng ngày'});
        try {
          const scheduled=stationsForDate(targetDate),existing=await db.getDailyPredictions(targetDate);
          const completed=new Set(existing.map(x=>x.province));
          const available=new Set((await db.listStations()).map(x=>x.code));
          const generated=[],skipped=[];
          for(const province of scheduled) {
            if(completed.has(province)){skipped.push({province,reason:'already_exists'});continue;}
            if(!available.has(province)){skipped.push({province,reason:'no_history'});continue;}
            const history=await db.getPrize8History({province,before:targetDate,limit:500});
            const forecast=rankPrize8(history,targetDate,{window:52,halfLife:12,recentWeight:.7,alpha:.5,topK:10,backtestDraws:80});
            if(forecast.status!=='experimental'||!forecast.trainingEnd) {
              skipped.push({province,reason:'insufficient_history'});continue;
            }
            await db.savePrize8Predictions({province,targetDate,trainingCutoff:forecast.trainingEnd,items:forecast.top,
              modelVersion:`v1-daily-${XSMN_SCHEDULE_VERSION}`,parameters:forecast.params});
            generated.push(province);
          }
          return json(res,200,{targetDate,scheduled,generated,skipped,predictions:await db.getDailyPredictions(targetDate),
            note:'Dự đoán đã lưu không được tạo lại hoặc sửa sau khi có kết quả.'});
        } catch(e) {return json(res,500,{error:e.message});}
      }
      if(url.pathname==='/api/station-results' && req.method==='GET') {
        if(typeof db.getStationHistory!=='function')return json(res,503,{error:'Cần MySQL để đọc lịch sử đài'});
        const province=url.searchParams.get('province')||'';
        const before=url.searchParams.get('before')||'9999-12-31';
        const limit=Number(url.searchParams.get('limit')||50);
        try {
          const results=await db.getStationHistory({province,before,limit});
          return json(res,200,{province,name:results[0]?.name||province,results,hasMore:results.length===limit});
        } catch(e) {return json(res,400,{error:e.message});}
      }
      if(url.pathname==='/api/prize8/predict' && req.method==='GET') {
        const targetDate = url.searchParams.get('date') || vnClock().day;
        const province = url.searchParams.get('province') || '';
        if(!validDay(targetDate)) return json(res,400,{error:'Ngày dự đoán phải có định dạng YYYY-MM-DD'});
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(province))
          return json(res,400,{error:'Hãy chọn một đài xổ số miền Nam'});
        const parameters = {
          window:Number(url.searchParams.get('window') ?? 52),
          halfLife:Number(url.searchParams.get('halfLife') ?? 12),
          recentWeight:Number(url.searchParams.get('recentWeight') ?? 70)/100,
          topK:Number(url.searchParams.get('topK') ?? 10),
          backtestDraws:80,
          alpha:0.5
        };
        let p;
        try { p=validateParameters(parameters); }
        catch(e) { return json(res,400,{error:e.message}); }
        if(typeof db.getPrize8History!=='function')
          return json(res,503,{error:'Cần MySQL để dự đoán giải 8'});
        const history=await db.getPrize8History({province,before:targetDate,limit:500});
        const forecast=rankPrize8(history,targetDate,p);
        const evaluation=backtestPrize8(history,targetDate,p);
        return json(res,200,{
          province,name:history.at(-1)?.name||province,
          targetDate,historyCount:history.length,
          forecast,backtest:evaluation,
          notes:'Chỉ dùng lịch sử giải 8 của đài đã chọn trước ngày dự đoán. Đây là xếp hạng thử nghiệm, không phải xác suất trúng.'
        });
      }
      if(url.pathname==='/api/prize8/distribution' && req.method==='GET') {
        const targetDate=url.searchParams.get('date')||vnClock().day;
        const province=url.searchParams.get('province')||'';
        if(!validDay(targetDate)||!/^[a-zA-Z0-9_-]{1,100}$/.test(province))
          return json(res,400,{error:'Ngày hoặc đài không hợp lệ'});
        if(typeof db.getPrize8History!=='function')return json(res,503,{error:'Cần MySQL để phân tích giải 8'});
        try {
          const history=await db.getPrize8History({province,before:targetDate,limit:500});
          const distribution=analyzePrize8Distribution(history,targetDate,{
            window:Number(url.searchParams.get('window')??104),halfLife:Number(url.searchParams.get('halfLife')??12),
            recent:Number(url.searchParams.get('recent')??40),long:Number(url.searchParams.get('long')??25),
            weekday:Number(url.searchParams.get('weekday')??25),parity:Number(url.searchParams.get('parity')??10)
          });
          return json(res,200,{province,name:history.at(-1)?.name||province,distribution});
        } catch(e) {return json(res,400,{error:e.message});}
      }
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
          const overwrite=url.searchParams.get('overwrite')==='true';
          try {
            if(!overwrite) {
              const existing=await db.readDay(day);
              if(existing)return json(res,200,{...existing,cached:true});
            }
            return json(res,200,await collector.collect(day,{force:overwrite}));
          }
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
