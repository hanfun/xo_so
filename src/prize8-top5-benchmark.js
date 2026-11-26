import 'dotenv/config';
import { createConfiguredStore } from './database.js';
import {
  MIN_HISTORY, normalizeHistory, rankPrize8V2, rankPrize8V3, rankPrize8V4, wilsonInterval
} from './prize8-predictor.js';

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

const calendarCandidates = [
  { name: 'V4-12-8', rank: rankPrize8V4, options: {} },
  { name: 'V4-8-4', rank: rankPrize8V4, options: {
    baseWeight: 0.88, calendarWeight: 0.08, ordinalWeight: 0.04
  } },
  { name: 'V4-6-2', rank: rankPrize8V4, options: {
    baseWeight: 0.92, calendarWeight: 0.06, ordinalWeight: 0.02
  } },
  { name: 'V4-calendar', rank: rankPrize8V4, options: {
    baseWeight: 0.90, calendarWeight: 0.10, ordinalWeight: 0
  } }
];

// Under independent uniform draws, each past-only Top 5 has a 5% hit chance.
function top5TailProbability(hits, draws) {
  if (!draws) return null;
  if (!hits) return 1;
  const mass = new Float64Array(hits + 1);
  mass[0] = 1;
  for (let draw = 0; draw < draws; draw++) {
    mass[hits] += 0.05 * mass[hits - 1];
    for (let k = Math.min(draw + 1, hits - 1); k > 0; k--) {
      mass[k] = 0.95 * mass[k] + 0.05 * mass[k - 1];
    }
    mass[0] *= 0.95;
  }
  return mass[hits];
}

function measure(stations, from, before, models) {
  const hits = models.map(() => 0);
  const rankSums = models.map(() => 0);
  const distanceSums = models.map(() => 0);
  let evaluated = 0;
  for (const history of stations) {
    for (let i = MIN_HISTORY; i < history.length; i++) {
      const { date, number } = history[i];
      if (date < from || date >= before) continue;
      const training = history.slice(0, i);
      evaluated++;
      models.forEach(({ rank, options }, j) => {
        const { top, ranking } = rank(training, date, { ...options, topK: 5 }, { includeRanking: true });
        hits[j] += Number(top.some(item => item.number === number));
        if (ranking) {
          const position = ranking.indexOf(number) + 1;
          rankSums[j] += position;
          distanceSums[j] += Math.max(0, position - 5);
        }
      });
    }
  }
  return models.map(({ name }, i) => ({
    name, evaluated, hits: hits[i],
    rate: evaluated ? Number((100 * hits[i] / evaluated).toFixed(2)) : null,
    ci95: wilsonInterval(hits[i], evaluated),
    avgRank: rankSums[i] ? Number((rankSums[i] / evaluated).toFixed(2)) : null,
    avgDistanceToTop5: rankSums[i] ? Number((distanceSums[i] / evaluated).toFixed(2)) : null
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
  const configs = [
    ...candidates.map(candidate => ({ ...candidate, rank: rankPrize8V3 })),
    ...calendarCandidates
  ];
  const tuning = measure(histories, '', split, configs);
  if (!tuning[0].evaluated) throw new Error('Không đủ dữ liệu trước mốc chia.');
  const selected = tuning.reduce((best, current) => current.hits > best.hits ? current : best).name;
  const comparison = [{ name: 'V2', rank: rankPrize8V2 }, configs[0]];
  if (selected !== 'V3') comparison.push(configs.find(model => model.name === selected));
  for (const model of calendarCandidates) {
    if (!comparison.some(item => item.name === model.name)) comparison.push(model);
  }
  const holdout = measure(histories, split, before, comparison).map(result => ({
    ...result,
    exploratoryPValueVsUniform: top5TailProbability(result.hits, result.evaluated)
  }));
  console.log(JSON.stringify({
    split, before, stations: stations.length, baselinePercent: 5,
    candidates: configs.map(({name, options}) => ({name, options})), tuning, selected, holdout
  }, null, 2));
} finally {
  await store.close();
}
