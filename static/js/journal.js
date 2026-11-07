function _txLabel(tx){
  if(!tx) return '取引';
  const parts=['取引'];
  if(tx.date) parts.push(tx.date);
  if(tx.party) parts.push(`「${tx.party}」`);
  const amt = Math.max(tx.debit||0, tx.credit||0, tx.bank_debit||0, tx.bank_credit||0, tx.amount||0,
    ...((tx.entries||[]).map(e=>parseInt(e.amount||0))));
  if(amt) parts.push('¥'+Number(amt).toLocaleString());
  return parts.join(' ');
}
// 取引の編集前後を比較して変更点の説明を返す
function _txDiff(before, after){
  const ch=[];
  const yen=v=>'¥'+Number(v||0).toLocaleString();
  if(before){
    if((before.date||'')!==(after.date||'')) ch.push(`日付 ${before.date||'(空)'} → ${after.date||'(空)'}`);
    if((before.party||'')!==(after.party||'')) ch.push(`取引先 「${before.party||'(空)'}」→「${after.party||'(空)'}」`);
    if((before.type||'')!==(after.type||'')) ch.push(`種別 ${before.type||'(空)'} → ${after.type||'(空)'}`);
    const dl={in:'入金',out:'出金'};
    if(after.direction && txDirection(before)!==after.direction) ch.push(`種別 ${dl[txDirection(before)]||'(空)'} → ${dl[after.direction]}`);
    const bAmt=Math.max(...((before.entries||[]).map(e=>parseInt(e.amount||0))),0);
    const aAmt=Math.max(...((after.entries||[]).map(e=>parseInt(e.amount||0))),0);
    if(bAmt!==aAmt) ch.push(`金額 ${yen(bAmt)} → ${yen(aAmt)}`);
    // 勘定科目（最初の行の借方・貸方）
    const bE=(before.entries||[])[0]||{}, aE=(after.entries||[])[0]||{};
    if((bE.debit_account||'')!==(aE.debit_account||'')) ch.push(`借方 ${bE.debit_account||'(空)'} → ${aE.debit_account||'(空)'}`);
    if((bE.credit_account||'')!==(aE.credit_account||'')) ch.push(`貸方 ${bE.credit_account||'(空)'} → ${aE.credit_account||'(空)'}`);
    if((before.memo||'')!==(after.memo||'')) ch.push('メモを変更');
    const bSt=txStatus(before), aSt=txStatus(after);
    if(bSt!==aSt) ch.push({reg:'仕訳登録済みにマーク',prov:'仮登録にする',unreg:'未登録に戻す'}[aSt]);
  }
  return ch;
}
// ── 金額検索 ────────────────────────────────────────────────────────────────
// 検索ボックスは空白区切りのトークンをすべて満たす行を返す（AND）。
// 各トークンは金額条件か、従来どおりの文字列検索として扱う。
//   1000        … 金額 1000、または金額の数字に "1000" を含む（例: 10000, 21000）
//   =1000       … 金額 1000 ちょうど
//   >1000 >=1000 <1000 <=1000
//   1000-5000   … 1000〜5000 の範囲
// ¥・カンマ・「円」は無視するので "¥934,652" のように貼り付けても検索できる。

// 取引が持つ金額の候補（取引金額＋各明細の金額）
function _txAmounts(tx){
  const list=[];
  const head=Math.max(tx.debit||0, tx.credit||0, tx.bank_debit||0, tx.bank_credit||0, tx.amount||0);
  if(head>0) list.push(head);
  (tx.entries||[]).forEach(e=>{
    const a=parseInt(e.amount||0);
    if(a>0) list.push(a);
  });
  return list;
}

function _normNum(s){
  const t=String(s).replace(/[¥￥,、\s円]/g,'')
    .replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  return /^\d+$/.test(t) ? parseInt(t,10) : null;
}

// 金額条件として解釈できればマッチ関数を返す。数値でなければ null。
function parseAmountQuery(token){
  const t=String(token).trim().replace(/[＞>]/g,'>').replace(/[＜<]/g,'<').replace(/[＝=]/g,'=');
  if(!t) return null;

  let m=t.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if(m){
    const n=_normNum(m[2]);
    if(n===null) return null;
    const op=m[1];
    return v=> op==='>=' ? v>=n : op==='<=' ? v<=n : op==='>' ? v>n : op==='<' ? v<n : v===n;
  }

  m=t.match(/^(.+?)\s*[-〜~]\s*(.+)$/);
  if(m){
    const lo=_normNum(m[1]), hi=_normNum(m[2]);
    if(lo===null||hi===null) return null;
    const [a,b]=lo<=hi?[lo,hi]:[hi,lo];
    return v=> v>=a && v<=b;
  }

  const n=_normNum(t);
  if(n===null) return null;
  const digits=String(n);
  return v=> v===n || String(v).includes(digits);
}

// ── 日付検索 ────────────────────────────────────────────────────────────────
//   2025-04-01 / 2025/4/1 / 2025年4月1日 … その日
//   2025-04 / 2025/4 / 2025年4月         … その月
//   4/1 / 4月1日                         … 年を問わずその日
//   4月                                  … 年を問わずその月
//   4/1~4/30 / 2025-04-01〜2025-05-31    … 範囲（区切りは ~ か 〜）
//   >=2025-04-01 <2025/5/1               … 比較
// "-" は金額の範囲と紛らわしいので、日付の範囲には使わない。

// 日付文字列を {y,m,d} に。年・日は省略可（null）。日付でなければ null。
function _parseDateTok(s){
  const t=String(s).trim()
    .replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0))
    .replace(/[／]/g,'/').replace(/[－ー]/g,'-');
  let m, y=null, mo, d=null;
  if((m=t.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/))) {y=+m[1];mo=+m[2];d=m[3]?+m[3]:null;}
  else if((m=t.match(/^(?:(\d{4})年)?(\d{1,2})月(?:(\d{1,2})日)?$/))) {y=m[1]?+m[1]:null;mo=+m[2];d=m[3]?+m[3]:null;}
  else if((m=t.match(/^(\d{1,2})\/(\d{1,2})$/))) {mo=+m[1];d=+m[2];}
  else return null;
  if(mo<1||mo>12||(d!==null&&(d<1||d>31))) return null;
  return {y,m:mo,d};
}

// 取引の日付を {y,m,d} に
function _txDate(tx){
  const m=String(tx.date||'').match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  return m?{y:+m[1],m:+m[2],d:+m[3]}:null;
}

// 比較用の数値。年を省略した条件は月日だけで比べる。
// 範囲の端が日なしなら、下端は月初・上端は月末として扱う。
function _dateKey(p,useYear,end){
  const d=p.d!==null?p.d:(end?99:0);
  return (useYear?p.y*10000:0)+p.m*100+d;
}

// 日付条件として解釈できればマッチ関数を返す。日付でなければ null。
function parseDateQuery(token){
  const t=String(token).trim().replace(/[＞>]/g,'>').replace(/[＜<]/g,'<').replace(/[＝=]/g,'=');
  let m=t.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if(m){
    const p=_parseDateTok(m[2]);
    if(!p) return null;
    const op=m[1], yr=p.y!==null;
    return tx=>{
      const x=_txDate(tx); if(!x) return false;
      const v=_dateKey(x,yr);
      if(op==='=') return _dateKey(p,yr,false)<=v && v<=_dateKey(p,yr,true);
      if(op==='>=') return v>=_dateKey(p,yr,false);
      if(op==='>')  return v>_dateKey(p,yr,true);
      if(op==='<=') return v<=_dateKey(p,yr,true);
      return v<_dateKey(p,yr,false);
    };
  }
  m=t.match(/^(.+?)\s*[~〜～]\s*(.+)$/);
  if(m){
    const a=_parseDateTok(m[1]), b=_parseDateTok(m[2]);
    if(!a||!b) return null;
    const yr=a.y!==null&&b.y!==null;
    const lo=_dateKey(a,yr,false), hi=_dateKey(b,yr,true);
    return tx=>{
      const x=_txDate(tx); if(!x) return false;
      const v=_dateKey(x,yr);
      return lo<=hi ? v>=lo&&v<=hi : v>=lo||v<=hi;  // 年なしで 12/1~1/31 のように年をまたぐ範囲
    };
  }
  const p=_parseDateTok(t);
  if(!p) return null;
  return tx=>{
    const x=_txDate(tx); if(!x) return false;
    return (p.y===null||x.y===p.y) && x.m===p.m && (p.d===null||x.d===p.d);
  };
}

function _matchText(tx,s){
  return (tx.party||'').toLowerCase().includes(s)
    || (tx.memo||'').toLowerCase().includes(s)
    || (tx.entries||[]).some(e=>(e.memo||'').toLowerCase().includes(s)
      || (e.debit_sub||'').toLowerCase().includes(s)
      || (e.credit_sub||'').toLowerCase().includes(s));
}

function _matchToken(tx,token){
  const dateFn=parseDateQuery(token);
  if(dateFn) return dateFn(tx);
  const amtFn=parseAmountQuery(token);
  if(amtFn) return _txAmounts(tx).some(amtFn);
  return _matchText(tx,token.toLowerCase());
}

// 入金か出金か: 銀行明細の取引は入出金額から、手入力の取引は direction（なければ仕訳の現金・預金の増減）から決める
function txDirection(tx){
  if(tx.debit>0||tx.bank_debit>0) return 'out';
  if(tx.credit>0||tx.bank_credit>0) return 'in';
  if(tx.direction==='in'||tx.direction==='out') return tx.direction;
  let net=0;
  (tx.entries||[]).forEach(e=>{
    const a=parseInt(e.amount||0);
    if(getAccountType(e.debit_account)==='assets') net+=a;
    if(getAccountType(e.credit_account)==='assets') net-=a;
  });
  return net>0?'in':net<0?'out':'';
}

function renderJ(){fj();}
// フィルタ変更時（ページ1にリセット）
function fj(){_fj(true);}
// 保存・削除後（ページ位置を保持）
function fjKeepPage(){_fj(false);}
function _fj(resetPage){
  const s=document.getElementById('js').value.trim();
  const tp=document.getElementById('jt').value;
  const ac=document.getElementById('ja').value;
  const st=document.getElementById('jst').value;
  let txs=getFyTx();
  if(s){
    const tokens=s.split(/\s+/).filter(Boolean);
    txs=txs.filter(t=>tokens.every(tok=>_matchToken(t,tok)));
  }
  if(tp)txs=txs.filter(t=>t.type===tp);
  if(ac){
    // 補助科目は ["科目","補助科目"] の JSON で選ばれる
    const [acN,subN]=ac.startsWith('[')?JSON.parse(ac):[ac,null];
    txs=txs.filter(t=>(t.entries||[]).some(e=>
      (e.debit_account===acN&&(subN===null||(e.debit_sub||'')===subN))||
      (e.credit_account===acN&&(subN===null||(e.credit_sub||'')===subN))));
  }
  if(st)txs=txs.filter(t=>txStatus(t)===st);
  txs.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  filtTx=txs;
  if(resetPage){curPg=1;}else{const tot=Math.ceil(filtTx.length/PS)||1;if(curPg>tot)curPg=tot;}
  document.getElementById('jcount').textContent=`${txs.length}件`;
  rJp();
}

function rJp(){
  const pg=filtTx.slice((curPg-1)*PS,curPg*PS);
  const start=(curPg-1)*PS;
  let html='';
  pg.forEach((tx,idx)=>{
    const no=start+idx+1;
    const entries=tx.entries||[];
    const entriesAmt = entries.reduce((s,e)=>s+parseInt(e.amount||0),0);
    // 資産科目の正味増減。費用の戻し・返金を含む複合仕訳では
    // 単純合計(entriesAmt)が取引金額と一致しないため、こちらでも照合する。
    const entriesNet = Math.abs(entries.reduce((s,e)=>{
      const amt=parseInt(e.amount||0);
      let v=0;
      if(getAccountType(e.debit_account)==='assets')  v+=amt;
      if(getAccountType(e.credit_account)==='assets') v-=amt;
      return s+v;
    },0));
    const origAmt = Math.max(tx.debit||0, tx.credit||0, tx.bank_debit||0, tx.bank_credit||0, tx.amount||0);
    const headerAmt = origAmt > 0 ? origAmt : entriesAmt;
    const dir = txDirection(tx);
    const isOut = dir === 'out';
    const isIn = dir === 'in';
    const bOut = isOut ? `<span class="amt-badge amt-out">出金</span>` : '';
    const bIn = isIn ? `<span class="amt-badge amt-in">入金</span>` : '';
    const status = txStatus(tx);
    const regBadge = status==='reg'
      ? '<span class="badge" style="background:#f0fdf4; color:#15803d; border:1px solid #86efac;">✓ 登録済</span>'
      : status==='prov'
      ? '<span class="badge" style="background:#fffbeb; color:#b45309; border:1px solid #fcd34d;">仮登録</span>'
      : '<span class="badge" style="background:#f8fafc; color:#64748b; border:1px solid #cbd5e1;">未登録</span>';
    // 以前AIアシスタントが付けていたAIアシスタントは自動ルールではないので表示しない
    const autoRuleLabel = (tx.auto_rule === 'AIアシスタント' ? '' : (tx.auto_rule || '')).replace('申請自動仕訳:transport','申請自動仕訳（交通費）').replace('申請自動仕訳:advance','申請自動仕訳（立替）');
    const autoRule = autoRuleLabel ? `<span class="badge bau">${escHtml(autoRuleLabel)}</span>` : '';

    const hasReceipt = tx.receipt_file ? '<span class="badge" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;cursor:pointer" onclick="viewReceiptOf(event,\'' + escJsAttr(tx.id) + '\')"><span class="ei" data-i="receipt"></span>領収書</span>' : '';
    html+=`<div class="jgrp" id="grp-${escHtml(tx.id)}">
      <div class="jgrp-head">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1;">
          <input type="checkbox" class="rc" data-id="${escHtml(tx.id)}">
          <span class="jno">${no}</span>
          <span style="font-weight:600; font-size:14px;">${escHtml(tx.date)}</span>
          ${tx.party ? `<span class="kana-badge">${escHtml(tx.party)}</span>` : ''}
          <span style="color:var(--mu);font-size:12px;">［${escHtml(tx.type||'手動')}］</span>
          <span style="font-weight:700; font-size:15px; color:var(--tx);">¥${headerAmt.toLocaleString()}</span>
          ${bOut} ${bIn}
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          ${autoRule} ${regBadge} ${hasReceipt}
          <div style="width:1px; height:14px; background:#cbd5e1; margin:0 2px;"></div>
          ${status==='unreg' ? `<button class="btn btn-outline bsm" onclick="provT('${escJsAttr(tx.id)}')">仮登録</button>` : ''}
          ${status!=='reg' ? `<button class="btn btn-outline-blue bsm" onclick="regT('${escJsAttr(tx.id)}')">登録</button>` : ''}
          <button class="btn btn-outline bsm" onclick="editTx('${escJsAttr(tx.id)}')">編集</button>
        </div>
      </div>
      <div class="jgrp-body"><table>
        <thead style="font-size:11px"><tr>
          <th>借方科目</th><th>借方補助</th><th>貸方科目</th><th>貸方補助</th><th style="text-align:right">金額</th><th>摘要</th>
        </tr></thead><tbody>`;
    entries.forEach(e=>{
      html+=`<tr>
        <td style="font-weight:500">${e.debit_account?escHtml(e.debit_account):'<span style="color:#ccc">-</span>'}</td>
        <td style="font-size:12px;color:var(--mu)">${escHtml(e.debit_sub||'')}</td>
        <td style="font-weight:500">${e.credit_account?escHtml(e.credit_account):'<span style="color:#ccc">-</span>'}</td>
        <td style="font-size:12px;color:var(--mu)">${escHtml(e.credit_sub||'')}</td>
        <td style="text-align:right;font-weight:600">¥${parseInt(e.amount||0).toLocaleString()}</td>
        <td style="font-size:12px">${escHtml(e.memo||tx.memo||'')}</td>
      </tr>`;
    });
    if(!entries.length) html+=`<tr><td colspan="6" style="color:var(--mu);text-align:center">仕訳明細なし（編集してください）</td></tr>`;
    if (origAmt > 0 && entriesAmt > 0 && origAmt !== entriesAmt && origAmt !== entriesNet) {
      html+=`<tr><td colspan="6" style="color:var(--ex);text-align:center;font-size:12px;background:#fef2f2;"><span class="ei" data-i="alert"></span>取引金額(¥${origAmt.toLocaleString()})と明細の合計(¥${entriesAmt.toLocaleString()}／正味¥${entriesNet.toLocaleString()})が一致していません。</td></tr>`;
    }
    html+=`</tbody></table></div></div>`;
  });
  document.getElementById('jgroups').innerHTML=html||'<p style="color:var(--mu);text-align:center;padding:20px">取引がありません</p>';
  rPag();
}

function rPag(){
  const tot=Math.ceil(filtTx.length/PS);
  const el=document.getElementById('jpag');
  let h='';
  if(tot>1){for(let i=1;i<=tot;i++){
    if(i===1||i===tot||(i>=curPg-2&&i<=curPg+2))h+=`<button class="pb${i===curPg?' active':''}" onclick="gP(${i})">${i}</button>`;
    else if(i===curPg-3||i===curPg+3)h+='<span style="padding:3px">…</span>';
  }}
  el.innerHTML=h;
}
function gP(n){curPg=n;rJp();}

async function regT(id){
  const tx=allTx.find(t=>t.id===id);if(!tx)return;
  const entries=tx.entries||[];
  if(!entries.length||entries.some(e=>!e.debit_account||!e.credit_account)){
    toast('全ての仕訳行に借方・貸方の勘定科目を設定してください','#f59e0b');return;
  }
  tx.registered=true;tx.provisional=false;
  await api('PUT','/transactions/'+id,{...tx,_skipLog:true});
  logChange('更新','/transactions',`${_txLabel(tx)} を仕訳登録しました`);
  fjKeepPage();loadDash();toast('登録しました','#059669');
}

// 仮登録: 決算書には含めず、後で「仮登録を一括登録」でまとめて登録済みにする
async function provT(id){
  const tx=allTx.find(t=>t.id===id);if(!tx)return;
  if(!_txEntriesReady(tx)){
    toast('全ての仕訳行に借方・貸方の勘定科目を設定してください','#f59e0b');return;
  }
  tx.provisional=true;
  await api('PUT','/transactions/'+id,{...tx,_skipLog:true});
  logChange('更新','/transactions',`${_txLabel(tx)} を仮登録しました`);
  fjKeepPage();loadDash();toast('仮登録しました','#b45309');
}

function _txEntriesReady(tx){
  const entries=tx.entries||[];
  return entries.length>0 && entries.every(e=>e.debit_account&&e.credit_account);
}

function togAll(cb){document.querySelectorAll('.rc').forEach(c=>c.checked=cb.checked);}

async function bulkReg(){
  const ids=[...document.querySelectorAll('.rc:checked')].map(c=>c.dataset.id);
  if(!ids.length){toast('チェックされた取引がありません','#f59e0b');return;}
  let ok=0;
  for(const id of ids){
    const tx=allTx.find(t=>t.id===id);
    if(!tx)continue;
    if(tx.registered)continue;
    if(_txEntriesReady(tx)){
      tx.registered=true;tx.provisional=false;await api('PUT','/transactions/'+id,{...tx,_skipLog:true});ok++;
    }
  }
  if(ok)logChange('更新','/transactions',`${ok}件の取引を一括で仕訳登録しました`);
  fjKeepPage();loadDash();toast(`${ok}件を一括登録しました`,'#059669');
}

// チェックした取引を一括で仮登録
async function bulkProv(){
  const ids=[...document.querySelectorAll('.rc:checked')].map(c=>c.dataset.id);
  if(!ids.length){toast('チェックされた取引がありません','#f59e0b');return;}
  let ok=0, skip=0;
  for(const id of ids){
    const tx=allTx.find(t=>t.id===id);
    if(!tx||txStatus(tx)!=='unreg')continue;
    if(!_txEntriesReady(tx)){skip++;continue;}
    tx.provisional=true;await api('PUT','/transactions/'+id,{...tx,_skipLog:true});ok++;
  }
  if(ok)logChange('更新','/transactions',`${ok}件の取引を一括で仮登録しました`);
  fjKeepPage();loadDash();
  toast(`${ok}件を仮登録しました`+(skip?`（科目未設定のため${skip}件スキップ）`:''),'#b45309');
}

// 表示中の年度・月の仮登録をすべて登録済みにする
async function commitProv(){
  const txs=getFyTx().filter(t=>txStatus(t)==='prov');
  if(!txs.length){toast('仮登録の取引はありません','#f59e0b');return;}
  if(!confirm(`仮登録 ${txs.length}件をすべて登録済みにしますか？`))return;
  let ok=0, skip=0;
  for(const tx of txs){
    if(!_txEntriesReady(tx)){skip++;continue;}
    tx.registered=true;tx.provisional=false;
    await api('PUT','/transactions/'+tx.id,{...tx,_skipLog:true});ok++;
  }
  if(ok)logChange('更新','/transactions',`仮登録 ${ok}件を一括で登録済みにしました`);
  fjKeepPage();loadDash();
  toast(`仮登録 ${ok}件を登録済みにしました`+(skip?`（科目未設定のため${skip}件スキップ）`:''),'#059669');
}

async function expJ(){
  showExportDialog('仕訳帳のエクスポート',
    async()=>{
      const base=window.location.pathname.replace(/\/$/,'');
      const r=await fetch(base+'/api/export/journal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactions:getRegFyTx()})});
      dlB(await r.blob(),'仕訳帳.xlsx');
    },
    ()=>{
      const txs=getRegFyTx();
      const rows=[];
      txs.forEach(tx=>{
        (tx.entries||[]).forEach(e=>{
          const amt=parseInt(e.amount||0);
          rows.push(`<tr><td>${escHtml(tx.date)}</td><td>${escHtml(tx.party||'')}</td>
            <td>${escHtml(e.debit_account||'')}</td><td>${escHtml(e.debit_sub||'')}</td>
            <td>${escHtml(e.credit_account||'')}</td><td>${escHtml(e.credit_sub||'')}</td>
            <td style="text-align:right">¥${amt.toLocaleString()}</td>
            <td>${escHtml(e.memo||tx.memo||'')}</td></tr>`);
        });
      });
      const html=`<div style="padding:16px;font-family:'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN',sans-serif;font-size:10px">
        <h3 style="margin:0 0 10px;font-size:14px">仕訳帳</h3>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:10px">
          <thead style="background:#1e293b;color:#fff"><tr><th>日付</th><th>相手先</th><th>借方科目</th><th>借方補助</th><th>貸方科目</th><th>貸方補助</th><th>金額</th><th>摘要</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
      html2pdf().set({margin:6,filename:'仕訳帳.pdf',html2canvas:{scale:1.5},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(html).save();
    }
  );
}

// ── 追加/編集モーダル関連 ──
function mkEntryRow(i, e){
  return`<tr>
    <td><select class="ac" style="width:120px" onchange="addEntries[${i}].debit_account=this.value;updEntrySub(${i},'d')">${allAcOp(e.debit_account)}</select></td>
    <td><select class="ac" id="eds${i}" style="width:100px" onchange="addEntries[${i}].debit_sub=this.value">${subOp(e.debit_account,e.debit_sub)}</select></td>
    <td><select class="ac" style="width:120px" onchange="addEntries[${i}].credit_account=this.value;updEntrySub(${i},'c')">${allAcOp(e.credit_account)}</select></td>
    <td><select class="ac" id="ecs${i}" style="width:100px" onchange="addEntries[${i}].credit_sub=this.value">${subOp(e.credit_account,e.credit_sub)}</select></td>
    <td><input type="number" value="${e.amount||''}" min="0" style="width:90px;border:1px solid var(--bd);border-radius:4px;padding:3px 5px;font-size:12px;text-align:right" oninput="addEntries[${i}].amount=parseInt(this.value)||0;calcAddBalance()"></td>
    <td style="width:100%;min-width:240px"><input type="text" value="${(e.memo||'').replace(/"/g,'&quot;')}" style="width:100%;min-width:220px;box-sizing:border-box;border:1px solid var(--bd);border-radius:4px;padding:3px 6px;font-size:12px" oninput="addEntries[${i}].memo=this.value"></td>
    <td><button onclick="addEntries.splice(${i},1);renderEntryRows()" style="background:none;border:none;cursor:pointer;color:var(--ex);font-size:14px">×</button></td>
  </tr>`;
}
function updEntrySub(i,side){
  const e=addEntries[i];
  if(side==='d'){document.getElementById('eds'+i).innerHTML=subOp(e.debit_account,'');e.debit_sub='';}
  else{document.getElementById('ecs'+i).innerHTML=subOp(e.credit_account,'');e.credit_sub='';}
}
function addEntryRow(){
  addEntries.push({debit_account:'',debit_sub:'',credit_account:'',credit_sub:'',amount:0,memo:''});
  renderEntryRows();
}
function renderEntryRows(){
  document.getElementById('add-entries').innerHTML=addEntries.map((e,i)=>mkEntryRow(i,e)).join('');
  calcAddBalance();
}
function calcAddBalance(){
  const total=addEntries.reduce((s,e)=>s+parseInt(e.amount||0),0);
  const el=document.getElementById('add-balance-check');
  if(el) el.innerHTML=`合計金額: <strong>¥${total.toLocaleString()}</strong>`;
}

function openAddTx(){
  editingTxId=null;
  addEntries=[{debit_account:'',debit_sub:'',credit_account:'',credit_sub:'',amount:0,memo:''}];
  document.getElementById('addtitle').textContent='仕訳を追加';
  document.getElementById('add-date').value=new Date().toISOString().slice(0,10);
  document.getElementById('add-dir').value='out';
  document.getElementById('add-party').value='';
  document.getElementById('add-status').value='unreg';
  renderEntryRows();
  document.getElementById('addov').classList.add('open');
}

function editTx(id){
  const tx=allTx.find(t=>t.id===id);if(!tx)return;
  editingTxId=id;
  addEntries=JSON.parse(JSON.stringify(tx.entries||[{debit_account:'',debit_sub:'',credit_account:'',credit_sub:'',amount:0,memo:''}]));
  document.getElementById('addtitle').textContent='仕訳を編集';
  document.getElementById('add-date').value=(tx.date||'').replace(/\//g,'-');
  document.getElementById('add-dir').value=txDirection(tx)||'out';
  document.getElementById('add-party').value=tx.party||'';
  document.getElementById('add-status').value=txStatus(tx);
  renderEntryRows();
  receiptReset();
  if(tx.receipt_file){
    receiptExisting=true;
    const url=`${getBase()}/api/receipt/${encodeURIComponent(id)}`;
    const isPdf=tx.receipt_file.endsWith('.pdf');
    receiptShowPreview(url, tx.receipt_file.split('/').pop(), isPdf);
    document.getElementById('receipt-view-link').style.display='';
  }
  document.getElementById('addov').classList.add('open');
}

function closeAdd(){document.getElementById('addov').classList.remove('open');editingTxId=null;receiptReset();}

async function submitAdd(){
  const dateRaw=document.getElementById('add-date').value;
  if(!dateRaw){toast('取引日を入力してください','#f59e0b');return;}
  const date=dateRaw.replace(/-/g,'/');
  const total=addEntries.reduce((s,e)=>s+parseInt(e.amount||0),0);
  if(total===0){toast('金額を入力してください','#f59e0b');return;}

  const data={
    date, party:document.getElementById('add-party').value,
    // 銀行明細の取引区分（振込・振替など）はそのまま。手で入れた取引は「手動」
    type: editingTxId ? ((allTx.find(t=>t.id===editingTxId)||{}).type||'手動') : '手動',
    // 入金か出金か（手入力の取引の表示用。銀行の入出金額 bank_credit/bank_debit とは別に持つ）
    direction: document.getElementById('add-dir').value,
    registered:document.getElementById('add-status').value==='reg',
    provisional:document.getElementById('add-status').value==='prov',
    entries:addEntries.filter(e=>parseInt(e.amount||0)>0),
    auto_rule:'', source_file:'手動入力',
    group_id: editingTxId ? (allTx.find(t=>t.id===editingTxId)||{}).group_id : undefined,
    memo: addEntries[0]?.memo || '',
  };

  if(editingTxId){
    data.id=editingTxId;
    const before=allTx.find(t=>t.id===editingTxId);
    const changes=_txDiff(before, data);
    await api('PUT','/transactions/'+editingTxId,{...data,_skipLog:true});
    const idx=allTx.findIndex(t=>t.id===editingTxId);
    if(idx>=0)allTx[idx]={...allTx[idx],...data};
    const desc = changes.length
      ? `${_txLabel(data)} を編集：${changes.join('、')}`
      : `${_txLabel(data)} を編集（変更なし）`;
    logChange('更新','/transactions',desc);
    toast('更新しました','#059669');
  }else{
    const res=await api('POST','/transactions',{...data,_skipLog:true});
    if(res.transaction)allTx.push(res.transaction);
    logChange('作成','/transactions',`${_txLabel(data)} を手動で追加しました`);
    toast('追加しました','#059669');
  }
  // 領収書アップロード（保存後に tx id が確定してからアップロード）
  const uploadTxId = editingTxId || (typeof res !== 'undefined' && res.transaction ? res.transaction.id : null);
  if(receiptPendingFile && uploadTxId){ await receiptUploadNow(uploadTxId); const t2=allTx.find(t=>t.id===uploadTxId); if(t2)t2.receipt_file='uploaded'; }
  closeAdd();popFy();fjKeepPage();loadDash();
}
// ── 領収書アップロード ────────────────────────────────────────────────────
let receiptPendingFile = null; // 新規アップロード待ちのファイル（最適化済みBlob）
let receiptExisting    = false; // 既存領収書フラグ

// 画像を最適化（リサイズ＋JPEG変換）してBlobを返す
async function optimizeImage(file) {
  const MAX_PX  = 2000;   // 長辺の上限（px）
  const QUALITY = 0.78;   // JPEG品質（0〜1）

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      // リサイズが必要かチェック
      if (w > MAX_PX || h > MAX_PX) {
        if (w >= h) { h = Math.round(h * MAX_PX / w); w = MAX_PX; }
        else        { w = Math.round(w * MAX_PX / h); h = MAX_PX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      // 白背景（PNG透過対策）
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('画像変換に失敗しました')); return; }
        resolve(blob);
      }, 'image/jpeg', QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像の読み込みに失敗しました')); };
    img.src = url;
  });
}

function receiptReset(){
  receiptPendingFile = null;
  receiptExisting    = false;
  document.getElementById('receipt-placeholder').style.display='';
  document.getElementById('receipt-preview').style.display='none';
  document.getElementById('receipt-uploading').style.display='none';
  const inp = document.getElementById('receipt-input');
  if(inp) inp.value='';
}

function receiptShowPreview(url, filename, isPdf){
  document.getElementById('receipt-placeholder').style.display='none';
  document.getElementById('receipt-uploading').style.display='none';
  const preview = document.getElementById('receipt-preview');
  preview.style.display='';
  document.getElementById('receipt-filename').textContent=filename;
  const img = document.getElementById('receipt-img');
  const pdfIcon = document.getElementById('receipt-pdf-icon');
  const link = document.getElementById('receipt-view-link');
  link.href = url;
  if(isPdf){
    img.style.display='none';
    pdfIcon.style.display='';
  } else {
    img.src = url;
    img.style.display='';
    pdfIcon.style.display='none';
  }
}

async function receiptSelected(input){
  const file = input.files[0];
  if(!file) return;
  const isPdf = file.type==='application/pdf';
  if(isPdf){
    // PDFはそのまま
    receiptPendingFile = file;
    receiptShowPreview('', file.name, true);
    document.getElementById('receipt-view-link').style.display='none';
  } else {
    // 最適化中UI
    document.getElementById('receipt-placeholder').style.display='none';
    document.getElementById('receipt-uploading').style.display='';
    document.getElementById('receipt-uploading').innerHTML='<div style="font-size:24px;margin-bottom:4px"><span class="ei" data-i="refresh"></span></div>最適化中...';
    try {
      const blob = await optimizeImage(file);
      // サイズ情報
      const origKB  = Math.round(file.size / 1024);
      const afterKB = Math.round(blob.size / 1024);
      const savings = origKB > afterKB ? `（${origKB}KB → ${afterKB}KB）` : `（${afterKB}KB）`;
      // Blobにファイル名を付与
      const outName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      receiptPendingFile = new File([blob], outName, {type:'image/jpeg'});
      document.getElementById('receipt-uploading').style.display='none';
      const previewUrl = URL.createObjectURL(blob);
      receiptShowPreview(previewUrl, outName + ' ' + savings, false);
      document.getElementById('receipt-view-link').style.display='none';
    } catch(e) {
      document.getElementById('receipt-uploading').style.display='none';
      document.getElementById('receipt-placeholder').style.display='';
      toast('画像の最適化に失敗しました: ' + e.message, '#dc2626');
    }
  }
}

function receiptDrop(event){
  event.preventDefault();
  event.currentTarget.style.borderColor='#cbd5e1';
  const file = event.dataTransfer.files[0];
  if(!file) return;
  const allowed=['image/jpeg','image/png','image/gif','image/webp','application/pdf'];
  if(!allowed.includes(file.type)){toast('JPEG/PNG/GIF/WebP/PDFのみアップロードできます','#f59e0b');return;}
  const inp = document.getElementById('receipt-input');
  // DataTransfer を経由して input に渡す
  const dt = new DataTransfer();
  dt.items.add(file);
  inp.files = dt.files;
  receiptSelected(inp);
}

async function receiptUploadNow(txId){
  if(!receiptPendingFile) return true;
  document.getElementById('receipt-placeholder').style.display='none';
  document.getElementById('receipt-preview').style.display='none';
  document.getElementById('receipt-uploading').style.display='';
  const fd = new FormData();
  fd.append('receipt', receiptPendingFile);
  fd.append('tx_id', txId);
  try{
    const res = await fetch(`${getBase()}/api/receipt-upload`, {method:'POST', body:fd});
    const data = await res.json();
    if(!data.success){ toast('領収書のアップロードに失敗しました: '+(data.error||''), '#dc2626'); return false; }
    const fname = receiptPendingFile?.name || '領収書';
    const tx = allTx.find(t=>t.id===txId);
    logChange('更新','/transactions',`${typeof _txLabel==='function'?_txLabel(tx):'取引'} に領収書「${fname}」をアップロードしました`);
    receiptPendingFile = null;
    receiptExisting = true;
    const isPdf = receiptPendingFile === null && data.path && data.path.endsWith('.pdf');
    return true;
  }catch(e){
    toast('領収書アップロードエラー: '+e.message,'#dc2626');
    return false;
  }
}

async function receiptClear(){
  if(editingTxId && receiptExisting){
    if(!confirm('領収書を削除しますか？')) return;
    await fetch(`${getBase()}/api/receipt/${encodeURIComponent(editingTxId)}`, {method:'DELETE'});
    const tx = allTx.find(t=>t.id===editingTxId);
    logChange('更新','/transactions',`${typeof _txLabel==='function'?_txLabel(tx):'取引'} の領収書を削除しました`);
    if(tx) tx.receipt_file = null;
  }
  receiptPendingFile = null;
  receiptExisting = false;
  receiptReset();
}

function viewReceiptOf(event, txId){
  event.stopPropagation();
  window.open(`${getBase()}/api/receipt/${encodeURIComponent(txId)}`, '_blank');
}
