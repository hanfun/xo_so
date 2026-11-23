import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PUBLIC_DIR, validDay, vnClock } from './config.js';
import { exportCsv, listHistory, readDay } from './store.js';
import { PRIZE_NAMES, REGIONS } from './lottery.js';
import { SLOTS } from './scheduler.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};
function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    ...headers
  });
  res.end(body);
}
const json = (res, status, payload) => send(res, status, JSON.stringify(payload));

export function createAppServer({ collector, dataDir = DATA_DIR, publicDir = PUBLIC_DIR } = {}) {
  if (!collector) throw new Error('collector required');
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const day = url.searchParams.get('date') || vnClock().day;
      if (url.pathname === '/api/status' && req.method === 'GET') {
        return json(res, 200, {
          now: new Date().toISOString(), today: vnClock().day,
          regions: REGIONS, prize_names: PRIZE_NAMES, schedule: SLOTS,
          timezone: 'Asia/Ho_Chi_Minh', source: 'https://doveso.submit69.com/api/'
        });
      }
      if (url.pathname === '/api/history' && req.method === 'GET') {
        return json(res, 200, { dates: await listHistory(dataDir) });
      }
      if (['/api/day', '/api/collect', '/api/export.csv'].includes(url.pathname)) {
        if (!validDay(day)) return json(res, 400, { error: 'Ngày phải có dạng YYYY-MM-DD' });
        if (url.pathname === '/api/day' && req.method === 'GET') {
          const report = await readDay(day, dataDir);
          return json(res, 200, report || {
            date: day, status: 'no_data', count: 0, region_counts: { MB: 0, MT: 0, MN: 0 },
            issues: [], results: [], error: collector.getLastError(day)
          });
        }
        if (url.pathname === '/api/collect' && req.method === 'POST') {
          try { return json(res, 200, await collector.collect(day)); }
          catch (e) { return json(res, 503, { error: e.message }); }
        }
        if (url.pathname === '/api/export.csv' && req.method === 'GET') {
          const report = await readDay(day, dataDir);
          if (!report || !report.count) return json(res, 404, { error: 'Chưa có dữ liệu để xuất' });
          return send(res, 200, exportCsv(report), 'text/csv; charset=utf-8', {
            'Content-Disposition': `attachment; filename="xskt-${day}.csv"`
          });
        }
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, contentType] = STATIC[url.pathname];
        return send(res, 200, await readFile(path.join(publicDir, file)), contentType);
      }
      return json(res, 404, { error: 'Không tìm thấy đường dẫn' });
    } catch (error) {
      console.error('[HTTP]', error);
      return json(res, 500, { error: 'Lỗi máy chủ. Xem terminal để biết chi tiết.' });
    }
  });
}
