// ── 会費の種類（金額→摘要の対応表） ──
// 設定 → 会費の種類 に「金額 摘要」を1行ずつ書く（例: 3000 一般会費）。
// 金額が重複する場合は上の行を優先する。
function feeMasters() {
  const raw = (typeof sts !== 'undefined' && sts && sts.fee_presets) || '';
  return String(raw).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^[¥￥]?([\d,]+)\s*(?:円)?[\s　:：]+(.+)$/);
    return m ? { fee: parseInt(m[1].replace(/,/g, ''), 10) || 0, tekiyo: m[2].trim() } : null;
  }).filter(Boolean);
}

// 金額から摘要を逆引き（デフォルト用）
function getDefaultTekiyo(fee) {
  const m = feeMasters().find(m => m.fee === fee);
  return m ? m.tekiyo : '会費';
}

// 摘要セレクトのオプションHTML生成
function tekiyoOptions(selected) {
  const masters = feeMasters();
  const opts = masters.map(m =>
    `<option value="${escHtml(m.tekiyo)}"${m.tekiyo === selected ? ' selected' : ''}>${escHtml(m.tekiyo)}（¥${m.fee.toLocaleString()}）</option>`
  ).join('');
  // 一覧にない摘要（手で入力したもの）も選択肢に残す
  const custom = selected && selected !== '会費' && !masters.some(m => m.tekiyo === selected)
    ? `<option value="${escHtml(selected)}" selected>${escHtml(selected)}</option>` : '';
  return `<option value="会費"${'会費' === selected ? ' selected' : ''}>会費（汎用）</option>` + custom + opts;
}

// ── 機能の ON/OFF（設定 → 使う機能）──
// サーバーが /api/settings の features に、既定値を埋めた全機能の ON/OFF を返す。
function hasFeature(f) {
  const fs = (typeof sts !== 'undefined' && sts && sts.features) || null;
  if (!fs || !(f in fs)) return true;
  return !!fs[f];
}
// ページ → 機能（無効な機能のページは開かない）
const PAGE_FEATURE = { invoice: 'invoice', billing: 'billing', 'credit-rules': 'credit_card', claims: 'claims', ai: 'ai' };
// data-feature="機能名" の付いた要素を、機能の ON/OFF に合わせて出し入れする
function applyFeatureUI() {
  document.querySelectorAll('[data-feature]').forEach(el => {
    const on = el.dataset.feature.split(/\s+/).every(hasFeature);
    el.classList.toggle('feat-off', !on);
  });
  document.body.classList.toggle('no-ai', !hasFeature('ai'));
}

// HTML に文字列を埋め込むときのエスケープ。
// 品目名など改行を含む値をそのまま流し込むと崩れる・壊れるため必ず通す。
function escHtml(v){
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// onclick="fn('...')" のように HTML 属性の中の JS 文字列に値を入れるときのエスケープ。
// JS 文字列として安全にしてから、さらに属性値として HTML エスケープする。
function escJsAttr(v){
  return escHtml(String(v == null ? '' : v)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
}

function getBase(){
  return window.location.pathname.replace(/\/[^\/]*$/, '').replace(/\/$/, '');
}

// ── グローバル状態 ──
let allTx=[], filtTx=[], allAc={}, allRu=[], sts={};
let curPg=1; const PS=30;
let curAcTab='income', editRu=[];
let mTx=[], mTitle='';
let curFy='';
let editingTxId=null;
let addEntries=[];
let allMembers=[];
let allInv=[], editingInvId=null, invItems=[];

// ── 認証・ユーザー情報 ──
let currentUser = null;
let currentRole = 'viewer';   // 'admin' | 'viewer' | 'denied'（「閲覧専用として見る」中は viewer）
let realRole = 'viewer';      // 本当の権限

// ── 管理者の「閲覧専用として見る」 ──
// 閲覧専用の人に見える画面（公開した月だけの決算書・質問だけのAIアシスタント）を、管理者がそのまま確かめるためのもの。
// この間は API 要求に X-View-As: viewer を付け、サーバーにも閲覧専用として答えてもらう（権限は下がるだけ）。
let acctViewAsViewer = false;
try { acctViewAsViewer = sessionStorage.getItem('acct_view_as') === 'viewer'; } catch (e) { /* 使えなければ通常表示 */ }
const _nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url || '');
  if (acctViewAsViewer && url.includes('/api/')) {
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {});
    headers.set('X-View-As', 'viewer');
    init = { ...init, headers };
  }
  return _nativeFetch(input, init);
};
function acctSetViewAs(on) {
  try { on ? sessionStorage.setItem('acct_view_as', 'viewer') : sessionStorage.removeItem('acct_view_as'); } catch (e) {}
  location.reload();   // メニュー・データを最初から作り直す
}

function isAdminUser() { return currentRole === 'admin'; }

async function loadCurrentUser() {
  try {
    const base = getBase();
    const authBase = base.replace(/\/api$/, '');
    const r = await fetch(authBase + '/auth.php?_path=/auth/me');
    if (!r.ok) return;
    const d = await r.json();
    currentUser = d.logged_in ? d.user : null;
    currentRole = (d.role || currentUser?.role || 'viewer');
    realRole = currentRole;
    if (acctViewAsViewer && realRole === 'admin') currentRole = 'viewer';
    else acctViewAsViewer = false;   // 管理者でなければ「閲覧専用として見る」は使わない
    renderViewAsBanner();
    if (!currentUser && typeof showLogin === 'function') showLogin();
    renderUserBadge();
  } catch(e) { /* auth未設定時は無視 */ }
}

// ── ロールに応じて画面を制限 ──
// 閲覧専用ユーザーには決算書だけを見せる
function applyRoleUI() {
  if (isAdminUser()) return;

  // 決算書以外のナビゲーションを隠す
  document.querySelectorAll('.sb .ni').forEach(el => {
    const id = el.id || '';
    if (id && !['nav-kessan', 'nav-ai'].includes(id) && id.startsWith('nav-')) el.style.display = 'none';
  });
  // 「設定」セクションのラベルごと非表示に
  document.querySelectorAll('.sb .ns').forEach(sec => {
    const visible = [...sec.querySelectorAll('.ni')].some(b => b.style.display !== 'none');
    if (!visible) sec.style.display = 'none';
  });

  // 決算書は年度セレクトを自前で持つため、上部の年度・月フィルタは不要
  ['fy-sel', 'mo-sel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function renderUserBadge() {
  const el = document.getElementById('user-badge');
  if (!el) return;
  if (!currentUser) {
    // 未ログインはログイン画面を再表示
    if (typeof showLogin === 'function') showLogin();
    return;
  }
  const pic = /^https:\/\//.test(currentUser.picture || '') ? currentUser.picture : '';
  const picHtml = pic
    ? `<img src="${escHtml(pic)}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover" onerror="this.style.display='none'">`
    : `<span style="font-size:16px"><span class="ei" data-i="user"></span></span>`;
  const roleBadge = isAdminUser()
    ? `<span class="ub-role" style="background:#faf5ff;color:#7c3aed;border:1px solid #e9d5ff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">管理者</span>`
    : `<span class="ub-role" style="background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">閲覧専用${acctViewAsViewer ? '（表示中）' : ''}</span>`;

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;font-size:12px">
      ${picHtml}
      <span class="ub-name" style="color:#374151;font-weight:600">${escHtml(currentUser.name || currentUser.email || '')}</span>
      ${roleBadge}
      ${currentUser.provider === 'password' ? `<button class="ub-btn" onclick="changeMyPassword()" title="パスワードを変更" style="background:none;border:1px solid #e2e8f0;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;color:#64748b"><span class="ei" data-i="key"></span><span class="ub-lbl"> パスワード</span></button>` : ''}
      <button class="ub-btn" onclick="logoutOAuth()" title="ログアウト" style="background:none;border:1px solid #e2e8f0;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;color:#64748b"><span class="ub-ic"><span class="ei" data-i="logout"></span></span><span class="ub-lbl">ログアウト</span></button>
      ${isAdminUser() ? `<button class="ub-btn" onclick="nav('logs')" title="ログ" style="background:none;border:1px solid #e2e8f0;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;color:#64748b"><span class="ei" data-i="clipboard"></span><span class="ub-lbl"> ログ</span></button>` : ''}
      ${isAdminUser() ? `<button class="ub-btn" onclick="acctSetViewAs(true)" title="閲覧専用の人に見える画面を確かめる" style="background:none;border:1px solid #e2e8f0;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;color:#0369a1"><span class="ei" data-i="eye"></span><span class="ub-lbl"> 閲覧専用として見る</span></button>` : ''}
    </div>`;
}

/** 「閲覧専用として見る」中は画面の上に帯を出し、すぐ戻れるようにする */
function renderViewAsBanner() {
  let bar = document.getElementById('view-as-bar');
  if (!acctViewAsViewer) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'view-as-bar';
    bar.className = 'view-as-bar';
    document.body.prepend(bar);
  }
  bar.innerHTML = `<span><span class="ei" data-i="eye"></span>閲覧専用の人に見える画面を表示しています（データの変更はできません）</span>
    <button onclick="acctSetViewAs(false)">管理者表示に戻る</button>`;
}

async function changeMyPassword() {
  const cur = prompt('いまのパスワード');
  if (cur === null) return;
  const next = prompt('新しいパスワード（10文字以上）');
  if (next === null) return;
  if (prompt('新しいパスワード（確認）') !== next) { toast('パスワードが一致しません', '#f59e0b'); return; }
  const r = await fetch(getBase() + '/auth.php?_path=/auth/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: cur, password: next }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) { toast('' + (d.error || '変更できませんでした'), '#ef4444'); return; }
  toast('パスワードを変更しました', '#059669');
}

async function logoutOAuth() {
  const base = getBase();
  await fetch(base + '/auth.php?_path=/auth/logout');
  currentUser = null;
  // 画面に残ったデータを消すため、読み込み直してログイン画面を出す
  location.reload();
}

// 編集ログを記録する関数
async function logEdit(action, target, detail) {
  try {
    const base = getBase();
    await fetch(base + '/auth.php?_path=/auth/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action, target, detail,
        user_name: currentUser?.name || '未ログイン',
        user_email: currentUser?.email || '',
      }),
    });
  } catch(e) { /* ログ失敗は無視 */ }
}

// api() のラッパー: 変更系の操作をログ記録
const _origApi = async function(method, path, body) {
  const base = getBase();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(base + '/api' + path, opts);
  return r.json();
};

// パスとボディから人間が読める操作説明を生成
// 金額フォーマット
function _yen(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? String(v) : '¥' + n.toLocaleString();
}

// 明示的にログを記録するためのヘルパー（呼び出し元から人間可読の説明を渡す）
function logChange(action, target, description) {
  if (!currentUser) return;
  logEdit(action, target, description).catch(() => {});
}

// パスとボディから人間が読める操作説明を生成（汎用フォールバック）
function _buildLogDetail(method, path, body) {
  const seg = path.replace(/^\//, '').split('/');
  const resource = seg[0];
  const b = body || {};

  // 取引（transactions）
  if (resource === 'transactions') {
    if (method === 'DELETE') return '取引を削除しました';
    const parts = [];
    if (b.date) parts.push(`日付 ${b.date}`);
    if (b.party) parts.push(`取引先「${b.party}」`);
    if (b.amount != null) parts.push(_yen(b.amount));
    if (b.type) parts.push(b.type);
    const reg = (b.registered === true) ? '（仕訳登録済みにマーク）'
      : (b.registered === false ? (b.provisional ? '（仮登録）' : '（未登録に戻す）') : '');
    const head = method === 'POST' ? '取引を登録' : '取引を更新';
    return `${head}${parts.length ? '：' + parts.join('・') : ''}${reg}`;
  }

  // 設定・科目・ルール系
  if (resource === 'settings') {
    if (path.includes('/claims')) return '交通費・立替申請の設定を変更しました';
    return 'システム設定を変更しました';
  }
  if (resource === 'accounts') return '勘定科目を更新しました';
  if (resource === 'rules')    return '自動仕訳ルールを更新しました';
  if (resource === 'credit-rules') return 'クレジットカード仕訳ルールを更新しました';
  if (resource === 'apply-rules') return '自動仕訳ルールを一括適用しました';
  if (resource === 'apply-credit-rules') return 'クレカ仕訳ルールを一括適用しました';
  if (resource === 'members')  return 'メンバー一覧を更新しました';
  if (resource === 'transport-deadlines') {
    return b.month ? `交通費申請の締め切りを設定しました（${b.month}）` : '交通費申請の締め切りを変更しました';
  }

  // フォールバック
  const actionMap = { POST: '作成', PUT: '更新', DELETE: '削除' };
  return `${resource} を${actionMap[method] || method}しました`;
}

async function api(method, path, body) {
  // _skipLog 付きの場合はラッパーでログしない（呼び出し元が logChange で記録）
  const skipLog = body && body._skipLog;
  if (body && body._skipLog) { body = { ...body }; delete body._skipLog; }

  const result = await _origApi(method, path, body);

  // 変更操作をログに記録（GET以外、かつ skipLog でない）
  if (method !== 'GET' && currentUser && !skipLog) {
    const actionMap = { POST: '作成', PUT: '更新', DELETE: '削除' };
    const action = actionMap[method] || method;
    const target = path.replace(/\/[a-f0-9\-]{36}$/, '').replace('/api', '');
    const detail = _buildLogDetail(method, path, body);
    logEdit(action, target, detail).catch(() => {});
  }
  return result;
}


const DEBIT_INCREASE = new Set(['assets','expense']);

function getAccountType(name){
  for(const tp of ['assets','liabilities','equity','income','expense']){
    if((allAc[tp]||[]).some(a=>a.name===name)) return tp;
  }
  return null;
}

function isDebitIncrease(name){ return DEBIT_INCREASE.has(getAccountType(name)); }

// 通知の左に、色に合わせたアイコンを付ける（緑=完了、黄=注意、赤=失敗、青=自動処理）
function toastIcon(c){
  const k=String(c||'').toLowerCase();
  if(['#059669','#16a34a','#10b981'].includes(k)) return 'checkc';
  if(['#f59e0b','#b45309','#d97706'].includes(k)) return 'alert';
  if(['#dc2626','#ef4444','#b91c1c'].includes(k)) return 'xc';
  if(['#1a56db','#2563eb'].includes(k)) return 'bolt';
  return '';
}
function toast(msg,c='#1e293b'){
  const t=document.getElementById('toast');
  const ic=toastIcon(c);
  t.innerHTML=(ic?`<span class="ei toast-ic">${iconSvg(ic)}</span>`:'')+escHtml(msg);
  t.style.background=c;
  t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);
}

function dlB(blob,name){
  const u=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=u; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(u),1000);
}

// ── 年度管理 ──
// 上部の月セレクトを、会計年度の開始月から並べ直す
function popMonthSel(){
  const sel=document.getElementById('mo-sel'); if(!sel) return;
  const cur=sel.value;
  const st=parseInt(sts.fiscal_year_start||4,10);
  const s0=st>=1&&st<=12?st:4;
  sel.innerHTML='<option value="">全月</option>'+Array.from({length:12},(_,i)=>{
    const m=(s0-1+i)%12+1; return `<option value="${m}">${m}月</option>`;
  }).join('');
  sel.value=cur;
}
function getFyList(){
  const fs=sts.fiscal_year_start||4;
  const ys=new Set();
  allTx.forEach(tx=>{
    if(!tx.date)return;
    const[y,m]=tx.date.split('/').map(Number);
    ys.add(m>=fs?y:y-1);
  });
  if(!ys.size)ys.add(new Date().getFullYear());
  return[...ys].sort((a,b)=>b-a);
}

function popFy(){
  const fys=getFyList();
  ['fy-sel','ks-yr','ld-yr','ml-yr'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const cur=el.value;
    el.innerHTML=fys.map(y=>`<option value="${y}">${y}年度</option>`).join('');
    if(cur&&fys.includes(parseInt(cur)))el.value=cur;
  });
  if(!curFy&&fys.length){curFy=String(fys[0]);
    ['fy-sel','ks-yr','ld-yr','ml-yr'].forEach(id=>{const e=document.getElementById(id);if(e)e.value=curFy;});
  }
}

function onFy(){
  curFy=document.getElementById('fy-sel').value;
  ['ks-yr','ld-yr','ml-yr'].forEach(id=>{const e=document.getElementById(id);if(e)e.value=curFy;});
  loadDash();fj();
}
function onMo(){loadDash();fj();}

function getFyTx(){
  const fy=document.getElementById('fy-sel').value;
  const mo=document.getElementById('mo-sel').value;
  const fs=sts.fiscal_year_start||4;
  return allTx.filter(tx=>{
    if(!tx.date)return false;
    const[y,m]=tx.date.split('/').map(Number);
    const tfy=m>=fs?y:y-1;
    if(parseInt(fy)!==tfy)return false;
    if(mo&&String(m)!==mo)return false;
    return true;
  });
}

// 取引の登録状態: 'reg'（登録済）/ 'prov'（仮登録）/ 'unreg'（未登録）
// 仮登録は決算書などには含めない（未登録と同じ扱い）。一括で登録済みにできる。
function txStatus(tx){
  if(tx.registered) return 'reg';
  return tx.provisional ? 'prov' : 'unreg';
}

// 登録済み仕訳のみ返す（決算書・帳簿・資産残高用）
function getRegFyTx(){
  return getFyTx().filter(tx=>tx.registered);
}

// ── 勘定科目セレクト生成 ──
function allAcOp(val=''){
  let s='<option value="">-</option>';
  const labels={assets:'資産',liabilities:'負債',equity:'純資産',income:'収益',expense:'費用'};
  for(const tp of ['assets','liabilities','equity','income','expense']){
    const accts=allAc[tp]||[];
    if(accts.length) s+=`<optgroup label="${labels[tp]}">`;
    accts.forEach(a=>s+=`<option value="${escHtml(a.name)}"${a.name===val?' selected':''}>${escHtml(a.code)} ${escHtml(a.name)}</option>`);
    if(accts.length) s+='</optgroup>';
  }
  return s;
}

function subOp(acName,val=''){
  for(const tp of ['assets','liabilities','equity','income','expense']){
    const a=(allAc[tp]||[]).find(x=>x.name===acName);
    if(a&&a.sub&&a.sub.length){
      let s='<option value="">-</option>';
      a.sub.forEach(x=>s+=`<option value="${escHtml(x.name)}"${x.name===val?' selected':''}>${escHtml(x.code)} ${escHtml(x.name)}</option>`);
      return s;
    }
  }
  return'<option value="">-</option>';
}

function allSubOp(val=''){
  let s='<option value="">-（なし）</option>';
  for(const tp of ['assets','liabilities','equity','income','expense']){
    (allAc[tp]||[]).forEach(a=>{
      if(a.sub && a.sub.length){
        s += `<optgroup label="${escHtml(a.name)}">`;
        a.sub.forEach(x=>{ s += `<option value="${escHtml(x.name)}"${x.name===val?' selected':''}>${escHtml(x.name)}</option>`; });
        s += `</optgroup>`;
      }
    });
  }
  return s;
}

function updAcF(){
  const flatOp = ['assets','liabilities','equity','income','expense']
    .flatMap(tp=>(allAc[tp]||[]).map(a=>`<option value="${escHtml(a.name)}">${escHtml(a.code)} ${escHtml(a.name)}</option>`))
    .join('');
  // 仕訳一覧の絞り込みは補助科目でも選べるよう、科目の下に補助科目を並べる
  const jaOp = ['assets','liabilities','equity','income','expense']
    .flatMap(tp=>(allAc[tp]||[]).map(a=>
      `<option value="${escHtml(a.name)}">${escHtml(a.code)} ${escHtml(a.name)}</option>`+
      (a.sub||[]).map(x=>`<option value="${escHtml(JSON.stringify([a.name,x.name]))}">　└ ${escHtml(x.name)}</option>`).join('')))
    .join('');
  const ja=document.getElementById('ja');
  if(ja){const v=ja.value;ja.innerHTML='<option value="">全勘定科目</option>'+jaOp;ja.value=v;if(ja.value!==v)ja.value='';}
  const ld=document.getElementById('ld-ac');
  if(ld) ld.innerHTML='<option value="">科目を選択</option>'+flatOp;
  const dac=document.getElementById('bl-other-debit-ac');
  const cac=document.getElementById('bl-other-credit-ac');
  if(dac) dac.innerHTML=allAcOp('普通預金');
  if(cac) cac.innerHTML=allAcOp();
}