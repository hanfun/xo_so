const $=id=>document.getElementById(id);
const LABELS={
  giaidb:'Đặc biệt',giai1:'Giải 1',giai2:'Giải 2',giai3:'Giải 3',giai4:'Giải 4',
  giai5:'Giải 5',giai6:'Giải 6',giai7:'Giải 7',giai8:'Giải 8'
};
let today='', report=null, collecting=false, rangeCollecting=false, analyzing=false;
let selectedStation='',stationHistoryBefore='9999-12-31';
let distributionItems=[];
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
  const draws=(data.results||[]).filter(draw=>draw.region==='MN');
  const board=el('article','lottery-board');
  const heading=el('div','lottery-board-heading');
  heading.append(el('strong','','XỔ SỐ KIẾN THIẾT MIỀN NAM'),
    el('span','',dateLabel(data.date).toUpperCase()));
  board.append(heading);
  const scroll=el('div','table-scroll');
  const table=el('table','traditional-table');
  const thead=el('thead'),headRow=el('tr');
  headRow.append(el('th','prize-heading','Giải'));
  draws.forEach(draw=>{
    const th=el('th','station-heading');
    const stationButton=el('button','station-link',draw.name);
    stationButton.type='button';stationButton.addEventListener('click',()=>loadStationHistory(draw.province,true));
    th.append(stationButton,el('small','',draw.ticket_type||'XSMN'));
    headRow.append(th);
  });
  thead.append(headRow);table.append(thead);
  const tbody=el('tbody');
  for(const [tier,label] of Object.entries(LABELS).reverse()) {
    const tr=el('tr',tier==='giaidb'?'special-row':'');
    tr.append(el('th','prize-name',label));
    draws.forEach(draw=>{
      const td=el('td','prize-cell');
      const wrap=el('div','traditional-numbers');
      (draw.prizes?.[tier]||[]).forEach(n=>wrap.append(el('span',tier==='giaidb'?'jackpot':'',n)));
      if(!wrap.childNodes.length)wrap.append(el('span','missing','—'));
      td.append(wrap);tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);scroll.append(table);board.append(scroll);
  const foot=el('div','lottery-board-footer',`Dữ liệu MySQL · ${data.count} đài · cập nhật ${new Date(data.fetched_at).toLocaleString('vi-VN')}`);
  board.append(foot);root.append(board);
}
function joinedPrize(prizes,tier) {return (prizes?.[tier]||[]).join(' · ')||'—';}
async function loadStationHistory(province,reset=false) {
  if(reset) {
    selectedStation=province;stationHistoryBefore='9999-12-31';
    $('stationHistoryRows').replaceChildren();$('stationHistory').hidden=false;
    $('stationHistoryMeta').textContent='Đang đọc lịch sử từ MySQL...';
  }
  const params=new URLSearchParams({province,before:stationHistoryBefore,limit:'50'});
  const button=$('stationHistoryMore');button.disabled=true;
  try {
    const data=await api(`/api/station-results?${params}`);
    $('stationHistoryTitle').textContent=`Lịch sử xổ số ${data.name}`;
    const rows=$('stationHistoryRows');
    for(const draw of data.results) {
      const tr=el('tr');
      tr.append(el('td','history-date',draw.date.split('-').reverse().join('/')),
        el('td','',joinedPrize(draw.prizes,'giai8')),el('td','',joinedPrize(draw.prizes,'giai7')),
        el('td','',joinedPrize(draw.prizes,'giai6')),el('td','',joinedPrize(draw.prizes,'giai5')),
        el('td','',joinedPrize(draw.prizes,'giai4')),el('td','',joinedPrize(draw.prizes,'giai3')),
        el('td','',joinedPrize(draw.prizes,'giai2')),el('td','',joinedPrize(draw.prizes,'giai1')),
        el('td','history-jackpot',joinedPrize(draw.prizes,'giaidb')));
      rows.append(tr);
    }
    const loaded=rows.children.length;
    $('stationHistoryMeta').textContent=`Đã tải ${loaded} kỳ từ MySQL. Thống kê bên dưới đã lọc theo đài này.`;
    stationHistoryBefore=data.results.at(-1)?.date||stationHistoryBefore;
    button.hidden=!data.hasMore;button.disabled=false;
    const select=$('stationSelect');
    if([...select.options].some(option=>option.value===province)){select.value=province;await analyze();}
    if(reset)$('stationHistory').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(e) {
    $('stationHistoryMeta').textContent=`Không tải được lịch sử đài: ${e.message}`;button.disabled=false;
  }
}
async function scan() {
  if(collecting||rangeCollecting)return;
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
async function scanRange() {
  if(rangeCollecting||collecting)return;
  const from=$('scanFromDate').value,to=$('scanToDate').value;
  const total=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
  if(!from||!to||from>to||to>today) {
    $('scanRangeProgress').textContent='Khoảng ngày không hợp lệ hoặc vượt quá ngày hôm nay.';return;
  }
  if(total>3661) {
    $('scanRangeProgress').textContent='Mỗi lần chỉ quét tối đa 10 năm. Hãy chia thành nhiều khoảng.';return;
  }
  const overwrite=$('scanOverwrite').checked;
  const button=$('scanRangeBtn');
  rangeCollecting=true;button.disabled=true;button.textContent='Đang quét...';$('collectBtn').disabled=true;
  let saved=0,stations=0,skipped=0,errors=0,processed=0;
  $('scanProgressBar').style.width='0%';$('scanPercent').textContent='0%';
  $('scanProgressTrack').setAttribute('aria-valuenow','0');
  $('scanRangeProgress').textContent=`Bắt đầu quét ${total} ngày từ ${from} đến ${to}...`;
  try {
    for(let day=from;day<=to;day=relativeDay(day,1)) {
      $('scanRangeProgress').textContent=`Đang xử lý ${day} · ${processed}/${total} ngày`;
      let requested=false;
      try {
        const params=new URLSearchParams({date:day,overwrite:String(overwrite)});
        const data=await api(`/api/collect?${params}`,{method:'POST'});
        if(data.cached)skipped++;else {saved++;stations+=Number(data.count||0);requested=true;}
      } catch(e) {
        errors++;requested=true;
        $('scanRangeProgress').textContent=`${day}: ${e.message} · tiếp tục ngày kế tiếp...`;
      }
      processed++;
      const percent=Math.round(100*processed/total);
      $('scanProgressBar').style.width=`${percent}%`;
      $('scanPercent').textContent=`${percent}%`;
      $('scanProgressTrack').setAttribute('aria-valuenow',String(percent));
      $('scanRangeProgress').textContent=`${processed}/${total} ngày · lưu ${saved} ngày (${stations} đài) · bỏ qua ${skipped} · lỗi ${errors}`;
      if(day!==to && requested) await new Promise(resolve=>setTimeout(resolve,1200));
    }
    $('scanRangeProgress').textContent=`Hoàn tất ${processed}/${total} ngày · lưu ${saved} ngày (${stations} kết quả đài) · bỏ qua ${skipped} · lỗi ${errors}.`;
    await Promise.all([loadDay(),loadStations(),analyze()]);
  } finally {
    rangeCollecting=false;button.disabled=false;button.textContent='Quét khoảng ngày';$('collectBtn').disabled=false;
  }
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
    const dist=$('distributionStation');
    if(dist) {
      const previousDist=dist.value;
      dist.replaceChildren(new Option('Chọn đài xổ số miền Nam',''));
      (data.stations||[]).forEach(s=>dist.append(new Option(`${s.name} (${nf.format(s.draw_count)} kỳ)`,s.code)));
      if([...dist.options].some(x=>x.value===previousDist))dist.value=previousDist;
    }
  } catch(e) {$('analysisNote').textContent=`Không tải được danh sách đài: ${e.message}`;}
}
function renderDistribution() {
  const parity=$('distributionParity').value;
  const items=distributionItems.filter(item=>!parity||item.parity===parity);
  const body=$('distributionRows');body.replaceChildren();
  if(!items.length) {const tr=el('tr');const td=el('td','','Không có dữ liệu.');td.colSpan=10;tr.append(td);body.append(tr);return;}
  items.forEach((item,index)=>{
    const tr=el('tr');
    tr.append(el('td','',index+1),el('td','distribution-number',item.number),el('td','',item.parity),
      el('td','distribution-score',`${item.scorePercent.toFixed(5)}%`),
      el('td','',`${item.components.recent.toFixed(5)}%`),el('td','',`${item.components.long.toFixed(5)}%`),
      el('td','',`${item.components.weekday.toFixed(5)}%`),el('td','',`${item.components.parity.toFixed(5)}%`),
      el('td','',item.observed),el('td','',item.weekdayObserved));
    body.append(tr);
  });
}
async function analyzeDistribution() {
  const station=$('distributionStation').value,date=$('distributionDate').value;
  if(!station||!date){$('distributionMessage').textContent='Hãy chọn ngày mục tiêu và một đài XSMN.';return;}
  const weights=['weightRecent','weightLong','weightWeekday','weightParity'].map(id=>Number($(id).value));
  if(weights.some(x=>!Number.isFinite(x)||x<0||x>100)||weights.reduce((a,b)=>a+b,0)!==100) {
    $('distributionMessage').textContent='Tổng bốn trọng số phải đúng bằng 100%.';return;
  }
  const button=$('distributionBtn');button.disabled=true;button.textContent='Đang phân tích...';
  const params=new URLSearchParams({date,province:station,window:$('distributionWindow').value,halfLife:'12',
    recent:String(weights[0]),long:String(weights[1]),weekday:String(weights[2]),parity:String(weights[3])});
  try {
    const data=await api(`/api/prize8/distribution?${params}`),result=data.distribution;
    distributionItems=result.items||[];renderDistribution();
    $('distributionMessage').textContent=result.status==='insufficient_history'
      ?`Đài ${data.name} mới có ${result.windowUsed} kỳ; cần ít nhất 20 kỳ.`
      :`${data.name} · ${result.windowUsed} kỳ · ${result.weekdaySample} kỳ cùng thứ với ngày mục tiêu · hiển thị đủ 100 số.`;
  } catch(e) {$('distributionMessage').textContent=`Không phân tích được: ${e.message}`;}
  finally {button.disabled=false;button.textContent='Phân tích 00–99';}
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
    $('dateInput').max=today;$('toDate').max=today;$('distributionDate').max=today;
    $('scanFromDate').max=today;$('scanToDate').max=today;
    $('dateInput').value=today;
    $('scanToDate').value=today;$('scanFromDate').value=relativeDay(today,-30);
    $('predictionDate').value=today;
    $('distributionDate').value=today;
    $('toDate').value=today;$('fromDate').value=relativeDay(today,-89);
    await Promise.all([loadDay(),loadStations()]);
    await analyze();
  } catch(e) {notice(`Không kết nối được máy chủ: ${e.message}`,'error');}
}
$('todayBtn').addEventListener('click',()=>{$('dateInput').value=today;void loadDay();});
$('yesterdayBtn').addEventListener('click',()=>{$('dateInput').value=relativeDay(today,-1);void loadDay();});
$('dateInput').addEventListener('change',loadDay);
$('collectBtn').addEventListener('click',scan);
$('scanRangeBtn').addEventListener('click',scanRange);
$('stationHistoryMore').addEventListener('click',()=>loadStationHistory(selectedStation,false));
$('analyzeBtn').addEventListener('click',analyze);
$('predictionBtn').addEventListener('click',predictPrize8);
$('distributionBtn').addEventListener('click',analyzeDistribution);
$('distributionParity').addEventListener('change',renderDistribution);
$('csvBtn').addEventListener('click',()=>{
  if(report?.count)location.href=`/api/export.csv?date=${encodeURIComponent(report.date)}`;
});
void bootstrap();
setInterval(()=>{if(!collecting && $('dateInput').value)void loadDay();},60_000);
