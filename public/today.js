const $ = id => document.getElementById(id);
const LABELS = {
  giaidb: 'Đặc biệt', giai1: 'Giải 1', giai2: 'Giải 2', giai3: 'Giải 3', giai4: 'Giải 4',
  giai5: 'Giải 5', giai6: 'Giải 6', giai7: 'Giải 7', giai8: 'Giải 8'
};
const nf = new Intl.NumberFormat('vi-VN');

let today = '';
let todayStationsFallback = [];
let selectedDate = '';
let selectedStation = '';
let scheduledStations = [];
let dailyPredictionsByCode = new Map();
let dailySkippedByCode = new Map();
let dayReport = null;
let scanning = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = String(text);
  return e;
}

function relativeDay(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function dateLabel(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long', timeZone: 'UTC'
  }).format(new Date(`${day}T12:00:00Z`));
}

function setNotice(message, tone = '') {
  $('todayNotice').textContent = message;
  $('todayNotice').className = `notice ${tone}`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function actualPrize8For(code) {
  const draw = (dayReport?.results || []).find(r => r.province === code);
  const num = draw?.prizes?.giai8?.[0];
  if (typeof num === 'string' && /^\d{2}$/.test(num)) return num;
  const saved = dailyPredictionsByCode.get(code);
  return saved?.actual ?? null;
}

function renderScheduledStations() {
  const grid = $('scheduledStationGrid');
  grid.replaceChildren();
  const doneCount = scheduledStations.filter(s => actualPrize8For(s.code) != null).length;
  $('scheduledMeta').textContent = `${dateLabel(selectedDate)} · ${scheduledStations.length} đài mở thưởng lúc 16:15 (giờ VN)${doneCount ? ` · Đã có KQ ${doneCount}/${scheduledStations.length} đài` : ' · Chưa có KQ'}`;

  if (!scheduledStations.length) {
    grid.append(el('p', 'placeholder', 'Không tìm thấy lịch mở thưởng cho ngày này.'));
    return;
  }

  for (const station of scheduledStations) {
    const actual = actualPrize8For(station.code);
    const saved = dailyPredictionsByCode.get(station.code);
    const isSelected = station.code === selectedStation;
    const btn = el('button', `scheduled-station-card${isSelected ? ' is-selected' : ''}${actual ? ' has-result' : ''}`);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(isSelected));

    const head = el('div', 'scheduled-card-head');
    head.append(
      el('strong', '', station.name),
      el('span', actual ? 'daily-badge hit-top1' : 'daily-badge pending', actual ? `G.8: ${actual}` : 'Chờ xổ')
    );

    let subText = 'Bấm để xem Top 5 Giải 8';
    if (saved?.top?.length) {
      const top5Nums = saved.top.slice(0, 5).map(x => x.number).join(' · ');
      subText = `Top 5 lưu cố định: ${top5Nums}`;
    } else if (dailySkippedByCode.get(station.code)?.reason === 'insufficient_history') {
      subText = 'Chưa đủ 20 kỳ lịch sử Giải 8';
    }

    btn.append(head, el('div', 'scheduled-card-sub', subText));
    btn.addEventListener('click', () => {
      if (selectedStation === station.code) return;
      selectedStation = station.code;
      renderScheduledStations();
      renderResultsBoard();
      void loadTop5ForSelected();
    });
    grid.append(btn);
  }
}

function renderTop5Result({ stationName, sourceLabel, trainingEnd, historyCount, items, actual, actualRank, generatedAt, insufficientText }) {
  const cards = $('top5Cards');
  const badgeWrap = $('top5StatusBadge');
  const banner = $('top5ActualBanner');
  cards.replaceChildren();
  badgeWrap.replaceChildren();
  banner.replaceChildren();
  banner.hidden = true;

  $('top5Title').textContent = `Top 5 Giải 8 — ${stationName}`;

  if (insufficientText) {
    $('top5Meta').textContent = insufficientText;
    cards.append(el('p', 'placeholder', insufficientText));
    return;
  }

  const top5 = (items || []).slice(0, 5);
  const metaParts = [sourceLabel];
  if (trainingEnd) metaParts.push(`Học đến ${trainingEnd}`);
  if (historyCount != null) metaParts.push(`${nf.format(historyCount)} kỳ lịch sử`);
  if (generatedAt) metaParts.push(`Lưu lúc ${new Date(generatedAt).toLocaleString('vi-VN')}`);
  $('top5Meta').textContent = metaParts.join(' · ');

  const hitRank = actual != null ? (top5.findIndex(x => x.number === actual) + 1 || null) : null;
  if (actual != null) {
    const isTop1 = hitRank === 1;
    const isTop5 = hitRank != null && hitRank <= 5;
    badgeWrap.append(el(
      'span',
      isTop1 ? 'daily-badge hit-top1' : (isTop5 ? 'daily-badge hit-top10' : 'daily-badge miss'),
      isTop1 ? 'Trúng Top 1 (#1)' : (isTop5 ? `Trúng Top 5 (#${hitRank})` : 'Ngoài Top 5')
    ));
    banner.hidden = false;
    banner.className = `top5-actual-banner ${isTop5 ? 'is-hit' : 'is-miss'}`;
    banner.append(
      el('strong', '', `Giải 8 thực tế (${stationName}): ${actual}`),
      el('span', '', isTop5
        ? `Nằm ở hạng #${hitRank}/5 trong danh sách dự đoán (${isTop1 ? 'Trúng Top 1' : 'Trúng Top 5'}).`
        : (actualRank
          ? `Hạng #${actualRank} trong bảng xếp hạng · Ngoài Top 5 (${actualRank - 5} bậc).`
          : 'Ngoài Top 10. Bản lưu cũ chỉ có 10 hạng đầu.'))
    );
  } else {
    badgeWrap.append(el('span', 'daily-badge pending', 'Chờ kết quả'));
  }

  top5.forEach((item, idx) => {
    const rank = item.rank ?? (idx + 1);
    const isMatch = actual != null && item.number === actual;
    const card = el('article', `top5-item${isMatch ? ' is-hit' : ''}`);
    const rankRow = el('div', 'top5-item-head');
    rankRow.append(
      el('span', 'top5-rank', `#${rank}`),
      el('span', 'top5-score', `${Number(item.score).toFixed(3)} điểm`)
    );
    const detail = item.totalObserved != null
      ? `Toàn lịch sử: ${item.totalObserved} lần · gần nhất ${item.lastSeen || 'chưa có'}`
      : (item.observed != null
        ? `Cửa sổ gần: ${item.observed} lần · gần nhất ${item.lastSeen || 'chưa có'}`
        : `Lưu cố định trong MySQL`);
    card.append(
      rankRow,
      el('div', 'top5-number', item.number),
      el('div', 'top5-detail', detail)
    );
    cards.append(card);
  });
}

async function loadTop5ForSelected() {
  const station = scheduledStations.find(s => s.code === selectedStation);
  if (!station) return;
  const actual = actualPrize8For(station.code);
  const saved = dailyPredictionsByCode.get(station.code);

  // For immutable consistency, always use the saved daily snapshot when present for this date & station.
  if (saved && Array.isArray(saved.top) && saved.top.length) {
    renderTop5Result({
      stationName: saved.name || station.name,
      sourceLabel: `Bản lưu bất biến (${saved.modelVersion || 'MySQL'})`,
      trainingEnd: saved.trainingCutoff,
      historyCount: null,
      items: saved.top.slice(0, 5),
      actual,
      actualRank: saved.actualRank ?? saved.top.find(item => item.number === actual)?.rank,
      generatedAt: saved.generatedAt
    });
    return;
  }

  $('top5Title').textContent = `Top 5 Giải 8 — ${station.name}`;
  $('top5Meta').textContent = 'Đang tính toán xếp hạng V3 từ lịch sử MySQL...';
  $('top5Cards').replaceChildren(el('p', 'placeholder', 'Đang tải dữ liệu xếp hạng...'));

  try {
    const params = new URLSearchParams({
      date: selectedDate,
      province: station.code,
      topK: '5',
      shortWeight: '15',
      longWeight: '30',
      includeRanking: 'true'
    });
    const data = await api(`/api/prize8/v3/predict?${params}`);
    if (station.code !== selectedStation) return;
    if (data.forecast.status === 'insufficient_history') {
      const need = Math.max(0, 20 - data.forecast.windowUsed);
      renderTop5Result({
        stationName: data.name || station.name,
        insufficientText: `Đài ${data.name || station.name} mới có ${data.forecast.windowUsed} kỳ Giải 8 trước ${selectedDate}; cần tối thiểu 20 kỳ (thiếu ${need} kỳ).`
      });
      return;
    }
    renderTop5Result({
      stationName: data.name || station.name,
      sourceLabel: `Tính lại bằng V3 ưu tiên Top 5 (${data.modelVersion})`,
      trainingEnd: data.forecast.trainingEnd,
      historyCount: data.forecast.historyCount,
      items: data.forecast.top.slice(0, 5),
      actual,
      actualRank: (data.forecast.ranking?.indexOf(actual) ?? -1) + 1,
      generatedAt: null
    });
  } catch (e) {
    renderTop5Result({
      stationName: station.name,
      insufficientText: `Không thể tính Top 5 cho ${station.name}: ${e.message}`
    });
  }
}

function renderResultsBoard() {
  const root = $('todayResultBoard');
  const meta = $('todayResultMeta');
  root.replaceChildren();
  const draws = (dayReport?.results || []).filter(d => d.region === 'MN');
  if (!draws.length) {
    meta.textContent = `Chưa có dữ liệu kết quả ngày ${dateLabel(selectedDate)} trong MySQL.`;
    const empty = el('div', 'empty');
    empty.append(
      el('div', 'empty-icon', '◷'),
      el('strong', '', `Chưa có kết quả XSMN ngày ${selectedDate.split('-').reverse().join('/')}`),
      el('p', '', 'XSMN mở thưởng lúc 16:15 giờ Việt Nam. Bạn có thể bấm “Quét KQ ngày này” ở phía trên để kiểm tra và cập nhật dữ liệu mới nhất.')
    );
    root.append(empty);
    return;
  }

  meta.textContent = `${dateLabel(selectedDate)} · ${draws.length} đài đã có kết quả trong MySQL · cột đài đang chọn được làm nổi bật.`;

  // Put selected station first for convenience while still showing all stations of that day.
  const orderedDraws = [...draws].sort((a, b) => {
    if (a.province === selectedStation) return -1;
    if (b.province === selectedStation) return 1;
    return a.name.localeCompare(b.name, 'vi');
  });

  const board = el('article', 'lottery-board');
  const heading = el('div', 'lottery-board-heading');
  heading.append(
    el('strong', '', 'KẾT QUẢ XỔ SỐ KIẾN THIẾT MIỀN NAM'),
    el('span', '', dateLabel(selectedDate).toUpperCase())
  );
  board.append(heading);

  const scroll = el('div', 'table-scroll');
  const table = el('table', 'traditional-table');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', 'prize-heading', 'Giải'));
  orderedDraws.forEach(draw => {
    const isSel = draw.province === selectedStation;
    const th = el('th', isSel ? 'station-heading is-selected-col' : 'station-heading');
    const btn = el('button', 'station-link', draw.name);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (scheduledStations.some(s => s.code === draw.province)) {
        selectedStation = draw.province;
        renderScheduledStations();
        renderResultsBoard();
        void loadTop5ForSelected();
      }
    });
    th.append(btn, el('small', '', isSel ? 'Đài đang chọn' : (draw.ticket_type || 'XSMN')));
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const [tier, label] of Object.entries(LABELS).reverse()) {
    const rowCls = tier === 'giaidb' ? 'special-row' : (tier === 'giai8' ? 'prize8-row' : '');
    const tr = el('tr', rowCls);
    tr.append(el('th', 'prize-name', label));
    orderedDraws.forEach(draw => {
      const isSel = draw.province === selectedStation;
      const td = el('td', isSel ? 'prize-cell is-selected-col' : 'prize-cell');
      const wrap = el('div', 'traditional-numbers');
      (draw.prizes?.[tier] || []).forEach(n => {
        const cls = tier === 'giaidb' ? 'jackpot' : (tier === 'giai8' ? 'prize8-num' : '');
        wrap.append(el('span', cls, n));
      });
      if (!wrap.childNodes.length) wrap.append(el('span', 'missing', '—'));
      td.append(wrap);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  scroll.append(table);
  board.append(scroll);

  const foot = el('div', 'lottery-board-footer',
    `Dữ liệu MySQL · ${draws.length} đài · cập nhật ${dayReport?.fetched_at ? new Date(dayReport.fetched_at).toLocaleString('vi-VN') : '—'}`);
  board.append(foot);
  root.append(board);
}

async function loadScreenForDate(day, { ensureDaily = false } = {}) {
  selectedDate = day;
  $('todayDateInput').value = day;
  setNotice(`Đang tải dữ liệu ngày ${dateLabel(day)}...`);
  try {
    const usePost = ensureDaily && day === today;
    const [dailyData, reportData] = await Promise.all([
      api(`/api/prize8/daily?date=${encodeURIComponent(day)}`, usePost ? { method: 'POST' } : undefined)
        .catch(() => ({ targetDate: day, scheduled: [], scheduled_details: [], predictions: [], skipped: [] })),
      api(`/api/day?date=${encodeURIComponent(day)}`)
    ]);
    if (day !== selectedDate) return;

    dayReport = reportData;
    dailyPredictionsByCode = new Map((dailyData.predictions || []).map(p => [p.province, p]));
    dailySkippedByCode = new Map((dailyData.skipped || []).map(s => [s.province, s]));
    scheduledStations = Array.isArray(dailyData.scheduled_details) && dailyData.scheduled_details.length
      ? dailyData.scheduled_details
      : (dailyData.scheduled?.length
        ? dailyData.scheduled.map(code => ({ code, name: code }))
        : (day === today ? todayStationsFallback : []));

    if (!scheduledStations.some(s => s.code === selectedStation)) {
      selectedStation = scheduledStations[0]?.code || '';
    }

    renderScheduledStations();
    renderResultsBoard();
    await loadTop5ForSelected();

    if (reportData.count) {
      setNotice(`Đã có kết quả ${reportData.count} đài ngày ${day.split('-').reverse().join('/')} · chọn từng đài để đối chiếu Top 5 Giải 8.`, 'ok');
    } else {
      setNotice(`Ngày ${day.split('-').reverse().join('/')} có ${scheduledStations.length} đài mở thưởng theo lịch; hiện chưa có kết quả trong MySQL.`, 'warn');
    }
  } catch (e) {
    setNotice(`Không tải được dữ liệu: ${e.message}`, 'error');
  }
}

async function scanSelectedDate() {
  if (scanning || !selectedDate) return;
  scanning = true;
  $('btnScanToday').disabled = true;
  $('btnScanToday').textContent = 'Đang quét...';
  setNotice(`Đang quét kết quả XSMN ngày ${selectedDate}...`);
  try {
    await api(`/api/collect?date=${encodeURIComponent(selectedDate)}&overwrite=true`, { method: 'POST' });
    await loadScreenForDate(selectedDate, { ensureDaily: false });
  } catch (e) {
    setNotice(`Lỗi quét kết quả: ${e.message}`, 'error');
  } finally {
    scanning = false;
    $('btnScanToday').disabled = false;
    $('btnScanToday').textContent = '↻ Quét KQ ngày này';
  }
}

async function bootstrap() {
  try {
    const status = await api('/api/status');
    today = status.today;
    todayStationsFallback = Array.isArray(status.today_stations) ? status.today_stations : [];
    $('todayDateInput').max = today;
    await loadScreenForDate(today, { ensureDaily: true });
  } catch (e) {
    setNotice(`Không kết nối được máy chủ: ${e.message}`, 'error');
  }
}

$('btnToday').addEventListener('click', () => { void loadScreenForDate(today, { ensureDaily: true }); });
$('btnYesterday').addEventListener('click', () => { void loadScreenForDate(relativeDay(today, -1), { ensureDaily: false }); });
$('todayDateInput').addEventListener('change', () => {
  const day = $('todayDateInput').value;
  if (day) void loadScreenForDate(day, { ensureDaily: day === today });
});
$('btnRefresh').addEventListener('click', () => {
  if (selectedDate) void loadScreenForDate(selectedDate, { ensureDaily: false });
});
$('btnScanToday').addEventListener('click', () => { void scanSelectedDate(); });

void bootstrap();
setInterval(() => {
  if (!scanning && selectedDate && selectedDate === today) {
    void loadScreenForDate(today, { ensureDaily: false });
  }
}, 60_000);
