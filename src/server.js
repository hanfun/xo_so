import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PUBLIC_DIR, validDay, vnClock } from './config.js';
import { exportCsv, listHistory as fileHistory, readDay as fileRead } from './store.js';
import { PRIZE_NAMES } from './lottery.js';
import { SLOTS } from './scheduler.js';
import {
  rankPrize8, backtestPrize8, validateParameters, analyzePrize8Distribution,
  rankPrize8V2, backtestPrize8V2, validateV2Parameters, analyzeHistoryCoverage,
  V2_MODEL_VERSION, DEFAULT_V2_PARAMS,
  rankPrize8V3, backtestPrize8V3, validateV3Parameters, V3_TOP5_WEIGHTS,
  V3_MODEL_VERSION, DEFAULT_V3_PARAMS
} from './prize8-predictor.js';
import { stationsForDate, stationDetailsForDate, stationDisplayName, XSMN_SCHEDULE_VERSION } from './station-schedule.js';

const STATIC={
  '/':['index.html','text/html; charset=utf-8'],
  '/index.html':['index.html','text/html; charset=utf-8'],
  '/today':['today.html','text/html; charset=utf-8'],
  '/today.html':['today.html','text/html; charset=utf-8'],
  '/style.css':['style.css','text/css; charset=utf-8'],
  '/app.js':['app.js','text/javascript; charset=utf-8'],
  '/today.js':['today.js','text/javascript; charset=utf-8']
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
  const dailyLocks = new Map();
  async function withDailyLock(targetDate, task) {
    const previous = dailyLocks.get(targetDate) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    dailyLocks.set(targetDate, current);
    try { return await current; }
    finally { if (dailyLocks.get(targetDate) === current) dailyLocks.delete(targetDate); }
  }
  return createHttpServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      const day=url.searchParams.get('date') || vnClock().day;
      if(url.pathname==='/api/status' && req.method==='GET') {
        const todayDay=vnClock().day;
        return json(res,200,{
          now:new Date().toISOString(),today:todayDay,
          today_stations:stationDetailsForDate(todayDay),
          regions:['MN'],prize_names:PRIZE_NAMES,schedule:SLOTS,
          timezone:'Asia/Ho_Chi_Minh',database:store?'mysql':'json-test'
        });
      }
      if(url.pathname==='/api/history' && req.method==='GET')
        return json(res,200,{dates:await db.listHistory()});
      if(url.pathname==='/api/stations' && req.method==='GET')
        return json(res,200,{stations:await db.listStations()});
      if(url.pathname==='/api/prize8/daily' && req.method==='GET') {
        const targetDate=url.searchParams.get('date')||vnClock().day;
        if(!validDay(targetDate))return json(res,400,{error:'Ngày dự đoán không hợp lệ'});
        if(typeof db.getDailyPredictions!=='function')
          return json(res,503,{error:'Cần MySQL để đọc dự đoán hằng ngày'});
        try {
          const scheduled=stationsForDate(targetDate);
          const predictions=await db.getDailyPredictions(targetDate);
          return json(res,200,{
            targetDate,
            scheduled,
            scheduled_details:stationDetailsForDate(targetDate),
            predictions,
            note:'Dự đoán đã lưu không được tạo lại hoặc sửa sau khi có kết quả.'
          });
        } catch(e) {return json(res,500,{error:e.message});}
      }
      if(url.pathname==='/api/prize8/daily' && req.method==='POST') {
        const targetDate=url.searchParams.get('date')||vnClock().day;
        if(!validDay(targetDate)||targetDate>vnClock().day)return json(res,400,{error:'Ngày dự đoán không hợp lệ'});
        if(typeof db.getDailyPredictions!=='function'||typeof db.savePrize8Predictions!=='function')
          return json(res,503,{error:'Cần MySQL để lưu dự đoán hằng ngày'});
        try {
          const payload = await withDailyLock(targetDate, async () => {
            const scheduled=stationsForDate(targetDate);
            const existing=await db.getDailyPredictions(targetDate);
            const completed=new Set(existing.map(x=>x.province));
            const stationsList=await db.listStations();
            const stationNames=new Map(stationsList.map(x=>[x.code,x.name]));
            const generated=[],skipped=[];
            for(const province of scheduled) {
              const name=stationNames.get(province)||stationDisplayName(province);
              if(completed.has(province)){skipped.push({province,name,reason:'already_exists'});continue;}
              if(!stationNames.has(province)){skipped.push({province,name,reason:'no_history'});continue;}
              const history=await db.getPrize8History({province,before:targetDate,limit:500});
              const forecast=rankPrize8V3(history,targetDate,V3_TOP5_WEIGHTS,{includeRanking:true});
              if(forecast.status!=='experimental'||!forecast.trainingEnd) {
                skipped.push({province,name,reason:'insufficient_history',historyCount:forecast.historyCount});
                continue;
              }
              const saved=await db.savePrize8Predictions({
                province,
                targetDate,
                trainingCutoff:forecast.trainingEnd,
                items:forecast.top,
                ranking:forecast.ranking,
                modelKey:'prize8-v3-top5-daily',
                modelVersion:`${V3_MODEL_VERSION}-top5-daily-${XSMN_SCHEDULE_VERSION}`,
                description:'Xếp hạng Giải 8 V3 ưu tiên Top 5 theo ngày',
                parameters:forecast.params
              });
              if(saved && saved.created===false) {
                skipped.push({province,name,reason:'already_exists'});
                continue;
              }
              generated.push(province);
            }
            return {
              targetDate,
              scheduled,
              scheduled_details:stationDetailsForDate(targetDate),
              generated,
              skipped,
              predictions:await db.getDailyPredictions(targetDate),
              note:'Dự đoán đã lưu không được tạo lại hoặc sửa sau khi có kết quả.'
            };
          });
          return json(res,200,payload);
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
      if((url.pathname==='/api/prize8/predict' || url.pathname==='/api/prize8/v2/predict' || url.pathname==='/api/prize8/v3/predict') && req.method==='GET') {
        const version = url.pathname==='/api/prize8/v3/predict'
          ? 'v3'
          : (url.pathname==='/api/prize8/v2/predict'
            ? 'v2'
            : (url.searchParams.get('version') || 'v1').toLowerCase());
        if(version!=='v1' && version!=='v2' && version!=='v3')
          return json(res,400,{error:'Phiên bản mô hình chỉ hỗ trợ v1, v2 hoặc v3'});
        const targetDate = url.searchParams.get('date') || vnClock().day;
        const province = url.searchParams.get('province') || '';
        if(!validDay(targetDate)) return json(res,400,{error:'Ngày dự đoán phải có định dạng YYYY-MM-DD'});
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(province))
          return json(res,400,{error:'Hãy chọn một đài xổ số miền Nam'});
        if(version==='v3') {
          const parameters = {
            shortHalfLife:Number(url.searchParams.get('shortHalfLife') ?? DEFAULT_V3_PARAMS.shortHalfLife),
            mediumHalfLife:Number(url.searchParams.get('mediumHalfLife') ?? DEFAULT_V3_PARAMS.mediumHalfLife),
            digitHalfLife:Number(url.searchParams.get('digitHalfLife') ?? DEFAULT_V3_PARAMS.digitHalfLife),
            shortWeight:Number(url.searchParams.get('shortWeight') ?? 30)/100,
            mediumWeight:Number(url.searchParams.get('mediumWeight') ?? 10)/100,
            longWeight:Number(url.searchParams.get('longWeight') ?? 15)/100,
            digitWeight:Number(url.searchParams.get('digitWeight') ?? 30)/100,
            uniformShrinkage:Number(url.searchParams.get('uniformShrinkage') ?? 15)/100,
            alpha:Number(url.searchParams.get('alpha') ?? DEFAULT_V3_PARAMS.alpha),
            alphaDigit:Number(url.searchParams.get('alphaDigit') ?? DEFAULT_V3_PARAMS.alphaDigit),
            topK:Number(url.searchParams.get('topK') ?? 10),
            backtestDraws:Number(url.searchParams.get('backtestDraws') ?? 80)
          };
          let p;
          try { p=validateV3Parameters(parameters); }
          catch(e) { return json(res,400,{error:e.message}); }
          if(typeof db.getPrize8History!=='function')
            return json(res,503,{error:'Cần MySQL để dự đoán giải 8'});
          const history=await db.getPrize8History({province,before:targetDate,limit:500});
          const coverage=analyzeHistoryCoverage(history,targetDate,province);
          const forecast=rankPrize8V3(history,targetDate,p,{
            includeRanking:url.searchParams.get('includeRanking')==='true'
          });
          const evaluation=backtestPrize8V3(history,targetDate,p);
          return json(res,200,{
            modelVersion:V3_MODEL_VERSION,
            province,name:history.at(-1)?.name||province,
            targetDate,historyCount:history.length,
            coverage,forecast,backtest:evaluation,
            notes:'Mô hình V3 dùng đa khung suy giảm (ngắn 6 kỳ + trung 18 kỳ), toàn lịch sử, biên đầu/đuôi suy giảm (16 kỳ) và làm mịn Dirichlet mạnh hơn, đối chiếu với V2, V1, tần suất thô và ngẫu nhiên đều.'
          });
        }
        if(version==='v2') {
          const parameters = {
            window:Number(url.searchParams.get('window') ?? 52),
            halfLife:Number(url.searchParams.get('halfLife') ?? 12),
            recentWeight:Number(url.searchParams.get('recentWeight') ?? 35)/100,
            longWeight:Number(url.searchParams.get('longWeight') ?? 30)/100,
            digitWeight:Number(url.searchParams.get('digitWeight') ?? 20)/100,
            uniformShrinkage:Number(url.searchParams.get('uniformShrinkage') ?? 15)/100,
            topK:Number(url.searchParams.get('topK') ?? 10),
            backtestDraws:Number(url.searchParams.get('backtestDraws') ?? 80),
            alpha:0.5,
            alphaDigit:1
          };
          let p;
          try { p=validateV2Parameters(parameters); }
          catch(e) { return json(res,400,{error:e.message}); }
          if(typeof db.getPrize8History!=='function')
            return json(res,503,{error:'Cần MySQL để dự đoán giải 8'});
          const history=await db.getPrize8History({province,before:targetDate,limit:500});
          const coverage=analyzeHistoryCoverage(history,targetDate,province);
          const forecast=rankPrize8V2(history,targetDate,p);
          const evaluation=backtestPrize8V2(history,targetDate,p);
          return json(res,200,{
            modelVersion:V2_MODEL_VERSION,
            province,name:history.at(-1)?.name||province,
            targetDate,historyCount:history.length,
            coverage,forecast,backtest:evaluation,
            notes:'Mô hình V2 chỉ dùng lịch sử giải 8 của đài đã chọn trước ngày dự đoán và đối chiếu với V1, tần suất thô và mốc ngẫu nhiên đều. Đây là xếp hạng thử nghiệm, không phải xác suất trúng.'
          });
        }
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
              if(existing && existing.status==='complete_by_provider_count') {
                return json(res,200,{...existing,cached:true});
              }
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
