import { validateDraw, extractSouthPayload, normalizePayload } from './lottery-core.js';
import { stationsForDate } from './station-schedule.js';

export function vietnamClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: parts.year + '-' + parts.month + '-' + parts.day,
    hour: Number(parts.hour), minute: Number(parts.minute) };
}
function validDraws(report, day) {
  const expected = new Set(stationsForDate(day)), draws = new Map();
  for (const row of Array.isArray(report?.results) ? report.results : []) {
    if (!expected.has(row?.province)) continue;
    const checked = validateDraw(row.province, row, day);
    if (checked.draw && !draws.has(row.province)) {
      draws.set(row.province, { ...checked.draw, source: row.source || report.source_url });
    }
  }
  return draws;
}
export function isCompleteReport(report, day) {
  return report?.date === day && validDraws(report, day).size === stationsForDate(day).length;
}
export function mergeReports(previous, incoming, day) {
  const prior = validDraws(previous, day), additions = validDraws(incoming, day);
  let changed = false;
  for (const [code, row] of additions) {
    if (!prior.has(code)) { prior.set(code, row); changed = true; }
  }
  if (!changed) return { changed: false, report: previous ?? null };
  const results = [...prior.values()].sort((a,b) => a.name.localeCompare(b.name,'vi'));
  const expected = stationsForDate(day).length;
  return { changed: true, report: {
    ...incoming, date: day, region: 'MN', results, count: results.length,
    expected_count: expected, region_counts: { MN: results.length },
    status: results.length === expected ? 'complete_by_provider_count' : 'needs_review'
  }};
}

export function isPastOrToday(day, today) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day+'T00:00:00Z'))
    && new Date(day+'T00:00:00Z').toISOString().slice(0,10) === day
    && day <= today;
}
// Dependency injection keeps the update path testable without GitHub credentials.
export async function syncDate({ read, write, fetchDay, now = new Date(), date }) {
  const { day: today, hour } = vietnamClock(now);
  const day = date ?? today;
  if (!isPastOrToday(day,today)) return {date:day,report:null,status:'invalid_date'};
  let existing = await read(day);
  if (isCompleteReport(existing.report, day)) return { date: day, report: existing.report, status: 'complete' };
  if (day === today && hour < 17) return { date: day, report: existing.report, status: 'before_opening' };
  let incoming;
  try {
    const { payload, sourceUrl } = await fetchDay(day);
    incoming = normalizePayload(day, extractSouthPayload(day, payload), sourceUrl);
  } catch {
    return { date: day, report: existing.report, status: 'source_unavailable' };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isCompleteReport(existing.report, day)) return { date: day, report: existing.report, status: 'complete' };
    const merged = mergeReports(existing.report, incoming, day);
    if (!merged.changed) return { date: day, report: existing.report, status: 'no_change' };
    // write returns false on optimistic SHA conflict; re-read before retrying.
    if (await write(day, merged.report, existing.sha)) {
      return { date: day, report: merged.report, status: 'updated' };
    }
    existing = await read(day);
  }
  return { date: day, report: existing.report, status: 'retry_later' };
}

export function syncToday(options) { return syncDate(options); }
