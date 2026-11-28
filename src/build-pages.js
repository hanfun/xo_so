import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateDataset } from './github-results-store.js';

const output = path.resolve('pages-dist');
// data/results.json is the only online result source. MySQL backup is an archive.
const days = validateDataset(JSON.parse(await readFile(process.argv[2] ?? 'data/results.json','utf8')));

await mkdir(output, { recursive: true });
await cp('public', output, { recursive: true });
for (const file of ['prize8-predictor.js', 'station-schedule.js', 'lottery-core.js', 'pages-sync-core.js', 'pages-browser-sync.js']) {
  await cp(path.join('src', file), path.join(output, file));
}
await writeFile(path.join(output, 'results.json'), JSON.stringify(days));
await writeFile(path.join(output, '.nojekyll'), '');

// Keep a single cache version across the entry scripts and their ES module imports.
// This avoids mixing stale browser/CDN modules with freshly deployed files.
const assetFiles = ['app.js','today.js','pages-api.js','pages-sync-config.js',
  'prize8-predictor.js','station-schedule.js','lottery-core.js','pages-sync-core.js','pages-browser-sync.js','style.css','results.json'];
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
