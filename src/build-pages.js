import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validDay } from './config.js';

const output = path.resolve('pages-dist');
const backup = JSON.parse(await readFile(process.argv[2] ?? 'data/xskt-backup-2026-11-23.json', 'utf8'));
const reports = new Map(backup.tables.source_snapshots.map(row => [
  String(row.draw_date).slice(0, 10),
  typeof row.report_json === 'string' ? JSON.parse(row.report_json) : row.report_json
]));
for (const file of await readdir('data')) {
  const day = file.slice(0, -5);
  if (!file.endsWith('.json') || !validDay(day)) continue;
  reports.set(day, JSON.parse(await readFile(path.join('data', file), 'utf8')));
}

await mkdir(output, { recursive: true });
await cp('public', output, { recursive: true });
for (const file of ['prize8-predictor.js', 'station-schedule.js', 'lottery-core.js', 'pages-sync-core.js']) {
  await cp(path.join('src', file), path.join(output, file));
}
const days = Object.fromEntries([...reports].map(([date, report]) => {
  const results = (report.results ?? []).filter(draw => draw.region === 'MN').map(
    ({ province, name, date, region, prizes, ticket_type }) => ({ province, name, date, region, prizes, ticket_type })
  );
  return [date, { date, count: results.length, results, status: report.status, fetched_at: report.fetched_at }];
}));
await writeFile(path.join(output, 'results.json'), JSON.stringify(days));
await writeFile(path.join(output, '.nojekyll'), '');
