import { API_BASE, TIMEZONE, validDay } from './config.js';

export const REGIONS = ['MB', 'MT', 'MN'];
export const PRIZE_NAMES = {
  giaidb: 'Đặc biệt', giai1: 'Giải 1', giai2: 'Giải 2',
  giai3: 'Giải 3', giai4: 'Giải 4', giai5: 'Giải 5',
  giai6: 'Giải 6', giai7: 'Giải 7', giai8: 'Giải 8'
};
export const PRIZE_ORDER = Object.keys(PRIZE_NAMES);
const MB = {
  giaidb: [1, 5], giai1: [1, 5], giai2: [2, 5], giai3: [6, 5],
  giai4: [4, 4], giai5: [6, 4], giai6: [3, 3], giai7: [4, 2]
};
const OTHER = {
  giaidb: [1, 6], giai1: [1, 5], giai2: [1, 5], giai3: [2, 5],
  giai4: [7, 5], giai5: [1, 4], giai6: [3, 4], giai7: [1, 3], giai8: [1, 2]
};

export function validateDraw(key, item, day) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'Dữ liệu đài không hợp lệ' };
  if (typeof item.province !== 'string' || item.province !== key) return { error: 'Mã đài không khớp' };
  if (!REGIONS.includes(item.region)) return { error: 'Mã miền không hợp lệ' };
  if (item.date !== day) return { error: 'Ngày quay không khớp' };
  if (typeof item.name !== 'string' || !item.name.trim()) return { error: 'Thiếu tên đài' };
  if (!item.prizes || typeof item.prizes !== 'object' || Array.isArray(item.prizes)) {
    return { error: 'Thiếu các giải' };
  }
  const spec = item.region === 'MB' ? MB : OTHER;
  const prizes = {};
  for (const [tier, [count, digits]] of Object.entries(spec)) {
    const nums = item.prizes[tier];
    if (!Array.isArray(nums) || nums.length !== count) {
      return { error: `${tier} chưa đủ ${count} số` };
    }
    if (!nums.every(n => typeof n === 'string' && new RegExp(`^[0-9]{${digits}}$`).test(n))) {
      return { error: `${tier} không đúng ${digits} chữ số (giữ nguyên số 0 đầu)` };
    }
    prizes[tier] = [...nums];
  }
  return { draw: {
    date: day, region: item.region, province: key, name: item.name.trim(),
    ticket_type: typeof item.ticket_type === 'string' ? item.ticket_type : '',
    prizes
  } };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function fetchDay(day, { baseUrl = API_BASE, fetchImpl = fetch, retries = 2 } = {}) {
  if (!validDay(day)) throw new Error('Ngày phải có định dạng YYYY-MM-DD');
  const url = `${baseUrl.replace(/\/+$/, '')}/${day}.json`;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'XSKT-Node-Local/1.0' },
        signal: AbortSignal.timeout(15000), cache: 'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} (${day})`);
      const max = 2_000_000;
      if (Number(response.headers.get('content-length')) > max) throw new Error('API trả về dữ liệu quá lớn');
      // JSON.parse after an explicit bounded download so a bad endpoint cannot exhaust memory.
      let size = 0;
      const chunks = [];
      if (!response.body) throw new Error('API trả về nội dung rỗng');
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > max) throw new Error('API trả về dữ liệu quá lớn');
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.date !== day) {
        throw new Error('Ngày trong phản hồi API không khớp');
      }
      if (!payload.results || typeof payload.results !== 'object' || Array.isArray(payload.results)) {
        throw new Error('API không có danh sách kết quả hợp lệ');
      }
      return { payload, sourceUrl: url };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw new Error(`Không lấy được dữ liệu: ${lastError.message}`);
}

export function normalizePayload(day, payload, sourceUrl, previous = null) {
  if (!validDay(day) || payload.date !== day) throw new Error('Ngày từ API không hợp lệ');
  const entries = payload.results;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Thiếu results');
  const providerCount = Number.isInteger(payload.count) && payload.count >= 1 ? payload.count : null;
  const issues = [];
  const fromProvider = Object.entries(entries);
  if (providerCount !== null && fromProvider.length !== providerCount) {
    issues.push(`API báo ${providerCount} đài nhưng gửi ${fromProvider.length} đài`);
  }
  const accepted = [];
  for (const [key, item] of fromProvider) {
    const { error, draw } = validateDraw(key, item, day);
    if (error) issues.push(`${key}: ${error}`);
    else accepted.push(draw);
  }
  // Preserve previously validated draws if a later fetch happens to be incomplete.
  const map = new Map();
  for (const old of previous?.results || []) {
    const check = validateDraw(old.province, old, day);
    if (check.draw) map.set(`${old.region}:${old.province}`, check.draw);
  }
  for (const draw of accepted) map.set(`${draw.region}:${draw.province}`, draw);
  const results = [...map.values()].sort((a, b) => {
    const byRegion = REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region);
    return byRegion || a.name.localeCompare(b.name, 'vi');
  });
  const regionCounts = Object.fromEntries(REGIONS.map(r => [r, results.filter(x => x.region === r).length]));
  const complete = !issues.length && regionCounts.MB > 0 && regionCounts.MT > 0 && regionCounts.MN > 0
    && providerCount !== null && accepted.length === providerCount && results.length === providerCount;
  return {
    date: day, status: complete ? 'complete_by_provider_count' : 'needs_review',
    count: results.length, provider_advertised_count: providerCount,
    region_counts: regionCounts, issues,
    source_url: sourceUrl, fetched_at: new Date().toISOString(), timezone: TIMEZONE,
    disclaimer: 'Nguồn tổng hợp bên thứ ba. Đối chiếu thông báo của công ty XSKT trước khi sử dụng chính thức.',
    results: results.map(d => ({ ...d, source: sourceUrl }))
  };
}
