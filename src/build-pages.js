import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

// Keep a single cache version across the entry scripts and their ES module imports.
// This avoids mixing stale browser/CDN modules with freshly deployed files.
const assetFiles = ['app.js','today.js','pages-api.js','pages-sync-config.js',
  'prize8-predictor.js','station-schedule.js','lottery-core.js','pages-sync-core.js','style.css','results.json'];
const hash = createHash('sha256');
for (const file of assetFiles) hash.update(await readFile(path.join(output,file)));
const version = hash.digest('hex').slice(0,16);
const moduleFiles = new Set(assetFiles.filter(file => file.endsWith('.js')));
for (const file of moduleFiles) {
  const target = path.join(output,file);
  let source = await readFile(target,'utf8');
  source = source.replace(/(['"])\.\/([\w-]+\.js)\1/g,(match,quote,name) =>
    moduleFiles.has(name) ? quote + './' + name + '?v=' + version + quote : match);
  if (file === 'pages-api.js') source = source.replace("'./results.json'", "'./results.json?v=" + version + "'");
  await writeFile(target,source);
}
for (const name of ['index.html','today.html']) {
  const target=path.join(output,name);
  const html=await readFile(target,'utf8');
  await writeFile(target,html.replace(/(src|href)="\.\/(app\.js|today\.js|style\.css)"/g,
    (_,attr,file)=>attr+'="./'+file+'?v='+version+'"'));
}
