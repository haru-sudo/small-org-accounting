// ── ダッシュボード ──
function loadDash(){
  const txs=getRegFyTx(); // 登録済み仕訳のみで残高・収支を集計
  const allFyTxs=getFyTx(); // 未登録件数・リスト用（全件）
  let tIn=0, tOut=0;
  txs.forEach(tx=>{
    (tx.entries||[]).forEach(e=>{
      const amt=parseInt(e.amount||0);
      // 収益は貸方が増加・借方が減少、費用は借方が増加・貸方が減少。
      // 返金や取り消しの戻し仕訳を差し引かないと決算書と数字がずれる。
      if(getAccountType(e.credit_account)==='income')  tIn+=amt;
      if(getAccountType(e.debit_account)==='income')   tIn-=amt;
      if(getAccountType(e.debit_account)==='expense')  tOut+=amt;
      if(getAccountType(e.credit_account)==='expense') tOut-=amt;
    });
  });
  const ur=allFyTxs.filter(t=>!t.registered).length;
  const pv=allFyTxs.filter(t=>txStatus(t)==='prov').length;
  const net=tIn-tOut;
  // 期末残高は決算書と同じく、資産科目（立替金を除く）の期首残高＋増減
  const obRaw=(sts.opening_balances||{})[curFy||document.getElementById('fy-sel').value]||0;
  const obMap=typeof obRaw==='object'?obRaw:{'普通預金':parseInt(obRaw||0)};
  const exAc=balanceExcludedAccounts();
  const isBalAc=ac=>!!ac&&getAccountType(ac)==='assets'&&!exAc.includes(ac);
  let closing=Object.entries(obMap).reduce((s,[k,v])=>s+(isBalAc(String(k).split('/')[0].trim())?parseInt(v||0):0),0);
  txs.forEach(tx=>(tx.entries||[]).forEach(e=>{
    const amt=parseInt(e.amount||0);
    if(isBalAc(e.debit_account))  closing+=amt;
    if(isBalAc(e.credit_account)) closing-=amt;
  }));
  document.getElementById('stats').innerHTML=`
    <div class="stat"><div class="lb">収入合計</div><div class="vl i">¥${tIn.toLocaleString()}</div></div>
    <div class="stat"><div class="lb">支出合計</div><div class="vl e">¥${tOut.toLocaleString()}</div></div>
    <div class="stat"><div class="lb">収支差額</div><div class="vl ${net>=0?'i':'e'}">¥${net.toLocaleString()}</div></div>
    <div class="stat"><div class="lb">期末残高（推計）</div><div class="vl b">¥${closing.toLocaleString()}</div></div>
    <div class="stat"><div class="lb">仕訳未登録</div><div class="vl" style="color:${ur>0?'#f59e0b':'#059669'}">${ur}件</div>${pv?`<div style="font-size:11px;color:#b45309">うち仮登録 ${pv}件</div>`:''}</div>`;
  const unp=allFyTxs.filter(t=>!t.registered).slice(0,10);
  const el=document.getElementById('unreglist');
  if(!unp.length){el.innerHTML='<p style="color:var(--in);font-size:13px"><span class="ei" data-i="checkc"></span>全て登録済み</p>';return;}
  el.innerHTML=`<div class="tbl-wrap"><table><thead><tr><th>日付</th><th>相手先</th><th>金額</th><th>適用ルール</th></tr></thead>
  <tbody>${unp.map(t=>{
    const amt=(t.entries||[]).reduce((s,e)=>s+parseInt(e.amount||0),0);
    return`<tr><td>${escHtml(t.date)}</td><td>${escHtml(t.party||'')}</td><td>¥${amt.toLocaleString()}</td>
    <td>${txStatus(t)==='prov'?'<span class="badge" style="background:#fffbeb;color:#b45309;border:1px solid #fcd34d">仮登録</span> ':''}${t.auto_rule&&t.auto_rule!=='AIアシスタント'?`<span class="badge bau">${escHtml(t.auto_rule)}</span>`:(txStatus(t)==='prov'?'':'-')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// ── 決算書 ──
// 期末残高に入れない資産科目（core/accounting.php の balanceExcludedAccounts と同じ）
function balanceExcludedAccounts(){
  const out=['立替金'];
  const adv=String((typeof sts!=='undefined'&&sts&&sts.advance_debit)||'').trim();
  if(adv&&!out.includes(adv)) out.push(adv);
  return out;
}
// 会計年度の月（設定の開始月から並べる。4月始まりなら「4月」…「3月」）
function fyMonthList(){
  const st=parseInt((typeof sts!=='undefined'&&sts&&sts.fiscal_year_start)||4,10);
  const s0=st>=1&&st<=12?st:4;
  return Array.from({length:12},(_,i)=>((s0-1+i)%12+1)+'月');
}
// 決算書の列（月・上半期・下半期・年度合計）
function fyKessanCols(){ const m=fyMonthList(); return [...m.slice(0,6),'上半期',...m.slice(6),'下半期','年度合計']; }

// 表示可能な列（閲覧専用ユーザーのみ制限される）
let ksVisibleCols=null;   // null = 全列表示
let ksPubMonths=[];       // 公開中の月
let ksAdvBal=null;        // 各月末の立替金残高（期末残高には含めない。PDF の注釈用）

async function loadK(){
  const yr=document.getElementById('ks-yr').value;if(!yr)return;
  const d=await api('GET','/kessan?year='+yr);
  ksPubMonths=d.published_months||[];
  ksVisibleCols=d.visible_cols||null;
  ksAdvBal=d.advance_balance||null;
  renderKsPub();
  renderK(d);
}

// 公開設定パネル（管理者のみ）／閲覧専用への案内
function renderKsPub(){
  const panel=document.getElementById('ks-pub');
  const note=document.getElementById('ks-viewer-note');
  const dl=document.getElementById('ks-dl');
  if(!panel||!note)return;

  if(isAdminUser()){
    panel.style.display='';
    note.style.display='none';
    document.getElementById('ks-pub-months').innerHTML=fyMonthList().map(m=>{
      const on=ksPubMonths.includes(m);
      return`<label style="display:inline-flex;align-items:center;gap:4px;border:1px solid ${on?'#86efac':'var(--bd)'};background:${on?'#f0fdf4':'#fff'};border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer;user-select:none">
        <input type="checkbox" ${on?'checked':''} onchange="toggleKsPub('${m}',this.checked)" style="margin:0">${m}</label>`;
    }).join('');
    return;
  }

  // 閲覧専用
  panel.style.display='none';
  note.style.display='';
  const shown=ksPubMonths.length;
  note.innerHTML = shown
    ? `公開されている月のみ表示しています（${ksPubMonths.join('・')}）。ほかの月は会計担当者が公開すると表示されます。`
    : `この年度はまだ公開されていません。会計担当者が公開するまでお待ちください。`;
  // PDF は表示中の（公開された月の）表をそのまま出すので、1か月でも公開されていれば出力できる。
  // Excel はサーバーが全月公開の年度しか出さないため、dlK() で全月公開のときだけ選べるようにする。
  if(dl) dl.style.display = shown ? '' : 'none';
}

function toggleKsPub(m,on){
  if(on){ if(!ksPubMonths.includes(m)) ksPubMonths.push(m); }
  else  { ksPubMonths=ksPubMonths.filter(x=>x!==m); }
  renderKsPub();
}
function ksPubAll(on){ ksPubMonths = on?[...fyMonthList()]:[]; renderKsPub(); }

async function saveKsPub(){
  const yr=document.getElementById('ks-yr').value;if(!yr)return;
  const ordered=fyMonthList().filter(m=>ksPubMonths.includes(m));
  const r=await api('POST','/kessan/published',{year:yr,months:ordered});
  if(r&&r.error){toast(''+r.error,'#dc2626');return;}
  ksPubMonths=r.months||ordered;
  renderKsPub();
  toast(ksPubMonths.length?`${ksPubMonths.length}か月を公開しました`:'公開を解除しました','#059669');
}

function renderK(d){
  const sk=document.getElementById('kwrap-sk');
  if(!d||!d.sections){
    document.getElementById('kwrap').innerHTML='<p style="padding:20px;color:var(--mu)">データなし</p>';
    if(sk)sk.innerHTML='';
    return;
  }
  document.getElementById('kwrap').innerHTML=ksTable(d,'期末残高',true);
  // 本表の下に、設定で選んだ勘定科目だけの別表（設定が空なら出さない）
  const skw=document.getElementById('kwrap-sk-wrap');
  if(sk)sk.innerHTML=d.sub_report?ksTable(d.sub_report,'収支累計'):'';
  if(skw)skw.style.display=d.sub_report?'':'none';
  const skt=document.getElementById('kwrap-sk-title');
  if(skt)skt.textContent=d.sub_report_title||'別表';
}
function ksTable(d,balLabel,showOpening){
  const yr=document.getElementById('ks-yr').value;
  const vis=m=>!ksVisibleCols||ksVisibleCols.includes(m);
  const HCELL='<td style="color:#e2e8f0;background:#fafafa" title="未公開">—</td>';
  let h=`<table class="kt"><thead><tr><th colspan="2">科目</th>${fyKessanCols().map(m=>
    vis(m)?`<th>${m}</th>`:`<th style="color:#cbd5e1;font-weight:400" title="未公開">—</th>`).join('')}</tr></thead><tbody>`;
  // 本表の先頭に前期繰越（年度の開始残高）を出す
  if(showOpening) h+=`<tr class="kob"><td colspan="2">前期繰越　開始残高：${(d.opening_balance||0).toLocaleString()}</td><td colspan="${fyKessanCols().length}"></td></tr>`;
  d.sections.forEach(sec=>{
    h+=`<tr class="ks"><td colspan="${fyKessanCols().length+2}">${sec.name}</td></tr>`;
    sec.groups.forEach(g=>{
      if(g.sub&&g.sub.length){
        // 親科目行もクリック可能に（sub指定なしで配下の全sub合計を表示）
        h+=`<tr class="ksh"><td></td><td>${g.code} ${g.name}</td>${fyKessanCols().map(m=>{
          if(!vis(m)) return HCELL;
          const v=g.sub_total[m]||0;
          return`<td class="${v?'cl':''}" onclick="${v?`showD('${escJsAttr(g.name)}','','${m}','${yr}')`:''}">${v?v.toLocaleString():''}</td>`;
        }).join('')}</tr>`;
        g.sub.forEach(s=>{
          h+=`<tr><td></td><td style="padding-left:20px">${escHtml(s.code)} ${escHtml(s.name)}</td>${fyKessanCols().map(m=>{
            if(!vis(m)) return HCELL;
            const v=s.monthly[m]||0;
            return`<td class="${v?'cl':''}" onclick="${v?`showD('${escJsAttr(g.name)}','${escJsAttr(s.name)}','${m}','${yr}')`:''}">${v?v.toLocaleString():'-'}</td>`;
          }).join('')}</tr>`;
        });
        h+=`<tr class="kst"><td></td><td>${g.name}小計</td>${fyKessanCols().map(m=>{
          if(!vis(m)) return HCELL;
          const v=g.sub_total[m]||0;
          return`<td class="${v?'cl':''}" onclick="${v?`showD('${escJsAttr(g.name)}','','${m}','${yr}')`:''}">${v?v.toLocaleString():'-'}</td>`;
        }).join('')}</tr>`;
      }else{
        h+=`<tr><td></td><td>${g.code} ${g.name}</td>${fyKessanCols().map(m=>{
          if(!vis(m)) return HCELL;
          const v=g.monthly[m]||0;
          return`<td class="${v?'cl':''}" onclick="${v?`showD('${escJsAttr(g.name)}','','${m}','${yr}')`:''}">${v?v.toLocaleString():'-'}</td>`;
        }).join('')}</tr>`;
      }
    });
    h+=`<tr class="ktt"><td colspan="2">${sec.name}合計</td>${fyKessanCols().map(m=>{
      if(!vis(m)) return HCELL;
      const v=sec.total[m]||0;
      return`<td>${v.toLocaleString()}</td>`;
    }).join('')}</tr>`;
  });
  h+=`<tr class="knet"><td colspan="2">収支差額</td>${fyKessanCols().map(m=>vis(m)?`<td>${(d.net[m]||0).toLocaleString()}</td>`:HCELL).join('')}</tr>`;
  // 期末残高の内訳（口座・現金ごとの月末残高。立替金は含めない）
  const bd=d.balance_breakdown||[];
  if(bd.length>1){
    h+=`<tr class="ks"><td colspan="${fyKessanCols().length+2}">期末残高の内訳</td></tr>`;
    bd.forEach(r=>{
      h+=`<tr class="kbd"><td></td><td style="padding-left:20px">${escHtml(r.name)}</td>${fyKessanCols().map(m=>vis(m)?`<td>${(r.monthly[m]||0).toLocaleString()}</td>`:HCELL).join('')}</tr>`;
    });
  }
  h+=`<tr class="kbal"><td colspan="2">${balLabel}</td>${fyKessanCols().map(m=>vis(m)?`<td>¥${(d.monthly_balance[m]||0).toLocaleString()}</td>`:HCELL).join('')}</tr>`;
  h+='</tbody></table>';
  return h;
}
async function showD(name,sub,month,year){
  let url=`/kessan/detail?name=${encodeURIComponent(name)}&month=${encodeURIComponent(month)}&year=${year}`;
  if(sub)url+=`&sub=${encodeURIComponent(sub)}`;
  const r=await api('GET',url);
  mTx=r.transactions||[];
  mTitle=sub?`${name}/${sub} — ${month}`:`${name} — ${month}`;
  document.getElementById('mtitle').textContent=mTitle;
  document.getElementById('mbody').innerHTML=!mTx.length?'<p style="color:var(--mu)">データなし</p>'
    :`<div class="tbl-wrap"><table><thead><tr><th>日付</th><th>相手先</th><th>相手科目</th><th style="text-align:right">金額</th><th>摘要</th></tr></thead>
     <tbody>${mTx.map(t=>{const amt=(t.debit_amt||0)+(t.credit_amt||0);return`<tr><td>${escHtml(t.date)}</td><td>${escHtml(t.party||'')}</td><td>${escHtml(t.counter||'')}</td>
       <td style="text-align:right;font-weight:600">¥${amt.toLocaleString()}</td>
       <td>${escHtml(t.memo||'')}</td></tr>`;}).join('')}</tbody></table></div>`;
  const ov=document.getElementById('detov');
  ov.style.zIndex='1050';
  ov.classList.add('open');
}
function closeM(){
  const ov=document.getElementById('detov');
  ov.classList.remove('open');
  setTimeout(()=>ov.style.zIndex='',300);
}

// ── 汎用エクスポート選択ダイアログ ──
function showExportDialog(title, onExcel, onPDF){
  document.getElementById('exp-dialog-title').textContent=title;
  document.getElementById('exp-dialog').style.display='flex';
  window._expOnExcel=onExcel;
  window._expOnPDF=onPDF;
}
function closeExportDialog(){document.getElementById('exp-dialog').style.display='none';}
function doExportExcel(){closeExportDialog();window._expOnExcel&&window._expOnExcel();}
function doExportPDF(){closeExportDialog();window._expOnPDF&&window._expOnPDF();}

// ── 決算書エクスポート ──
async function dlK(){
  // 閲覧専用で全月が公開されていない年度は Excel を出せないので、PDF だけ出す
  if(!isAdminUser() && ksPubMonths.length<fyMonthList().length){ dlKPDF(); return; }
  showExportDialog('決算書のエクスポート',
    async()=>{
      const yr=document.getElementById('ks-yr').value;
      const base=window.location.pathname.replace(/\/$/,'');
      const r=await fetch(base+'/api/export/kessan?year='+yr);
      dlB(await r.blob(),yr+'年度決算書.xlsx');
    },
    ()=>dlKPDF()
  );
}
// PDF の注釈: 期末残高に含めていない立替金（まだ精算されていない立替）の額。
// 年度合計が見えていればその時点、見えていなければ表示中の最後の月末の残高を書く。
function ksAdvNote(){
  if(!ksAdvBal) return '';
  const vis=m=>!ksVisibleCols||ksVisibleCols.includes(m);
  const col=vis('年度合計') ? '年度合計' : [...fyMonthList()].reverse().find(m=>vis(m)&&m in ksAdvBal);
  if(!col || !(col in ksAdvBal) || !ksAdvBal[col]) return '';
  const when=col==='年度合計' ? '年度末' : `${col}末`;
  return `<p style="margin:12px 0 0;font-size:10px;color:#475569">※ 期末残高には立替金 ¥${(ksAdvBal[col]||0).toLocaleString()}（${when}時点・未精算の立替）を含みません。</p>`;
}
function dlKPDF(){
  const yr=document.getElementById('ks-yr').value;
  const el=document.getElementById('kwrap');
  if(!el)return;
  const sk=document.getElementById('kwrap-sk');
  const html=`<div style="padding:20px;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif;font-size:10px">
    <h2 style="margin:0 0 12px;font-size:16px">${yr}年度 決算書</h2>
    ${el.outerHTML}
    ${sk&&sk.innerHTML?`<h2 style="margin:20px 0 12px;font-size:16px">${yr}年度 ${escHtml(document.getElementById('kwrap-sk-title')?.textContent||'別表')}</h2>${sk.outerHTML}`:''}
    ${ksAdvNote()}
  </div>`;
  html2pdf().set({margin:6,filename:`${yr}年度決算書.pdf`,html2canvas:{scale:1.5},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(html).save();
}

// 決算書詳細エクスポート
async function dlDet(){
  showExportDialog('詳細データのエクスポート',
    async()=>{
      const base=window.location.pathname.replace(/\/$/,'');
      const r=await fetch(base+'/api/export/detail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactions:mTx,title:mTitle})});
      dlB(await r.blob(),mTitle.replace(/[\/\\]/g,'-')+'.xlsx');
    },
    ()=>{
      const rows=mTx.map(t=>{const amt=(t.debit_amt||0)+(t.credit_amt||0);return`<tr><td>${escHtml(t.date)}</td><td>${escHtml(t.party||'')}</td><td>${escHtml(t.counter||'')}</td>
        <td style="text-align:right">¥${amt.toLocaleString()}</td>
        <td>${escHtml(t.memo||'')}</td></tr>`;}).join('');
      const html=`<div style="padding:16px;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif;font-size:11px">
        <h3 style="margin:0 0 10px">${mTitle}</h3>
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:10px">
          <thead style="background:#1e293b;color:#fff"><tr><th>日付</th><th>相手先</th><th>相手科目</th><th>金額</th><th>摘要</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
      html2pdf().set({margin:8,filename:mTitle.replace(/[\/\\]/g,'-')+'.pdf',html2canvas:{scale:1.5},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}}).from(html).save();
    }
  );
}

// ── 統合帳簿（総勘定元帳 + 月次仕訳日記帳） ──
function initLedger(){
  updAcF();popFy();
  // タブ状態を復元、デフォルトは元帳
  const cur=document.getElementById('ledger-tab-ld')?.classList.contains('active');
  if(!cur) ledgerTab('ld');
  else loadLd();
}

function ledgerTab(t){
  ['ld','mo'].forEach(x=>{
    const p=document.getElementById('ledger-pane-'+x);if(p)p.style.display=x===t?'':'none';
    const b=document.getElementById('ledger-tab-'+x);if(b)b.classList.toggle('active',x===t);
  });
  if(t==='ld') loadLd();
  if(t==='mo') loadMonthly();
}

// 総勘定元帳
function loadLd(){
  const ac=document.getElementById('ld-ac').value;
  const yr=document.getElementById('ld-yr').value;
  if(!ac){document.getElementById('ldbody').innerHTML='<p style="color:var(--mu);padding:16px">科目を選択してください</p>';return;}
  const fs=sts.fiscal_year_start||4;
  const acType=getAccountType(ac);
  const isDebitInc=DEBIT_INCREASE.has(acType);
  const txs=allTx.filter(tx=>{
    if(!tx.date)return false;
    if(!tx.registered)return false;
    const[y,m]=tx.date.split('/').map(Number);
    const fy=m>=fs?y:y-1;
    if(fy!==parseInt(yr))return false;
    return(tx.entries||[]).some(e=>e.debit_account===ac||e.credit_account===ac);
  }).sort((a,b)=>(a.date||'').localeCompare(b.date||''));

  const obRaw=(sts.opening_balances||{})[yr]||0;
  const obMap=typeof obRaw==='object'?obRaw:{'普通預金':parseInt(obRaw||0)};
  // キーが "科目名 / 補助名" 形式のため前方一致で合算
  let ob=0;
  Object.entries(obMap).forEach(([k,v])=>{
    if(k===ac||k.startsWith(ac+' /')||k.startsWith(ac+'/')) ob+=parseInt(v||0);
  });
  let run=ob;
  const rows=[];
  txs.forEach(tx=>{
    (tx.entries||[]).forEach(e=>{
      const amt=parseInt(e.amount||0);
      const isDr=e.debit_account===ac;
      const isCr=e.credit_account===ac;
      if(!isDr&&!isCr)return;
      const dr=isDr?amt:0;
      const cr=isCr?amt:0;
      if(isDebitInc){run+=dr-cr;}else{run+=cr-dr;}
      const counter=isDr?e.credit_account:e.debit_account;
      rows.push(`<tr><td>${escHtml(tx.date)}</td><td>${escHtml(counter||'')}</td><td>${escHtml(tx.party||'')}</td><td>${escHtml(e.memo||tx.memo||'')}</td>
        <td style="text-align:right;font-weight:600">¥${amt.toLocaleString()}</td>
        <td style="text-align:right;font-weight:600">¥${run.toLocaleString()}</td></tr>`);
    });
  });
  document.getElementById('ldbody').innerHTML=
    `<tr style="background:#f1f5f9;font-weight:600"><td colspan="5">期首残高</td><td style="text-align:right">¥${ob.toLocaleString()}</td></tr>`
    +rows.join('');
}

async function expLedger(){
  const ac=document.getElementById('ld-ac').value;
  const yr=document.getElementById('ld-yr').value;
  if(!ac){toast('科目を選択してください','#f59e0b');return;}
  showExportDialog('総勘定元帳のエクスポート',
    async()=>{
      const base=window.location.pathname.replace(/\/$/,'');
      const r=await fetch(base+'/api/export/ledger',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({account:ac,year:yr})});
      if(r.ok) dlB(await r.blob(),`総勘定元帳_${ac}_${yr}年度.xlsx`);
      else {
        // APIがなければクライアント側でCSV生成
        const rows=[['日付','相手科目','相手先','摘要','借方','貸方','残高']];
        document.querySelectorAll('#ldbody tr').forEach(tr=>{
          rows.push([...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
        });
        const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
        dlB(new Blob(['\uFEFF'+csv],{type:'text/csv'}),`総勘定元帳_${ac}_${yr}年度.csv`);
      }
    },
    ()=>{
      const ac2=document.getElementById('ld-ac').value;
      const yr2=document.getElementById('ld-yr').value;
      const table=document.getElementById('ldbody')?.closest('table');
      if(!table)return;
      const html=`<div style="padding:16px;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif">
        <h3 style="margin:0 0 10px;font-size:14px">総勘定元帳 — ${ac2} (${yr2}年度)</h3>
        ${table.outerHTML}
      </div>`;
      html2pdf().set({margin:8,filename:`総勘定元帳_${ac2}_${yr2}年度.pdf`,html2canvas:{scale:1.5},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(html).save();
    }
  );
}

// 月次仕訳日記帳
function loadMonthly(){
  popFy();
  const yr=document.getElementById('ml-yr')?document.getElementById('ml-yr').value:'';
  const mo=document.getElementById('ml-mo')?document.getElementById('ml-mo').value:'';
  const byAccount=document.getElementById('ml-by-account')?.checked;
  const fs=sts.fiscal_year_start||4;
  let txs=[...allTx];
  if(yr)txs=txs.filter(tx=>{if(!tx.date)return false;const[y,m]=tx.date.split('/').map(Number);return(m>=fs?y:y-1)===parseInt(yr);});
  if(mo)txs=txs.filter(t=>parseInt((t.date||'').split('/')[1])===parseInt(mo));
  txs=txs.filter(t=>t.registered); // 登録済みのみ表示
  txs.sort((a,b)=>(a.date||'').localeCompare(b.date||''));

  const el=document.getElementById('ml-content');
  if(!el)return;

  if(byAccount){
    const summary={};
    txs.forEach(tx=>{
      (tx.entries||[]).forEach(e=>{
        const amt=parseInt(e.amount||0);if(!amt)return;
        const da=e.debit_account||'';
        const ca=e.credit_account||'';
        if(da){
          if(!summary[da])summary[da]={total:0,rows:[]};
          summary[da].total+=amt;
          summary[da].rows.push({date:tx.date,party:tx.party,counter:ca,amount:amt,memo:e.memo||tx.memo||''});
        }
        if(ca){
          if(!summary[ca])summary[ca]={total:0,rows:[]};
          summary[ca].total+=amt;
          summary[ca].rows.push({date:tx.date,party:tx.party,counter:da,amount:amt,memo:e.memo||tx.memo||''});
        }
      });
    });
    let html='';
    const allAccts=[];
    for(const tp of ['assets','liabilities','equity','income','expense']){
      (allAc[tp]||[]).forEach(a=>allAccts.push(a.name));
    }
    const sortedNames=[...new Set([...allAccts,...Object.keys(summary)])];
    sortedNames.forEach(name=>{
      const s=summary[name];if(!s)return;
      html+=`<div class="card" style="padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <strong style="font-size:13px">${escHtml(name)}</strong>
          <span style="font-size:12px;color:var(--mu)">合計金額: ¥${s.total.toLocaleString()}</span>
        </div>
        <div class="tbl-wrap"><table><thead><tr><th>日付</th><th>相手先</th><th>相手科目</th><th style="text-align:right">金額</th><th>摘要</th></tr></thead>
        <tbody>${s.rows.map(r=>`<tr><td>${escHtml(r.date)}</td><td>${escHtml(r.party||'')}</td><td>${escHtml(r.counter||'')}</td>
          <td style="text-align:right;font-weight:600">¥${r.amount.toLocaleString()}</td>
          <td>${escHtml(r.memo||'')}</td></tr>`).join('')}</tbody></table></div>
      </div>`;
    });
    el.innerHTML=html||'<p style="color:var(--mu)">データなし</p>';
  }else{
    let total=0;
    const rows=[];
    txs.forEach(tx=>{
      (tx.entries||[]).forEach(e=>{
        const amt=parseInt(e.amount||0);
        total+=amt;
        rows.push(`<tr><td>${escHtml(tx.date)}</td><td>${escHtml(tx.party||'')}</td>
          <td>${escHtml(e.debit_account||'')}</td><td>${escHtml(e.debit_sub||'')}</td>
          <td>${escHtml(e.credit_account||'')}</td><td>${escHtml(e.credit_sub||'')}</td>
          <td style="text-align:right;font-weight:600">¥${amt.toLocaleString()}</td>
          <td>${escHtml(e.memo||tx.memo||'')}</td></tr>`);
      });
    });
    el.innerHTML=`<div class="tbl-wrap"><table><thead><tr>
      <th>日付</th><th>相手先</th><th>借方科目</th><th>借方補助</th><th>貸方科目</th><th>貸方補助</th><th style="text-align:right">金額</th><th>摘要</th>
    </tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div style="text-align:right;margin-top:8px;font-size:13px;font-weight:600">
      ${txs.length}件 / 合計金額: <span style="color:var(--p)">¥${total.toLocaleString()}</span>
    </div>`;
  }
}

async function expMonthly(){
  const yr=document.getElementById('ml-yr').value;
  const mo=document.getElementById('ml-mo').value;
  const byAccount=document.getElementById('ml-by-account')?.checked;
  showExportDialog('月次仕訳日記帳のエクスポート',
    async()=>{
      const base=window.location.pathname.replace(/\/$/,'');
      const r=await fetch(base+'/api/export/monthly',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({year:yr,month:mo,by_account:byAccount})});
      dlB(await r.blob(),`月次仕訳日記帳_${yr}年度${mo?'_'+mo+'月':''}.xlsx`);
    },
    ()=>{
      const el=document.getElementById('ml-content');
      if(!el)return;
      const label=`${yr}年度${mo?mo+'月':'全月'}`;
      const html=`<div style="padding:16px;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif;font-size:10px">
        <h3 style="margin:0 0 10px;font-size:14px">月次仕訳日記帳 — ${label}</h3>
        ${el.innerHTML}
      </div>`;
      html2pdf().set({margin:8,filename:`月次仕訳日記帳_${yr}年度${mo?'_'+mo+'月':''}.pdf`,html2canvas:{scale:1.5},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(html).save();
    }
  );
}

// ── 資産・残高 ──
function loadAssets(){
  const fy=curFy||document.getElementById('fy-sel').value;
  const fs=sts.fiscal_year_start||4;
  const fyTxs=allTx.filter(tx=>{
    if(!tx.date)return false;
    if(!tx.registered)return false; // 登録済みのみ
    const[y,m]=tx.date.split('/').map(Number);
    return(m>=fs?y:y-1)===parseInt(fy);
  });
  const obRaw=(sts.opening_balances||{})[fy]||0;
  const obMap=typeof obRaw==='object'?obRaw:{'普通預金':parseInt(obRaw||0)};
  const assets=allAc.assets||[];
  let html='<div class="ab-grid">';
  assets.forEach(ac=>{
    // 期首残高：DBのキーは "科目名 / 補助科目名" 形式のため前方一致で合算
    let balance=0;
    Object.entries(obMap).forEach(([k,v])=>{
      if(k===ac.name||k.startsWith(ac.name+' /')||k.startsWith(ac.name+'/'))
        balance+=parseInt(v||0);
    });
    fyTxs.forEach(tx=>{
      (tx.entries||[]).forEach(e=>{
        const amt=parseInt(e.amount||0);
        if(e.debit_account===ac.name) balance+=amt;
        if(e.credit_account===ac.name) balance-=amt;
      });
    });
    let subHtml='';
    if(ac.sub&&ac.sub.length){
      subHtml='<div class="sub-list">';
      ac.sub.forEach(s=>{
        // 補助科目の期首残高：キー "科目名 / 補助名" または "科目名/補助名"
        const obKey1=`${ac.name} / ${s.name}`;
        const obKey2=`${ac.name}/${s.name}`;
        let sv=parseInt(obMap[obKey1]||obMap[obKey2]||0);
        fyTxs.forEach(tx=>{(tx.entries||[]).forEach(e=>{
          const amt=parseInt(e.amount||0);
          if(e.debit_account===ac.name&&e.debit_sub===s.name) sv+=amt;
          if(e.credit_account===ac.name&&e.credit_sub===s.name) sv-=amt;
        });});
        subHtml+=`<div class="sub-row"><span>${escHtml(s.name)}</span><span>¥${sv.toLocaleString()}</span></div>`;
      });
      subHtml+='</div>';
    }
    html+=`<div class="ab-card">
      <div class="name">${ac.code} ${ac.name}</div>
      <div class="amount" style="color:${balance>=0?'var(--p)':'var(--ex)'}">¥${balance.toLocaleString()}</div>
      ${subHtml}
    </div>`;
  });
  html+='</div>';
  document.getElementById('ab-wrap').innerHTML=html;
  loadMonthlyBalance();
}

// ── 月別 現金・預金残高（各月末の残高推移）──
let mbData = null;   // CSV出力用に直近の計算結果を保持

// 会計年度の月並び（例: 4月開始 → [4,5,...,3]）
function _mbMonths(fs){
  const ms=[];
  for(let i=0;i<12;i++) ms.push(((fs-1+i)%12)+1);
  return ms;
}

// 期首残高の取得。sub 未指定なら補助科目分も合算（キーは "科目 / 補助" 形式）
function _mbOpening(obMap, acName, sub){
  let v=0;
  Object.entries(obMap||{}).forEach(([k,val])=>{
    const key=String(k).replace(/\s*\/\s*/g,'/');
    if(sub==null){ if(key===acName||key.startsWith(acName+'/')) v+=parseInt(val||0); }
    else         { if(key===acName+'/'+sub) v+=parseInt(val||0); }
  });
  return v;
}

// 月ごとの増減（資産なので 借方＋ / 貸方−）
function _mbDeltas(txs, months, acName, sub){
  const idx={}; months.forEach((m,i)=>idx[m]=i);
  const d=new Array(12).fill(0);
  txs.forEach(tx=>{
    const m=parseInt((tx.date||'').split('/')[1]);
    const i=idx[m]; if(i===undefined) return;
    (tx.entries||[]).forEach(e=>{
      const amt=parseInt(e.amount||0); if(!amt) return;
      if(e.debit_account===acName  && (sub==null||(e.debit_sub||'')===sub))  d[i]+=amt;
      if(e.credit_account===acName && (sub==null||(e.credit_sub||'')===sub)) d[i]-=amt;
    });
  });
  return d;
}

function loadMonthlyBalance(){
  const el=document.getElementById('mb-wrap');
  if(!el) return;
  const fy=parseInt(curFy||document.getElementById('fy-sel').value);
  const fs=sts.fiscal_year_start||4;
  const months=_mbMonths(fs);
  const showAll=!!document.getElementById('mb-all')?.checked;
  const showSub=!!document.getElementById('mb-sub')?.checked;

  // 対象年度の登録済み仕訳のみ
  const txs=allTx.filter(tx=>{
    if(!tx.date||!tx.registered) return false;
    const[y,m]=tx.date.split('/').map(Number);
    return (m>=fs?y:y-1)===fy;
  });

  const obRaw=(sts.opening_balances||{})[fy]||0;
  const obMap=typeof obRaw==='object'?obRaw:{'普通預金':parseInt(obRaw||0)};
  const assets=allAc.assets||[];
  const isCash=a=>/現金|預金/.test(a.name||'');
  const targets=showAll?assets:assets.filter(isCash);

  if(!targets.length){
    el.innerHTML='<p style="color:var(--mu);font-size:13px">対象の資産科目がありません。勘定科目に「現金」「預金」を含む科目を登録してください。</p>';
    mbData=null; return;
  }

  const rows=[];              // {label, indent, opening, deltas[], balances[], strong}
  const totalDeltas=new Array(12).fill(0);
  let totalOpening=0;

  targets.forEach(ac=>{
    const op=_mbOpening(obMap, ac.name, null);
    const dl=_mbDeltas(txs, months, ac.name, null);
    rows.push({label:`${ac.code} ${ac.name}`, indent:0, opening:op, deltas:dl, strong:true});
    totalOpening+=op;
    dl.forEach((v,i)=>totalDeltas[i]+=v);

    if(showSub && (ac.sub||[]).length){
      ac.sub.forEach(s=>{
        rows.push({
          label:s.name, indent:1,
          opening:_mbOpening(obMap, ac.name, s.name),
          deltas:_mbDeltas(txs, months, ac.name, s.name),
        });
      });
      // 補助科目が付いていない分（あれば）
      const noSub=_mbDeltas(txs, months, ac.name, '');
      if(noSub.some(v=>v!==0)) rows.push({label:'（補助科目なし）', indent:1, opening:0, deltas:noSub});
    }
  });

  if(targets.length>1){
    rows.push({label:showAll?'資産合計':'現金・預金 合計', indent:0, opening:totalOpening, deltas:totalDeltas, total:true});
  }

  // 累計 → 各月末残高
  rows.forEach(r=>{
    let run=r.opening; r.balances=r.deltas.map(v=>run+=v);
  });

  mbData={fy, months, rows};

  const yen=v=>'¥'+(v||0).toLocaleString();
  const delta=v=>v===0?'<span style="color:#cbd5e1">±0</span>'
    :`<span style="color:${v>0?'var(--in)':'var(--ex)'}">${v>0?'+':''}${v.toLocaleString()}</span>`;

  el.innerHTML=`<div class="tbl-wrap"><table>
    <thead><tr><th style="min-width:150px">科目</th><th style="text-align:right">期首</th>
      ${months.map(m=>`<th style="text-align:right">${m}月</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr${r.total?' style="background:#f1f5f9;font-weight:700"':''}>
      <td style="padding-left:${8+r.indent*16}px${r.strong?';font-weight:600':''}">${r.label}</td>
      <td style="text-align:right;color:var(--mu)">${yen(r.opening)}</td>
      ${r.balances.map((b,i)=>`<td style="text-align:right;white-space:nowrap">
        <div style="font-weight:600;color:${b<0?'var(--ex)':'inherit'}">${yen(b)}</div>
        <div style="font-size:11px">${delta(r.deltas[i])}</div>
      </td>`).join('')}
    </tr>`).join('')}</tbody></table></div>
  <p style="font-size:11px;color:var(--mu);margin-top:8px">※ 未登録の仕訳は含みません。期首残高は「設定 › 期首残高設定」の値を使用します。</p>`;
}

function expMonthlyBalance(){
  if(!mbData){ toast('データがありません','#f59e0b'); return; }
  const {fy, months, rows}=mbData;
  const head=['科目','区分','期首',...months.map(m=>m+'月')];
  const lines=[head];
  rows.forEach(r=>{
    const name='  '.repeat(r.indent)+r.label;
    lines.push([name,'月末残高',r.opening,...r.balances]);
    lines.push([name,'増減','',...r.deltas]);
  });
  const csv=lines.map(l=>l.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  dlB(new Blob(['\uFEFF'+csv],{type:'text/csv'}), `月別残高_${fy}年度.csv`);
}
