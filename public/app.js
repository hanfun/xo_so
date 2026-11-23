const $=id=>document.getElementById(id);
const LABELS={
  giaidb:'Đặc biệt',giai1:'Giải 1',giai2:'Giải 2',giai3:'Giải 3',giai4:'Giải 4',
  giai5:'Giải 5',giai6:'Giải 6',giai7:'Giải 7',giai8:'Giải 8'
};
let today='', report=null, collecting=false, analyzing=false;
const nf=new Intl.NumberFormat('vi-VN');
function el(tag,cls,text) {
  const e=document.createElement(tag);
  if(cls)e.className=cls;
  if(text!==undefined)e.textContent=String(text);
  return e;
}
function relativeDay(day,delta) {
  const d=new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate()+delta);
  return d.toISOString().slice(0,10);
}
function dateLabel(day) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return day;
  return new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',
    weekday:'long',timeZone:'UTC'}).format(new Date(`${day}T12:00:00Z`));
}
function notice(message,tone='') {
  $('notice').textContent=message;
  $('notice').className=`notice ${tone}`;
}
async function api(path,options) {
  const response=await fetch(path,options);
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||`HTTP ${response.status}`);
  return body;
}
async function loadDay() {
  const day=$('dateInput').value;
  try {
    const data=await api(`/api/day?date=${encodeURIComponent(day)}`);
    if(day!==$('dateInput').value)return;
    report=data;
    renderResults();
  } catch(e) { notice(`Lỗi tải dữ liệu: ${e.message}`,'error'); }
}
function renderResults() {
  const data=report||{date:$('dateInput').value,count:0,results:[]};
  $('countMN').textContent=nf.format(data.count||0);
  $('countPrizes').textContent=nf.format((data.results||[]).reduce((n,d)=>
    n+Object.values(d.prizes||{}).reduce((s,arr)=>s+arr.length,0),0));
  $('dayDisplay').textContent=data.date.split('-').reverse().join('/');
  $('csvBtn').disabled=!data.count;
  $('meta').textContent=`${dateLabel(data.date)} · ${data.count||0} đài miền Nam`;
  if(!data.count)notice('Chưa có dữ liệu XSMN ngày này. Chọn ngày khác hoặc bấm Quét XSMN.','warn');
  else if(data.status==='complete_by_provider_count')
    notice(`Đã lưu ${data.count} đài XSMN · ${new Date(data.fetched_at).toLocaleString('vi-VN')} (dữ liệu tham khảo).`,'ok');
  else notice(`Có ${data.count} đài; dữ liệu chưa đủ/đang kiểm tra. ${(data.issues||[]).slice(0,2).join(' · ')}`,'warn');

  const root=$('results');root.replaceChildren();
  if(!(data.results||[]).length) {
    const empty=el('div','empty');
    empty.append(el('div','empty-icon','▤'),el('strong','','Chưa có kết quả xổ số miền Nam'));
    empty.append(el('p','','Có thể nhập lịch sử bằng lệnh npm run history:import hoặc quét ngày đang xem.'));
    root.append(empty);return;
  }
  for(const draw of data.results) {
    if(draw.region!=='MN')continue;
    const card=el('article','result-card');
    const header=el('div','card-header');
    const title=el('div','card-headline');
    title.append(el('h3','',draw.name),el('small','',`Miền Nam · ${dateLabel(draw.date)}`));
    header.append(title,el('div','card-prize',draw.prizes?.giaidb?.[0]||'—'));
    card.append(header);
    const scroll=el('div','table-scroll');
    const table=el('table');const tbody=el('tbody');
    for(const [tier,label] of Object.entries(LABELS)) {
      const nums=draw.prizes?.[tier];
      if(!Array.isArray(nums))continue;
      const tr=el('tr');tr.append(el('th','',label));
      const td=el('td');const wrap=el('div','number-wrap');
      nums.forEach(n=>wrap.append(el('span',`num${tier==='giaidb'?' special':''}`,n)));
      td.append(wrap);tr.append(td);tbody.append(tr);
    }
    table.append(tbody);scroll.append(table);card.append(scroll);
    const foot=el('div','card-footer');
    foot.append(document.createTextNode('Nguồn tổng hợp: '));
    const link=el('a','','Xem JSON nguồn ↗');
    link.href=draw.source||data.source_url||'https://doveso.submit69.com/api/';
    link.rel='noopener noreferrer';link.target='_blank';
    foot.append(link);card.append(foot);root.append(card);
  }
}
async function scan() {
  if(collecting)return;
  const day=$('dateInput').value; collecting=true;
  $('collectBtn').disabled=true; $('collectBtn').textContent='Đang quét...';
  notice(`Đang lấy kết quả miền Nam ngày ${day}...`);
  try {
    const data=await api(`/api/collect?date=${encodeURIComponent(day)}`,{method:'POST'});
    if(day===$('dateInput').value){report=data;renderResults();}
    await Promise.all([loadStations(),analyze()]);
  } catch(e) {notice(`Lỗi cập nhật: ${e.message}. Kết quả đã lưu không bị xóa.`,'error');}
  finally{collecting=false;$('collectBtn').disabled=false;$('collectBtn').textContent='↻ Quét XSMN';}
}
async function loadStations() {
  try {
    const data=await api('/api/stations');
    const select=$('stationSelect');const previous=select.value;
    select.replaceChildren();
    select.append(new Option('Tất cả đài miền Nam',''));
    (data.stations||[]).forEach(s=>select.append(new Option(`${s.name} (${nf.format(s.draw_count)} kỳ)`,s.code)));
    if([...select.options].some(x=>x.value===previous))select.value=previous;
    const pred=$('predictionStation');
    if(pred) {
      const previousPred=pred.value;
      pred.replaceChildren(new Option('Chọn đài xổ số miền Nam',''));
      (data.stations||[]).forEach(s=>pred.append(new Option(`${s.name} (${nf.format(s.draw_count)} kỳ)`,s.code)));
      if([...pred.options].some(x=>x.value===previousPred))pred.value=previousPred;
    }
  } catch(e) {$('analysisNote').textContent=`Không tải được danh sách đài: ${e.message}`;}
}
function renderAnalysis(data) {
  $('totalNumbers').textContent=nf.format(data.totals.numbers);
  $('totalDraws').textContent=nf.format(data.totals.draws);
  $('totalDays').textContent=nf.format(data.totals.days);
  $('analysisNote').className='analysis-note';
  $('analysisNote').textContent=data.totals.numbers
    ?`Đã thống kê ${nf.format(data.totals.numbers)} kết quả từ ${nf.format(data.totals.draws)} lượt đài; nhóm theo 2 số cuối của mỗi kết quả.`
    :'Không có dữ liệu trong bộ lọc. Hãy quét hoặc nhập lịch sử trước khi phân tích.';
  const list=$('frequency');list.replaceChildren();
  const max=Math.max(1,...data.frequency.map(f=>f.appearances));
  if(!data.frequency.length)list.append(el('p','placeholder','Chưa có số liệu.'));
  for(const entry of data.frequency) {
    const row=el('div','freq-row');
    row.append(el('strong','freq-num',entry.tail.padStart(2,'0')));
    const track=el('div','freq-track');const fill=el('div','freq-bar');
    fill.style.width=`${Math.max(2,entry.appearances/max*100)}%`;
    track.append(fill);row.append(track,el('span','freq-count',nf.format(entry.appearances)),
      el('span','freq-last',entry.last_seen||'—'));
    row.title=`${entry.tail}: ${entry.appearances} lần, lần gần nhất ${entry.last_seen||'—'}`;
    list.append(row);
  }
  const months=$('monthBars');months.replaceChildren();
  const maxMonth=Math.max(1,...data.months.map(m=>m.numbers));
  if(!data.months.length)months.append(el('p','placeholder','Chưa có dữ liệu theo tháng.'));
  for(const entry of data.months) {
    const row=el('div','month-row');
    row.append(el('span','month-name',entry.month));
    const track=el('div','month-track'),bar=el('div','month-bar');
    bar.style.width=`${Math.max(2,entry.numbers/maxMonth*100)}%`;
    track.append(bar);row.append(track,el('span','month-count',nf.format(entry.numbers)));
    row.title=`${entry.month}: ${entry.numbers} kết quả từ ${entry.draws} lượt đài`;
    months.append(row);
  }
  const days=$('dailyRows');days.replaceChildren();
  if(!data.days.length) {
    const tr=el('tr');const td=el('td','','Chưa có dữ liệu');td.colSpan=3;tr.append(td);days.append(tr);
  }
  for(const entry of data.days) {
    const tr=el('tr');
    tr.append(el('td','',entry.date.split('-').reverse().join('/')),
      el('td','',nf.format(entry.draws)),el('td','',nf.format(entry.numbers)));
    days.append(tr);
  }
}
async function analyze() {
  if(analyzing)return;
  const from=$('fromDate').value,to=$('toDate').value;
  if(!from||!to||from>to) {
    $('analysisNote').textContent='Hãy chọn khoảng thời gian hợp lệ.';return;
  }
  analyzing=true;$('analyzeBtn').disabled=true;
  $('analysisNote').textContent='Đang tính thống kê từ MySQL...';
  const params=new URLSearchParams({
    from,to,province:$('stationSelect').value,prize:$('prizeSelect').value
  });
  try { renderAnalysis(await api(`/api/stats?${params}`)); }
  catch(e) {
    $('analysisNote').className='analysis-note error';
    $('analysisNote').textContent=`Không thống kê được: ${e.message}`;
  } finally { analyzing=false;$('analyzeBtn').disabled=false; }
}
async function predictPrize8() {
  const station=$('predictionStation').value;
  if(!station) {
    $('predictionMessage').textContent='Hãy chọn một đài xổ số miền Nam. Mỗi đài có lịch sử giải 8 riêng.';
    return;
  }
  const date=$('predictionDate').value;
  if(!date) {
    $('predictionMessage').textContent='Hãy chọn ngày cần xếp hạng.';
    return;
  }
  const button=$('predictionBtn');
  button.disabled=true;button.textContent='Đang tính...';
  $('predictionMessage').className='analysis-note';
  $('predictionMessage').textContent='Đang đọc lịch sử giải 8 và chạy kiểm định từng kỳ...';
  const params=new URLSearchParams({
    date, province:station,
    window:$('predictionWindow').value,
    halfLife:$('predictionHalfLife').value,
    recentWeight:$('predictionWeight').value,
    topK:'10'
  });
  try {
    const response=await api(`/api/prize8/predict?${params}`);
    const {forecast,backtest,name}=response;
    const top=$('predictionTop'),scores=forecast.top||[];
    top.replaceChildren();
    if(forecast.status==='insufficient_history') {
      const need=Math.max(0,20-forecast.windowUsed);
      $('predictionMessage').textContent=`Đài ${name} có ${forecast.windowUsed} kỳ giải 8 trước ${date}; cần thêm ít nhất ${need} kỳ để bắt đầu xếp hạng. Hãy nhập lịch sử.`;
      top.append(el('p','placeholder','Chưa đủ dữ liệu để xếp hạng có ý nghĩa.'));
    } else {
      $('predictionMessage').textContent=`${name} · ${nf.format(forecast.windowUsed)} kỳ được dùng · kỳ mới nhất trong dữ liệu: ${forecast.trainingEnd}. Trọng số gần đây: ${Math.round(100*forecast.params.recentWeight)}%.`;
      scores.forEach((score,i)=>{
        const row=el('div','rank-item');
        row.append(
          el('span','rank-pos',`#${i+1}`),
          el('strong','rank-number',score.number),
          el('span','rank-detail',`${score.observed} lần / ${forecast.windowUsed} kỳ · gần nhất ${score.lastSeen||'chưa có'}`),
          el('span','rank-score',score.score.toFixed(3))
        );
        top.append(row);
      });
    }
    const root=$('predictionBacktest');root.replaceChildren();
    if(!backtest.evaluated) {
      root.append(el('p','placeholder','Chưa có đủ kỳ trước ngày dự đoán để kiểm định.'));
    } else {
      root.append(el('p','panel-help',`Đã kiểm định ${backtest.evaluated} kỳ, luôn học từ những kỳ trước từng lần quay.`));
      const grid=el('div','backtest-metrics');
      for(const [label,item] of [['Top 1',backtest.top1],[`Top ${backtest.topK.k}`,backtest.topK]]) {
        const box=el('div','backtest-metric');
        box.append(el('span','',`${label}: ${item.hits}/${backtest.evaluated} kỳ`),
          el('strong','',`${item.rate}%`),
          el('span','',`Mốc chọn ngẫu nhiên: ${item.randomBaselinePercent}%`));
        grid.append(box);
      }
      root.append(grid);
      root.append(el('p','backtest-warning',backtest.warning));
    }
  } catch(e) {
    $('predictionMessage').className='analysis-note error';
    $('predictionMessage').textContent=`Không xếp hạng được giải 8: ${e.message}`;
  } finally {button.disabled=false;button.textContent='Xếp hạng giải 8';}
}

async function bootstrap() {
  try {
    const status=await api('/api/status');
    today=status.today;
    $('dateInput').max=today;$('toDate').max=today;
    $('dateInput').value=today;
    $('predictionDate').value=today;
    $('toDate').value=today;$('fromDate').value=relativeDay(today,-89);
    await Promise.all([loadDay(),loadStations()]);
    await analyze();
  } catch(e) {notice(`Không kết nối được máy chủ: ${e.message}`,'error');}
}
$('todayBtn').addEventListener('click',()=>{$('dateInput').value=today;void loadDay();});
$('yesterdayBtn').addEventListener('click',()=>{$('dateInput').value=relativeDay(today,-1);void loadDay();});
$('dateInput').addEventListener('change',loadDay);
$('collectBtn').addEventListener('click',scan);
$('analyzeBtn').addEventListener('click',analyze);
$('predictionBtn').addEventListener('click',predictPrize8);
$('csvBtn').addEventListener('click',()=>{
  if(report?.count)location.href=`/api/export.csv?date=${encodeURIComponent(report.date)}`;
});
void bootstrap();
setInterval(()=>{if(!collecting && $('dateInput').value)void loadDay();},60_000);
