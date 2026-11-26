import 'dotenv/config';
import { createConfiguredStore } from './database.js';
import { MIN_HISTORY, normalizeHistory, rankPrize8V2, rankPrize8V3, wilsonInterval } from './prize8-predictor.js';

const candidates = [
  { name: 'V3', options: {} },
  { name: 'V3-alpha', options: { alpha: 2, alphaDigit: 3 } },
  { name: 'V3-dai-han', options: {
    shortWeight: 0.15, mediumWeight: 0.10, longWeight: 0.30, digitWeight: 0.30
  } },
  { name: 'V3-chu-so', options: {
    shortWeight: 0.20, mediumWeight: 0.10, longWeight: 0.15, digitWeight: 0.40
  } }
];

function measure(stations, from, before, models) {
  const hits = models.map(() => 0);
  let evaluated = 0;
  for (const history of stations) {
    for (let i = MIN_HISTORY; i < history.length; i++) {
      const { date, number } = history[i];
      if (date < from || date >= before) continue;
      const training = history.slice(0, i);
      evaluated++;
      models.forEach(({ rank, options }, j) => {
        const { top } = rank(training, date, { ...options, topK: 5 });
        hits[j] += Number(top.some(item => item.number === number));
      });
    }
  }
  return models.map(({ name }, i) => ({
    name, evaluated, hits: hits[i],
    rate: evaluated ? Number((100 * hits[i] / evaluated).toFixed(2)) : null,
    ci95: wilsonInterval(hits[i], evaluated)
  }));
}

const [split = '2026-06-01', before = '2026-11-23'] = process.argv.slice(2);
const validDate = value => {
  const parsed = new Date(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
};
if (!validDate(split) || !validDate(before) || split >= before) {
  throw new Error('Cần hai mốc YYYY-MM-DD hợp lệ, mốc chia phải trước mốc kết thúc.');
}

const store = await createConfiguredStore();
try {
  const stations = await store.listStations();
  const histories = await Promise.all(stations.map(async ({ code }) =>
    normalizeHistory(await store.getPrize8History({ province: code, before }))));
  const configs = candidates.map(candidate => ({ ...candidate, rank: rankPrize8V3 }));
  const tuning = measure(histories, '', split, configs);
  if (!tuning[0].evaluated) throw new Error('Không đủ dữ liệu trước mốc chia.');
  const selected = tuning.reduce((best, current) => current.hits > best.hits ? current : best).name;
  const comparison = [{ name: 'V2', rank: rankPrize8V2 }, configs[0]];
  if (selected !== 'V3') comparison.push(configs.find(model => model.name === selected));
  const holdout = measure(histories, split, before, comparison);
  console.log(JSON.stringify({
    split, before, stations: stations.length, baselinePercent: 5, candidates, tuning, selected, holdout
  }, null, 2));
} finally {
  await store.close();
}
