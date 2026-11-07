// ── PDFアップロード ──
let uploadedDatesSet = new Set();
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-based

async function upPDF(input){
  const file=input.files[0];if(!file)return;
  const ps = document.getElementById('up-period-start').value;
  const pe = document.getElementById('up-period-end').value;
  const errEl = document.getElementById('up-date-error');
  if(!ps||!pe){
    errEl.innerHTML='<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>取引期間の開始日と終了日を入力してください</p>';
    input.value=''; return;
  }
  if(ps > pe){
    errEl.innerHTML='<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>開始日が終了日より後です</p>';
    input.value=''; return;
  }
  // 今日の日付が終了日に指定されている場合は警告して処理中断
  const todayStr = new Date().toISOString().slice(0,10);
  if(pe === todayStr){
    errEl.innerHTML='<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>ダウンロードした日の日付は終了日に含めないでください。終了日はダウンロード日の前日を指定してください。</p>';
    input.value=''; return;
  }
  // 重複チェック
  const overlap = checkDateOverlap(ps, pe);
  if(overlap){
    errEl.innerHTML=`<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>${overlap} はすでにアップロード済みです。期間を調整してください。</p>`;
    input.value=''; return;
  }
  errEl.innerHTML='';

  const fd=new FormData();
  fd.append('pdf',file);
  fd.append('period_start',ps);
  fd.append('period_end',pe);
  document.getElementById('upres').innerHTML='<p style="color:var(--mu)"><span class="ei" data-i="upload"></span>アップロード中...</p>';
  const base=window.location.pathname.replace(/\/$/,'');
  try{
    const r=await fetch(base+'/api/upload',{method:'POST',body:fd});
    let d;
    try{ d=await r.json(); }
    catch(je){
      document.getElementById('upres').innerHTML='<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>レスポンス解析失敗</p>';
      input.value=''; return;
    }
    if(d && d.success===true){
      document.getElementById('upres').innerHTML='<p style="color:var(--mu)"><span class="ei" data-i="download"></span>データ反映中...</p>';
      logChange('作成','/transactions',`銀行明細PDF「${file.name}」を取り込みました（${ps}〜${pe}・${d.count}件）`);
      try{ const t=await api('GET','/transactions'); allTx=t.transactions||[]; }catch(e2){allTx=[];}
      popFy(); loadDash();
      document.getElementById('upres').innerHTML='<p style="color:var(--in)"><span class="ei" data-i="checkc"></span>'+d.count+'件取り込みました</p>';
      toast(''+d.count+'件取込完了','#059669');
      // カレンダー更新
      await loadUploadCalendar();
    }else{
      const em=(d&&d.error&&typeof d.error==='string')?d.error:'PDFの取り込みに失敗しました';
      document.getElementById('upres').innerHTML='<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>'+em+'</p>';
    }
  }catch(e){document.getElementById('upres').innerHTML='<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>通信エラー: '+e.message+'</p>';}
  input.value='';
}

function checkDateOverlap(start, end) {
  const s = start.replace(/-/g, '/');
  const e = end.replace(/-/g, '/');
  const cur = new Date(start);
  const endD = new Date(end);
  while(cur <= endD) {
    const ds = cur.toISOString().slice(0,10).replace(/-/g,'/');
    if(uploadedDatesSet.has(ds)) return ds;
    cur.setDate(cur.getDate()+1);
  }
  return null;
}

// 終了日変更時の警告表示
function _updateTodayWarn(){
  const pe = document.getElementById('up-period-end');
  const warn = document.getElementById('up-today-warn');
  if(!pe || !warn) return;
  const todayStr = new Date().toISOString().slice(0,10);
  warn.style.display = (pe.value && pe.value === todayStr) ? '' : 'none';
}
document.addEventListener('DOMContentLoaded', ()=>{
  const pe = document.getElementById('up-period-end');
  if(pe) pe.addEventListener('change', _updateTodayWarn);
});

const drop=document.getElementById('drop');
if(drop) {
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');
    const f=e.dataTransfer.files[0];
    if(f&&f.type==='application/pdf'){const dt=new DataTransfer();dt.items.add(f);document.getElementById('pdfin').files=dt.files;upPDF(document.getElementById('pdfin'));}
  });
}

async function loadUploadCalendar(){
  const d=await api('GET','/upload-dates');
  const dates = d.dates || [];
  uploadedDatesSet = new Set(dates);
  renderUploadCalendar();
}

function renderUploadCalendar(){
  const el=document.getElementById('upload-calendar');
  if(!el) return;
  const y=calYear, m=calMonth;
  const today = new Date();
  const todayStr = today.toISOString().slice(0,10).replace(/-/g,'/');

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

  let html = `<div class="upload-cal">
    <div class="upload-cal-hd">
      <button onclick="calPrev()">◀</button>
      <span class="cal-title">${y}年 ${monthNames[m]}</span>
      <button onclick="calNext()">▶</button>
    </div>
    <div class="cal-grid">
      <div class="cal-dow sun">日</div><div class="cal-dow">月</div><div class="cal-dow">火</div>
      <div class="cal-dow">水</div><div class="cal-dow">木</div><div class="cal-dow">金</div>
      <div class="cal-dow sat">土</div>`;

  // 空セル
  for(let i=0;i<firstDay;i++) html+='<div class="cal-day empty"></div>';

  for(let d=1;d<=daysInMonth;d++){
    const dateStr=`${y}/${String(m+1).padStart(2,'0')}/${String(d).padStart(2,'0')}`;
    const dow = new Date(y,m,d).getDay();
    let cls='cal-day';
    if(uploadedDatesSet.has(dateStr)) cls+=' uploaded';
    if(dateStr===todayStr) cls+=' today';
    if(dow===0) cls+=' sun';
    if(dow===6) cls+=' sat';
    html+=`<div class="${cls}">${d}</div>`;
  }

  html += `</div>
    <div class="cal-legend">
      <span><span class="cal-legend-dot up"></span> アップロード済</span>
      <span><span class="cal-legend-dot td"></span> 今日</span>
    </div>
  </div>`;
  el.innerHTML=html;
}

function calPrev(){
  calMonth--;
  if(calMonth<0){calMonth=11;calYear--;}
  renderUploadCalendar();
}
function calNext(){
  calMonth++;
  if(calMonth>11){calMonth=0;calYear++;}
  renderUploadCalendar();
}

// ── 期間リセット（仕訳・PDF取込状態の巻き戻し）──
const RS_SRC_LABEL = { pdf:'銀行明細PDF', credit_csv:'クレカ明細CSV', manual:'手動追加' };
let rsPreviewData = null;   // 直近のプレビュー結果
let rsPreviewBody = null;   // プレビュー時のパラメータ（実行時はこれを使う）

function rsSources(){
  const s=[];
  if(document.getElementById('rs-src-pdf')?.checked)    s.push('pdf');
  if(document.getElementById('rs-src-csv')?.checked)    s.push('credit_csv');
  if(document.getElementById('rs-src-manual')?.checked) s.push('manual');
  return s;
}

function rsClearPreview(){
  rsPreviewData=null; rsPreviewBody=null;
  const el=document.getElementById('rs-preview');
  if(el) el.innerHTML='';
}

function rsBody(dryRun){
  const start=document.getElementById('rs-start').value;
  const end  =document.getElementById('rs-end').value;
  const srcs =rsSources();
  if(!start||!end){ toast('リセット期間の開始日と終了日を入力してください','#f59e0b'); return null; }
  if(start>end)   { toast('開始日が終了日より後です','#f59e0b'); return null; }
  if(!srcs.length){ toast('削除する仕訳の取込元を1つ以上選んでください','#f59e0b'); return null; }
  return {
    start, end, sources:srcs,
    clear_upload_dates: !!document.getElementById('rs-clear-dates')?.checked,
    dry_run: !!dryRun,
    _skipLog: true,
  };
}

async function rsPreview(){
  const body=rsBody(true);
  if(!body) return;
  const el=document.getElementById('rs-preview');
  el.innerHTML='<p style="color:var(--mu);font-size:13px"><span class="ei" data-i="search"></span>対象を集計中...</p>';
  const d=await api('POST','/reset-period',body);
  if(!d||d.error){ el.innerHTML=`<p style="color:var(--ex);font-size:13px"><span class="ei" data-i="xc"></span>${d?.error||'集計に失敗しました'}</p>`; return; }
  rsPreviewData=d;
  rsPreviewBody={...body, dry_run:false};

  if(!d.tx_count && !d.upload_dates){
    el.innerHTML='<p style="font-size:13px;color:var(--mu)">この期間に削除対象の仕訳・取込済み日付はありません。</p>';
    return;
  }
  const bySrc=Object.entries(d.by_source||{}).filter(([,v])=>v>0)
    .map(([k,v])=>`${RS_SRC_LABEL[k]||k} ${v}件`).join(' / ') || 'なし';
  const warn=[];
  if(d.registered)     warn.push(`登録済みの仕訳 ${d.registered}件を含みます`);
  if(d.billing_linked) warn.push(`請求シートに紐付いた仕訳 ${d.billing_linked}件を含みます（リセット後は請求シートの「照合」をやり直してください）`);
  if(d.claim_count)    warn.push(`交通費・立替申請 ${d.claim_count}件の仕訳紐付けを解除し、返金済み分は再マッチ待ちに戻します`);
  if(d.receipt_count)  warn.push(`領収書付きの仕訳 ${d.receipt_count}件を含みます（画像ファイル自体は削除しません）`);

  el.innerHTML=`
    <div style="background:#fff;border:1px solid var(--bd);border-radius:8px;padding:12px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">${d.start} 〜 ${d.end} のリセット対象</div>
      <div style="font-size:13px;line-height:1.9">
        削除する仕訳：<strong style="color:var(--ex)">${d.tx_count}件</strong>（${bySrc}）<br>
        金額合計：¥${(d.amount||0).toLocaleString()}<br>
        未取込に戻す日付：<strong>${d.upload_dates}日分</strong>${d.clear_upload_dates?'':'（戻さない設定）'}
      </div>
      ${warn.length?`<ul style="font-size:12px;color:#b45309;margin:10px 0 0;padding-left:18px">${warn.map(w=>`<li>${w}</li>`).join('')}</ul>`:''}
      <button class="btn bsm" style="background:#dc2626;color:#fff;margin-top:12px" onclick="rsExecute()"><span class="ei" data-i="trash"></span>この内容でリセットを実行</button>
    </div>`;
}

async function rsExecute(){
  if(!rsPreviewData){ toast('先に「対象を確認」を押してください','#f59e0b'); return; }
  const p=rsPreviewData;
  if(!confirm(`${p.start} 〜 ${p.end} の仕訳 ${p.tx_count}件を削除し、${p.upload_dates}日分を未取込に戻します。\n実行してよろしいですか？（直後なら取り消せます）`)) return;

  // 確認した内容そのままを実行する（プレビュー後に入力を変えても影響しない）
  const body={...rsPreviewBody, _skipLog:true};
  const el=document.getElementById('rs-preview');
  el.innerHTML='<p style="color:var(--mu);font-size:13px"><span class="ei" data-i="eraser"></span>リセット中...</p>';
  const d=await api('POST','/reset-period',body);
  if(!d||d.error){ el.innerHTML=`<p style="color:var(--ex);font-size:13px"><span class="ei" data-i="xc"></span>${d?.error||'リセットに失敗しました'}</p>`; return; }

  logChange('削除','/reset-period',
    `${d.start}〜${d.end} をリセット（仕訳${d.tx_count}件削除・取込済み${d.upload_dates}日分を未取込に・申請${d.claims_reset||0}件の紐付け解除）`);

  try{ const t=await api('GET','/transactions'); allTx=t.transactions||[]; }catch(e){ allTx=[]; }
  popFy(); loadDash();
  await loadUploadCalendar();
  await loadResetHistory();
  rsPreviewData=null;
  el.innerHTML=`<p style="color:var(--in);font-size:13px"><span class="ei" data-i="checkc"></span>仕訳 ${d.tx_count}件を削除し、${d.upload_dates}日分を未取込に戻しました${d.claims_reset?`（申請 ${d.claims_reset}件の紐付けを解除）`:''}</p>`;
  toast('リセット完了','#059669');
}

async function loadResetHistory(){
  const el=document.getElementById('rs-history');
  if(!el) return;
  let d;
  try{ d=await api('GET','/reset-history'); }catch(e){ el.textContent='履歴を取得できませんでした'; return; }
  const rows=(d&&d.resets)||[];
  if(!rows.length){ el.innerHTML='<span style="color:var(--mu)">まだリセットは実行されていません</span>'; return; }
  el.innerHTML=`<div class="tbl-wrap"><table><thead><tr>
      <th>実行日時</th><th>期間</th><th>取込元</th><th style="text-align:right">削除件数</th><th style="text-align:right">未取込に戻した日数</th><th></th>
    </tr></thead><tbody>${rows.slice(0,10).map(r=>`<tr${r.undone?' style="opacity:.55"':''}>
      <td>${r.created_at||''}</td>
      <td>${r.start||''}〜${r.end||''}</td>
      <td>${(r.sources||[]).map(s=>RS_SRC_LABEL[s]||s).join('・')}</td>
      <td style="text-align:right">${r.tx_count||0}件</td>
      <td style="text-align:right">${r.upload_dates||0}日</td>
      <td style="text-align:right">${r.undone
        ? '<span class="badge" style="background:#e2e8f0;color:#475569">取り消し済み</span>'
        : `<button class="btn bsm" style="background:#475569;color:#fff" onclick="rsUndo('${r.id}')">↩ 取り消し</button>`}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function rsUndo(id){
  if(!confirm('このリセットを取り消して、削除した仕訳と取込済み日付を元に戻しますか？')) return;
  const d=await api('POST','/reset-undo',{id, _skipLog:true});
  if(!d||d.error){ toast(''+(d?.error||'取り消しに失敗しました'),'#dc2626'); return; }
  logChange('作成','/reset-undo',`期間リセットを取り消しました（仕訳${d.tx_restored}件・取込済み${d.upload_dates_restored}日分を復元）`);
  try{ const t=await api('GET','/transactions'); allTx=t.transactions||[]; }catch(e){}
  popFy(); loadDash();
  await loadUploadCalendar();
  await loadResetHistory();
  rsClearPreview();
  toast(`${d.tx_restored}件の仕訳を復元しました`,'#059669');
}

// ── ルール ──
function updRuleSub(i, side) {
  const r = editRu[i];
  if(side === 'd'){
    document.getElementById('ru-dsub-'+i).innerHTML = subOp(r.debit_account, '');
    r.debit_sub = '';
  } else {
    document.getElementById('ru-csub-'+i).innerHTML = subOp(r.credit_account, '');
    r.credit_sub = '';
  }
}

// 自動生成されたルール（交通費/立替等）はユーザーに見せないが保存時には維持
function _isAutoGenRule(r){
  const n = r && r.name ? r.name : '';
  return /^(交通費自動|立替自動|申請自動仕訳)[:：]/.test(n);
}
let _hiddenRules = []; // 自動生成ルールの保持用
async function loadRu(){
  const d=await api('GET','/rules');
  // 適用される順（優先度の高い順）に並べて見せる。保存時は並び順から優先度を振り直す
  const all = JSON.parse(JSON.stringify(d.rules||[])).sort((a,b)=>(b.priority||0)-(a.priority||0));
  _hiddenRules = all.filter(_isAutoGenRule);
  editRu = all.filter(r => !_isAutoGenRule(r));
  rRu();
}
function rRu(){
  document.getElementById('rlist').innerHTML=editRu.map((r,i)=>`
  <div class="ri" draggable="true" data-idx="${i}"
    ondragstart="dS(event,${i})" ondragover="dO(event)" ondrop="dD(event,${i})" ondragleave="dL(event)">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="cursor:grab;color:var(--mu);font-size:18px;user-select:none">⠿</span>
      <span class="prbadge">#${i+1}</span>
      <input style="flex:1;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px;font-weight:600"
        value="${(r.name||'').replace(/"/g,'&quot;')}" oninput="editRu[${i}].name=this.value">
      <button class="btn bd2 bsm" onclick="editRu.splice(${i},1);rRu()">削除</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      <div style="grid-column:1/-1; display:flex; gap:8px;">
        <div style="flex:2"><label style="font-size:11px;color:var(--mu)">相手先パターン（正規表現）</label>
          <input id="rpat${i}" oninput="editRu[${i}].pattern=this.value" style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px"></div>
        <div style="flex:1"><label style="font-size:11px;color:var(--mu)">金額条件（完全一致/任意）</label>
          <input type="number" value="${r.exact_amount||''}" oninput="editRu[${i}].exact_amount=this.value" style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px" placeholder="未入力で全金額"></div>
      </div>
      <div><label style="font-size:11px;color:var(--mu)">借方科目</label>
        <select onchange="editRu[${i}].debit_account=this.value; updRuleSub(${i},'d')" style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px;font-size:12px">${allAcOp(r.debit_account)}</select></div>
      <div><label style="font-size:11px;color:var(--mu)">貸方科目</label>
        <select onchange="editRu[${i}].credit_account=this.value; updRuleSub(${i},'c')" style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px;font-size:12px">${allAcOp(r.credit_account)}</select></div>
      <div><label style="font-size:11px;color:var(--mu)">借方補助</label>
        <select id="ru-dsub-${i}" onchange="editRu[${i}].debit_sub=this.value" style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px;font-size:12px">${subOp(r.debit_account, r.debit_sub)}</select></div>
      <div><label style="font-size:11px;color:var(--mu)">貸方補助</label>
        <select id="ru-csub-${i}" onchange="editRu[${i}].credit_sub=this.value" style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px;font-size:12px">${subOp(r.credit_account, r.credit_sub)}</select></div>
      <div style="grid-column:1/-1"><label style="font-size:11px;color:var(--mu)">摘要テンプレート</label>
        <input value="${(r.memo_template||'').replace(/"/g,'&quot;')}" oninput="editRu[${i}].memo_template=this.value"
          style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px"></div>
    </div>
  </div>`).join('');
  editRu.forEach((r,i)=>{const el=document.getElementById('rpat'+i);if(el)el.value=r.pattern||'';});
}
let dSrc=-1;
function dS(e,i){dSrc=i;e.dataTransfer.effectAllowed='move';}
function dO(e){e.preventDefault();e.currentTarget.style.background='#eff6ff';}
function dL(e){e.currentTarget.style.background='';}
function dD(e,i){e.currentTarget.style.background='';if(dSrc===i)return;const mv=editRu.splice(dSrc,1)[0];editRu.splice(i,0,mv);rRu();}
function addRule(){editRu.unshift({name:'新ルール',pattern:'',debit_account:'',credit_account:'',memo_template:''});rRu();}
async function saveRules(){
  editRu.forEach((r,i)=>r.priority=editRu.length-i);
  // ユーザーの表示ルール + 非表示の自動生成ルールをマージして保存
  const merged = [...editRu, ..._hiddenRules];
  await api('POST','/rules',{rules:merged,_skipLog:true});allRu=merged;
  logChange('更新','/rules',`自動仕訳ルールを保存しました（${editRu.length}件）`);
  toast('ルールを保存しました','#059669');
  // 未登録取引にルールを適用
  const res=await api('POST','/apply-rules',{_skipLog:true});
  if(res.updated>0){
    logChange('更新','/transactions',`自動仕訳ルールを適用し ${res.updated}件の取引を更新しました`);
    toast(`${res.updated}件の未登録取引に自動仕訳を適用しました`,'#1a56db');
    allTx=(await api('GET','/transactions')).transactions||allTx;
    loadDash();
    // 仕訳帳ページが表示中なら再描画
    if(document.getElementById('page-journal')?.classList.contains('active')){
      if(typeof renderJ==='function') renderJ();
    }
  } else {
    toast('ℹ️ ルールを保存しました（適用対象の未登録取引なし）','#64748b');
  }
}

// ── 勘定科目 ──
function loadAcs(){rAcT();}
function atab(t){
  curAcTab=t;
  document.querySelectorAll('#page-accounts .tab').forEach(b=>b.classList.remove('active'));
  const btn=document.getElementById('tab-'+t);if(btn)btn.classList.add('active');
  const hints={
    assets:'借方で増加する科目（普通預金、小口現金、売掛金など）',
    liabilities:'貸方で増加する科目（未払金、借入金など）',
    equity:'貸方で増加する科目（元入金、繰越利益など）',
    income:'貸方で増加する科目（会費収入、補助金収入など）',
    expense:'借方で増加する科目（交通費、消耗品費、備品費など）',
  };
  document.getElementById('ac-type-hint').textContent=hints[t]||'';
  rAcT();
}
function rAcT(){
  const gs=allAc[curAcTab]||[];
  document.getElementById('actree').innerHTML=gs.map((g,gi)=>`
  <div style="margin-bottom:10px">
    <div class="agt">
      <span>
        <input style="width:55px;background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:2px 4px;color:#fff;font-size:12px"
          value="${g.code}" onblur="allAc['${curAcTab}'][${gi}].code=this.value">
        <input style="flex:1;background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:2px 6px;color:#fff;font-size:13px;margin-left:6px"
          value="${g.name}" onblur="allAc['${curAcTab}'][${gi}].name=this.value">
      </span>
      <button class="btn bd2 bsm" onclick="allAc['${curAcTab}'].splice(${gi},1);rAcT()">削除</button>
    </div>
    ${(g.sub||[]).map((s,si)=>`
    <div class="ait sub">
      <input style="width:55px;border:1px solid var(--bd);border-radius:4px;padding:3px;font-size:12px" value="${s.code}" onblur="allAc['${curAcTab}'][${gi}].sub[${si}].code=this.value">
      <input style="flex:1;border:1px solid var(--bd);border-radius:4px;padding:3px;font-size:12px" value="${s.name}" onblur="allAc['${curAcTab}'][${gi}].sub[${si}].name=this.value">
      <button class="btn bd2 bsm" onclick="allAc['${curAcTab}'][${gi}].sub.splice(${si},1);rAcT()">削除</button>
    </div>`).join('')}
    <div class="ait sub" style="background:#fffbeb"><button class="btn bs bsm" onclick="addSub(${gi})">+ 補助科目</button></div>
  </div>`).join('');
}
function addSub(gi){const g=allAc[curAcTab][gi];if(!g.sub)g.sub=[];g.sub.push({code:g.code+(g.sub.length+1).toString().padStart(2,'0'),name:'新補助科目'});rAcT();}
function addAc(){if(!allAc[curAcTab])allAc[curAcTab]=[];allAc[curAcTab].push({code:'',name:'新勘定科目',sub:[]});rAcT();}
async function saveAcs(){await api('POST','/accounts',allAc);updAcF();rRu();toast('保存しました','#059669');}

// ── 設定 ──
function _secretSet(k){ return !!(sts.secrets_set && sts.secrets_set[k]); }
function loadSt(){
  document.getElementById('s-club').value=sts.club_name||'';
  document.getElementById('s-fys').value=sts.fiscal_year_start||4;
  document.getElementById('s-grace-days').value=sts.payment_grace_days!==undefined ? sts.payment_grace_days : 7;
  document.getElementById('s-bank-sub').value=sts.bank_account_sub||'';
  // 秘密の値はサーバーから返さない。登録済みかどうかだけ表示する
  const it=document.getElementById('s-internal-token');
  it.value=''; it.placeholder=_secretSet('php_internal_token')?'登録済み（変えるときだけ入力）':'未設定だと外部からの申請を受け付けません';
  // ログイン方法
  const lm=sts.login_methods||{password:true};
  document.getElementById('lm-password').checked=!!lm.password;
  document.getElementById('lm-slack').checked=!!lm.slack;
  document.getElementById('lm-google').checked=!!lm.google;
  document.getElementById('s-slack-client-id').value=sts.slack_client_id||'';
  document.getElementById('s-google-client-id').value=sts.google_client_id||'';
  for(const [id,key] of [['s-slack-client-secret','slack_client_secret'],['s-google-client-secret','google_client_secret']]){
    const el=document.getElementById(id); el.value='';
    el.placeholder=_secretSet(key)?'登録済み（変えるときだけ入力）':'未登録';
  }
  const base=window.location.origin+getBase();
  document.getElementById('slack-redirect-url').textContent=base+'/auth.php?_path=/auth/slack/callback';
  document.getElementById('google-redirect-url').textContent=base+'/auth.php?_path=/auth/google/callback';
  renderLoginConf();
  renderFeatureList();
  // 決算書の別表
  document.getElementById('s-sub-title').value=sts.sub_report_title||'';
  renderSubReportAccounts();
  // 請求書の差出人
  document.getElementById('s-inv-from-name').value=sts.invoice_from_name||'';
  document.getElementById('s-inv-from-zip').value=sts.invoice_from_zip||'';
  document.getElementById('s-inv-from-addr').value=sts.invoice_from_addr||'';
  document.getElementById('s-inv-from-tel').value=sts.invoice_from_tel||'';
  document.getElementById('s-inv-notes').value=sts.invoice_notes||'';
  _invSealPending=null; renderInvSeal(sts.invoice_seal||'');
  // 会費の種類
  document.getElementById('s-fee-presets').value=sts.fee_presets||'';
  const obAc=document.getElementById('ob-ac');
  if(obAc) obAc.innerHTML=allAcOp('');
  const obSub=document.getElementById('ob-sub');
  if(obSub){ obSub.style.display='none'; obSub.value=''; }
  rOB();
}

// ── 設定の一部だけを保存する（画面の sts もそろえる）──
async function saveStPart(part, msg){
  const r=await api('POST','/settings',part);
  if(r&&r.error){ toast(''+(r.message||r.error),'#ef4444'); return false; }
  const fresh=await api('GET','/settings');
  if(fresh&&!fresh.error) sts=fresh;
  applyFeatureUI();
  toast(msg||'保存しました','#059669');
  return true;
}

// ── 使う機能 ──
function renderFeatureList(){
  const el=document.getElementById('feature-list'); if(!el) return;
  const meta=sts.feature_meta||{};
  const desc={
    invoice:'請求書・見積書を作って PDF で出力します。',
    billing:'会費などの請求シートを作り、銀行明細の振込名義カナ × 金額で入金を照合します。',
    credit_card:'三井住友カードの利用明細 CSV を取り込み、カード明細ごとに仕訳します。',
    claims:'外部の申請フォーム（Slack ボットなど）から届く交通費・立替の申請を管理します。申請フォームは別に用意が必要です。',
    ai:'Claude API を使ったチャットで、仕訳の提案や集計を頼めます。Claude の APIキー（従量課金）が必要です。',
    ai_slack:'AIアシスタントが Slack のチャンネルを読んで、明細の目的を調べます。Slack の Bot Token が必要です。',
  };
  el.innerHTML=Object.keys(meta).map(k=>{
    const sub=k==='ai_slack';
    return `<label class="feat-row" style="${sub?'margin-left:26px':''}"><input type="checkbox" data-feat="${k}" ${hasFeature(k)?'checked':''} onchange="syncFeatureDeps()">
      <span><strong>${escHtml(meta[k].label)}</strong><br><span class="feat-sub">${escHtml(desc[k]||'')}</span></span></label>`;
  }).join('');
  syncFeatureDeps();
}
function syncFeatureDeps(){
  const ai=document.querySelector('[data-feat="ai"]'), sl=document.querySelector('[data-feat="ai_slack"]');
  if(ai&&sl){ sl.disabled=!ai.checked; if(!ai.checked) sl.checked=false; sl.closest('.feat-row').classList.toggle('disabled',!ai.checked); }
}
async function saveFeatures(){
  const features={};
  document.querySelectorAll('[data-feat]').forEach(cb=>features[cb.dataset.feat]=cb.checked);
  await saveStPart({features},'使う機能を保存しました');
  renderFeatureList();
}

// ── ログイン方法 ──
function renderLoginConf(){
  document.getElementById('lm-slack-conf').style.display=document.getElementById('lm-slack').checked?'':'none';
  document.getElementById('lm-google-conf').style.display=document.getElementById('lm-google').checked?'':'none';
}
async function saveLoginMethods(){
  const part={login_methods:{
    password:document.getElementById('lm-password').checked,
    slack:document.getElementById('lm-slack').checked,
    google:document.getElementById('lm-google').checked,
  }};
  if(!part.login_methods.password&&!part.login_methods.slack&&!part.login_methods.google){
    toast('ログイン方法を1つ以上選んでください','#f59e0b'); return;
  }
  part.slack_client_id=document.getElementById('s-slack-client-id').value.trim();
  part.google_client_id=document.getElementById('s-google-client-id').value.trim();
  const ss=document.getElementById('s-slack-client-secret').value.trim(); if(ss) part.slack_client_secret=ss;
  const gs=document.getElementById('s-google-client-secret').value.trim(); if(gs) part.google_client_secret=gs;
  if(!part.login_methods.password && !confirm('パスワードログインを切ります。Slack / Google で自分がログインできることを確かめましたか？')) return;
  if(await saveStPart(part,'ログイン方法を保存しました')) loadSt();
}

// ── 決算書の別表 ──
function renderSubReportAccounts(){
  const el=document.getElementById('s-sub-accounts'); if(!el) return;
  const chosen=new Set(Array.isArray(sts.sub_report_accounts)?sts.sub_report_accounts:[]);
  const names=[...(allAc.income||[]),...(allAc.expense||[])].map(a=>a.name);
  if(!names.length){ el.innerHTML='<span style="color:var(--mu)">収入・支出の勘定科目がありません</span>'; return; }
  el.innerHTML=names.map(n=>`<label style="display:flex;align-items:center;gap:4px;width:auto"><input type="checkbox" class="sub-ac" value="${escHtml(n)}" ${chosen.has(n)?'checked':''} style="flex:none;min-width:0">${escHtml(n)}</label>`).join('');
}
async function saveSubReport(){
  const accounts=[...document.querySelectorAll('.sub-ac:checked')].map(cb=>cb.value);
  await saveStPart({sub_report_title:document.getElementById('s-sub-title').value.trim(),sub_report_accounts:accounts},'別表の設定を保存しました');
}

// ── 請求書の差出人 ──
let _invSealPending=null;   // null = 変更なし / '' = 削除 / data URI = 新しい画像
function renderInvSeal(src){
  const img=document.getElementById('s-inv-seal-img'); if(!img) return;
  img.src=src||''; img.style.display=src?'':'none';
}
function pickInvSeal(input){
  const f=input.files&&input.files[0]; if(!f) return;
  if(f.size>300*1024){ toast('画像は300KBまでにしてください','#f59e0b'); input.value=''; return; }
  const fr=new FileReader();
  fr.onload=()=>{ _invSealPending=String(fr.result); renderInvSeal(_invSealPending); };
  fr.readAsDataURL(f);
}
function clearInvSeal(){ _invSealPending=''; renderInvSeal(''); const i=document.getElementById('s-inv-seal'); if(i) i.value=''; }
async function saveInvoiceSettings(){
  const part={
    invoice_from_name:document.getElementById('s-inv-from-name').value.trim(),
    invoice_from_zip:document.getElementById('s-inv-from-zip').value.trim(),
    invoice_from_addr:document.getElementById('s-inv-from-addr').value.trim(),
    invoice_from_tel:document.getElementById('s-inv-from-tel').value.trim(),
    invoice_notes:document.getElementById('s-inv-notes').value,
  };
  if(_invSealPending!==null) part.invoice_seal=_invSealPending;
  if(await saveStPart(part,'請求書の差出人を保存しました')) _invSealPending=null;
}

// ── 期首残高 ──
async function saveOB(){
  await saveStPart({opening_balances:sts.opening_balances||{}},'期首残高を保存しました');
  rOB();
}

// ── 会費の種類 ──
async function saveFeePresets(){
  await saveStPart({fee_presets:document.getElementById('s-fee-presets').value},'会費の種類を保存しました');
}

// ── 申請フォーム連携の内部トークン ──
function genInternalToken(){
  const a=new Uint8Array(24); crypto.getRandomValues(a);
  const t=[...a].map(b=>b.toString(16).padStart(2,'0')).join('');
  const el=document.getElementById('s-internal-token'); el.type='text'; el.value=t;
  toast('トークンを作りました。保存してから、申請フォーム側にも同じ値を設定してください');
}
function copyText(id){
  const el=document.getElementById(id); if(!el) return;
  navigator.clipboard.writeText(el.textContent).then(()=>toast('コピーしました','#059669'));
}
function rOB(){
  const obAll=sts.opening_balances||{};
  // 異常データを除外: 年度キーが数字でない or 1900未満 or 値がnull
  const years=Object.keys(obAll).filter(y=>/^\d+$/.test(y)&&parseInt(y)>=1900&&obAll[y]!=null).sort();
  if(!years.length){
    document.getElementById('oblist').innerHTML='<p style="color:var(--mu);font-size:13px">期首残高なし</p>';
    return;
  }
  document.getElementById('oblist').innerHTML=years.map(y=>{
    const val=obAll[y];
    const isObj=typeof val==='object'&&val!==null;
    const entries=isObj?Object.entries(val):[['普通預金',val]];
    const total=entries.reduce((s,[,v])=>s+parseInt(v||0),0);
    return`<div style="border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>${y}年度</strong>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--mu)">合計: <strong>¥${total.toLocaleString()}</strong></span>
          <button class="btn bs bsm" onclick="addObAccount('${y}')">+ 科目追加</button>
          <button class="btn bd2 bsm" onclick="delete sts.opening_balances['${y}'];rOB()">年度削除</button>
        </div>
      </div>
      ${entries.map(([ac,v])=>`
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
        <span style="min-width:120px;font-size:13px">${ac}</span>
        <input type="number" value="${parseInt(v||0)}" min="0"
          style="width:130px;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px;text-align:right"
          oninput="setObVal('${y}','${ac}',this.value)">
        <button class="btn bd2 bsm" onclick="delObAccount('${y}','${ac}')">削除</button>
      </div>`).join('')}
    </div>`;
  }).join('');
}
function setObVal(yr, ac, v){
  if(!sts.opening_balances)sts.opening_balances={};
  const cur=sts.opening_balances[yr];
  if(typeof cur==='object'&&cur!==null){
    cur[ac]=parseInt(v)||0;
  }else{
    sts.opening_balances[yr]={[ac]:parseInt(v)||0};
  }
}
function delObAccount(yr, ac){
  const cur=sts.opening_balances?.[yr];
  if(!cur)return;
  if(typeof cur==='object'){delete cur[ac];if(!Object.keys(cur).length)delete sts.opening_balances[yr];}
  else delete sts.opening_balances[yr];
  rOB();
}
function addObAccount(yr){
  openObPicker(yr);
}

// ── 期首残高 科目選択モーダル ──
function openObPicker(yr){
  // 既存モーダルがあれば削除
  document.getElementById('ob-picker-modal')?.remove();
  const m=document.createElement('div');
  m.id='ob-picker-modal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
  m.innerHTML=`
    <div style="background:#fff;border-radius:10px;padding:20px;width:380px;max-width:92vw;box-shadow:0 10px 30px rgba(0,0,0,.2)">
      <div style="font-weight:600;margin-bottom:12px">期首残高 科目追加（${yr}年度）</div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--mu);display:block;margin-bottom:4px">勘定科目</label>
        <select id="ob-pick-ac" style="width:100%;border:1px solid var(--bd);border-radius:6px;padding:6px 8px;font-size:14px"
          onchange="onObPickAcChange()">${allAcOp('')}</select>
      </div>
      <div id="ob-pick-sub-wrap" style="margin-bottom:14px;display:none">
        <label style="font-size:12px;color:var(--mu);display:block;margin-bottom:4px">補助科目</label>
        <select id="ob-pick-sub" style="width:100%;border:1px solid var(--bd);border-radius:6px;padding:6px 8px;font-size:14px">
          <option value="">-（なし）</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn bs bsm" onclick="document.getElementById('ob-picker-modal').remove()">キャンセル</button>
        <button class="btn bp bsm" onclick="confirmObPicker('${yr}')">追加</button>
      </div>
    </div>`;
  document.body.appendChild(m);
}
function onObPickAcChange(){
  const acName=document.getElementById('ob-pick-ac').value;
  const wrap=document.getElementById('ob-pick-sub-wrap');
  const sel=document.getElementById('ob-pick-sub');
  if(!acName){ wrap.style.display='none'; return; }
  // その科目に補助科目があるか確認
  let hasSub=false;
  for(const tp of ['assets','liabilities','equity','income','expense']){
    const a=(allAc[tp]||[]).find(x=>x.name===acName);
    if(a&&a.sub&&a.sub.length){ hasSub=true; break; }
  }
  if(hasSub){
    sel.innerHTML=subOp(acName,'');
    wrap.style.display='';
  }else{
    wrap.style.display='none';
  }
}
function confirmObPicker(yr){
  const ac=document.getElementById('ob-pick-ac').value;
  if(!ac){ toast('勘定科目を選んでください','#f59e0b'); return; }
  const subSel=document.getElementById('ob-pick-sub');
  const sub=subSel && document.getElementById('ob-pick-sub-wrap').style.display!=='none' ? subSel.value : '';
  const key=sub ? `${ac} / ${sub}` : ac;
  if(!sts.opening_balances)sts.opening_balances={};
  if(typeof sts.opening_balances[yr]!=='object'||sts.opening_balances[yr]===null){
    // 旧形式の数値があれば普通預金として移行
    const old=sts.opening_balances[yr]||0;
    sts.opening_balances[yr]={};
    if(old) sts.opening_balances[yr]['普通預金']=parseInt(old);
  }
  if(sts.opening_balances[yr][key]!==undefined){
    toast('既に追加済みの科目です','#f59e0b');
    return;
  }
  sts.opening_balances[yr][key]=0;
  document.getElementById('ob-picker-modal').remove();
  rOB();
}
function onObAcChange(){
  const acName=document.getElementById('ob-ac').value;
  const sub=document.getElementById('ob-sub');
  if(!acName){ sub.style.display='none'; sub.value=''; return; }
  let hasSub=false;
  for(const tp of ['assets','liabilities','equity','income','expense']){
    const a=(allAc[tp]||[]).find(x=>x.name===acName);
    if(a&&a.sub&&a.sub.length){ hasSub=true; break; }
  }
  if(hasSub){
    sub.innerHTML=subOp(acName,'');
    sub.style.display='';
  }else{
    sub.style.display='none';
    sub.value='';
  }
}
function addOB(){
  const yRaw=document.getElementById('ob-yr').value;
  const y=parseInt(yRaw);
  const vRaw=document.getElementById('ob-vl').value;
  const ac=document.getElementById('ob-ac').value;
  const subEl=document.getElementById('ob-sub');
  const sub=subEl.style.display!=='none' ? subEl.value : '';
  // バリデーション
  if(!yRaw||isNaN(y)||y<1900){
    toast('年度は4桁の西暦（1900以降）を入力してください','#f59e0b');
    return;
  }
  if(!ac){toast('勘定科目を選んでください','#f59e0b');return;}
  if(vRaw===''||vRaw===null){
    toast('金額を入力してください','#f59e0b');
    return;
  }
  const v=parseInt(vRaw)||0;
  const key=sub ? `${ac} / ${sub}` : ac;
  if(!sts.opening_balances)sts.opening_balances={};
  if(typeof sts.opening_balances[y]!=='object'||sts.opening_balances[y]===null){
    // 旧形式移行
    const old=sts.opening_balances[y]||0;
    sts.opening_balances[y]={};
    if(old) sts.opening_balances[y]['普通預金']=parseInt(old);
  }
  sts.opening_balances[y][key]=v;
  rOB();
}
async function saveSt(){
  const part={
    club_name:document.getElementById('s-club').value.trim(),
    fiscal_year_start:parseInt(document.getElementById('s-fys').value),
    payment_grace_days:parseInt(document.getElementById('s-grace-days').value)||0,
    bank_account_sub:document.getElementById('s-bank-sub').value.trim(),
    opening_balances:sts.opening_balances||{},
  };
  const internalToken=document.getElementById('s-internal-token').value.trim();
  if(internalToken) part.php_internal_token=internalToken;
  if(!await saveStPart(part)) return;
  document.getElementById('club-lbl').textContent=sts.club_name||'';
  document.getElementById('s-internal-token').type='password';
  popMonthSel();
  loadSt(); popFy(); loadDash();
}
// ── クレジットカード明細CSVアップロード ──
async function upCreditCsv(input) {
  const file = input.files[0]; if (!file) return;
  const paymentDate = document.getElementById('csv-payment-date')?.value;
  if (!paymentDate) {
    toast('引き落とし日を入力してください', '#f59e0b');
    input.value = '';
    return;
  }
  const resEl = document.getElementById('csvres');
  const previewEl = document.getElementById('csv-tx-preview');
  resEl.innerHTML = '<p style="color:var(--mu)"><span class="ei" data-i="upload"></span>アップロード中...</p>';
  previewEl.innerHTML = '';

  const fd = new FormData();
  fd.append('csv', file);
  fd.append('payment_date', paymentDate);
  const base = window.location.pathname.replace(/\/$/, '');
  try {
    const r = await fetch(base + '/api/upload-credit-csv', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.success) {
      const regMsg = d.registered
        ? '（全件自動仕訳済み <span class="ei" data-i="checkc"></span>）'
        : d.auto_applied > 0
          ? `（${d.auto_applied}件自動仕訳済み・残り未仕訳あり）`
          : '（未仕訳あり — クレカ仕訳ルールを設定してください）';
      resEl.innerHTML = `<p style="color:var(--in)"><span class="ei" data-i="checkc"></span>${d.count}件の明細を取り込みました ${regMsg}</p>`;
      logChange('作成','/transactions',`クレジットカード明細CSV「${file.name}」を取り込みました（支払日 ${paymentDate}・${d.count}件${d.auto_applied?`・${d.auto_applied}件自動仕訳`:''}）`);
      toast('クレジット明細 ' + d.count + '件取込完了', '#059669');
      try { const t = await api('GET', '/transactions'); allTx = t.transactions || []; } catch(e2) {}
      await renderCreditEntryList();
      // 取り込んだトランザクションをプレビュー
      if (d.tx_id) renderCreditTxPreview(d.tx_id);
    } else {
      resEl.innerHTML = `<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>${d.error || '取り込みに失敗しました'}</p>`;
    }
  } catch(e) {
    resEl.innerHTML = `<p style="color:var(--ex)"><span class="ei" data-i="xc"></span>通信エラー: ${e.message}</p>`;
  }
  input.value = '';
}

function renderCreditTxPreview(txId) {
  const el = document.getElementById('csv-tx-preview'); if (!el) return;
  const tx = (allTx || []).find(t => t.id === txId);
  if (!tx) { el.innerHTML = ''; return; }

  const entries = tx.entries || [];
  const unmatched = entries.filter(e => !e.debit_account || !e.credit_account);

  let html = `<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
    <div style="background:#f8fafc;padding:10px 14px;font-size:12px;font-weight:700;color:#374151;display:flex;justify-content:space-between">
      <span><span class="ei" data-i="card"></span>${tx.party || ''} — ${tx.date || ''} / ¥${(tx.amount||0).toLocaleString()} / ${entries.length}件</span>
      <span style="color:${tx.registered ? '#059669' : '#f59e0b'}">${tx.registered ? '<span class="ei" data-i="checkc"></span>登録済' : '<span class="ei" data-i="hourglass"></span>未登録'}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f1f5f9;color:#64748b">
        <th style="padding:6px 10px;text-align:left">借方科目</th>
        <th style="padding:6px 10px;text-align:left">貸方科目</th>
        <th style="padding:6px 10px;text-align:right">金額</th>
        <th style="padding:6px 10px;text-align:left">摘要</th>
      </tr></thead>
      <tbody>`;
  entries.forEach(e => {
    const missing = !e.debit_account || !e.credit_account;
    const rowStyle = missing ? 'background:#fef9c3' : '';
    html += `<tr style="border-top:1px solid #f1f5f9;${rowStyle}">
      <td style="padding:6px 10px">${e.debit_account || '<span style="color:#94a3b8">—</span>'} ${e.debit_sub ? '<span style="color:#94a3b8;font-size:11px">' + e.debit_sub + '</span>' : ''}</td>
      <td style="padding:6px 10px">${e.credit_account || '<span style="color:#94a3b8">—</span>'} ${e.credit_sub ? '<span style="color:#94a3b8;font-size:11px">' + e.credit_sub + '</span>' : ''}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:700">¥${(e.amount||0).toLocaleString()}</td>
      <td style="padding:6px 10px;color:#64748b">${e.memo || ''}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  if (unmatched.length > 0) {
    html += `<div style="padding:8px 14px;background:#fef9c3;font-size:12px;color:#854d0e">
      <span class="ei" data-i="alert"></span>${unmatched.length}件の明細が未仕訳です。「自動仕訳ルール」タブで加盟店名パターンを登録してください。
    </div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
}

// ドラッグ＆ドロップ対応（CSVエリア）
document.addEventListener('DOMContentLoaded', () => {
  const creditDrop = document.getElementById('credit-drop');
  if (creditDrop) {
    creditDrop.addEventListener('dragover', e => { e.preventDefault(); creditDrop.classList.add('over'); });
    creditDrop.addEventListener('dragleave', () => creditDrop.classList.remove('over'));
    creditDrop.addEventListener('drop', e => {
      e.preventDefault(); creditDrop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) { const dt = new DataTransfer(); dt.items.add(f); document.getElementById('csvin').files = dt.files; upCreditCsv(document.getElementById('csvin')); }
    });
  }
});

// ── クレカ仕訳ルール ──
let editCreditRu = [];

async function loadCreditRules() {
  const d = await api('GET', '/credit-rules');
  editCreditRu = JSON.parse(JSON.stringify(d.rules || []));
  rCreditRu();
  await renderCreditEntryList();
}

function rCreditRu() {
  document.getElementById('credit-rlist').innerHTML = editCreditRu.map((r, i) => `
  <div class="ri" draggable="true" data-idx="${i}"
    ondragstart="crDS(event,${i})" ondragover="dO(event)" ondrop="crDD(event,${i})" ondragleave="dL(event)">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="cursor:grab;color:var(--mu);font-size:18px;user-select:none">⠿</span>
      <span class="prbadge">#${i+1}</span>
      <input style="flex:1;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px;font-weight:600"
        value="${(r.name||'').replace(/"/g,'&quot;')}" oninput="editCreditRu[${i}].name=this.value">
      <button class="btn bd2 bsm" onclick="editCreditRu.splice(${i},1);rCreditRu()">削除</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      <div style="grid-column:1/-1">
        <label style="font-size:11px;color:var(--mu)">加盟店名パターン（部分一致・正規表現）</label>
        <input id="crpat${i}" oninput="editCreditRu[${i}].pattern=this.value"
          style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px"
          placeholder="例: トヨタ、ETC、AMAZON">
      </div>
      <div><label style="font-size:11px;color:var(--mu)">借方科目 <span style="color:#ef4444">*</span></label>
        <select onchange="editCreditRu[${i}].debit_account=this.value;crUpdSub(${i})"
          style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px;font-size:12px">${allAcOp(r.debit_account)}</select></div>
      <div><label style="font-size:11px;color:var(--mu)">貸方科目（固定）</label>
        <div style="padding:6px 8px;background:#f1f5f9;border-radius:5px;font-size:12px;color:#64748b">
          普通預金${sts.bank_account_sub ? ' ' + escHtml(sts.bank_account_sub) : ''}
        </div></div>
      <div><label style="font-size:11px;color:var(--mu)">借方補助</label>
        <select id="cr-dsub-${i}" onchange="editCreditRu[${i}].debit_sub=this.value"
          style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px;font-size:12px">${subOp(r.debit_account, r.debit_sub)}</select></div>
      <div></div>
      <div style="grid-column:1/-1"><label style="font-size:11px;color:var(--mu)">摘要テンプレート</label>
        <input value="${(r.memo_template||'').replace(/"/g,'&quot;')}" oninput="editCreditRu[${i}].memo_template=this.value"
          style="width:100%;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font-size:13px"
          placeholder="空欄=加盟店名をそのまま使用"></div>
    </div>
  </div>`).join('');
  editCreditRu.forEach((r, i) => {
    const el = document.getElementById('crpat' + i);
    if (el) el.value = r.pattern || '';
  });
}

function crUpdSub(i) {
  const r = editCreditRu[i];
  const el = document.getElementById('cr-dsub-' + i);
  if (el) { el.innerHTML = subOp(r.debit_account, ''); r.debit_sub = ''; }
}

let crDSrc = -1;
function crDS(e, i) { crDSrc = i; e.dataTransfer.effectAllowed = 'move'; }
function crDD(e, i) {
  e.currentTarget.style.background = '';
  if (crDSrc === i) return;
  const mv = editCreditRu.splice(crDSrc, 1)[0];
  editCreditRu.splice(i, 0, mv);
  rCreditRu();
}

function addCreditRule() {
  editCreditRu.unshift({ name: '新ルール', pattern: '', debit_account: '', debit_sub: '', memo_template: '' });
  rCreditRu();
}

async function saveCreditRules() {
  editCreditRu.forEach((r, i) => r.priority = editCreditRu.length - i);
  await api('POST', '/credit-rules', { rules: editCreditRu });
  toast('クレカ仕訳ルールを保存しました', '#059669');
}

async function applyCreditRules() {
  await saveCreditRules();
  const res = await api('POST', '/apply-credit-rules', {});
  if (res.updated > 0) {
    toast(`${res.updated}件のクレカ仕訳を更新しました`, '#1a56db');
    try { const t = await api('GET', '/transactions'); allTx = t.transactions || []; } catch(e) {}
    await renderCreditEntryList();
  } else {
    toast('未仕訳のクレカ明細はありません', '#64748b');
  }
  await renderCreditEntryList();
}

async function renderCreditEntryList() {
  const el = document.getElementById('credit-entry-list'); if (!el) return;
  // クレカ由来トランザクションを表示
  const creditTxs = (allTx || []).filter(t =>
    t.party === 'ｸﾚｼﾞﾂﾄ ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ' || (t.source_file || '').endsWith('.csv')
  );
  if (!creditTxs.length) {
    el.innerHTML = '<p style="color:var(--mu);font-size:13px">クレカ明細がまだインポートされていません</p>';
    return;
  }
  let html = '';
  for (const tx of creditTxs) {
    const entries = tx.entries || [];
    const unmatched = entries.filter(e => !e.debit_account);
    const statusColor = tx.registered ? '#059669' : '#f59e0b';
    const statusLabel = tx.registered ? '<span class="ei" data-i="checkc"></span>登録済' : `<span class="ei" data-i="hourglass"></span>未仕訳 ${unmatched.length}件`;
    html += `<div style="border:1px solid var(--bd);border-radius:10px;overflow:hidden;margin-bottom:12px">
      <div style="background:#f8fafc;padding:9px 14px;display:flex;justify-content:space-between;align-items:center;font-size:13px">
        <span><strong>${tx.party}</strong> ${tx.date} / ¥${(tx.amount||0).toLocaleString()} / ${entries.length}件</span>
        <span style="color:${statusColor};font-weight:600">${statusLabel}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f1f5f9;color:#64748b">
          <th style="padding:5px 10px;text-align:left">借方科目</th>
          <th style="padding:5px 10px;text-align:left">貸方科目</th>
          <th style="padding:5px 10px;text-align:right">金額</th>
          <th style="padding:5px 10px;text-align:left">摘要（加盟店）</th>
        </tr></thead><tbody>`;
    entries.forEach(e => {
      const missing = !e.debit_account;
      html += `<tr style="border-top:1px solid #f1f5f9;${missing ? 'background:#fef9c3' : ''}">
        <td style="padding:5px 10px">${e.debit_account
          ? `${e.debit_account}${e.debit_sub ? ' <span style="color:#94a3b8">' + e.debit_sub + '</span>' : ''}`
          : '<span style="color:#f59e0b">— 未設定</span>'}</td>
        <td style="padding:5px 10px">${e.credit_account || ''} <span style="color:#94a3b8;font-size:11px">${e.credit_sub || ''}</span></td>
        <td style="padding:5px 10px;text-align:right;font-weight:700">¥${(e.amount||0).toLocaleString()}</td>
        <td style="padding:5px 10px;color:#374151">${e.memo || ''}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  }
  el.innerHTML = html;
}

// Slack OAuth設定 ヘルパー

