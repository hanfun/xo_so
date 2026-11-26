import { validDay } from './config.js';
import { validateDraw, PRIZE_ORDER, PRIZE_NAMES } from './lottery.js';

/** MySQL 8+ authoritative storage + normalized prize rows for historical statistics. */
export function createMysqlStore({ pool }) {
  if (!pool) throw new Error('MySQL connection pool is required');
  async function readDay(day) {
    if (!validDay(day)) throw new Error('Ngày không hợp lệ');
    const [rows] = await pool.execute('SELECT report_json FROM source_snapshots WHERE draw_date = ? LIMIT 1',[day]);
    if (!rows.length) return null;
    return typeof rows[0].report_json === 'string' ? JSON.parse(rows[0].report_json) : rows[0].report_json;
  }
  async function listHistory() {
    const [rows] = await pool.execute("SELECT DATE_FORMAT(draw_date, '%Y-%m-%d') AS day FROM source_snapshots ORDER BY draw_date DESC");
    return rows.map(row=>row.day);
  }
  async function listStations() {
    const [rows] = await pool.execute(`SELECT p.code, p.name, COUNT(d.id) AS draw_count
      FROM provinces p LEFT JOIN draws d ON d.province_id=p.id
      WHERE p.region='MN' GROUP BY p.id, p.code, p.name ORDER BY p.name`);
    return rows.map(row=>({code:row.code,name:row.name,draw_count:Number(row.draw_count)}));
  }
  async function writeDay(day,report,rawPayload=null) {
    if(!validDay(day) || report?.date!==day || !Array.isArray(report.results)) throw new Error('Báo cáo không hợp lệ');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`INSERT INTO source_snapshots
        (draw_date, source_url, raw_json, report_json, provider_count, status, fetched_at)
        VALUES (?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE source_url=VALUES(source_url), raw_json=COALESCE(VALUES(raw_json),raw_json),
          report_json=VALUES(report_json), provider_count=VALUES(provider_count),
          status=VALUES(status), fetched_at=VALUES(fetched_at)`,[
        day,report.source_url||null,rawPayload?JSON.stringify(rawPayload):null,
        JSON.stringify(report),report.provider_advertised_count??null,
        report.status||'needs_review',sqlTime(report.fetched_at)
      ]);
      for(const item of report.results) {
        const { error,draw } = validateDraw(item.province,item,day);
        if(error) throw new Error(`${item.province}: ${error}`);
        const [prov] = await conn.execute(`INSERT INTO provinces (region,code,name) VALUES (?,?,?)
          ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), name=VALUES(name)`,['MN',draw.province,draw.name]);
        const [res] = await conn.execute(`INSERT INTO draws (province_id,draw_date,ticket_type,source_url)
          VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),
          ticket_type=VALUES(ticket_type),source_url=VALUES(source_url),collected_at=CURRENT_TIMESTAMP(3)`,[
          prov.insertId,day,draw.ticket_type||'',report.source_url||null
        ]);
        await conn.execute('DELETE FROM prize_results WHERE draw_id=?',[res.insertId]);
        const values=[];
        for(const tier of PRIZE_ORDER) {
          draw.prizes[tier].forEach((number,i)=>values.push(res.insertId,tier,i+1,number));
        }
        if(values.length) {
          const placeholders=Array(values.length/4).fill('(?,?,?,?)').join(',');
          await conn.execute(`INSERT INTO prize_results (draw_id,prize_code,position,number) VALUES ${placeholders}`,values);
        }
      }
      await conn.commit();
    } catch(e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally { conn.release(); }
  }
  async function getStats({from,to,province='',prize=''}={}) {
    if(!validDay(from)||!validDay(to)||from>to) throw new Error('Khoảng ngày không hợp lệ');
    if(province && !/^[a-zA-Z0-9_-]{1,100}$/.test(province)) throw new Error('Mã đài không hợp lệ');
    if(prize && !Object.hasOwn(PRIZE_NAMES,prize)) throw new Error('Mã giải không hợp lệ');
    const conditions=["p.region='MN'",'d.draw_date BETWEEN ? AND ?'];
    const args=[from,to];
    if(province){conditions.push('p.code = ?');args.push(province);}
    if(prize){conditions.push('r.prize_code = ?');args.push(prize);}
    const joined=`FROM prize_results r JOIN draws d ON d.id=r.draw_id
      JOIN provinces p ON p.id=d.province_id WHERE ${conditions.join(' AND ')}`;
    const [totals] = await pool.execute(`SELECT COUNT(*) AS total_numbers,
      COUNT(DISTINCT d.id) AS total_draws,COUNT(DISTINCT d.draw_date) AS total_days ${joined}`,args);
    const [frequency] = await pool.execute(`SELECT RIGHT(r.number,2) AS tail,
      COUNT(*) AS appearances,COUNT(DISTINCT d.id) AS draw_count,
      DATE_FORMAT(MAX(d.draw_date),'%Y-%m-%d') AS last_seen ${joined}
      GROUP BY RIGHT(r.number,2) ORDER BY appearances DESC,tail ASC LIMIT 20`,args);
    const [months] = await pool.execute(`SELECT DATE_FORMAT(d.draw_date,'%Y-%m') AS month,
      COUNT(*) AS prize_numbers,COUNT(DISTINCT d.id) AS draws ${joined}
      GROUP BY DATE_FORMAT(d.draw_date,'%Y-%m') ORDER BY month ASC`,args);
    const [days] = await pool.execute(`SELECT DATE_FORMAT(d.draw_date,'%Y-%m-%d') AS date,
      COUNT(*) AS prize_numbers,COUNT(DISTINCT d.id) AS draws ${joined}
      GROUP BY DATE_FORMAT(d.draw_date,'%Y-%m-%d') ORDER BY date DESC LIMIT 31`,args);
    const count=x=>Number(x||0);
    return {
      filters:{from,to,province,prize},
      totals:{numbers:count(totals[0]?.total_numbers),draws:count(totals[0]?.total_draws),days:count(totals[0]?.total_days)},
      frequency:frequency.map(x=>({
        tail:String(x.tail),appearances:count(x.appearances),
        draws:count(x.draw_count),last_seen:x.last_seen
      })),
      months:months.map(x=>({month:x.month,numbers:count(x.prize_numbers),draws:count(x.draws)})),
      days:days.map(x=>({date:x.date,numbers:count(x.prize_numbers),draws:count(x.draws)})),
      notes:'Tần suất hai số cuối của các lần quay trong bộ lọc, không phải xác suất kỳ sau.'
    };
  }
  async function getPrize8History({ province, before, limit = 500 } = {}) {
    if (typeof province !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(province))
      throw new Error('Hãy chọn một đài xổ số miền Nam hợp lệ');
    if (!validDay(before)) throw new Error('Ngày dự đoán không hợp lệ');
    if (!Number.isInteger(limit) || limit < 20 || limit > 500)
      throw new Error('Giới hạn lịch sử phải từ 20 đến 500 kỳ');
    // IMPORTANT: strict < target date to avoid target draw leakage.
    const [rows] = await pool.execute(`SELECT
      p.code AS province, p.name AS name,
      DATE_FORMAT(d.draw_date,'%Y-%m-%d') AS date, r.number
      FROM prize_results r
      JOIN draws d ON d.id=r.draw_id
      JOIN provinces p ON p.id=d.province_id
      WHERE p.region='MN' AND p.code=? AND r.prize_code='giai8'
        AND r.position=1 AND d.draw_date < ?
      ORDER BY d.draw_date DESC LIMIT ?`, [province, before, limit]);
    return rows.map(row => ({
      province: String(row.province),
      name: String(row.name),
      date: String(row.date),
      number: String(row.number)
    })).reverse();
  }
  async function getStationHistory({province,before='9999-12-31',limit=50}={}) {
    if(typeof province!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(province))
      throw new Error('Mã đài không hợp lệ');
    if(!validDay(before))throw new Error('Ngày phân trang không hợp lệ');
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Giới hạn phải từ 1 đến 100 kỳ');
    const [rows]=await pool.execute(`SELECT p.code AS province,p.name,
      DATE_FORMAT(d.draw_date,'%Y-%m-%d') AS date,d.ticket_type,
      r.prize_code,r.position,r.number
      FROM (SELECT d0.id FROM draws d0 JOIN provinces p0 ON p0.id=d0.province_id
        WHERE p0.region='MN' AND p0.code=? AND d0.draw_date < ?
        ORDER BY d0.draw_date DESC LIMIT ?) selected
      JOIN draws d ON d.id=selected.id JOIN provinces p ON p.id=d.province_id
      JOIN prize_results r ON r.draw_id=d.id
      ORDER BY d.draw_date DESC,FIELD(r.prize_code,'giaidb','giai1','giai2','giai3','giai4','giai5','giai6','giai7','giai8'),r.position`,
      [province,before,limit]);
    const grouped=new Map();
    for(const row of rows) {
      if(!grouped.has(row.date))grouped.set(row.date,{province:String(row.province),name:String(row.name),
        date:String(row.date),ticket_type:String(row.ticket_type||''),prizes:Object.fromEntries(PRIZE_ORDER.map(x=>[x,[]]))});
      if(Object.hasOwn(grouped.get(row.date).prizes,row.prize_code))
        grouped.get(row.date).prizes[row.prize_code].push(String(row.number));
    }
    return [...grouped.values()];
  }
  async function savePrize8Predictions({
    province,
    targetDate,
    trainingCutoff,
    items,
    ranking,
    modelKey = 'prize8-v2-daily',
    modelVersion,
    description = 'Xếp hạng Giải 8 tự động theo ngày',
    parameters
  }) {
    if(!validDay(targetDate)||!validDay(trainingCutoff)||trainingCutoff>=targetDate)
      throw new Error('Mốc huấn luyện dự đoán không hợp lệ');
    if(!Array.isArray(items)||!items.length)throw new Error('Không có số dự đoán để lưu');
    if(items.some(item=>typeof item?.number!=='string'||!/^\d{2}$/.test(item.number)))
      throw new Error('Số dự đoán giải 8 phải là chuỗi hai chữ số');
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Lock the station row to serialize concurrent daily-prediction requests for the same station.
      const [provinces]=await conn.execute(
        "SELECT id FROM provinces WHERE region='MN' AND code=? LIMIT 1 FOR UPDATE",
        [province]
      );
      if(!provinces.length)throw new Error(`Chưa có dữ liệu đài ${province}`);
      const provinceId=provinces[0].id;
      // Strictly idempotent & immutable: never regenerate or overwrite once saved for (province, target_date).
      const [existing]=await conn.execute(
        `SELECT COUNT(*) AS existing_count FROM predictions
         WHERE province_id=? AND target_date=? AND prediction_type='prize8_top10'`,
        [provinceId,targetDate]
      );
      if(Number(existing[0]?.existing_count||0)>0) {
        await conn.commit();
        return { created:false, reason:'already_exists' };
      }
      const [models]=await conn.execute(`INSERT INTO model_versions
        (model_key,version,description,parameters_json) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
        [modelKey,modelVersion,description,JSON.stringify(parameters)]);
      for(const [index,item] of items.entries()) {
        await conn.execute(`INSERT IGNORE INTO predictions
          (model_version_id,province_id,target_date,prediction_type,predicted_value,confidence,training_cutoff,metadata_json)
          VALUES (?,?,?,?,?,NULL,?,?)`,[models.insertId,provinceId,targetDate,'prize8_top10',item.number,
          trainingCutoff,JSON.stringify({
            rank:index+1,
            ...(index===0 && ranking ? { ranking } : {}),
            score:item.score,
            observed:item.observed ?? null,
            totalObserved:item.totalObserved ?? null,
            lastSeen:item.lastSeen ?? null
          })]);
      }
      await conn.commit();
      return { created:true, count:items.length };
    } catch(e) {try{await conn.rollback();}catch{}throw e;}
    finally{conn.release();}
  }
  async function getDailyPredictions(targetDate) {
    if(!validDay(targetDate))throw new Error('Ngày dự đoán không hợp lệ');
    const [rows]=await pool.execute(`SELECT p.code AS province,p.name,pred.predicted_value,
      DATE_FORMAT(pred.training_cutoff,'%Y-%m-%d') AS training_cutoff,
      pred.generated_at,pred.metadata_json,
      mv.model_key,mv.version AS model_version,
      actual.number AS actual
      FROM predictions pred
      JOIN provinces p ON p.id=pred.province_id
      LEFT JOIN model_versions mv ON mv.id=pred.model_version_id
      LEFT JOIN draws d ON d.province_id=p.id AND d.draw_date=pred.target_date
      LEFT JOIN prize_results actual ON actual.draw_id=d.id AND actual.prize_code='giai8' AND actual.position=1
      WHERE p.region='MN' AND pred.target_date=? AND pred.prediction_type='prize8_top10'
      ORDER BY p.name,CAST(JSON_UNQUOTE(JSON_EXTRACT(pred.metadata_json,'$.rank')) AS UNSIGNED),pred.id`,[targetDate]);
    const grouped=new Map();
    for(const row of rows) {
      const metadata=typeof row.metadata_json==='string'?JSON.parse(row.metadata_json):(row.metadata_json||{});
      const cutoff=row.training_cutoff instanceof Date
        ? row.training_cutoff.toISOString().slice(0,10)
        : String(row.training_cutoff);
      if(!grouped.has(row.province))grouped.set(row.province,{
        province:String(row.province),
        name:String(row.name),
        targetDate,
        trainingCutoff:cutoff,
        generatedAt:new Date(row.generated_at).toISOString(),
        modelKey:row.model_key?String(row.model_key):null,
        modelVersion:row.model_version?String(row.model_version):null,
        actual:row.actual==null?null:String(row.actual),
        top:[],
        ranking:null
      });
      if(Array.isArray(metadata.ranking)) grouped.get(row.province).ranking=metadata.ranking;
      grouped.get(row.province).top.push({
        number:String(row.predicted_value),
        rank:Number(metadata.rank ?? (grouped.get(row.province).top.length+1)),
        score:Number(metadata.score ?? 0),
        observed:metadata.observed ?? null,
        totalObserved:metadata.totalObserved ?? null,
        lastSeen:metadata.lastSeen ?? null
      });
    }
    return [...grouped.values()].map(({ranking,...group})=>{
      const fullRank=group.actual==null?0:(ranking?.indexOf(group.actual)??-1)+1;
      const actualRank=fullRank || (group.top.find(x=>x.number===group.actual)?.rank??null);
      const top1Hit=group.actual==null?null:actualRank===1;
      const top5Hit=group.actual==null?null:actualRank!==null&&actualRank<=5;
      const top10Hit=group.actual==null?null:actualRank!==null&&actualRank<=10;
      const status=group.actual==null?'pending':(top1Hit?'top1_hit':(top10Hit?'top10_hit':'miss'));
      return { ...group, actualRank, top1Hit, top5Hit, top10Hit, status };
    });
  }
  return { readDay,listHistory,listStations,writeDay,getStats,getPrize8History,getStationHistory,
    savePrize8Predictions,getDailyPredictions,close:()=>pool.end() };
}
function sqlTime(value) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) throw new Error('fetched_at không hợp lệ');
  return date.toISOString().slice(0,23).replace('T',' ');
}
