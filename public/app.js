const $=id=>document.getElementById(id);
const LABELS={
  giaidb:'Đặc biệt',giai1:'Giải 1',giai2:'Giải 2',giai3:'Giải 3',giai4:'Giải 4',
  giai5:'Giải 5',giai6:'Giải 6',giai7:'Giải 7',giai8:'Giải 8'
};
let today='', todayStations=[], report=null, collecting=false, rangeCollecting=false, analyzing=false;
let todayResultCodes=new Set();
let selectedStation='',stationHistoryBefore='9999-12-31';
let distributionItems=[];
let dailySkippedByCode=new Map();
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
const githubPages = location.hostname.endsWith('.github.io');
const dataSource = githubPages ? 'JSON đã xuất bản' : 'kho dữ liệu local';
$('storageLabel').textContent = githubPages ? 'JSON trên GitHub Pages' : 'MySQL local · JSON dự phòng';
if(githubPages) $('updateSchedule').textContent='Kết quả được cập nhật khi bản JSON mới được xuất bản.';
async function api(path,options) {
  if(githubPages) return (await import('./pages-api.js')).pagesApi(path);
  const response=await fetch(path,options);
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||`HTTP ${response.status}`);
  return body;
}
function renderTodaySchedule() {
  const meta=$('todayScheduleMeta');
  const list=$('todayScheduleList');
  if(!meta||!list)return;
  list.replaceChildren();
  if(!todayStations.length) {
    meta.textContent='Không có dữ liệu lịch mở thưởng hôm nay.';
    return;
  }
  const doneCount=todayStations.filter(s=>todayResultCodes.has(s.code)).length;
  meta.textContent=`${dateLabel(today)} · ${todayStations.length} đài XSMN · Mở thưởng 16:15 (giờ VN)${doneCount?` · Đã có KQ ${doneCount}/${todayStations.length} đài`:''}`;
  for(const station of todayStations) {
    const hasResult=todayResultCodes.has(station.code);
    const chip=el('button',hasResult?'today-station-chip is-done':'today-station-chip');
    chip.type='button';
    chip.append(
      el('span','today-station-dot'),
      el('strong','today-station-name',station.name),
      el('span','today-station-state',hasResult?'Đã có KQ':'Chờ xổ')
    );
    chip.title=`Xem lịch sử và chọn đài ${station.name}`;
    chip.addEventListener('click',()=>{
      const predSelect=$('predictionStation');
      if(predSelect && [...predSelect.options].some(o=>o.value===station.code)) predSelect.value=station.code;
      void loadStationHistory(station.code,true);
    });
    list.append(chip);
  }
}
async function loadDay() {
  const day=$('dateInput').value;
  try {
    const data=await api(`/api/day?date=${encodeURIComponent(day)}`);
    if(day!==$('dateInput').value)return;
    report=data;
    if(day===today) {
      todayResultCodes=new Set((data.results||[]).map(r=>r.province));
      renderTodaySchedule();
    }
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
  const foot=el('div','lottery-board-footer',`${dataSource} · ${data.count} đài · cập nhật ${new Date(data.fetched_at).toLocaleString('vi-VN')}`);
  board.append(foot);root.append(board);
}
function joinedPrize(prizes,tier) {return (prizes?.[tier]||[]).join(' · ')||'—';}
async function loadStationHistory(province,reset=false) {
  if(reset) {
    selectedStation=province;stationHistoryBefore='9999-12-31';
    $('stationHistoryRows').replaceChildren();$('stationHistory').hidden=false;
    $('stationHistoryMeta').textContent=`Đang đọc lịch sử từ ${dataSource}...`;
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
    $('stationHistoryMeta').textContent=`Đã tải ${loaded} kỳ từ ${dataSource}. Thống kê bên dưới đã lọc theo đài này.`;
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
    const data=await api(`/api/collect?date=${encodeURIComponent(day)}&overwrite=true`,{method:'POST'});
    if(day===today){
      todayResultCodes=new Set((data.results||[]).map(r=>r.province));
      renderTodaySchedule();
    }
    if(day===$('dateInput').value){report=data;renderResults();}
    await Promise.all([loadStations(),analyze(),loadDailyPredictions({ensure:false})]);
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
    await Promise.all([loadDay(),loadStations(),analyze(),loadDailyPredictions({ensure:true})]);
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
  $('analysisNote').textContent=`Đang tính thống kê từ ${dataSource}...`;
  const params=new URLSearchParams({
    from,to,province:$('stationSelect').value,prize:$('prizeSelect').value
  });
  try { renderAnalysis(await api(`/api/stats?${params}`)); }
  catch(e) {
    $('analysisNote').className='analysis-note error';
    $('analysisNote').textContent=`Không thống kê được: ${e.message}`;
  } finally { analyzing=false;$('analyzeBtn').disabled=false; }
}
function syncPredictionModelUI() {
  const model=$('predictionModel')?.value||'v3';
  if($('v1WeightField'))$('v1WeightField').hidden=model!=='v1';
  if($('v2WeightFields'))$('v2WeightFields').hidden=model!=='v2';
  if($('v3WeightFields'))$('v3WeightFields').hidden=model!=='v3';
  if($('windowField'))$('windowField').hidden=model==='v3';
  if($('halfLifeField'))$('halfLifeField').hidden=model==='v3';
}
function formatCi(ci) {
  if(!ci||ci.low==null||ci.high==null)return '—';
  return `${ci.low}%–${ci.high}%`;
}
function formatSigned(value,suffix='',digits=2) {
  if(value==null)return '—';
  const sign=value>0?'+':'';
  return `${sign}${Number(value).toFixed(digits)}${suffix}`;
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
  const model=$('predictionModel')?.value||'v3';
  const params=new URLSearchParams({
    date, province:station,
    topK:'10'
  });
  let endpoint='/api/prize8/predict';
  if(model==='v3') {
    const weights=['v3ShortWeight','v3MediumWeight','v3LongWeight','v3DigitWeight','v3UniformShrinkage'].map(id=>Number($(id).value));
    if(weights.some(x=>!Number.isFinite(x)||x<0||x>100)||Math.abs(weights.reduce((a,b)=>a+b,0)-100)>1e-6) {
      $('predictionMessage').className='analysis-note error';
      $('predictionMessage').textContent='Tổng năm trọng số V3 (Ngắn, Trung, Toàn lịch sử, Đầu/đuôi, Co về đều) phải đúng bằng 100%.';
      return;
    }
    endpoint='/api/prize8/v3/predict';
    params.set('shortWeight',String(weights[0]));
    params.set('mediumWeight',String(weights[1]));
    params.set('longWeight',String(weights[2]));
    params.set('digitWeight',String(weights[3]));
    params.set('uniformShrinkage',String(weights[4]));
  } else if(model==='v2') {
    const weights=['v2RecentWeight','v2LongWeight','v2DigitWeight','v2UniformShrinkage'].map(id=>Number($(id).value));
    if(weights.some(x=>!Number.isFinite(x)||x<0||x>100)||Math.abs(weights.reduce((a,b)=>a+b,0)-100)>1e-6) {
      $('predictionMessage').className='analysis-note error';
      $('predictionMessage').textContent='Tổng bốn trọng số V2 (Gần đây, Toàn lịch sử, Biên đầu/đuôi, Co về đều) phải đúng bằng 100%.';
      return;
    }
    endpoint='/api/prize8/v2/predict';
    params.set('window',$('predictionWindow').value);
    params.set('halfLife',$('predictionHalfLife').value);
    params.set('recentWeight',String(weights[0]));
    params.set('longWeight',String(weights[1]));
    params.set('digitWeight',String(weights[2]));
    params.set('uniformShrinkage',String(weights[3]));
  } else {
    params.set('window',$('predictionWindow').value);
    params.set('halfLife',$('predictionHalfLife').value);
    params.set('recentWeight',$('predictionWeight').value);
  }
  const button=$('predictionBtn');
  button.disabled=true;button.textContent='Đang tính...';
  $('predictionMessage').className='analysis-note';
  $('predictionMessage').textContent='Đang đọc lịch sử giải 8 và chạy kiểm định từng kỳ...';
  try {
    const response=await api(`${endpoint}?${params}`);
    const {forecast,backtest,name,coverage}=response;
    const top=$('predictionTop'),scores=forecast.top||[];
    top.replaceChildren();
    if(forecast.status==='insufficient_history') {
      const need=Math.max(0,20-forecast.windowUsed);
      $('predictionMessage').textContent=`Đài ${name} có ${forecast.windowUsed} kỳ giải 8 trước ${date}; cần thêm ít nhất ${need} kỳ để bắt đầu xếp hạng. Hãy nhập lịch sử.`;
      top.append(el('p','placeholder','Chưa đủ dữ liệu để xếp hạng có ý nghĩa.'));
    } else if(model==='v3') {
      $('predictionMessage').textContent=`${name} · V3 (${response.modelVersion}) · toàn lịch sử ${nf.format(forecast.historyCount)} kỳ · học đến ${forecast.trainingEnd}.`;
      scores.forEach((score,i)=>{
        const row=el('div','rank-item');
        const detail=el('div','rank-detail');
        detail.append(
          el('div','',`Toàn bộ: ${score.totalObserved}/${forecast.historyCount} · gần nhất ${score.lastSeen||'chưa có'}`),
          el('div','rank-components',`Ngắn ${score.components.short.toFixed(2)}% · Trung ${score.components.medium.toFixed(2)}% · Dài ${score.components.long.toFixed(2)}% · Đầu/đuôi ${score.components.digit.toFixed(2)}%`)
        );
        row.append(
          el('span','rank-pos',`#${i+1}`),
          el('strong','rank-number',score.number),
          detail,
          el('span','rank-score',score.score.toFixed(3))
        );
        top.append(row);
      });
    } else if(model==='v2') {
      $('predictionMessage').textContent=`${name} · V2 (${response.modelVersion}) · toàn lịch sử ${nf.format(forecast.historyCount)} kỳ (cửa sổ gần ${nf.format(forecast.windowUsed)} kỳ) · đến ${forecast.trainingEnd}.`;
      scores.forEach((score,i)=>{
        const row=el('div','rank-item');
        const detail=el('div','rank-detail');
        detail.append(
          el('div','',`Gần: ${score.observed}/${forecast.windowUsed} · Toàn bộ: ${score.totalObserved}/${forecast.historyCount} · gần nhất ${score.lastSeen||'chưa có'}`),
          el('div','rank-components',`Gần ${score.components.recent.toFixed(2)}% · Dài ${score.components.long.toFixed(2)}% · Đầu/đuôi ${score.components.digit.toFixed(2)}%`)
        );
        row.append(
          el('span','rank-pos',`#${i+1}`),
          el('strong','rank-number',score.number),
          detail,
          el('span','rank-score',score.score.toFixed(3))
        );
        top.append(row);
      });
    } else {
      $('predictionMessage').textContent=`${name} · V1 · ${nf.format(forecast.windowUsed)} kỳ được dùng · kỳ mới nhất trong dữ liệu: ${forecast.trainingEnd}. Trọng số gần đây: ${Math.round(100*forecast.params.recentWeight)}%.`;
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
    if((model==='v3'||model==='v2') && coverage) {
      const covBox=el('div','coverage-box');
      covBox.append(
        el('strong','',`Độ phủ lịch sử: ${coverage.coveragePercent}% (${nf.format(coverage.totalDraws)}/${nf.format(coverage.expectedDrawsInSpan)} kỳ)`),
        el('span','',coverage.firstDate
          ? `Giai đoạn ${coverage.firstDate} → ${coverage.lastDate} · ước thiếu ${coverage.missingDraws} kỳ · khoảng trống lớn nhất ${coverage.maxGapDays} ngày.`
          : 'Chưa có kỳ giải 8 nào trước ngày mục tiêu.')
      );
      if(coverage.warning)covBox.append(el('div','coverage-warn',coverage.warning));
      root.append(covBox);
    }
    if(!backtest.evaluated) {
      root.append(el('p','placeholder','Chưa có đủ kỳ trước ngày dự đoán để kiểm định.'));
    } else if((model==='v3'||model==='v2') && backtest.models) {
      const primaryKey=model==='v3'?'v3':'v2';
      const primaryLabel=model==='v3'?'V3':'V2';
      const primaryModel=backtest.models[primaryKey];
      root.append(el('p','panel-help',`Kiểm định cuốn chiếu ${backtest.evaluated} kỳ (${backtest.evaluationStart} → ${backtest.evaluationEnd}), luôn học từ các kỳ trước từng lần quay.`));
      const grid=el('div','backtest-metrics');
      for(const [label,item] of [[`${primaryLabel} Top 1`,primaryModel.top1],[`${primaryLabel} Top ${primaryModel.topK.k}`,primaryModel.topK]]) {
        const box=el('div','backtest-metric');
        box.append(
          el('span','',`${label}: ${item.hits}/${backtest.evaluated} kỳ`),
          el('strong','',`${item.rate}%`),
          el('span','',`CI 95%: ${formatCi(item.ci95)} · So ngẫu nhiên: ${formatSigned(item.liftPoints,' đ%')}`)
        );
        grid.append(box);
      }
      root.append(grid);
      const scroll=el('div','table-scroll');
      const table=el('table','benchmark-table');
      const thead=el('thead'),hr=el('tr');
      ['Mô hình','Top 1','Top 10 (CI 95%)','Log-loss','MRR'].forEach(h=>hr.append(el('th','',h)));
      thead.append(hr);table.append(thead);
      const tbody=el('tbody');
      const rowsDef=[
        ...(backtest.models.v3?[['V3 (Đa khung + Đầu/đuôi động)',backtest.models.v3,'benchmark-v2']]:[]),
        ['V2 (Đa thành phần)',backtest.models.v2,model==='v2'?'benchmark-v2':''],
        ['V1 (Trọng số gần)',backtest.models.v1,''],
        ['Tần suất thô (Raw)',backtest.models.raw,''],
        ['Ngẫu nhiên đều',backtest.models.uniform,'benchmark-uniform']
      ];
      for(const [label,m,cls] of rowsDef) {
        const tr=el('tr',cls);
        const top1Text=m.top1.hits==null?`${m.top1.rate}%`:`${m.top1.rate}% (${m.top1.hits})`;
        const topKText=m.topK.hits==null?`${m.topK.rate}%`:`${m.topK.rate}% (${formatCi(m.topK.ci95)})`;
        tr.append(
          el('td','',label),
          el('td','',top1Text),
          el('td','',topKText),
          el('td','',m.logLoss!=null?m.logLoss.toFixed(4):'—'),
          el('td','',m.mrr!=null?m.mrr.toFixed(4):'—')
        );
        tbody.append(tr);
      }
      table.append(tbody);scroll.append(table);root.append(scroll);
      const sig=model==='v3'
        ? backtest.comparison?.v3VsUniform?.isStatisticallySignificantTopK
        : backtest.comparison?.v2VsUniform?.isStatisticallySignificantTopK;
      root.append(el('p','backtest-note',sig
        ? `Cận dưới CI 95% của ${primaryLabel} Top 10 vượt mốc 10% trên mẫu quá khứ; vẫn cần kiểm chứng ngoài mẫu trước khi rút kết luận.`
        : `Chênh lệch Top 10 của ${primaryLabel} chưa vượt mốc ngẫu nhiên 10% ở mức tin cậy 95% — phù hợp kỳ vọng của kỳ quay ngẫu nhiên.`));
      root.append(el('p','backtest-warning',backtest.warning));
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

function dailyStatusMeta(item) {
  if(item.actual==null) return { text:'Chờ kết quả', cls:'daily-badge pending' };
  if(item.top1Hit) return { text:'Trúng Top 1 · #1', cls:'daily-badge hit-top1' };
  if(item.top5Hit) return { text:`Trúng Top 5 · #${item.actualRank}`, cls:'daily-badge hit-top10' };
  if(item.top10Hit) return { text:`Trúng Top 10 · #${item.actualRank}`, cls:'daily-badge hit-top10' };
  return { text:'Ngoài Top 10', cls:'daily-badge miss' };
}
function renderDailyPredictions(data) {
  const msg=$('dailyPredictionMessage');
  const root=$('dailyPredictionCards');
  if(!msg||!root)return;
  root.replaceChildren();
  if(Array.isArray(data.skipped)) {
    dailySkippedByCode=new Map(data.skipped.map(s=>[s.province,s]));
  }
  const predictions=data.predictions||[];
  const scheduled=data.scheduled||[];
  const generatedCount=Array.isArray(data.generated)?data.generated.length:0;
  const withActual=predictions.filter(p=>p.actual!=null);
  const top1Hits=withActual.filter(p=>p.top1Hit).length;
  const top10Hits=withActual.filter(p=>p.top10Hit).length;
  const parts=[
    `Ngày ${dateLabel(data.targetDate)}`,
    `${predictions.length}/${scheduled.length} đài đã lưu Top 10`
  ];
  if(generatedCount) parts.push(`vừa tạo mới ${generatedCount} đài`);
  if(withActual.length) parts.push(`đã đối chiếu ${withActual.length} đài (Top 1: ${top1Hits}, Top 10: ${top10Hits})`);
  msg.textContent=`${parts.join(' · ')}. ${data.note||''}`.trim();

  const detailsByCode=new Map((data.scheduled_details||[]).map(s=>[s.code,s.name]));
  const byProvince=new Map(predictions.map(item=>[item.province,item]));
  const orderedCodes=[...new Set([...scheduled,...predictions.map(p=>p.province)])];
  if(!orderedCodes.length) {
    root.append(el('p','placeholder','Không có đài mở thưởng theo lịch cho ngày này.'));
    return;
  }
  const isPastDay=Boolean(today && data.targetDate && data.targetDate < today);
  for(const code of orderedCodes) {
    const item=byProvince.get(code);
    if(!item) {
      const skipped=dailySkippedByCode.get(code);
      const card=el('article','daily-card daily-card-muted');
      const head=el('div','daily-card-head');
      const label=skipped?.name||detailsByCode.get(code)||code;
      head.append(el('strong','',label),el('span','daily-badge pending',isPastDay?'Chưa lưu bản cố định':'Chưa đủ lịch sử'));
      const reason=skipped?.reason==='insufficient_history'
        ? `Mới có ${skipped.historyCount??0} kỳ Giải 8 trước ngày ${data.targetDate} (cần tối thiểu 20 kỳ để tạo Top 10).`
        : (isPastDay
          ? `Chưa có bảng xếp hạng. Bạn có thể bấm “Xếp hạng giải 8” bên dưới hoặc xem tại màn hình Hôm nay · Top 5.`
          : `Chưa có đủ lịch sử Giải 8 trong ${dataSource} cho đài này.`);
      card.append(head,el('p','daily-empty-note',reason));
      root.append(card);
      continue;
    }
    const card=el('article','daily-card');
    const head=el('div','daily-card-head');
    const titleWrap=el('div','daily-card-title');
    titleWrap.append(el('strong','',item.name));
    if(item.modelVersion) titleWrap.append(el('small','',item.modelVersion));
    const badge=dailyStatusMeta(item);
    head.append(titleWrap,el('span',badge.cls,badge.text));
    card.append(head);

    const actualBar=el('div',item.actual!=null?'daily-actual has-actual':'daily-actual');
    if(item.actual!=null) {
      const rankLabel=item.actualRank?`Hạng #${item.actualRank}`:'Ngoài Top 10 · bản lưu cũ';
      actualBar.append(
        el('div','daily-actual-num',`Giải 8: ${item.actual}`),
        el('div','daily-actual-meta',`${rankLabel} · Top 5: ${item.top5Hit?'Đạt':'Không'} · Top 10: ${item.top10Hit?'Đạt':'Không'}`)
      );
    } else {
      actualBar.append(el('div','daily-actual-meta','Chưa có kết quả Giải 8 hôm nay — sẽ tự đối chiếu khi kết quả được quét.'));
    }
    card.append(actualBar);

    const list=el('div','daily-top-list');
    (item.top||[]).forEach(entry=>{
      const isMatch=item.actual!=null && entry.number===item.actual;
      const cell=el('div',isMatch?'daily-top-cell daily-top-hit':'daily-top-cell');
      cell.append(
        el('span','daily-top-rank',`#${entry.rank}`),
        el('strong','daily-top-num',entry.number),
        el('span','daily-top-score',Number(entry.score).toFixed(2))
      );
      list.append(cell);
    });
    card.append(list);

    const foot=el('div','daily-card-foot',
      `Học đến ${item.trainingCutoff} · ${item.modelVersion?.includes('-replay-') ? 'Tính lại để đối chiếu' : 'Lưu cố định'}${item.generatedAt ? ' ' + new Date(item.generatedAt).toLocaleString('vi-VN') : ''}`);
    card.append(foot);
    root.append(card);
  }
}
async function loadDailyPredictions({date='',ensure=false}={}) {
  const msg=$('dailyPredictionMessage');
  if(!msg)return;
  const targetDate=date||$('dateInput')?.value||today;
  try {
    const query=targetDate?`?date=${encodeURIComponent(targetDate)}`:'';
    const allowPost=ensure && targetDate===today;
    const data=await api(`/api/prize8/daily${query}`,allowPost?{method:'POST'}:undefined);
    renderDailyPredictions(data);
  } catch(e) {
    msg.textContent=`Không tải được dự đoán hằng ngày: ${e.message}`;
  }
}
function onSelectedDayChanged() {
  const day=$('dateInput').value;
  if(!day)return;
  if($('predictionDate'))$('predictionDate').value=day;
  if($('distributionDate'))$('distributionDate').value=day;
  void loadDay();
  void loadDailyPredictions({date:day,ensure:day===today});
}
async function bootstrap() {
  try {
    const status=await api('/api/status');
    today=status.today;
    todayStations=Array.isArray(status.today_stations)?status.today_stations:[];
    renderTodaySchedule();
    $('dateInput').max=today;$('toDate').max=today;$('distributionDate').max=today;
    $('scanFromDate').max=today;$('scanToDate').max=today;
    $('dateInput').value=today;
    $('scanToDate').value=today;$('scanFromDate').value=relativeDay(today,-30);
    $('predictionDate').value=today;
    $('distributionDate').value=today;
    $('toDate').value=today;$('fromDate').value=relativeDay(today,-89);
    await Promise.all([loadDay(),loadStations(),loadDailyPredictions({date:today})]);
    if(githubPages) {
      for(const id of ['collectBtn','scanRangeBtn','csvBtn']) $(id).hidden=true;
    } else void api('/api/opening-sync',{method:'POST'}).then(async ({errors})=>{
      await Promise.all([loadDay(),loadStations(),loadDailyPredictions()]);
      if(errors.length) notice('Một số ngày chưa cập nhật được kết quả hoặc Top 5.','error');
    }).catch(()=>notice('Chưa hoàn tất tự động cập nhật lịch sử.','error'));
    await analyze();
  } catch(e) {notice(`Không kết nối được máy chủ: ${e.message}`,'error');}
}
$('todayBtn').addEventListener('click',()=>{$('dateInput').value=today;onSelectedDayChanged();});
$('yesterdayBtn').addEventListener('click',()=>{$('dateInput').value=relativeDay(today,-1);onSelectedDayChanged();});
$('dateInput').addEventListener('change',onSelectedDayChanged);
$('collectBtn').addEventListener('click',scan);
$('scanRangeBtn').addEventListener('click',scanRange);
$('stationHistoryMore').addEventListener('click',()=>loadStationHistory(selectedStation,false));
$('analyzeBtn').addEventListener('click',analyze);
$('predictionBtn').addEventListener('click',predictPrize8);
$('predictionModel')?.addEventListener('change',syncPredictionModelUI);
syncPredictionModelUI();
$('distributionBtn').addEventListener('click',analyzeDistribution);
$('distributionParity').addEventListener('change',renderDistribution);
$('csvBtn').addEventListener('click',()=>{
  if(report?.count)location.href=`/api/export.csv?date=${encodeURIComponent(report.date)}`;
});
void bootstrap();
setInterval(()=>{
  if(!collecting && $('dateInput').value) {
    void loadDay();
    void loadDailyPredictions({ensure:false});
  }
},60_000);
