import { XSMN_WEEKLY_SCHEDULE } from './station-schedule.js';

/**
 * Experimental, non-calibrated ranking of Southern lottery prize 8 (00..99).
 *
 * Input: individual province's prize-8 history; a draw contributes exactly
 * one two-digit string. Train only on dates < targetDate.
 *
 * V1 Ranking = recentWeight * exponentially decayed smoothed frequency
 *            + (1 - recentWeight) * equally weighted smoothed frequency (in window).
 * V2 Ranking = recentWeight * decayed frequency (in window)
 *            + longWeight * full-history frequency (all draws < targetDate)
 *            + digitWeight * factorized tens/ones marginal frequency (0-9 x 0-9)
 *            + uniformShrinkage * (1 / 100).
 *
 * This is NOT a validated probability forecast: independent fair draws
 * cannot be reliably predicted from their past outcomes.
 */
export const MIN_HISTORY = 20;
export const V2_MODEL_VERSION = 'v2.0.0';
export const V3_MODEL_VERSION = 'v3.0.0';
export const V4_MODEL_VERSION = 'v4.0.0';
export const UNIFORM_LOG_LOSS = Math.log(100);
export const UNIFORM_BRIER = 0.99;
export const UNIFORM_AVG_RANK = 50.5;
export const UNIFORM_MRR = Array.from({ length: 100 }, (_, i) => 1 / (i + 1))
  .reduce((a, b) => a + b, 0) / 100;

export const DEFAULT_PARAMS = Object.freeze({
  window: 52, halfLife: 12, recentWeight: 0.7, alpha: 0.5, topK: 10,
  backtestDraws: 80
});

export const DEFAULT_V2_PARAMS = Object.freeze({
  window: 52,
  halfLife: 12,
  recentWeight: 0.35,
  longWeight: 0.30,
  digitWeight: 0.20,
  uniformShrinkage: 0.15,
  alpha: 0.5,
  alphaDigit: 1,
  topK: 10,
  backtestDraws: 80
});

export const DEFAULT_V3_PARAMS = Object.freeze({
  shortHalfLife: 6,
  mediumHalfLife: 18,
  digitHalfLife: 16,
  shortWeight: 0.30,
  mediumWeight: 0.10,
  longWeight: 0.15,
  digitWeight: 0.30,
  uniformShrinkage: 0.15,
  alpha: 1.0,
  alphaDigit: 1.5,
  topK: 10,
  backtestDraws: 80
});

export const V3_TOP5_WEIGHTS = Object.freeze({ shortWeight: 0.15, longWeight: 0.30 });

export const DEFAULT_V4_PARAMS = Object.freeze({
  ...DEFAULT_V3_PARAMS,
  baseWeight: 0.80,
  calendarWeight: 0.12,
  ordinalWeight: 0.08,
  calendarHalfLife: 80,
  alphaContext: 2,
  topK: 10,
  backtestDraws: 80
});

export function validateV4Parameters(params = {}) {
  const p = { ...DEFAULT_V4_PARAMS, ...params };
  validateV3Parameters(p);
  for (const key of ['baseWeight', 'calendarWeight', 'ordinalWeight']) {
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1)
      throw new Error(`${key} phải nằm trong khoảng 0–1`);
  }
  if (Math.abs(p.baseWeight + p.calendarWeight + p.ordinalWeight - 1) > 1e-6)
    throw new Error('Tổng ba trọng số V4 (baseWeight, calendarWeight, ordinalWeight) phải bằng 1');
  if (!Number.isFinite(p.calendarHalfLife) || p.calendarHalfLife < 12 || p.calendarHalfLife > 500)
    throw new Error('calendarHalfLife phải nằm trong khoảng 12–500 kỳ');
  if (!Number.isFinite(p.alphaContext) || p.alphaContext <= 0 || p.alphaContext > 20)
    throw new Error('alphaContext phải lớn hơn 0 và không quá 20');
  return p;
}

export function validateParameters(params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!Number.isInteger(p.window) || p.window < MIN_HISTORY || p.window > 200)
    throw new Error('window phải nằm trong khoảng 20–200 kỳ');
  if (!Number.isFinite(p.halfLife) || p.halfLife < 2 || p.halfLife > 100)
    throw new Error('halfLife phải nằm trong khoảng 2–100 kỳ');
  if (!Number.isFinite(p.recentWeight) || p.recentWeight < 0 || p.recentWeight > 1)
    throw new Error('recentWeight phải nằm trong khoảng 0–1');
  if (!Number.isFinite(p.alpha) || p.alpha <= 0 || p.alpha > 10)
    throw new Error('alpha phải lớn hơn 0 và không quá 10');
  if (!Number.isInteger(p.topK) || p.topK < 1 || p.topK > 20)
    throw new Error('topK phải nằm trong khoảng 1–20');
  if (!Number.isInteger(p.backtestDraws) || p.backtestDraws < 1 || p.backtestDraws > 200)
    throw new Error('backtestDraws phải nằm trong khoảng 1–200');
  return p;
}
export function normalizeHistory(history) {
  if (!Array.isArray(history)) throw new Error('Lịch sử kết quả không hợp lệ');
  const valid = history.filter(item =>
    item && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
    && typeof item.number === 'string' && /^\d{2}$/.test(item.number)
  );
  // The same station must have one prize-8 result per day. Explicitly reject
  // conflicting duplicates rather than silently treating them as independent.
  const unique = new Map();
  for (const item of valid) {
    if (unique.has(item.date) && unique.get(item.date) !== item.number)
      throw new Error(`Có hai kết quả giải 8 khác nhau vào ngày ${item.date}`);
    unique.set(item.date, item.number);
  }
  return [...unique].map(([date,number]) => ({date,number}))
    .sort((a,b) => a.date.localeCompare(b.date));
}
function rankingCore(history, params) {
  const p = validateParameters(params);
  const rows = history.slice(-p.window);
  if (rows.length < MIN_HISTORY) return [];
  const raw = new Array(100).fill(0);
  const decayed = new Array(100).fill(0);
  let recentSum = 0;
  for (let i=0; i<rows.length; i++) {
    const row = rows[rows.length - 1 - i];
    const number = Number(row.number);
    const weight = Math.pow(0.5, i / p.halfLife);
    raw[number] += 1;
    decayed[number] += weight;
    recentSum += weight;
  }
  const longDenom = rows.length + 100 * p.alpha;
  const recentDenom = recentSum + 100 * p.alpha;
  return Array.from({length:100}, (_,i)=>{
    const score = p.recentWeight * ((decayed[i] + p.alpha) / recentDenom)
      + (1-p.recentWeight) * ((raw[i] + p.alpha) / longDenom);
    return {
      number: String(i).padStart(2,'0'),
      score: Number((100 * score).toFixed(5)),
      observed: raw[i],
      weightedCount: Number(decayed[i].toFixed(4)),
      lastSeen: [...rows].reverse().find(row=>Number(row.number)===i)?.date || null
    };
  }).sort((a,b)=>b.score-a.score || a.number.localeCompare(b.number));
}
export function rankPrize8(history, targetDate, options = {}) {
  const params=validateParameters(options);
  if (typeof targetDate!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày dự đoán không hợp lệ');
  const past=normalizeHistory(history).filter(row=>row.date < targetDate);
  const used=past.slice(-params.window);
  const items=rankingCore(used,params);
  return {
    targetDate,
    status: used.length < MIN_HISTORY ? 'insufficient_history' : 'experimental',
    historyCount:past.length,
    windowUsed:used.length,
    trainingEnd:used.at(-1)?.date || null,
    top:items.slice(0,params.topK),
    params: { window:params.window,halfLife:params.halfLife,
      recentWeight:params.recentWeight,alpha:params.alpha,topK:params.topK },
    disclaimer:'Điểm xếp hạng dựa trên trọng số lịch sử, KHÔNG phải xác suất trúng đã được kiểm định.'
  };
}

export function analyzePrize8Distribution(history,targetDate,options={}) {
  if(typeof targetDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày phân tích không hợp lệ');
  const window=Number(options.window??104),halfLife=Number(options.halfLife??12),alpha=0.5;
  if(!Number.isInteger(window)||window<20||window>200)throw new Error('window phải nằm trong khoảng 20–200 kỳ');
  if(!Number.isFinite(halfLife)||halfLife<2||halfLife>100)throw new Error('halfLife phải nằm trong khoảng 2–100 kỳ');
  const weights={recent:Number(options.recent??40),long:Number(options.long??25),weekday:Number(options.weekday??25),parity:Number(options.parity??10)};
  if(Object.values(weights).some(x=>!Number.isFinite(x)||x<0||x>100))throw new Error('Mỗi trọng số phải từ 0 đến 100');
  const weightSum=Object.values(weights).reduce((a,b)=>a+b,0);
  if(Math.abs(weightSum-100)>1e-9)throw new Error('Tổng bốn trọng số phải bằng 100%');
  const all=normalizeHistory(history).filter(row=>row.date<targetDate);
  const rows=all.slice(-window),targetWeekday=new Date(`${targetDate}T12:00:00Z`).getUTCDay();
  const weekdayRows=rows.filter(row=>new Date(`${row.date}T12:00:00Z`).getUTCDay()===targetWeekday);
  if(rows.length<MIN_HISTORY)return {status:'insufficient_history',targetDate,historyCount:all.length,windowUsed:rows.length,items:[]};
  const raw=new Array(100).fill(0),decayed=new Array(100).fill(0),weekdayCounts=new Array(100).fill(0);
  const parityCounts=[0,0];let decaySum=0;
  for(let age=0;age<rows.length;age++) {
    const number=Number(rows[rows.length-1-age].number),weight=Math.pow(0.5,age/halfLife);
    raw[number]++;decayed[number]+=weight;decaySum+=weight;parityCounts[number%2]++;
  }
  weekdayRows.forEach(row=>weekdayCounts[Number(row.number)]++);
  const longDen=rows.length+100*alpha,recentDen=decaySum+100*alpha,weekdayDen=weekdayRows.length+100*alpha;
  const parityDen=rows.length+2;
  const items=Array.from({length:100},(_,number)=>{
    const components={
      recent:(decayed[number]+alpha)/recentDen,
      long:(raw[number]+alpha)/longDen,
      weekday:(weekdayCounts[number]+alpha)/weekdayDen,
      parity:((parityCounts[number%2]+1)/parityDen)/50
    };
    const mix=(weights.recent*components.recent+weights.long*components.long+
      weights.weekday*components.weekday+weights.parity*components.parity)/100;
    return {number:String(number).padStart(2,'0'),parity:number%2?'lẻ':'chẵn',
      scorePercent:Number((100*mix).toFixed(5)),observed:raw[number],weekdayObserved:weekdayCounts[number],
      components:Object.fromEntries(Object.entries(components).map(([key,value])=>[key,Number((100*value).toFixed(5))]))};
  }).sort((a,b)=>b.scorePercent-a.scorePercent||a.number.localeCompare(b.number));
  return {status:'experimental',targetDate,targetWeekday,historyCount:all.length,windowUsed:rows.length,
    weekdaySample:weekdayRows.length,weights,params:{window,halfLife,alpha},items,
    disclaimer:'Tỷ trọng thống kê thử nghiệm, không phải xác suất trúng đã hiệu chỉnh. Mốc lý thuyết công bằng của mỗi số là 1%.'};
}

/**
 * Strict forward-chain backtest. Each prediction is trained only on observations
 * strictly earlier than the date being evaluated, with no look-ahead.
 */
export function backtestPrize8(history, targetDate, options = {}) {
  const p=validateParameters(options);
  const rows=normalizeHistory(history).filter(r=>r.date < targetDate);
  const start=Math.max(MIN_HISTORY,rows.length - p.backtestDraws);
  let top1Hits=0,topKHits=0,evaluated=0;
  let top1Last=0,topKLast=0;
  for(let i=start;i<rows.length;i++) {
    const sorted=rankingCore(rows.slice(Math.max(0,i-p.window),i),p);
    if(!sorted.length)continue;
    const target=rows[i].number;
    const matched1=sorted[0].number===target;
    const matchedK=sorted.slice(0,p.topK).some(x=>x.number===target);
    top1Hits+=Number(matched1);
    topKHits+=Number(matchedK);
    top1Last=top1Hits;
    topKLast=topKHits;
    evaluated++;
  }
  return {
    evaluated,
    top1:{ hits:top1Last,rate:evaluated?Number((100*top1Hits/evaluated).toFixed(2)):null,randomBaselinePercent:1 },
    topK:{ k:p.topK,hits:topKLast,rate:evaluated?Number((100*topKHits/evaluated).toFixed(2)):null,
      randomBaselinePercent:p.topK },
    warning:evaluated<30
      ? 'Mẫu kiểm định nhỏ: cần thu thập thêm lịch sử trước khi đánh giá.'
      : 'Kết quả kiểm định quá khứ không chứng minh khả năng dự đoán kỳ tiếp theo.'
  };
}

export function validateV2Parameters(params = {}) {
  const p = { ...DEFAULT_V2_PARAMS, ...params };
  if (!Number.isInteger(p.window) || p.window < MIN_HISTORY || p.window > 200)
    throw new Error('window phải nằm trong khoảng 20–200 kỳ');
  if (!Number.isFinite(p.halfLife) || p.halfLife < 2 || p.halfLife > 100)
    throw new Error('halfLife phải nằm trong khoảng 2–100 kỳ');
  const weightKeys = ['recentWeight', 'longWeight', 'digitWeight', 'uniformShrinkage'];
  for (const key of weightKeys) {
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1)
      throw new Error(`${key} phải nằm trong khoảng 0–1`);
  }
  const weightSum = p.recentWeight + p.longWeight + p.digitWeight + p.uniformShrinkage;
  if (Math.abs(weightSum - 1) > 1e-6)
    throw new Error('Tổng bốn trọng số V2 (recentWeight, longWeight, digitWeight, uniformShrinkage) phải bằng 1');
  if (!Number.isFinite(p.alpha) || p.alpha <= 0 || p.alpha > 10)
    throw new Error('alpha phải lớn hơn 0 và không quá 10');
  if (!Number.isFinite(p.alphaDigit) || p.alphaDigit <= 0 || p.alphaDigit > 10)
    throw new Error('alphaDigit phải lớn hơn 0 và không quá 10');
  if (!Number.isInteger(p.topK) || p.topK < 1 || p.topK > 20)
    throw new Error('topK phải nằm trong khoảng 1–20');
  if (!Number.isInteger(p.backtestDraws) || p.backtestDraws < 1 || p.backtestDraws > 200)
    throw new Error('backtestDraws phải nằm trong khoảng 1–200');
  return p;
}

export function wilsonInterval(hits, total, z = 1.959963984540054) {
  if (!Number.isInteger(total) || total <= 0) return { low: null, high: null };
  const p = Math.min(1, Math.max(0, hits / total));
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return {
    low: Number((100 * Math.max(0, center - margin)).toFixed(2)),
    high: Number((100 * Math.min(1, center + margin)).toFixed(2))
  };
}

function stationWeekdays(province) {
  if (!province) return [];
  const days = [];
  for (const [wd, list] of Object.entries(XSMN_WEEKLY_SCHEDULE)) {
    if (list.includes(province)) days.push(Number(wd));
  }
  return days.sort((a, b) => a - b);
}

function countScheduledDays(startDay, endDay, weekdays) {
  const startMs = Date.parse(`${startDay}T12:00:00Z`);
  const endMs = Date.parse(`${endDay}T12:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  const totalDays = Math.round((endMs - startMs) / 86400000) + 1;
  if (!weekdays.length) return Math.max(1, Math.floor((totalDays - 1) / 7) + 1);
  const fullWeeks = Math.floor(totalDays / 7);
  const rem = totalDays % 7;
  const startWd = new Date(startMs).getUTCDay();
  let count = 0;
  for (const wd of weekdays) {
    const offset = (wd - startWd + 7) % 7;
    count += fullWeeks + (offset < rem ? 1 : 0);
  }
  return count;
}

export function analyzeHistoryCoverage(history, targetDate, province = '') {
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày kiểm tra độ phủ không hợp lệ');
  const past = normalizeHistory(history).filter(row => row.date < targetDate);
  const weekdays = stationWeekdays(province);
  if (!past.length) {
    return {
      totalDraws: 0,
      firstDate: null,
      lastDate: null,
      expectedDrawsInSpan: 0,
      missingDraws: 0,
      coveragePercent: 0,
      maxGapDays: 0,
      gapCount: 0,
      scheduleWeekdays: weekdays,
      warning: 'Chưa có kỳ giải 8 nào trước ngày mục tiêu.'
    };
  }
  const firstDate = past[0].date;
  const lastDate = past.at(-1).date;
  const expectedDrawsInSpan = Math.max(past.length, countScheduledDays(firstDate, lastDate, weekdays));
  const missingDraws = Math.max(0, expectedDrawsInSpan - past.length);
  const coveragePercent = Number((100 * past.length / expectedDrawsInSpan).toFixed(2));
  const gapThreshold = weekdays.length >= 2 ? 5 : 8;
  let maxGapDays = 0;
  let gapCount = 0;
  for (let i = 1; i < past.length; i++) {
    const diffDays = Math.round(
      (Date.parse(`${past[i].date}T12:00:00Z`) - Date.parse(`${past[i - 1].date}T12:00:00Z`)) / 86400000
    );
    if (diffDays > maxGapDays) maxGapDays = diffDays;
    if (diffDays > gapThreshold) gapCount++;
  }
  let warning = null;
  if (past.length < MIN_HISTORY) {
    warning = `Mới có ${past.length} kỳ (cần tối thiểu ${MIN_HISTORY} kỳ để xếp hạng).`;
  } else if (coveragePercent < 90) {
    warning = `Độ phủ lịch sử ${coveragePercent}% (ước thiếu ${missingDraws} kỳ trong giai đoạn ${firstDate} – ${lastDate}).`;
  } else if (past.length < 52) {
    warning = `Mẫu lịch sử còn ít (${past.length} kỳ); nên thu thập thêm 2–3 năm để kiểm định ổn định hơn.`;
  }
  return {
    totalDraws: past.length,
    firstDate,
    lastDate,
    expectedDrawsInSpan,
    missingDraws,
    coveragePercent,
    maxGapDays,
    gapCount,
    scheduleWeekdays: weekdays,
    warning
  };
}

function evaluateV2Core(allPast, params) {
  if (allPast.length < MIN_HISTORY) return { items: [], probs: [] };
  const p = params;
  const recentRows = allPast.slice(-p.window);
  const longCounts = new Array(100).fill(0);
  const tensCounts = new Array(10).fill(0);
  const onesCounts = new Array(10).fill(0);
  const lastSeen = new Array(100).fill(null);
  for (let i = 0; i < allPast.length; i++) {
    const row = allPast[i];
    const n = Number(row.number);
    longCounts[n] += 1;
    tensCounts[Math.floor(n / 10)] += 1;
    onesCounts[n % 10] += 1;
    lastSeen[n] = row.date;
  }
  const recentRaw = new Array(100).fill(0);
  const decayed = new Array(100).fill(0);
  let decaySum = 0;
  for (let age = 0; age < recentRows.length; age++) {
    const n = Number(recentRows[recentRows.length - 1 - age].number);
    const weight = Math.pow(0.5, age / p.halfLife);
    recentRaw[n] += 1;
    decayed[n] += weight;
    decaySum += weight;
  }
  const recentDen = decaySum + 100 * p.alpha;
  const longDen = allPast.length + 100 * p.alpha;
  const digitDen = allPast.length + 10 * p.alphaDigit;
  const probs = new Array(100);
  const scored = new Array(100);
  for (let i = 0; i < 100; i++) {
    const tens = Math.floor(i / 10);
    const ones = i % 10;
    const pRecent = (decayed[i] + p.alpha) / recentDen;
    const pLong = (longCounts[i] + p.alpha) / longDen;
    const pDigit = ((tensCounts[tens] + p.alphaDigit) / digitDen)
      * ((onesCounts[ones] + p.alphaDigit) / digitDen);
    const pUniform = 0.01;
    const mix = p.recentWeight * pRecent
      + p.longWeight * pLong
      + p.digitWeight * pDigit
      + p.uniformShrinkage * pUniform;
    probs[i] = mix;
    scored[i] = {
      number: String(i).padStart(2, '0'),
      score: Number((100 * mix).toFixed(5)),
      observed: recentRaw[i],
      totalObserved: longCounts[i],
      weightedCount: Number(decayed[i].toFixed(4)),
      lastSeen: lastSeen[i],
      components: {
        recent: Number((100 * pRecent).toFixed(5)),
        long: Number((100 * pLong).toFixed(5)),
        digit: Number((100 * pDigit).toFixed(5)),
        uniform: 1
      },
      _mix: mix,
      _digit: pDigit
    };
  }
  scored.sort((a, b) =>
    (b._mix - a._mix)
    || (b.totalObserved - a.totalObserved)
    || (b._digit - a._digit)
    || a.number.localeCompare(b.number)
  );
  const items = scored.map(({ _mix, _digit, ...rest }) => rest);
  return { items, probs };
}

function evaluateV1Core(windowRows, params) {
  if (windowRows.length < MIN_HISTORY) return { items: [], probs: [] };
  const raw = new Array(100).fill(0);
  const decayed = new Array(100).fill(0);
  let recentSum = 0;
  for (let i = 0; i < windowRows.length; i++) {
    const n = Number(windowRows[windowRows.length - 1 - i].number);
    const weight = Math.pow(0.5, i / params.halfLife);
    raw[n] += 1;
    decayed[n] += weight;
    recentSum += weight;
  }
  const longDenom = windowRows.length + 100 * params.alpha;
  const recentDenom = recentSum + 100 * params.alpha;
  const probs = new Array(100);
  const items = new Array(100);
  for (let i = 0; i < 100; i++) {
    const prob = params.recentWeight * ((decayed[i] + params.alpha) / recentDenom)
      + (1 - params.recentWeight) * ((raw[i] + params.alpha) / longDenom);
    probs[i] = prob;
    items[i] = {
      number: String(i).padStart(2, '0'),
      score: Number((100 * prob).toFixed(5))
    };
  }
  items.sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
  return { items, probs };
}

function evaluateRawCore(allPast, alpha) {
  if (allPast.length < MIN_HISTORY) return { items: [], probs: [] };
  const counts = new Array(100).fill(0);
  for (let i = 0; i < allPast.length; i++) counts[Number(allPast[i].number)] += 1;
  const denom = allPast.length + 100 * alpha;
  const probs = new Array(100);
  const items = new Array(100);
  for (let i = 0; i < 100; i++) {
    const prob = (counts[i] + alpha) / denom;
    probs[i] = prob;
    items[i] = {
      number: String(i).padStart(2, '0'),
      score: Number((100 * prob).toFixed(5)),
      _prob: prob
    };
  }
  items.sort((a, b) => (b._prob - a._prob) || a.number.localeCompare(b.number));
  return { items, probs };
}

export function rankPrize8V2(history, targetDate, options = {}) {
  const params = validateV2Parameters(options);
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày dự đoán không hợp lệ');
  const past = normalizeHistory(history).filter(row => row.date < targetDate);
  const windowUsed = Math.min(past.length, params.window);
  if (past.length < MIN_HISTORY) {
    return {
      modelVersion: V2_MODEL_VERSION,
      targetDate,
      status: 'insufficient_history',
      historyCount: past.length,
      windowUsed,
      trainingStart: past[0]?.date || null,
      trainingEnd: past.at(-1)?.date || null,
      top: [],
      params: {
        window: params.window,
        halfLife: params.halfLife,
        recentWeight: params.recentWeight,
        longWeight: params.longWeight,
        digitWeight: params.digitWeight,
        uniformShrinkage: params.uniformShrinkage,
        alpha: params.alpha,
        alphaDigit: params.alphaDigit,
        topK: params.topK
      },
      disclaimer: 'Điểm xếp hạng V2 là chỉ số thống kê thử nghiệm, KHÔNG phải xác suất trúng đã kiểm định. Mỗi số 00–99 có xác suất lý thuyết 1% trong kỳ quay công bằng.'
    };
  }
  const { items } = evaluateV2Core(past, params);
  return {
    modelVersion: V2_MODEL_VERSION,
    targetDate,
    status: 'experimental',
    historyCount: past.length,
    windowUsed,
    trainingStart: past[0].date,
    trainingEnd: past.at(-1).date,
    top: items.slice(0, params.topK),
    params: {
      window: params.window,
      halfLife: params.halfLife,
      recentWeight: params.recentWeight,
      longWeight: params.longWeight,
      digitWeight: params.digitWeight,
      uniformShrinkage: params.uniformShrinkage,
      alpha: params.alpha,
      alphaDigit: params.alphaDigit,
      topK: params.topK
    },
    disclaimer: 'Điểm xếp hạng V2 là chỉ số thống kê thử nghiệm, KHÔNG phải xác suất trúng đã kiểm định. Mỗi số 00–99 có xác suất lý thuyết 1% trong kỳ quay công bằng.'
  };
}

function createAccumulator() {
  return { top1Hits: 0, topKHits: 0, logLossSum: 0, brierSum: 0, rrSum: 0, rankSum: 0 };
}

function recordEvaluation(acc, result, targetNumber, topK) {
  const targetIdx = Number(targetNumber);
  const pTarget = Math.max(result.probs[targetIdx] ?? 1e-12, 1e-12);
  let sumSq = 0;
  for (let s = 0; s < 100; s++) sumSq += result.probs[s] * result.probs[s];
  acc.logLossSum += -Math.log(pTarget);
  acc.brierSum += sumSq - 2 * pTarget + 1;
  const rank = result.items.findIndex(x => x.number === targetNumber) + 1;
  if (rank === 1) acc.top1Hits += 1;
  if (rank >= 1 && rank <= topK) acc.topKHits += 1;
  if (rank >= 1) {
    acc.rrSum += 1 / rank;
    acc.rankSum += rank;
  }
}

function summarizeAccumulator(acc, evaluated, topK) {
  if (!evaluated) {
    return {
      top1: {
        hits: 0, rate: null, ci95: { low: null, high: null },
        randomBaselinePercent: 1, liftPoints: null, liftRatio: null
      },
      topK: {
        k: topK, hits: 0, rate: null, ci95: { low: null, high: null },
        randomBaselinePercent: topK, liftPoints: null, liftRatio: null
      },
      logLoss: null,
      logLossVsUniform: null,
      brierScore: null,
      brierVsUniform: null,
      mrr: null,
      avgRank: null
    };
  }
  const top1Rate = Number((100 * acc.top1Hits / evaluated).toFixed(2));
  const topKRate = Number((100 * acc.topKHits / evaluated).toFixed(2));
  const logLoss = Number((acc.logLossSum / evaluated).toFixed(5));
  const brierScore = Number((acc.brierSum / evaluated).toFixed(5));
  const mrr = Number((acc.rrSum / evaluated).toFixed(5));
  const avgRank = Number((acc.rankSum / evaluated).toFixed(2));
  return {
    top1: {
      hits: acc.top1Hits,
      rate: top1Rate,
      ci95: wilsonInterval(acc.top1Hits, evaluated),
      randomBaselinePercent: 1,
      liftPoints: Number((top1Rate - 1).toFixed(2)),
      liftRatio: Number((top1Rate / 1).toFixed(3))
    },
    topK: {
      k: topK,
      hits: acc.topKHits,
      rate: topKRate,
      ci95: wilsonInterval(acc.topKHits, evaluated),
      randomBaselinePercent: topK,
      liftPoints: Number((topKRate - topK).toFixed(2)),
      liftRatio: Number((topKRate / topK).toFixed(3))
    },
    logLoss,
    logLossVsUniform: Number((UNIFORM_LOG_LOSS - logLoss).toFixed(5)),
    brierScore,
    brierVsUniform: Number((UNIFORM_BRIER - brierScore).toFixed(5)),
    mrr,
    avgRank
  };
}

/**
 * Strict forward-chain V2 backtest comparing V2, V1, Raw full-history frequency,
 * and theoretical Uniform random baselines on the exact same chronological draws.
 */
export function backtestPrize8V2(history, targetDate, options = {}) {
  const p = validateV2Parameters(options);
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày kiểm định không hợp lệ');
  const rows = normalizeHistory(history).filter(r => r.date < targetDate);
  const start = Math.max(MIN_HISTORY, rows.length - p.backtestDraws);
  const v1Params = {
    window: p.window,
    halfLife: p.halfLife,
    recentWeight: DEFAULT_PARAMS.recentWeight,
    alpha: p.alpha,
    topK: p.topK
  };
  const accV2 = createAccumulator();
  const accV1 = createAccumulator();
  const accRaw = createAccumulator();
  let evaluated = 0;
  for (let i = start; i < rows.length; i++) {
    const train = rows.slice(0, i);
    const target = rows[i].number;
    recordEvaluation(accV2, evaluateV2Core(train, p), target, p.topK);
    recordEvaluation(accV1, evaluateV1Core(train.slice(-v1Params.window), v1Params), target, p.topK);
    recordEvaluation(accRaw, evaluateRawCore(train, p.alpha), target, p.topK);
    evaluated += 1;
  }
  const v2 = summarizeAccumulator(accV2, evaluated, p.topK);
  const v1 = summarizeAccumulator(accV1, evaluated, p.topK);
  const raw = summarizeAccumulator(accRaw, evaluated, p.topK);
  const uniform = {
    top1: {
      hits: null, rate: 1, ci95: { low: 1, high: 1 },
      randomBaselinePercent: 1, liftPoints: 0, liftRatio: 1
    },
    topK: {
      k: p.topK, hits: null, rate: p.topK, ci95: { low: p.topK, high: p.topK },
      randomBaselinePercent: p.topK, liftPoints: 0, liftRatio: 1
    },
    logLoss: Number(UNIFORM_LOG_LOSS.toFixed(5)),
    logLossVsUniform: 0,
    brierScore: UNIFORM_BRIER,
    brierVsUniform: 0,
    mrr: Number(UNIFORM_MRR.toFixed(5)),
    avgRank: UNIFORM_AVG_RANK
  };
  const diff = (a, b, digits = 2) =>
    (a == null || b == null) ? null : Number((a - b).toFixed(digits));
  const comparison = {
    v2VsUniform: {
      top1LiftPoints: v2.top1.liftPoints,
      topKLiftPoints: v2.topK.liftPoints,
      logLossImprovement: v2.logLossVsUniform,
      brierImprovement: v2.brierVsUniform,
      isStatisticallySignificantTopK: Boolean(
        evaluated >= 30 && v2.topK.ci95.low != null && v2.topK.ci95.low > p.topK
      )
    },
    v2VsV1: {
      top1DiffPoints: diff(v2.top1.rate, v1.top1.rate, 2),
      topKDiffPoints: diff(v2.topK.rate, v1.topK.rate, 2),
      logLossImprovement: diff(v1.logLoss, v2.logLoss, 5),
      mrrDiff: diff(v2.mrr, v1.mrr, 5)
    },
    v2VsRaw: {
      top1DiffPoints: diff(v2.top1.rate, raw.top1.rate, 2),
      topKDiffPoints: diff(v2.topK.rate, raw.topK.rate, 2),
      logLossImprovement: diff(raw.logLoss, v2.logLoss, 5),
      mrrDiff: diff(v2.mrr, raw.mrr, 5)
    }
  };
  return {
    modelVersion: V2_MODEL_VERSION,
    evaluated,
    evaluationStart: evaluated ? rows[start].date : null,
    evaluationEnd: evaluated ? rows.at(-1).date : null,
    top1: v2.top1,
    topK: v2.topK,
    models: { v2, v1, raw, uniform },
    comparison,
    warning: evaluated < 30
      ? 'Mẫu kiểm định nhỏ (< 30 kỳ): dao động ngẫu nhiên lớn, chưa đủ cơ sở kết luận.'
      : 'Kết quả kiểm định quá khứ (kể cả khi cao hơn mốc ngẫu nhiên) không chứng minh lợi thế ở kỳ quay công bằng tiếp theo.'
  };
}

export function validateV3Parameters(params = {}) {
  const p = { ...DEFAULT_V3_PARAMS, ...params };
  for (const key of ['shortHalfLife', 'mediumHalfLife', 'digitHalfLife']) {
    if (!Number.isFinite(p[key]) || p[key] < 2 || p[key] > 100)
      throw new Error(`${key} phải nằm trong khoảng 2–100 kỳ`);
  }
  const weightKeys = ['shortWeight', 'mediumWeight', 'longWeight', 'digitWeight', 'uniformShrinkage'];
  for (const key of weightKeys) {
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1)
      throw new Error(`${key} phải nằm trong khoảng 0–1`);
  }
  const weightSum = weightKeys.reduce((sum, key) => sum + p[key], 0);
  if (Math.abs(weightSum - 1) > 1e-6)
    throw new Error('Tổng năm trọng số V3 (shortWeight, mediumWeight, longWeight, digitWeight, uniformShrinkage) phải bằng 1');
  if (!Number.isFinite(p.alpha) || p.alpha <= 0 || p.alpha > 10)
    throw new Error('alpha phải lớn hơn 0 và không quá 10');
  if (!Number.isFinite(p.alphaDigit) || p.alphaDigit <= 0 || p.alphaDigit > 10)
    throw new Error('alphaDigit phải lớn hơn 0 và không quá 10');
  if (!Number.isInteger(p.topK) || p.topK < 1 || p.topK > 20)
    throw new Error('topK phải nằm trong khoảng 1–20');
  if (!Number.isInteger(p.backtestDraws) || p.backtestDraws < 1 || p.backtestDraws > 200)
    throw new Error('backtestDraws phải nằm trong khoảng 1–200');
  return p;
}

function evaluateV3Core(allPast, params) {
  if (allPast.length < MIN_HISTORY) return { items: [], probs: [] };
  const p = params;
  const nRows = allPast.length;
  const longCounts = new Array(100).fill(0);
  const shortDecayed = new Array(100).fill(0);
  const medDecayed = new Array(100).fill(0);
  const tensDecayed = new Array(10).fill(0);
  const onesDecayed = new Array(10).fill(0);
  const lastSeen = new Array(100).fill(null);
  let shortSum = 0;
  let medSum = 0;
  let digitSum = 0;
  for (let age = 0; age < nRows; age++) {
    const row = allPast[nRows - 1 - age];
    const n = Number(row.number);
    const wShort = Math.pow(0.5, age / p.shortHalfLife);
    const wMed = Math.pow(0.5, age / p.mediumHalfLife);
    const wDigit = Math.pow(0.5, age / p.digitHalfLife);
    longCounts[n] += 1;
    shortDecayed[n] += wShort;
    medDecayed[n] += wMed;
    tensDecayed[Math.floor(n / 10)] += wDigit;
    onesDecayed[n % 10] += wDigit;
    shortSum += wShort;
    medSum += wMed;
    digitSum += wDigit;
    if (lastSeen[n] === null) lastSeen[n] = row.date;
  }
  const shortDen = shortSum + 100 * p.alpha;
  const medDen = medSum + 100 * p.alpha;
  const longDen = nRows + 100 * p.alpha;
  const digitDen = digitSum + 10 * p.alphaDigit;
  const probs = new Array(100);
  const scored = new Array(100);
  for (let i = 0; i < 100; i++) {
    const tens = Math.floor(i / 10);
    const ones = i % 10;
    const pShort = (shortDecayed[i] + p.alpha) / shortDen;
    const pMed = (medDecayed[i] + p.alpha) / medDen;
    const pLong = (longCounts[i] + p.alpha) / longDen;
    const pDigit = ((tensDecayed[tens] + p.alphaDigit) / digitDen)
      * ((onesDecayed[ones] + p.alphaDigit) / digitDen);
    const pUniform = 0.01;
    const mix = p.shortWeight * pShort
      + p.mediumWeight * pMed
      + p.longWeight * pLong
      + p.digitWeight * pDigit
      + p.uniformShrinkage * pUniform;
    probs[i] = mix;
    scored[i] = {
      number: String(i).padStart(2, '0'),
      score: Number((100 * mix).toFixed(5)),
      observed: longCounts[i],
      totalObserved: longCounts[i],
      weightedCount: Number(shortDecayed[i].toFixed(4)),
      lastSeen: lastSeen[i],
      components: {
        short: Number((100 * pShort).toFixed(5)),
        medium: Number((100 * pMed).toFixed(5)),
        long: Number((100 * pLong).toFixed(5)),
        digit: Number((100 * pDigit).toFixed(5)),
        uniform: 1
      },
      _mix: mix,
      _digit: pDigit
    };
  }
  scored.sort((a, b) =>
    (b._mix - a._mix)
    || (b.totalObserved - a.totalObserved)
    || (b._digit - a._digit)
    || a.number.localeCompare(b.number)
  );
  const items = scored.map(({ _mix, _digit, ...rest }) => rest);
  return { items, probs };
}

export function rankPrize8V3(history, targetDate, options = {}, { includeRanking = false } = {}) {
  const params = validateV3Parameters(options);
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày dự đoán không hợp lệ');
  const past = normalizeHistory(history).filter(row => row.date < targetDate);
  const cleanParams = {
    shortHalfLife: params.shortHalfLife,
    mediumHalfLife: params.mediumHalfLife,
    digitHalfLife: params.digitHalfLife,
    shortWeight: params.shortWeight,
    mediumWeight: params.mediumWeight,
    longWeight: params.longWeight,
    digitWeight: params.digitWeight,
    uniformShrinkage: params.uniformShrinkage,
    alpha: params.alpha,
    alphaDigit: params.alphaDigit,
    topK: params.topK
  };
  if (past.length < MIN_HISTORY) {
    return {
      modelVersion: V3_MODEL_VERSION,
      targetDate,
      status: 'insufficient_history',
      historyCount: past.length,
      windowUsed: past.length,
      trainingStart: past[0]?.date || null,
      trainingEnd: past.at(-1)?.date || null,
      top: [],
      params: cleanParams,
      disclaimer: 'Điểm xếp hạng V3 (đa khung thời gian + biên đầu/đuôi suy giảm + làm mịn Dirichlet) là chỉ số thống kê thử nghiệm, KHÔNG phải xác suất trúng đã kiểm định. Mỗi số 00–99 có xác suất lý thuyết 1% trong kỳ quay công bằng.'
    };
  }
  const { items } = evaluateV3Core(past, params);
  return {
    modelVersion: V3_MODEL_VERSION,
    targetDate,
    status: 'experimental',
    historyCount: past.length,
    windowUsed: past.length,
    trainingStart: past[0].date,
    trainingEnd: past.at(-1).date,
    top: items.slice(0, params.topK),
    ...(includeRanking ? { ranking: items.map(item => item.number) } : {}),
    params: cleanParams,
    disclaimer: 'Điểm xếp hạng V3 (đa khung thời gian + biên đầu/đuôi suy giảm + làm mịn Dirichlet) là chỉ số thống kê thử nghiệm, KHÔNG phải xác suất trúng đã kiểm định. Mỗi số 00–99 có xác suất lý thuyết 1% trong kỳ quay công bằng.'
  };
}

/**
 * Strict forward-chain V3 backtest comparing V3, V2, V1, Raw full-history frequency,
 * and theoretical Uniform random baselines on the exact same chronological draws.
 */
export function backtestPrize8V3(history, targetDate, options = {}) {
  const p = validateV3Parameters(options);
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày kiểm định không hợp lệ');
  const rows = normalizeHistory(history).filter(r => r.date < targetDate);
  const start = Math.max(MIN_HISTORY, rows.length - p.backtestDraws);
  const v2Params = { ...DEFAULT_V2_PARAMS, topK: p.topK };
  const v1Params = { ...DEFAULT_PARAMS, topK: p.topK };
  const accV3 = createAccumulator();
  const accV2 = createAccumulator();
  const accV1 = createAccumulator();
  const accRaw = createAccumulator();
  let evaluated = 0;
  for (let i = start; i < rows.length; i++) {
    const train = rows.slice(0, i);
    const target = rows[i].number;
    recordEvaluation(accV3, evaluateV3Core(train, p), target, p.topK);
    recordEvaluation(accV2, evaluateV2Core(train, v2Params), target, p.topK);
    recordEvaluation(accV1, evaluateV1Core(train.slice(-v1Params.window), v1Params), target, p.topK);
    recordEvaluation(accRaw, evaluateRawCore(train, DEFAULT_V2_PARAMS.alpha), target, p.topK);
    evaluated += 1;
  }
  const v3 = summarizeAccumulator(accV3, evaluated, p.topK);
  const v2 = summarizeAccumulator(accV2, evaluated, p.topK);
  const v1 = summarizeAccumulator(accV1, evaluated, p.topK);
  const raw = summarizeAccumulator(accRaw, evaluated, p.topK);
  const uniform = {
    top1: {
      hits: null, rate: 1, ci95: { low: 1, high: 1 },
      randomBaselinePercent: 1, liftPoints: 0, liftRatio: 1
    },
    topK: {
      k: p.topK, hits: null, rate: p.topK, ci95: { low: p.topK, high: p.topK },
      randomBaselinePercent: p.topK, liftPoints: 0, liftRatio: 1
    },
    logLoss: Number(UNIFORM_LOG_LOSS.toFixed(5)),
    logLossVsUniform: 0,
    brierScore: UNIFORM_BRIER,
    brierVsUniform: 0,
    mrr: Number(UNIFORM_MRR.toFixed(5)),
    avgRank: UNIFORM_AVG_RANK
  };
  const diff = (a, b, digits = 2) =>
    (a == null || b == null) ? null : Number((a - b).toFixed(digits));
  const comparison = {
    v3VsUniform: {
      top1LiftPoints: v3.top1.liftPoints,
      topKLiftPoints: v3.topK.liftPoints,
      logLossImprovement: v3.logLossVsUniform,
      brierImprovement: v3.brierVsUniform,
      isStatisticallySignificantTopK: Boolean(
        evaluated >= 30 && v3.topK.ci95.low != null && v3.topK.ci95.low > p.topK
      )
    },
    v3VsV2: {
      top1DiffPoints: diff(v3.top1.rate, v2.top1.rate, 2),
      topKDiffPoints: diff(v3.topK.rate, v2.topK.rate, 2),
      logLossImprovement: diff(v2.logLoss, v3.logLoss, 5),
      mrrDiff: diff(v3.mrr, v2.mrr, 5)
    },
    v3VsV1: {
      top1DiffPoints: diff(v3.top1.rate, v1.top1.rate, 2),
      topKDiffPoints: diff(v3.topK.rate, v1.topK.rate, 2),
      logLossImprovement: diff(v1.logLoss, v3.logLoss, 5),
      mrrDiff: diff(v3.mrr, v1.mrr, 5)
    },
    v3VsRaw: {
      top1DiffPoints: diff(v3.top1.rate, raw.top1.rate, 2),
      topKDiffPoints: diff(v3.topK.rate, raw.topK.rate, 2),
      logLossImprovement: diff(raw.logLoss, v3.logLoss, 5),
      mrrDiff: diff(v3.mrr, raw.mrr, 5)
    }
  };
  return {
    modelVersion: V3_MODEL_VERSION,
    evaluated,
    evaluationStart: evaluated ? rows[start].date : null,
    evaluationEnd: evaluated ? rows.at(-1).date : null,
    top1: v3.top1,
    topK: v3.topK,
    models: { v3, v2, v1, raw, uniform },
    comparison,
    warning: evaluated < 30
      ? 'Mẫu kiểm định nhỏ (< 30 kỳ): dao động ngẫu nhiên lớn, chưa đủ cơ sở kết luận.'
      : 'Kết quả kiểm định quá khứ (kể cả khi cao hơn mốc ngẫu nhiên) không chứng minh lợi thế ở kỳ quay công bằng tiếp theo.'
  };
}

function utcDateParts(day) {
  const date = new Date(`${day}T12:00:00Z`);
  return { weekday: date.getUTCDay(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function cyclicDistance(a, b, size) {
  const direct = Math.abs(a - b);
  return Math.min(direct, size - direct);
}

function evaluateV4Core(allPast, targetDate, params) {
  if (allPast.length < MIN_HISTORY) return { items: [], probs: [] };
  const base = evaluateV3Core(allPast, params);
  const target = utcDateParts(targetDate);
  const calendarCounts = new Array(100).fill(0);
  const ordinalCounts = new Array(100).fill(0);
  let calendarSum = 0;
  let ordinalSum = 0;
  const targetOrdinal = allPast.length + 1;
  for (let i = 0; i < allPast.length; i++) {
    const row = allPast[i];
    const n = Number(row.number);
    const age = allPast.length - 1 - i;
    const recency = Math.pow(0.5, age / params.calendarHalfLife);
    const parts = utcDateParts(row.date);
    // Smooth similarities avoid tiny exact-match buckets. Weekday, day-of-month,
    // and month each contribute a normalized, past-only calendar signal.
    const weekdaySimilarity = parts.weekday === target.weekday ? 1 : 0.15;
    const daySimilarity = Math.exp(-cyclicDistance(parts.day, target.day, 31) / 4);
    const monthSimilarity = Math.exp(-cyclicDistance(parts.month, target.month, 12) / 2);
    const calendarSimilarity = recency
      * (0.40 * weekdaySimilarity + 0.35 * daySimilarity + 0.25 * monthSimilarity);
    calendarCounts[n] += calendarSimilarity;
    calendarSum += calendarSimilarity;

    const ordinal = i + 1;
    const ordinalSimilarity = recency * (
      0.65 * (ordinal % 10 === targetOrdinal % 10 ? 1 : 0.10)
      + 0.35 * (ordinal % 4 === targetOrdinal % 4 ? 1 : 0.25)
    );
    ordinalCounts[n] += ordinalSimilarity;
    ordinalSum += ordinalSimilarity;
  }
  const calendarDen = calendarSum + 100 * params.alphaContext;
  const ordinalDen = ordinalSum + 100 * params.alphaContext;
  const baseByNumber = new Map(base.items.map(item => [Number(item.number), item]));
  const probs = new Array(100);
  const scored = new Array(100);
  for (let n = 0; n < 100; n++) {
    const baseItem = baseByNumber.get(n);
    const pBase = base.probs[n];
    const pCalendar = (calendarCounts[n] + params.alphaContext) / calendarDen;
    const pOrdinal = (ordinalCounts[n] + params.alphaContext) / ordinalDen;
    const mix = params.baseWeight * pBase
      + params.calendarWeight * pCalendar
      + params.ordinalWeight * pOrdinal;
    probs[n] = mix;
    scored[n] = {
      ...baseItem,
      score: Number((100 * mix).toFixed(5)),
      components: {
        ...baseItem.components,
        calendar: Number((100 * pCalendar).toFixed(5)),
        ordinal: Number((100 * pOrdinal).toFixed(5))
      },
      _mix: mix,
      _calendar: pCalendar,
      _ordinal: pOrdinal
    };
  }
  scored.sort((a, b) => (b._mix - a._mix)
    || (b._calendar - a._calendar)
    || (b._ordinal - a._ordinal)
    || (b.totalObserved - a.totalObserved)
    || a.number.localeCompare(b.number));
  const items = scored.map(({ _mix, _calendar, _ordinal, ...rest }) => rest);
  return { items, probs };
}

export function rankPrize8V4(history, targetDate, options = {}, { includeRanking = false } = {}) {
  const params = validateV4Parameters(options);
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày dự đoán không hợp lệ');
  const past = normalizeHistory(history).filter(row => row.date < targetDate);
  const cleanParams = Object.fromEntries([
    'shortHalfLife', 'mediumHalfLife', 'digitHalfLife', 'shortWeight', 'mediumWeight',
    'longWeight', 'digitWeight', 'uniformShrinkage', 'alpha', 'alphaDigit', 'baseWeight',
    'calendarWeight', 'ordinalWeight', 'calendarHalfLife', 'alphaContext', 'topK'
  ].map(key => [key, params[key]]));
  if (past.length < MIN_HISTORY) return {
    modelVersion: V4_MODEL_VERSION, targetDate, status: 'insufficient_history',
    historyCount: past.length, windowUsed: past.length,
    trainingStart: past[0]?.date || null, trainingEnd: past.at(-1)?.date || null,
    top: [], params: cleanParams,
    disclaimer: 'Điểm V4 là xếp hạng thống kê thử nghiệm, không phải xác suất trúng đã kiểm định.'
  };
  const { items } = evaluateV4Core(past, targetDate, params);
  return {
    modelVersion: V4_MODEL_VERSION, targetDate, status: 'experimental',
    historyCount: past.length, windowUsed: past.length,
    trainingStart: past[0].date, trainingEnd: past.at(-1).date,
    top: items.slice(0, params.topK),
    ...(includeRanking ? { ranking: items.map(item => item.number) } : {}),
    params: cleanParams,
    context: { targetOrdinal: past.length + 1, ...utcDateParts(targetDate) },
    disclaimer: 'V4 bổ sung lịch và thứ tự kỳ nhưng vẫn chỉ là xếp hạng thử nghiệm; mỗi số 00–99 có mốc lý thuyết 1% trong kỳ quay công bằng.'
  };
}

export function backtestPrize8V4(history, targetDate, options = {}) {
  const p = validateV4Parameters(options);
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    throw new Error('Ngày kiểm định không hợp lệ');
  const rows = normalizeHistory(history).filter(row => row.date < targetDate);
  const start = Math.max(MIN_HISTORY, rows.length - p.backtestDraws);
  const accV4 = createAccumulator();
  const accV3 = createAccumulator();
  let evaluated = 0;
  for (let i = start; i < rows.length; i++) {
    const train = rows.slice(0, i);
    const target = rows[i];
    recordEvaluation(accV4, evaluateV4Core(train, target.date, p), target.number, p.topK);
    recordEvaluation(accV3, evaluateV3Core(train, p), target.number, p.topK);
    evaluated++;
  }
  const v4 = summarizeAccumulator(accV4, evaluated, p.topK);
  const v3 = summarizeAccumulator(accV3, evaluated, p.topK);
  return {
    modelVersion: V4_MODEL_VERSION,
    evaluated,
    evaluationStart: evaluated ? rows[start].date : null,
    evaluationEnd: evaluated ? rows.at(-1).date : null,
    top1: v4.top1,
    topK: v4.topK,
    models: { v4, v3 },
    comparison: {
      v4VsV3: {
        top1DiffPoints: v4.top1.rate == null ? null : Number((v4.top1.rate - v3.top1.rate).toFixed(2)),
        topKDiffPoints: v4.topK.rate == null ? null : Number((v4.topK.rate - v3.topK.rate).toFixed(2)),
        logLossImprovement: v4.logLoss == null ? null : Number((v3.logLoss - v4.logLoss).toFixed(5)),
        mrrDiff: v4.mrr == null ? null : Number((v4.mrr - v3.mrr).toFixed(5))
      }
    },
    warning: evaluated < 30
      ? 'Mẫu kiểm định nhỏ (< 30 kỳ), chưa đủ cơ sở kết luận.'
      : 'Backtest quá khứ không chứng minh lợi thế cho kỳ quay công bằng tiếp theo.'
  };
}
