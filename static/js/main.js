const PT = {
  dashboard: 'ダッシュボード', journal: '仕訳帳', kessan: '決算書',
  ledger: '帳簿（元帳・日記帳）', assets: '資産・残高', invoice: '請求書',
  billing: '請求シート', upload: 'PDFアップロード', rules: '自動仕訳ルール', 'credit-rules': 'クレカ仕訳ルール',
  accounts: '勘定科目', settings: '設定', claims: '交通費・立替申請', logs: '編集ログ',
  users: 'ユーザー管理', ai: 'AIアシスタント'
};

// 閲覧専用ユーザーが開けるページ（AIアシスタントは閲覧専用向けの範囲で使える）
const VIEWER_PAGES = ['kessan', 'ai'];

function nav(n) {
  // 閲覧専用は決算書のみ
  if (!isAdminUser() && !VIEWER_PAGES.includes(n)) {
    if (typeof toast === 'function') toast('閲覧専用アカウントのため決算書とAIアシスタントのみ使えます', '#f59e0b');
    n = 'kessan';
  }
  // 設定で切った機能のページは開かない
  if (PAGE_FEATURE[n] && !hasFeature(PAGE_FEATURE[n])) n = isAdminUser() ? 'dashboard' : 'kessan';
  document.body.classList.remove('tz-float');   // 浮かぶAIアシスタントは画面を移ると閉じる
  document.body.dataset.page = n;               // 決算書の画面だけ右下の丸いボタンを出す
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(x => x.classList.remove('active'));
  const page = document.getElementById('page-' + n);
  const navBtn = document.getElementById('nav-' + n);
  if (page) page.classList.add('active');
  if (navBtn) navBtn.classList.add('active');
  document.getElementById('ptitle').textContent = PT[n] || n;
  document.body.classList.toggle('tz-on', n === 'ai');   // AIアシスタント画面では年度・月の選択を隠す
  if (n === 'journal') renderJ();
  if (n === 'kessan') { popFy(); loadK(); }
  if (n === 'dashboard') loadDash();
  if (n === 'rules') loadRu();
  if (n === 'credit-rules') loadCreditRules();
  if (n === 'accounts') loadAcs();
  if (n === 'upload') { loadUploadCalendar(); loadResetHistory(); }
  if (n === 'ledger') initLedger();
  if (n === 'settings') { loadSt(); if (hasFeature('ai')) aiLoadIntegrations(); }
  if (n === 'assets') loadAssets();
  if (n === 'invoice') loadInv();
  if (n === 'billing') loadBilling();
  if (n === 'claims') loadClaimsPage();
  if (n === 'logs') loadLogs();
  if (n === 'users') loadUsers();
  if (n === 'ai') loadAiPage();
  closeSb();
}

function openSb() {
  document.getElementById('sb').classList.add('open');
  document.getElementById('sbov').classList.add('open');
}

function closeSb() {
  document.getElementById('sb').classList.remove('open');
  document.getElementById('sbov').classList.remove('open');
}

async function init() {
  // 先にログイン状態と権限を確定させる（閲覧専用なら読み込むAPIを絞るため）
  await loadCurrentUser();
  applyRoleUI();

  const admin = isAdminUser();

  // 閲覧専用は自動仕訳ルールを読まない（サーバー側でも403）
  const [t, a, r, s, mem] = await Promise.all([
    api('GET', '/transactions'),
    api('GET', '/accounts'),
    admin ? api('GET', '/rules') : Promise.resolve({ rules: [] }),
    api('GET', '/settings'),
    // メンバー名簿は決算書に不要なので閲覧専用では読まない（サーバー側でも403）
    admin ? api('GET', '/members') : Promise.resolve({ members: [] }),
  ]);
  sts = s || {};
  applyFeatureUI();
  popMonthSel();
  allTx = t.transactions || [];
  allAc = a || {};
  allRu = r.rules || [];
  sts = s || {};
  allMembers = (mem && mem.members) || [];
  document.getElementById('club-lbl').textContent = sts.club_name || '';
  popFy();
  updAcF();

  if (admin) {
    loadDash();
  } else {
    nav('kessan');   // 閲覧専用は決算書を初期表示
  }
}

// ── 編集ログ表示 ──
let _allLogs = [];

async function loadLogs() {
  const el = document.getElementById('log-list');
  if (!el) return;
  el.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">読み込み中...</p>';
  try {
    const base = getBase();
    const r = await fetch(base + '/auth.php?_path=/auth/logs');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    _allLogs = d.logs || [];
    filterLogs();
  } catch(e) {
    el.innerHTML = `<p style="color:#ef4444;text-align:center;padding:20px">ログの取得に失敗しました。<br><small>${escHtml(e.message)}</small></p>`;
  }
}


function filterLogs() {
  const el = document.getElementById('log-list');
  if (!el) return;
  const q = (document.getElementById('log-search')?.value || '').trim().toLowerCase();
  const af = (document.getElementById('log-action-filter')?.value || '');
  let logs = _allLogs;
  if (af) logs = logs.filter(l => (l.action || '') === af);
  if (q) logs = logs.filter(l =>
    (l.user_name || '').toLowerCase().includes(q) ||
    (l.user_email || '').toLowerCase().includes(q) ||
    (l.action || '').includes(q) ||
    (l.target || '').toLowerCase().includes(q) ||
    (l.detail || '').toLowerCase().includes(q)
  );

  if (!logs.length) {
    el.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">ログがありません</p>';
    return;
  }

  const actionMeta = {
    '作成':    { color: '#059669', bg: '#f0fdf4', icon: '＋' },
    '更新':    { color: '#2563eb', bg: '#eff6ff', icon: '✎' },
    '削除':    { color: '#dc2626', bg: '#fef2f2', icon: '✕' },
    'ログイン':  { color: '#7c3aed', bg: '#faf5ff', icon: '→' },
    'ログアウト': { color: '#9ca3af', bg: '#f9fafb', icon: '←' },
    '閲覧':    { color: '#0891b2', bg: '#f0f9ff', icon: '<span class="ei" data-i="eye"></span>' },
  };
  function targetLabel(t) {
    const map = {
      '/claims': '交通費・立替申請', '/transactions': '取引', '/invoices': '請求書',
      '/billing': '請求管理', '/settings': '設定', '/rules': '自動仕訳ルール',
      '/credit-rules': 'クレカ仕訳ルール', '/accounts': '勘定科目', '/members': 'メンバー',
      '/transport-deadlines': '申請締め切り', 'auth': '認証', '/ai': 'AIアシスタント',
    };
    if (!t) return '';
    for (const [k, v] of Object.entries(map)) {
      if (t === k || t.startsWith(k + '/')) return v;
    }
    return t;
  }
  function parseDetail(detail, target) {
    if (!detail) return '';
    if (!detail.trim().startsWith('{')) return detail;
    try {
      const obj = JSON.parse(detail);
      if (obj.status) {
        const stMap = { approved: '承認', rejected: '却下', pending: '未承認に戻す', paid: '返金済みに変更' };
        const st = stMap[obj.status] || obj.status;
        if (target && target.includes('claims')) return `申請を${st}`;
      }
      const parts = [];
      if (obj.date) parts.push(`日付: ${obj.date}`);
      if (obj.party) parts.push(`取引先: ${obj.party}`);
      if (obj.amount != null) parts.push(`金額: ¥${Number(obj.amount).toLocaleString()}`);
      if (obj.type) parts.push(`種別: ${obj.type}`);
      if (obj.memo != null && obj.memo !== '') parts.push(`メモ: ${obj.memo}`);
      if (obj.applicant) parts.push(`申請者: ${obj.applicant}`);
      if (obj.registered != null) parts.push(obj.registered ? '登録済み' : (obj.provisional ? '仮登録' : '未登録'));
      if (parts.length) return parts.join('　');
      const vals = Object.values(obj).filter(v => typeof v === 'string' || typeof v === 'number').slice(0, 3);
      return vals.map(String).join('　');
    } catch { return detail.slice(0, 100); }
  }
  const rows = logs.map(l => {
    const meta = actionMeta[l.action] || { color: '#64748b', bg: '#f8fafc', icon: '●' };
    const tLabel = targetLabel(l.target);
    const detail = parseDetail(l.detail, l.target);
    const tsStr = (l.ts || '').replace('T', ' ').replace(/\.\d+$/, '');
    return `<div style="display:grid;grid-template-columns:140px 76px 155px 115px 1fr;padding:10px 14px;border-bottom:1px solid #f1f5f9;align-items:start" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
      <div style="font-size:11px;color:#94a3b8;white-space:nowrap;padding-top:2px">${escHtml(tsStr)}</div>
      <div><span style="display:inline-flex;align-items:center;gap:3px;background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}33;border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700">${meta.icon} ${escHtml(l.action || '')}</span></div>
      <div style="font-size:12px;font-weight:600;color:#1e293b;padding-top:2px">${escHtml(l.user_name || '')}<div style="font-weight:400;color:#94a3b8;font-size:10px;margin-top:1px">${escHtml(l.user_email || '')}</div></div>
      <div style="font-size:12px;color:#475569;font-weight:500;padding-top:2px">${escHtml(tLabel)}</div>
      <div style="font-size:12px;color:#334155;padding-top:2px;line-height:1.5">${escHtml(detail)}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:140px 76px 155px 115px 1fr;padding:8px 14px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;color:#64748b;letter-spacing:.03em">
      <div>日時</div><div>操作</div><div>ユーザー</div><div>対象</div><div>内容</div>
    </div>
    ${rows}
    <div style="font-size:12px;color:#94a3b8;text-align:right;padding:8px 14px">${logs.length}件</div>
  `;
}

init();
