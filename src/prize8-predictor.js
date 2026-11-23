/**
 * Experimental, non-calibrated ranking of Southern lottery prize 8 (00..99).
 *
 * Input: individual province's prize-8 history; a draw contributes exactly
 * one two-digit string. Train only on dates < targetDate.
 *
 * Ranking = recentWeight * exponentially decayed smoothed frequency
 *         + (1 - recentWeight) * equally weighted smoothed frequency.
 * Smoothing adds alpha pseudo-count to each of the 100 possible values.
 *
 * This is NOT a validated probability forecast: independent fair draws
 * cannot be reliably predicted from their past outcomes.
 */
export const MIN_HISTORY = 20;
export const DEFAULT_PARAMS = Object.freeze({
  window: 52, halfLife: 12, recentWeight: 0.7, alpha: 0.5, topK: 10,
  backtestDraws: 80
});

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
