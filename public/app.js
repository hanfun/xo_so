const $ = id => document.getElementById(id);
const REGIONS = { MB: 'Miền Bắc', MT: 'Miền Trung', MN: 'Miền Nam' };
const PRIZE_LABELS = {
  giaidb: 'Đặc biệt', giai1: 'Giải 1', giai2: 'Giải 2', giai3: 'Giải 3',
  giai4: 'Giải 4', giai5: 'Giải 5', giai6: 'Giải 6', giai7: 'Giải 7', giai8: 'Giải 8'
};
let selectedRegion = 'ALL';
let today = '';
let report = null;
let busy = false;

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function dateLabel(date) {
  const dateObject = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(dateObject.getTime())) return date;
  return new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
  }).format(dateObject);
}
function prevDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function notice(text, tone = '') {
  $('notice').textContent = text;
  $('notice').className = `notice ${tone}`;
}
function setBusy(on) {
  busy = on;
  $('collectBtn').disabled = on;
  $('collectBtn').textContent = on ? '↻ Đang quét...' : '↻ Quét kết quả';
}
async function getJson(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function load() {
  const day = $('dateInput').value;
  try {
    const data = await getJson(`/api/day?date=${encodeURIComponent(day)}`);
    if (day !== $('dateInput').value) return;
    report = data;
    render();
  } catch (error) {
    notice(`Không đọc được dữ liệu local: ${error.message}`, 'error');
  }
}
function render() {
  const data = report || { results: [], region_counts: {}, date: $('dateInput').value };
  for (const region of ['MB', 'MT', 'MN']) {
    $(`count${region}`).textContent = String(data.region_counts?.[region] || 0);
  }
  $('csvBtn').disabled = !data.count;
  $('meta').textContent = `${dateLabel(data.date)} · ${data.count || 0} đài có kết quả`;
  if (!data.count) {
    notice(`Chưa có kết quả đã lưu cho ngày ${dateLabel(data.date)}. Bấm “Quét kết quả” để kiểm tra nguồn.`, 'warn');
  } else if (data.status === 'complete_by_provider_count') {
    notice(`Đã lưu ${data.count} đài của cả 3 miền · Cập nhật ${new Date(data.fetched_at).toLocaleString('vi-VN')}${data.cached ? ' (dữ liệu đệm 5 phút)' : ''}.`, 'ok');
  } else {
    const issues = data.issues?.length ? ` ${data.issues.length} vấn đề: ${data.issues.slice(0, 2).join(' · ')}` : '';
    notice(`Đã có ${data.count || 0} đài nhưng chưa xác nhận đủ 3 miền / khớp số đài API.${issues}`, 'warn');
  }
  const container = $('results');
  container.replaceChildren();
  const filtered = (data.results || []).filter(r => selectedRegion === 'ALL' || r.region === selectedRegion);
  if (filtered.length === 0) {
    const empty = make('div', 'empty');
    empty.append(make('div', 'empty-icon', '▤'));
    empty.append(make('strong', '', 'Chưa có kết quả để hiển thị'));
    empty.append(make('p', '', 'Hãy chọn ngày hoặc miền khác, hoặc bấm “Quét kết quả” để lấy dữ liệu mới.'));
    container.append(empty);
    return;
  }
  for (const draw of filtered) {
    const card = make('article', 'result-card');
    const header = make('div', 'card-header');
    const headline = make('div', 'card-headline');
    headline.append(make('h3', '', draw.name));
    headline.append(make('small', '', `${REGIONS[draw.region] || draw.region}${draw.ticket_type ? ` · Ký hiệu ${draw.ticket_type}` : ''}`));
    header.append(headline, make('div', 'card-prize', draw.prizes?.giaidb?.[0] || '—'));
    card.append(header);
    const scroll = make('div', 'table-scroll');
    const table = make('table');
    const body = make('tbody');
    for (const [tier, label] of Object.entries(PRIZE_LABELS)) {
      const numbers = draw.prizes?.[tier];
      if (!Array.isArray(numbers)) continue;
      const row = make('tr');
      row.append(make('th', '', label));
      const cell = make('td');
      const numbersEl = make('div', 'number-wrap');
      numbers.forEach(number => numbersEl.append(make('span', `num${tier === 'giaidb' ? ' special' : ''}`, number)));
      cell.append(numbersEl);
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    card.append(scroll);
    const footer = make('div', 'card-footer');
    footer.append(document.createTextNode(`Ngày ${dateLabel(draw.date)} · `));
    const link = make('a', '', 'Nguồn dữ liệu ↗');
    link.href = draw.source || data.source_url || 'https://doveso.submit69.com/api/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    footer.append(link);
    card.append(footer);
    container.append(card);
  }
}
async function collect() {
  if (busy) return;
  const day = $('dateInput').value;
  setBusy(true);
  notice(`Đang kiểm tra kết quả ngày ${dateLabel(day)}...`);
  try {
    report = await getJson(`/api/collect?date=${encodeURIComponent(day)}`, { method: 'POST' });
    if (day === $('dateInput').value) render();
  } catch (error) {
    notice(`Không cập nhật được ngày ${dateLabel(day)}: ${error.message}. Dữ liệu đã lưu (nếu có) vẫn được giữ nguyên.`, 'error');
  } finally { setBusy(false); }
}
async function bootstrap() {
  try {
    const status = await getJson('/api/status');
    today = status.today;
    $('dateInput').max = today;
    $('dateInput').value = today;
    await load();
  } catch (error) {
    notice(`Không kết nối được máy chủ Node.js: ${error.message}`, 'error');
  }
}
$('dateInput').addEventListener('change', load);
$('todayBtn').addEventListener('click', () => { $('dateInput').value = today; void load(); });
$('yesterdayBtn').addEventListener('click', () => { $('dateInput').value = prevDay(today); void load(); });
$('collectBtn').addEventListener('click', collect);
$('csvBtn').addEventListener('click', () => {
  if (report?.count) window.location.href = `/api/export.csv?date=${encodeURIComponent(report.date)}`;
});
document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    selectedRegion = button.dataset.region;
    document.querySelectorAll('.tab').forEach(b => {
      const active = b.dataset.region === selectedRegion;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    render();
  });
});
void bootstrap();
// Update UI when the background scheduler has finished. GET /api/day reads only local files.
setInterval(() => { if (!busy && $('dateInput').value) void load(); }, 60_000);
