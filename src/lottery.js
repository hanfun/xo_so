import { API_BASE, FALLBACK_API_BASE, TIMEZONE, validDay } from './config.js';

export const REGIONS = ['MN'];
export const PRIZE_NAMES = {
  giaidb: 'Đặc biệt', giai1: 'Giải 1', giai2: 'Giải 2',
  giai3: 'Giải 3', giai4: 'Giải 4', giai5: 'Giải 5',
  giai6: 'Giải 6', giai7: 'Giải 7', giai8: 'Giải 8'
};
export const PRIZE_ORDER = Object.keys(PRIZE_NAMES);
const PRIZE_SPEC = {
  giaidb: [1,6], giai1: [1,5], giai2: [1,5], giai3: [2,5],
  giai4: [7,5], giai5: [1,4], giai6: [3,4], giai7: [1,3], giai8: [1,2]
};
export function validateDraw(key, item, day) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'Dữ liệu đài không hợp lệ' };
  if (typeof item.province !== 'string' || item.province !== key) return { error: 'Mã đài không khớp' };
  if (item.region !== 'MN') return { error: 'Chỉ hỗ trợ xổ số miền Nam' };
  if (item.date !== day) return { error: 'Ngày quay không khớp' };
  if (typeof item.name !== 'string' || !item.name.trim()) return { error: 'Thiếu tên đài' };
  if (!item.prizes || typeof item.prizes !== 'object' || Array.isArray(item.prizes)) return { error: 'Thiếu các giải' };
  const prizes = {};
  for (const [tier, [count,digits]] of Object.entries(PRIZE_SPEC)) {
    const nums = item.prizes[tier];
    if (!Array.isArray(nums) || nums.length !== count) return { error: `${tier} chưa đủ ${count} số` };
    if (!nums.every(n => typeof n === 'string' && new RegExp(`^[0-9]{${digits}}$`).test(n))) {
      return { error: `${tier} không đúng ${digits} chữ số (giữ nguyên số 0 đầu)` };
    }
    prizes[tier] = [...nums];
  }
  return { draw: {
    date: day, region: 'MN', province: key, name: item.name.trim(),
    ticket_type: typeof item.ticket_type === 'string' ? item.ticket_type : '', prizes
  }};
}
export function extractSouthPayload(day, payload) {
  if (!validDay(day) || !payload || payload.date !== day
    || !payload.results || typeof payload.results !== 'object' || Array.isArray(payload.results)) {
    throw new Error('Dữ liệu API không đúng ngày hoặc thiếu danh sách kết quả');
  }
  const entries = Object.entries(payload.results).filter(([, value]) => value && value.region === 'MN');
  return { date: day, count: entries.length, results: Object.fromEntries(entries) };
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function readJson(response) {
  const max = 2_000_000;
  if (Number(response.headers.get('content-length')) > max) throw new Error('API trả về dữ liệu quá lớn');
  let size=0; const chunks=[];
  if (!response.body) throw new Error('API trả về nội dung rỗng');
  for await (const chunk of response.body) {
    size+=chunk.length;
    if (size>max) throw new Error('API trả về dữ liệu quá lớn');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));
}
async function fetchPrimary(day,{baseUrl,fetchImpl,retries}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/${day}.json`;
  let lastError;
  for (let attempt=0; attempt<retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept:'application/json', 'User-Agent':'XSKT-Node-Local/1.1' },
        signal: AbortSignal.timeout(15000), cache:'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} (${day})`);
      const payload = await readJson(response);
      if (!payload || typeof payload!=='object' || Array.isArray(payload) || payload.date !== day
        || !payload.results || typeof payload.results!=='object' || Array.isArray(payload.results)) {
        throw new Error('Ngày hoặc danh sách kết quả của API không hợp lệ');
      }
      return { payload, sourceUrl:url };
    } catch(error) {
      lastError=error;
      if (attempt+1 < retries) await sleep(800*(attempt+1));
    }
  }
  throw lastError;
}
function stationCode(name) {
  const normalized=String(name).trim().toLowerCase().replace(/đ/g,'d')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if(['tp-hcm','tp-ho-chi-minh','ho-chi-minh'].includes(normalized)) return 'ho-chi-minh';
  return normalized;
}
export function adaptXosovnmPayload(day,body) {
  const displayDate=day.split('-').reverse().join('/');
  const row=body?.data?.find?.(item=>item?.date===displayDate);
  const cities=row?.data?.city;
  if(!Array.isArray(cities) || !cities.length) throw new Error(`Nguồn phụ không có kết quả XSMN ngày ${day}`);
  const fields={giaidb:['db',1],giai1:['g1',1],giai2:['g2',1],giai3:['g3',2],
    giai4:['g4',7],giai5:['g5',1],giai6:['g6',3],giai7:['g7',1],giai8:['g8',1]};
  const results={};
  cities.forEach((name,index)=>{
    const prizes={};
    for(const [tier,[field,count]] of Object.entries(fields)) {
      const values=row.data[field];
      if(!Array.isArray(values) || values.length!==cities.length*count)
        throw new Error(`Nguồn phụ thiếu hoặc sai cấu trúc ${field}`);
      prizes[tier]=values.slice(index*count,(index+1)*count).map(String);
    }
    const code=stationCode(name);
    results[code]={date:day,region:'MN',province:code,name:String(name).trim(),ticket_type:'',prizes};
  });
  return {date:day,count:cities.length,results};
}
async function fetchFallback(day,{baseUrl,fetchImpl}) {
  const date=day.split('-').reverse().join('/');
  const query=new URLSearchParams({date,limit:'10'});
  const url=`${baseUrl.replace(/\/+$/, '')}/lottery/region/mien-nam?${query}`;
  const response=await fetchImpl(url,{
    headers:{Accept:'application/json','User-Agent':'XSKT-Node-Local/1.1'},
    signal:AbortSignal.timeout(15000),cache:'no-store'
  });
  if(!response.ok) throw new Error(`HTTP ${response.status} (${day})`);
  return {payload:adaptXosovnmPayload(day,await readJson(response)),sourceUrl:url};
}
export async function fetchDay(day, {
  baseUrl = API_BASE, fallbackBaseUrl = FALLBACK_API_BASE, fetchImpl = fetch, retries = 2
} = {}) {
  if (!validDay(day)) throw new Error('Ngày phải có định dạng YYYY-MM-DD');
  let primaryError;
  try { return await fetchPrimary(day,{baseUrl,fetchImpl,retries}); }
  catch(error) { primaryError=error; }
  try { return await fetchFallback(day,{baseUrl:fallbackBaseUrl,fetchImpl}); }
  catch(error) {
    throw new Error(`Không lấy được dữ liệu: nguồn chính: ${primaryError.message}; nguồn phụ: ${error.message}`);
  }
}
export function normalizePayload(day, southPayload, sourceUrl, previous = null) {
  if (!validDay(day) || southPayload?.date !== day) throw new Error('Ngày từ API không hợp lệ');
  const entries = southPayload.results;
  if (!entries || typeof entries!=='object' || Array.isArray(entries)) throw new Error('Thiếu results');
  const providerEntries = Object.entries(entries).filter(([,item])=>item?.region==='MN');
  const issues = []; const accepted = [];
  for (const [key, item] of providerEntries) {
    const { error, draw } = validateDraw(key,item,day);
    if (error) issues.push(`${key}: ${error}`);
    else accepted.push(draw);
  }
  const map = new Map();
  for (const old of previous?.results || []) {
    if (old?.region!=='MN') continue;
    const check = validateDraw(old.province,old,day);
    if (check.draw) map.set(check.draw.province,check.draw);
  }
  for(const item of accepted) map.set(item.province,item);
  const results = [...map.values()].sort((a,b)=>a.name.localeCompare(b.name,'vi'));
  if (!providerEntries.length && !results.length) throw new Error('Nguồn chưa có dữ liệu XSMN cho ngày này');
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const expected = weekday===6 ? 4 : 3;
  if (providerEntries.length !== expected) {
    issues.push(`Nguồn mới có ${providerEntries.length}/${expected} đài miền Nam`);
  }
  const complete = issues.length===0 && accepted.length===expected && results.length===expected;
  return {
    date:day, region:'MN',
    status: complete ? 'complete_by_provider_count' : 'needs_review',
    count:results.length, expected_count:expected, provider_advertised_count:providerEntries.length,
    region_counts:{MN:results.length}, issues,
    source_url:sourceUrl, fetched_at:new Date().toISOString(), timezone:TIMEZONE,
    disclaimer:'Dữ liệu nguồn tổng hợp bên thứ ba, không phải kết quả chính thức. Cần đối chiếu công ty XSKT.',
    results:results.map(item=>({...item,source:sourceUrl}))
  };
}
