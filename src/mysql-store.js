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
  return { readDay,listHistory,listStations,writeDay,getStats,close:()=>pool.end() };
}
function sqlTime(value) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) throw new Error('fetched_at không hợp lệ');
  return date.toISOString().slice(0,23).replace('T',' ');
}
