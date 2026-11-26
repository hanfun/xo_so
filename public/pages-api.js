import {
  rankPrize8, rankPrize8V2, rankPrize8V3, rankPrize8V4,
  backtestPrize8, backtestPrize8V2, backtestPrize8V3, backtestPrize8V4,
  analyzeHistoryCoverage, analyzePrize8Distribution
} from './prize8-predictor.js';
import { stationDetailsForDate } from './station-schedule.js';
import { isCompleteReport, mergeReports } from './pages-sync-core.js';
import { workerUrl } from './pages-sync-config.js';

let syncAttempt;
async function maybeSyncToday(days, today) {
  if (!workerUrl || isCompleteReport(days[today], today)) return;
  if (syncAttempt?.date === today && Date.now() - syncAttempt.at < 300_000) return syncAttempt.promise;
  const promise = (async () => {
    try {
      const response = await fetch(new URL('/sync', workerUrl), { signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error('Sync HTTP ' + response.status);
      const update = await response.json();
      if (update.date !== today || !update.report) return;
      const merged = mergeReports(days[today], update.report, today);
      if (merged.changed) days[today] = merged.report;
    } catch (error) { console.warn('Không đồng bộ được JSON hôm nay:', error.message); }
  })();
  syncAttempt = { date: today, at: Date.now(), promise };
  return promise;
}

let dataset;
async function loadDataset() {
  if (!dataset) {
    dataset = fetch(new URL('./results.json', import.meta.url), { cache: 'no-cache' }).then(response => {
      if (!response.ok) throw new Error('Chưa có dữ liệu JSON trên GitHub Pages.');
      return response.json();
    }).catch(error => {
      dataset = undefined;
      throw error;
    });
  }
  return dataset;
}

const models = {
  v1: [rankPrize8, backtestPrize8],
  v2: [rankPrize8V2, backtestPrize8V2],
  v3: [rankPrize8V3, backtestPrize8V3],
  v4: [rankPrize8V4, backtestPrize8V4]
};

export async function pagesApi(request) {
  const { pathname, searchParams } = new URL(request, location.origin);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const date = searchParams.get('date') || today;
  if (pathname === '/api/status') return { today, today_stations: stationDetailsForDate(today) };
  if (pathname === '/api/opening-sync' || pathname === '/api/collect') {
    throw new Error('GitHub Pages đọc kết quả từ lần xuất bản JSON gần nhất.');
  }
  const days = await loadDataset();
  if (date === today) await maybeSyncToday(days, today);
  if (pathname === '/api/day') return days[date] ?? { date, count: 0, results: [] };
  if (pathname === '/api/history') return { dates: Object.keys(days).sort().reverse() };
  const draws = Object.values(days).flatMap(day => day.results);
  const province = searchParams.get('province');
  const name = draws.find(draw => draw.province === province)?.name || province;
  if (pathname === '/api/stations') {
    const stations = new Map();
    for (const draw of draws) {
      const item = stations.get(draw.province) ?? { code: draw.province, name: draw.name, draw_count: 0 };
      item.draw_count++;
      stations.set(item.code, item);
    }
    return { stations: [...stations.values()] };
  }
  if (pathname === '/api/station-results') {
    const before = searchParams.get('before') || '9999-12-31';
    const limit = Number(searchParams.get('limit') || 50);
    const results = draws.filter(draw => draw.province === province && draw.date < before)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    return { province, name, results, hasMore: results.length === limit };
  }
  if (pathname === '/api/stats') {
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const prize = searchParams.get('prize') || '';
    const months = new Map();
    const daily = new Map();
    const frequency = new Map();
    const totals = { numbers: 0, draws: 0, days: 0 };
    for (const draw of draws) {
      if (draw.date < from || draw.date > to || (province && draw.province !== province)) continue;
      const numbers = prize ? draw.prizes[prize] ?? [] : Object.values(draw.prizes).flat();
      if (!numbers.length) continue;
      const month = draw.date.slice(0, 7);
      const monthStats = months.get(month) ?? { month, numbers: 0, draws: 0 };
      const dayStats = daily.get(draw.date) ?? { date: draw.date, numbers: 0, draws: 0 };
      for (const item of [monthStats, dayStats, totals]) {
        item.numbers += numbers.length;
        item.draws++;
      }
      months.set(month, monthStats);
      daily.set(draw.date, dayStats);
      const seen = new Set();
      for (const number of numbers) {
        const tail = number.slice(-2);
        const item = frequency.get(tail) ?? { tail, appearances: 0, draws: 0, last_seen: draw.date };
        item.appearances++;
        if (!seen.has(tail)) item.draws++;
        if (draw.date > item.last_seen) item.last_seen = draw.date;
        frequency.set(tail, item);
        seen.add(tail);
      }
    }
    totals.days = daily.size;
    return {
      filters: { from, to, prize, province: province || '' }, totals,
      frequency: [...frequency.values()].sort((a, b) => b.appearances - a.appearances || a.tail.localeCompare(b.tail)).slice(0, 20),
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      days: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 31)
    };
  }
  const historyFor = code => draws
    .filter(draw => draw.province === code && draw.date < date && draw.prizes.giai8?.length)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-500)
    .map(draw => ({ date: draw.date, number: draw.prizes.giai8[0] }));
  if (pathname === '/api/prize8/daily') {
    const scheduled_details = stationDetailsForDate(date);
    const skipped = [];
    const predictions = [];
    for (const station of scheduled_details) {
      const forecast = rankPrize8V4(historyFor(station.code), date, {}, { includeRanking: true });
      if (forecast.status !== 'experimental') {
        skipped.push({ province: station.code, reason: 'insufficient_history', historyCount: forecast.historyCount });
        continue;
      }
      const actual = days[date]?.results.find(draw => draw.province === station.code)?.prizes.giai8?.[0] ?? null;
      const actualRank = actual === null ? null : forecast.ranking.indexOf(actual) + 1;
      predictions.push({
        province: station.code, name: station.name, targetDate: date,
        trainingCutoff: forecast.trainingEnd, modelVersion: `${forecast.modelVersion}-replay-json`,
        top: forecast.top.map((item, i) => ({ ...item, rank: i + 1 })),
        actual, actualRank, top5Hit: actualRank === null ? null : actualRank <= 5,
        top1Hit: actualRank === null ? null : actualRank === 1,
        top10Hit: actualRank === null ? null : actualRank <= 10,
        status: actualRank === null ? 'pending' : actualRank === 1 ? 'top1_hit' : actualRank <= 10 ? 'top10_hit' : 'miss'
      });
    }
    return { scheduled_details, predictions, skipped };
  }
  const history = historyFor(province);
  const options = Object.fromEntries([...searchParams]
    .filter(([, value]) => value !== '' && Number.isFinite(Number(value)))
    .filter(([key]) => !['province', 'date'].includes(key))
    .map(([key, value]) => [key, Number(value)]));
  if (pathname === '/api/prize8/distribution') {
    return { province, name, distribution: analyzePrize8Distribution(history, date, options) };
  }
  for (const key of Object.keys(options)) {
    if (key.endsWith('Weight') || key === 'uniformShrinkage') options[key] /= 100;
  }
  const version = pathname.match(/^\/api\/prize8\/(v[234])\/predict$/)?.[1]
    ?? (pathname === '/api/prize8/predict' ? 'v1' : null);
  if (version) {
    const [rank, backtest] = models[version];
    const forecast = rank(history, date, options, { includeRanking: searchParams.get('includeRanking') === 'true' });
    return { province, name, modelVersion: forecast.modelVersion, forecast,
      backtest: backtest(history, date, options), coverage: analyzeHistoryCoverage(history, date, province) };
  }
  throw new Error('Chức năng này cần máy chủ MySQL.');
}
