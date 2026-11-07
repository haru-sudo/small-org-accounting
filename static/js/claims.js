// ── 交通費・立替申請管理 ──

let allClaims = [];
let clSettings = {};

function clTab(t) {
  ['list', 'settings'].forEach(x => {
    const p = document.getElementById('cl-' + x + '-pane'); if (p) p.style.display = x === t ? '' : 'none';
    const b = document.getElementById('cltab-' + x); if (b) b.classList.toggle('active', x === t);
  });
  if (t === 'list') loadClaims();
  if (t === 'settings') { loadClSettings(); loadDeadlines(); }
}

async function loadClaims() {
  const d = await api('GET', '/claims');
  allClaims = d.claims || [];
  // 仕訳・登録済み判定に取引一覧が必要。未取得なら取得する
  if (!Array.isArray(allTx) || !allTx.length) {
    try { allTx = (await api('GET', '/transactions')).transactions || []; } catch (e) {}
  }
  // 「対象仕訳なし／インポート待ち」の判定に取込済み日付が必要。
  // upload_dates（＝取込時に明示した期間）だけに依存すると、期間指定漏れ・別経路取込・
  // 取得失敗時に取込済み日付が空になり、未一致の申請がすべて「インポート待ち」に落ちて
  // 「対象仕訳なし」が出なくなる。そこで upload_dates と「実際に台帳にある取引日付」の
  // 和集合を取込済みとみなす（カバー範囲を増やすだけなので誤判定方向には動かない）。
  const covered = new Set();
  try {
    const ud = (await api('GET', '/upload-dates')).dates || [];
    ud.forEach(d => covered.add(d));
  } catch (e) { /* 失敗しても下の取引日付でフォールバック */ }
  (Array.isArray(allTx) ? allTx : []).forEach(tx => {
    const d = (tx.date || '').replace(/-/g, '/');
    if (d) covered.add(d);
  });
  _clUploadedDates = covered;
  renderClaims();
}

// ── 仕訳・登録済み判定 ───────────────────────────────────────────────
// 申請側の journaled/pending_match フラグは、取引が自動ルールで先に
// 「登録済み」になると更新されず（申請マッチャーは未登録取引しか見ない）、
// 実態とズレる。そこで実際の登録済み取引を見て状態を判定する。
let _clTxByClaim = {}; // claim_id -> 登録済みtx
let _clTxByAmt = {};   // |金額| -> 登録済みtx[]

function clBuildTxIndex() {
  _clTxByClaim = {};
  _clTxByAmt = {};
  (Array.isArray(allTx) ? allTx : []).forEach(tx => {
    if (!tx.registered) return;
    if (tx.claim_id) _clTxByClaim[tx.claim_id] = tx;
    const amt = Math.abs(parseInt(tx.amount || 0));
    (_clTxByAmt[amt] = _clTxByAmt[amt] || []).push(tx);
  });
}

// この申請に対応する「登録済み取引」を探す（あれば仕訳・登録済み）
function clFindJournalTx(c) {
  if (c.id && _clTxByClaim[c.id]) return _clTxByClaim[c.id]; // 1) claim_id 直接リンク
  const amount = Math.abs(parseInt(c.amount || 0));
  const cand = _clTxByAmt[amount] || [];
  if (!cand.length) return null;
  const applicant = (c.applicant || '').trim();
  const kana = (c.person_kana || '').trim();
  for (const tx of cand) {
    if (tx.claim_id && tx.claim_id !== c.id) continue; // 別申請に紐付け済みは除外
    // 2) 自動ルール署名（"…自動:申請者 ¥金額" に申請者名を含む）
    if (applicant && (tx.auto_rule || '').includes(applicant)) return tx;
    // 3) 相手先/摘要に申請者名・カナを含む
    const party = ((tx.party || '') + ' ' + (tx.memo || '')).toLowerCase();
    if (applicant && party.includes(applicant.toLowerCase())) return tx;
    if (kana && party.includes(kana.toLowerCase())) return tx;
  }
  return null;
}

// 返金済み申請の仕訳マッチング状態を判定してステータスラベルを返す
//   登録済み取引あり or journaled=true        → 仕訳・登録済み
//   未仕訳 かつ 対象期間が未取込                → インポート待ち（PDF取込時に自動マッチング）
//   未仕訳 かつ 対象期間が取込済み（明細はある） → 対象仕訳なし（一致する仕訳が存在しない）
let _clUploadedDates = new Set(); // 取込済み日付（YYYY/MM/DD）

// この申請の対象期間（返金日／利用日 ±1日）が取込済みか
function clClaimPeriodUploaded(c) {
  if (!(_clUploadedDates instanceof Set) || !_clUploadedDates.size) return false;
  const base = c.paid_date || c.work_date || '';
  if (!base) return false;
  const d = new Date(String(base).replace(/\//g, '-'));
  if (isNaN(d)) return false;
  const fmt = dt => `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
  for (let off = -1; off <= 1; off++) {
    const dd = new Date(d); dd.setDate(dd.getDate() + off);
    if (_clUploadedDates.has(fmt(dd))) return true;
  }
  return false;
}

function clMatchBadge(c) {
  if (clFindJournalTx(c) || c.journaled) {
    return { txt: '<span class="ei" data-i="checkc"></span>仕訳・登録済み', bg: '#ecfdf5', fg: '#059669', bd: '#a7f3d0',
             title: '一致する登録済みの仕訳があります' };
  }
  // 取込済み日付が分かる場合は「取込済みなのに一致仕訳なし＝対象仕訳なし」を優先
  if (_clUploadedDates instanceof Set && _clUploadedDates.size) {
    if (clClaimPeriodUploaded(c)) {
      return { txt: '<span class="ei" data-i="search"></span>対象仕訳なし', bg: '#fef2f2', fg: '#dc2626', bd: '#fecaca',
               title: '対象期間は取込済みですが、一致する仕訳が見つかりません' };
    }
    return { txt: '<span class="ei" data-i="hourglass"></span>インポート待ち', bg: '#fffbeb', fg: '#b45309', bd: '#fde68a',
             title: '対象期間の明細が未取込です。PDF取込時に自動マッチングされます' };
  }
  // 取込済み日付を取得できない場合はフラグにフォールバック
  if (c.pending_match) {
    return { txt: '<span class="ei" data-i="hourglass"></span>インポート待ち', bg: '#fffbeb', fg: '#b45309', bd: '#fde68a' };
  }
  return { txt: '<span class="ei" data-i="search"></span>対象仕訳なし', bg: '#fef2f2', fg: '#dc2626', bd: '#fecaca' };
}

function renderClaims() {
  clBuildTxIndex();
  const typeF = document.getElementById('cl-filter-type').value;
  const statF = document.getElementById('cl-filter-status').value;
  const nameF = document.getElementById('cl-filter-name').value.trim();
  let list = [...allClaims].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (typeF) list = list.filter(c => c.type === typeF);
  if (statF) list = list.filter(c => c.status === statF);
  if (nameF) list = list.filter(c => (c.applicant || '').includes(nameF));

  const el = document.getElementById('cl-list');
  if (!list.length) { el.innerHTML = '<p style="color:var(--mu);text-align:center;padding:20px">申請なし</p>'; return; }

  const statusLabel = { pending: '<span class="ei" data-i="hourglass"></span>未承認', approved: '<span class="ei" data-i="checkc"></span>承認済', paid: '<span class="ei" data-i="send"></span>返金済', rejected: '<span class="ei" data-i="xc"></span>却下' };
  const statusColor = { pending: '#f59e0b', approved: '#059669', paid: '#3b82f6', rejected: '#ef4444' };

  el.innerHTML = list.map(c => {
    const amount = parseInt(c.amount || 0);
    const typeLabel = c.type === 'transport' ? '<span class="ei" data-i="train"></span>交通費' : '<span class="ei" data-i="box"></span>立替';
    // meal_allowance はDBカラムがない場合 route_detail からパース
    const mealFromDetail = (() => {
      const m = (c.route_detail || '').match(/【食事代\s*[¥￥](\d+)】/);
      return m ? parseInt(m[1]) : 0;
    })();
    const mealAmt = parseInt(c.meal_allowance || 0) || mealFromDetail;
    const transportAmt = amount - mealAmt;
    const manualBadge = c.is_manual ? `<span class="badge" style="background:#fef9c3;color:#854d0e;border:1px solid #fde047"><span class="ei" data-i="alert"></span>手動申請</span>` : '';
    const ticketBadge = (c.type === 'transport' && c.ticket_type === 'normal')
      ? `<span class="badge" style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;margin-left:4px"><span class="ei" data-i="ticket"></span>切符申請</span>`
      : '';
    const stat = c.status || 'pending';
    // 領収書バッジ（claim.receipt_file が存在する場合）
    const receiptBadge = c.receipt_file
      ? `<span class="badge" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;cursor:pointer" onclick="viewClaimReceipt(event,'${escJsAttr(c.id)}')"><span class="ei" data-i="receipt"></span>領収書</span>`
      : '';



    const desc = c.type === 'transport'
      ? `${c.work_destination || ''} ${c.from_station || ''}→${c.to_station || ''}`
      : `${c.usage || ''} ${c.store ? `(${c.store})` : ''}`;

    // 経路詳細：往路・復路をパースして見やすく表示
    const routeDetailHtml = (() => {
      if (!c.route_detail) return '';
      const lines = c.route_detail.split('\n').filter(Boolean);
      // 往路・復路のセクションに分ける
      let sections = [];
      let current = null;
      lines.forEach(l => {
        if (l.startsWith('【') || l.startsWith('[')) {
          if (current) sections.push(current);
          current = { header: l, items: [] };
        } else if (current) {
          current.items.push(l);
        } else {
          sections.push({ header: null, items: [l] });
        }
      });
      if (current) sections.push(current);

      if (!sections.length) return '';

      return sections.map(s => {
        const itemsHtml = s.items.map(item => {
          // 路線名の行（→含む）
          const isRoute = item.includes('→') || item.includes('▶');
          // 乗り換え行
          const isTransfer = item.includes('乗り換え') || item.includes('乗換');
          // 金額行
          const isFare = item.includes('¥') || item.includes('円') || item.includes('運賃');
          let style = 'font-size:12px;color:#374151;padding:2px 0 2px 8px;border-left:2px solid #e2e8f0;margin:2px 0';
          if (isFare) style = 'font-size:12px;color:#059669;font-weight:600;padding:3px 8px;background:#f0fdf4;border-radius:4px;margin-top:4px;display:inline-block';
          else if (isTransfer) style = 'font-size:11px;color:#64748b;padding:1px 0 1px 8px;border-left:2px dashed #cbd5e1;margin:1px 0';
          return `<div style="${style}">${escHtml(item)}</div>`;
        }).join('');

        return `<div style="margin-bottom:${s.header ? '8px' : '0'}">
          ${s.header ? `<div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:.05em;margin-bottom:4px">${escHtml(s.header)}</div>` : ''}
          ${itemsHtml}
        </div>`;
      }).join('');
    })();

    return `<div style="border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:10px;background:${stat === 'rejected' ? '#fafafa' : '#fff'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <span class="badge" style="background:#f1f5f9;color:#475569">${typeLabel}</span>
            ${manualBadge}${ticketBadge}
            ${receiptBadge}
            <strong>${escHtml(c.applicant || '')}</strong>
            ${(() => {
              // 申請日を表示。立替申請などで申請日が未入力の場合は登録日(created_at)で
              // 代替する。実際の申請日との区別はツールチップで示す。
              const ad = c.application_date || (c.created_at || '').split(' ')[0] || '';
              if (!ad) return '';
              const approx = !c.application_date;
              return `<span style="font-size:12px;color:var(--mu)"${approx ? ' title="登録日（申請日が未入力のため代替表示）"' : ''}>${escHtml(ad)} 申請</span>`;
            })()}
            ${c.work_date ? `<span style="font-size:12px;color:var(--mu)">利用日: ${escHtml(c.work_date)}</span>` : ''}
          </div>
          <div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:4px">${escHtml(desc)}</div>
          ${routeDetailHtml ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin:6px 0 8px">${routeDetailHtml}</div>` : ''}
          ${c.memo ? `<div style="font-size:12px;color:var(--mu)"><span class="ei" data-i="edit"></span>${escHtml(c.memo)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700;color:var(--p)">¥${amount.toLocaleString()}</div>
          ${c.type === 'transport'
            ? (mealAmt > 0
                ? `<div style="font-size:11px;color:#64748b;margin-top:2px;white-space:nowrap"><span class="ei" data-i="train"></span>¥${transportAmt.toLocaleString()} + <span class="ei" data-i="meal"></span>¥${mealAmt.toLocaleString()}</div>`
                : `<div style="font-size:11px;color:#64748b;margin-top:2px;white-space:nowrap"><span class="ei" data-i="train"></span>¥${amount.toLocaleString()}</div>`)
            : ''}
          <span class="badge" style="background:${statusColor[stat]}1a;color:${statusColor[stat]};border:1px solid ${statusColor[stat]}66">${statusLabel[stat]}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9">
        ${stat === 'approved' && !c.journaled ? `
          <button class="btn bp bsm" onclick="openJournalClaim('${escJsAttr(c.id)}')"><span class="ei" data-i="book"></span>仕訳登録・返金済へ</button>
        `: ''}
        ${stat === 'approved' && c.journaled ? `
          <span style="font-size:12px;color:var(--in)">✓ 仕訳登録済</span>
        `: ''}
        ${stat === 'paid' ? (() => {
          const mb = clMatchBadge(c);
          return `<span style="font-size:12px;color:#3b82f6">✓ 返金済 ${escHtml(c.paid_date || '')}</span>
          <span class="badge" title="${(mb.title || '').replace(/"/g, '')}" style="background:${mb.bg};color:${mb.fg};border:1px solid ${mb.bd}">${mb.txt}</span>`;
        })() : ''}
        ${stat === 'pending' ? `
          <button class="btn bg bsm" onclick="approveClaim('${escJsAttr(c.id)}')">承認</button>
          <button class="btn bd2 bsm" onclick="rejectClaim('${escJsAttr(c.id)}')">却下</button>
        `: ''}
        <button class="btn bs bsm" onclick="editClaim('${escJsAttr(c.id)}')">編集</button>
        <button class="btn bd2 bsm" onclick="deleteClaim('${escJsAttr(c.id)}')">削除</button>
      </div>
    </div>`;
  }).join('');
}


function _claimLabel(c) {
  if (!c) return '';
  const who = c.applicant || '不明';
  const type = c.type === 'transport' ? '交通費' : '立替';
  const date = c.work_date || c.application_date || c.date || '';
  const amt = c.amount != null ? '¥' + Number(c.amount).toLocaleString() : '';
  let s = `${who}さんの${type}申請`;
  const extra = [date && date, amt].filter(Boolean);
  if (extra.length) s += `（${extra.join('・')}）`;
  return s;
}

async function approveClaim(id) {
  const c = allClaims.find(x => x.id === id);
  await api('PUT', '/claims/' + id, { status: 'approved', _skipLog: true });
  if (c) c.status = 'approved';
  logChange('更新', '/claims', `${_claimLabel(c)} を承認しました`);
  renderClaims();
  toast('承認しました', '#059669');
}

async function rejectClaim(id) {
  if (!confirm('この申請を却下しますか？')) return;
  const c = allClaims.find(x => x.id === id);
  await api('PUT', '/claims/' + id, { status: 'rejected', _skipLog: true });
  if (c) c.status = 'rejected';
  logChange('更新', '/claims', `${_claimLabel(c)} を却下しました`);
  renderClaims();
  toast('却下しました', '#ef4444');
}

async function deleteClaim(id) {
  if (!confirm('この申請を削除しますか？')) return;
  const c = allClaims.find(x => x.id === id);
  await api('DELETE', '/claims/' + id, { _skipLog: true });
  logChange('削除', '/claims', `${_claimLabel(c)} を削除しました`);
  allClaims = allClaims.filter(x => x.id !== id);
  renderClaims();
  toast('削除しました');
}

// メンバーマスタから申請者のカナを取得（氏名一致 → 苗字一致 → 空欄）
// 返金処理ダイアログ・編集ダイアログの両方で、person_kana が未設定のときの
// フォールバック（自動入力）に使う共通ロジック。
function lookupMemberKana(applicant) {
  if (!applicant || !Array.isArray(allMembers)) return '';
  const member = allMembers.find(m => m.name === applicant);
  if (member && member.kana) return member.kana;
  // 苗字のみで一致するメンバーを探す
  const surname = applicant.split(/[ 　]/)[0];
  const byFamily = allMembers.find(m => m.name && m.kana &&
    (m.name.startsWith(surname) || surname.startsWith(m.name.split(/[ 　]/)[0])));
  return byFamily ? byFamily.kana : '';
}

async function openJournalClaim(id) {
  const c = allClaims.find(x => x.id === id); if (!c) return;
  const amount = parseInt(c.amount || 0);
  const paidDate = new Date().toISOString().slice(0, 10);

  // allMembersが未取得の場合はAPIから取得
  if (!allMembers || allMembers.length === 0) {
    try {
      const md = await api('GET', '/members');
      allMembers = md.members || [];
    } catch(e) { allMembers = []; }
  }

  // メンバーマスタからカナを取得（氏名一致 → 苗字一致 → 空欄）
  const defaultKana = lookupMemberKana(c.applicant);

  document.getElementById('mbody').innerHTML = `
    <div style="margin-bottom:14px">
      <p style="font-size:13px;color:#374151;margin-bottom:10px">
        <strong>${escHtml(c.applicant || '')}</strong>（¥${amount.toLocaleString()}）の返金処理を行います。<br>
        <span style="font-size:12px;color:#64748b">返金日前後の仕訳から申請者・金額が一致するものを自動マッチングします。</span>
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px">返金日</label>
          <input type="date" id="jcl-paid-date" class="fi" style="width:100%" value="${paidDate}" oninput="previewClaimMatch('${escJsAttr(id)}')">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px">カナ（マッチング用）${defaultKana ? ` <span style="font-size:10px;background:#dbeafe;color:#1d4ed8;border-radius:3px;padding:1px 5px;margin-left:4px;font-weight:500"><span class="ei" data-i="user"></span>メンバーマスタから自動入力</span>` : ''}</label>
          <input type="text" id="jcl-kana" class="fi" style="width:100%;transition:background 0.4s" value="${escHtml(defaultKana)}" oninput="previewClaimMatch('${escJsAttr(id)}')" placeholder="半角カナ">
        </div>
      </div>
      <div id="jcl-match-preview" style="margin-bottom:12px">
        <div style="text-align:center;padding:20px;color:#94a3b8;font-size:13px">
          返金日を設定するとマッチング候補を表示します
        </div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:12px">
        <div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px">仕訳が見つからない場合 — 科目設定</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <label style="font-size:11px;color:#64748b;display:block;margin-bottom:3px">借方科目</label>
            <select id="jcl-debit" class="fi" style="width:100%" onchange="document.getElementById('jcl-debit-sub').innerHTML=subOp(this.value,'')">${allAcOp(c.type === 'transport' ? (clSettings.transport_debit || '交通費') : (clSettings.advance_debit || '立替金'))}</select>
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;display:block;margin-bottom:3px">借方補助</label>
            <select id="jcl-debit-sub" class="fi" style="width:100%">${subOp(c.type === 'transport' ? (clSettings.transport_debit || '交通費') : (clSettings.advance_debit || '立替金'), c.type === 'transport' ? (clSettings.transport_debit_sub || '') : (clSettings.advance_debit_sub || ''))}</select>
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;display:block;margin-bottom:3px">貸方科目</label>
            <select id="jcl-credit" class="fi" style="width:100%" onchange="document.getElementById('jcl-credit-sub').innerHTML=subOp(this.value,'')">${allAcOp(clSettings.refund_credit || '普通預金')}</select>
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;display:block;margin-bottom:3px">貸方補助</label>
            <select id="jcl-credit-sub" class="fi" style="width:100%">${subOp(clSettings.refund_credit || '普通預金', clSettings.refund_credit_sub || '')}</select>
          </div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn bs" onclick="closeM()">キャンセル</button>
      <button class="btn bp" onclick="execJournalClaim('${escJsAttr(id)}')"><span class="ei" data-i="checkc"></span>返金済にする</button>
    </div>`;
  document.getElementById('mtitle').textContent = '返金処理';
  document.getElementById('detov').classList.add('open');
  // 初期プレビュー & カナ自動入力ハイライト
  setTimeout(() => {
    previewClaimMatch(id);
    if (defaultKana) {
      const kanaEl = document.getElementById('jcl-kana');
      if (kanaEl) {
        kanaEl.style.background = '#dbeafe';
        setTimeout(() => { kanaEl.style.background = ''; }, 1200);
      }
    }
  }, 100);
}

// 全角→半角カナ変換
function toHankakuKana(str) {
  const map = {
    'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ', 'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
    'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ', 'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
    'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ', 'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
    'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ', 'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
    'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ', 'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
    'ァ': 'ｧ', 'ィ': 'ｨ', 'ゥ': 'ｩ', 'ェ': 'ｪ', 'ォ': 'ｫ', 'ッ': 'ｯ', 'ャ': 'ｬ', 'ュ': 'ｭ', 'ョ': 'ｮ',
    'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ', 'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
    'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ', 'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
    'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ', 'ー': 'ｰ', '　': ' '
  };
  return str.split('').map(c => map[c] || c).join('');
}

// 返金日前後の仕訳をプレビュー
function previewClaimMatch(id) {
  const c = allClaims.find(x => x.id === id); if (!c) return;
  const amount = parseInt(c.amount || 0);
  const paidDate = document.getElementById('jcl-paid-date')?.value;
  const kana = document.getElementById('jcl-kana')?.value || '';
  const el = document.getElementById('jcl-match-preview');
  if (!el || !paidDate) return;

  // 返金日 ±1 日の範囲を計算
  const d = new Date(paidDate);
  const d0 = new Date(d); d0.setDate(d0.getDate() - 1);
  const d1 = new Date(d); d1.setDate(d1.getDate() + 1);
  const fmt = dt => dt.toISOString().slice(0, 10).replace(/-/g, '/');
  const rangeStart = fmt(d0);
  const rangeEnd = fmt(d1);

  // allTx から対象仕訳を検索（日付範囲内 & 金額一致 & 相手先に申請者名/カナを含む）
  const candidates = (allTx || []).filter(tx => {
    if (tx.registered) return false; // 登録済みは対象外
    const txDate = (tx.date || '').replace(/-/g, '/');
    if (txDate < rangeStart || txDate > rangeEnd) return false;
    const txAmount = Math.abs(parseInt(tx.amount || 0));
    if (txAmount !== amount) return false;
    const party = (tx.party || tx.description || tx.memo || '').toLowerCase();
    const kanaLower = kana.toLowerCase();
    const nameLower = (c.applicant || '').toLowerCase();
    return kana ? party.includes(kanaLower) || party.includes(nameLower) : party.includes(nameLower);
  });

  if (!candidates.length) {
    el.innerHTML = `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:10px 12px;font-size:12px;color:#713f12">
      <strong><span class="ei" data-i="alert"></span>対象期間（${escHtml(rangeStart)}〜${escHtml(rangeEnd)}）に一致する仕訳が見つかりません</strong><br>
      PDFアップロード時に自動でマッチングされます。下の科目設定を保存しておいてください。
    </div>`;
    return;
  }

  const rows = candidates.map(tx => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 8px;font-size:12px;color:#64748b">${escHtml(tx.date || '')}</td>
      <td style="padding:7px 8px;font-size:12px;font-weight:600">${escHtml(tx.party || tx.description || '')}</td>
      <td style="padding:7px 8px;font-size:12px">${escHtml(tx.debit_account || '')}</td>
      <td style="padding:7px 8px;font-size:12px">${escHtml(tx.credit_account || '')}</td>
      <td style="padding:7px 8px;font-size:12px;text-align:right;font-weight:700;color:#059669">¥${Math.abs(parseInt(tx.amount || 0)).toLocaleString()}</td>
      <td style="padding:7px 8px">
        <span style="font-size:11px;background:#dcfce7;color:#166534;border-radius:4px;padding:2px 6px;font-weight:700">✓ マッチ</span>
      </td>
    </tr>`).join('');

  el.innerHTML = `<div style="border:1px solid #86efac;border-radius:8px;overflow:hidden">
    <div style="background:#f0fdf4;padding:7px 12px;font-size:11px;font-weight:700;color:#166534">
      <span class="ei" data-i="checkc"></span>${candidates.length}件の仕訳が見つかりました（返金処理時に自動マッチングされます）
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f8fafc;font-size:11px;color:#64748b">
          <th style="padding:6px 8px;text-align:left">日付</th>
          <th style="padding:6px 8px;text-align:left">相手先</th>
          <th style="padding:6px 8px;text-align:left">借方</th>
          <th style="padding:6px 8px;text-align:left">貸方</th>
          <th style="padding:6px 8px;text-align:right">金額</th>
          <th style="padding:6px 8px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

async function execJournalClaim(id) {
  const c = allClaims.find(x => x.id === id); if (!c) return;
  const paidDate = document.getElementById('jcl-paid-date').value.replace(/-/g, '/');
  const kana = document.getElementById('jcl-kana')?.value || '';
  // 返金ダイアログで選んだ科目を控えておき、サーバ保存とローカル(allClaims)反映の
  // 両方に使う。ローカルへ書き戻さないと、返金直後に編集画面を開いたとき
  // fallback_debit 等が未設定のままデフォルト（立替金/交通費）に戻って見えてしまう。
  const fbDebit     = document.getElementById('jcl-debit')?.value || '';
  const fbDebitSub  = document.getElementById('jcl-debit-sub')?.value || '';
  const fbCredit    = document.getElementById('jcl-credit')?.value || '';
  const fbCreditSub = document.getElementById('jcl-credit-sub')?.value || '';

  // 返金済みステータスに更新
  await api('PUT', '/claims/' + id, {
    status: 'paid',
    paid_date: paidDate,
    person_kana: kana,
    fallback_debit: fbDebit,
    fallback_debit_sub: fbDebitSub,
    fallback_credit: fbCredit,
    fallback_credit_sub: fbCreditSub,
    pending_match: true,  // PDFアップロード時に再マッチングを試みる
    _skipLog: true,
  });
  logChange('更新', '/claims', `${_claimLabel(c)} を返金済みにしました（返金日 ${paidDate}）`);

  // マッチした仕訳に対してルール適用（申請者カナ＋金額で一致した仕訳の科目を補完）
  const amount = parseInt(c.amount || 0);
  const d = new Date(paidDate.replace(/\//g, '-'));
  const d0 = new Date(d); d0.setDate(d0.getDate() - 1);
  const d1 = new Date(d); d1.setDate(d1.getDate() + 1);
  const fmt = dt => dt.toISOString().slice(0, 10).replace(/-/g, '/');

  const matched = (allTx || []).filter(tx => {
    if (tx.registered) return false; // 登録済みは対象外
    const txDate = (tx.date || '').replace(/-/g, '/');
    if (txDate < fmt(d0) || txDate > fmt(d1)) return false;
    if (Math.abs(parseInt(tx.amount || 0)) !== amount) return false;
    const party = (tx.party || tx.description || tx.memo || '').toLowerCase();
    return kana ? party.includes(kana.toLowerCase()) || party.includes((c.applicant || '').toLowerCase())
      : party.includes((c.applicant || '').toLowerCase());
  });

  // 摘要: 交通費は「M/D行き先交通費」、立替は申請画面のメモ（空なら用途）
  const defMemo = buildClaimMemo(c);

  const defDebit = fbDebit || (c.type === 'transport' ? (clSettings.transport_debit || '交通費') : (clSettings.advance_debit || '立替金'));
  const defDSub = fbDebitSub || '';
  const defCredit = fbCredit || clSettings.refund_credit || '普通預金';
  const defCSub = fbCreditSub || '';

  for (const tx of matched) {
    // 科目は entries（＝仕訳帳の表示元）を見て空欄判定する
    const e0 = (tx.entries || [])[0] || {};
    const update = { registered: true, claim_id: id };
    if (!e0.debit_account) { update.debit_account = defDebit; update.debit_sub = defDSub; }
    if (!e0.credit_account) { update.credit_account = defCredit; update.credit_sub = defCSub; }
    // 立替は申請メモを摘要の正とする（交通費は空欄のみ補完）
    if (defMemo && (c.type !== 'transport' || !tx.memo)) update.memo = defMemo;
    // 仕訳帳に「立替自動:○○ ¥金額」のラベルを出す
    if (isClaimAutoRuleLabel(tx.auto_rule)) update.auto_rule = claimAutoRuleLabel(c);
    // 申請に領収書があり、仕訳側に未添付なら引き継ぐ（返金時に領収書を自動添付）
    if (c.receipt_file && !tx.receipt_file) { update.receipt_file = c.receipt_file; }
    await api('PUT', '/transactions/' + tx.id, update);
  }
  const c2 = allClaims.find(x => x.id === id);
  if (c2) {
    // サーバに保存した内容をローカルにも反映（科目・カナを書き戻さないと
    // 返金直後の編集画面でデフォルトに戻って見える）
    Object.assign(c2, {
      status: 'paid', paid_date: paidDate, person_kana: kana,
      fallback_debit: fbDebit, fallback_debit_sub: fbDebitSub,
      fallback_credit: fbCredit, fallback_credit_sub: fbCreditSub,
      journaled: matched.length > 0,
      pending_match: matched.length === 0,
    });
    // journal_tx_id を保存しておくと、この申請の自動ルールが「使い切り」と判定され、
    // 後日の同額の別出金に摘要・科目が付かなくなる
    if (matched.length > 0) {
      await api('PUT', '/claims/' + id, { pending_match: false, journaled: true, journal_tx_id: matched[0].id });
      c2.journal_tx_id = matched[0].id;
    }
  }

  // 自動仕訳ルールを自動登録（今後のPDFアップロードで同パターンを自動仕訳）
  if (kana) {
    const ruleType = c.type === 'transport' ? '交通費' : '立替';
    const ruleName = claimAutoRuleLabel(c);
    // 既存ルールと重複チェック
    const existingRules = allRu || [];
    const alreadyExists = existingRules.some(r =>
      r.pattern === kana && parseInt(r.exact_amount || 0) === amount
    );
    if (!alreadyExists) {
      const newRule = {
        name: ruleName,
        pattern: kana,
        exact_amount: amount,
        debit_account: defDebit,
        debit_sub: defDSub,
        credit_account: defCredit,
        credit_sub: defCSub,
        // 立替は「アダチ 7月分立替」ではなく申請メモをそのまま摘要にする
        memo_template: c.type === 'transport'
          ? `{$利用日} {$行き先}`
          : (buildAdvanceMemo(c) || `{$苗字} {$取引月}月分${ruleType}`),
        claim_id: c.id,
        priority: (existingRules.length + 1),
      };
      existingRules.push(newRule);
      existingRules.forEach((r, i) => r.priority = existingRules.length - i);
      await api('POST', '/rules', { rules: existingRules });
      allRu = existingRules;
      toast(`自動仕訳ルール「${ruleName}」を登録しました`, '#1a56db');
    }
  }

  allTx = (await api('GET', '/transactions')).transactions || allTx;
  closeM(); renderClaims(); loadDash();
  toast(matched.length ? `返金済にしました（${matched.length}件の仕訳をマッチング）` : '返金済にしました（PDFアップロード時に自動マッチングします）', '#059669');
}

function editClaim(id) {
  const c = allClaims.find(x => x.id === id); if (!c) return;
  const cur = c.status;
  const opts = ['pending', 'approved', 'paid', 'rejected'].map(s =>
    `<option value="${s}"${s === cur ? ' selected' : ''}>${{ pending: '未承認', approved: '承認済', paid: '返金済', rejected: '却下' }[s]}</option>`
  ).join('');

  // 返金済みのときは返金日・カナ・科目も修正できるようにする
  const isPaid = cur === 'paid';
  const defD  = c.fallback_debit  || (c.type === 'transport' ? (clSettings.transport_debit || '交通費') : (clSettings.advance_debit || '立替金'));
  const defDS = c.fallback_debit_sub  || '';
  const defC  = c.fallback_credit || clSettings.refund_credit || '普通預金';
  const defCS = c.fallback_credit_sub || '';
  // カナ（マッチング用）: 保存済みの person_kana を優先。未設定（インポート待ちで
  // カナ未捕捉のケース等）の場合はメンバーマスタから自動補完して空欄を防ぐ。
  const savedKana = (c.person_kana || '').trim();
  const kanaVal   = savedKana || lookupMemberKana(c.applicant);
  const kanaAuto  = !savedKana && !!kanaVal;  // マスタから自動補完したか
  const refundFields = isPaid ? `
    <div class="full" style="border-top:1px solid #e2e8f0;margin-top:6px;padding-top:12px">
      <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:10px">返金・仕訳情報の修正</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label>返金日</label><input type="date" id="ec-paid-date" class="fi" style="width:100%" value="${escHtml((c.paid_date || '').replace(/\//g, '-'))}"></div>
        <div><label>カナ（マッチング用）${kanaAuto ? ` <span style="font-size:10px;background:#dbeafe;color:#1d4ed8;border-radius:3px;padding:1px 5px;margin-left:4px;font-weight:500"><span class="ei" data-i="user"></span>メンバーマスタから自動入力</span>` : ''}</label><input type="text" id="ec-kana" class="fi" style="width:100%" value="${escHtml(kanaVal)}" placeholder="半角カナ"></div>
        <div><label>借方科目</label><select id="ec-debit" class="fi" style="width:100%" onchange="document.getElementById('ec-debit-sub').innerHTML=subOp(this.value,'')">${allAcOp(defD)}</select></div>
        <div><label>借方補助</label><select id="ec-debit-sub" class="fi" style="width:100%">${subOp(defD, defDS)}</select></div>
        <div><label>貸方科目</label><select id="ec-credit" class="fi" style="width:100%" onchange="document.getElementById('ec-credit-sub').innerHTML=subOp(this.value,'')">${allAcOp(defC)}</select></div>
        <div><label>貸方補助</label><select id="ec-credit-sub" class="fi" style="width:100%">${subOp(defC, defCS)}</select></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn bp bsm" onclick="rematchClaim('${escJsAttr(id)}')"><span class="ei" data-i="refresh"></span>この内容で再マッチング</button>
        <button class="btn bs bsm" onclick="revertClaimPaid('${escJsAttr(id)}')">↩️ 返金を取り消す</button>
      </div>
      <div style="font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.6">
        ※「再マッチング」＝返金日±3日の仕訳から金額・カナ一致を探して仕訳を補完・紐付けします（自動ルールで登録済みの仕訳も拾います）。<br>
        ※「返金取消」＝状態を承認済みに戻します（紐付いた仕訳の登録自体は解除しません）。
      </div>
    </div>` : '';

  document.getElementById('mbody').innerHTML = `
    <div class="fg">
      <div><label>金額</label><input type="number" id="ec-amount" class="fi" value="${parseInt(c.amount || 0) || 0}" style="width:100%"></div>
      <div><label>状態</label><select id="ec-status" class="fi" style="width:100%">${opts}</select></div>
      <div class="full"><label>メモ</label><input type="text" id="ec-memo" class="fi" style="width:100%" value="${escHtml(c.memo || '')}"></div>
      ${refundFields}
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
      <button class="btn bs" onclick="closeM()">キャンセル</button>
      <button class="btn bp" onclick="saveEditClaim('${escJsAttr(id)}')"><span class="ei" data-i="save"></span>保存</button>
    </div>`;
  document.getElementById('mtitle').textContent = '申請編集';
  document.getElementById('detov').classList.add('open');
}

async function saveEditClaim(id) {
  const c = allClaims.find(x => x.id === id);
  const newStatus = document.getElementById('ec-status').value;
  const newAmount = parseInt(document.getElementById('ec-amount').value) || 0;
  const newMemo = document.getElementById('ec-memo').value;
  const data = { amount: newAmount, status: newStatus, memo: newMemo };

  // 返金情報フィールドが出ていれば一緒に保存
  const pdEl = document.getElementById('ec-paid-date');
  if (pdEl) {
    data.paid_date = pdEl.value ? pdEl.value.replace(/-/g, '/') : '';
    data.person_kana = document.getElementById('ec-kana')?.value || '';
    data.fallback_debit = document.getElementById('ec-debit')?.value || '';
    data.fallback_debit_sub = document.getElementById('ec-debit-sub')?.value || '';
    data.fallback_credit = document.getElementById('ec-credit')?.value || '';
    data.fallback_credit_sub = document.getElementById('ec-credit-sub')?.value || '';
  }

  // 変更点を検出して説明文を作成
  const changes = [];
  if (c) {
    if (Number(c.amount) !== newAmount) changes.push(`金額を ¥${Number(c.amount||0).toLocaleString()} → ¥${newAmount.toLocaleString()}`);
    const stLabel = { pending: '未承認', approved: '承認済', rejected: '却下', paid: '返金済' };
    if ((c.status||'') !== newStatus) changes.push(`状態を「${stLabel[c.status]||c.status||'未承認'}」→「${stLabel[newStatus]||newStatus}」`);
    if ((c.memo||'') !== newMemo) changes.push('メモを変更');
    if (pdEl) {
      if ((c.paid_date||'') !== (data.paid_date||'')) changes.push('返金日を変更');
      if ((c.person_kana||'') !== (data.person_kana||'')) changes.push('カナを変更');
      if ((c.fallback_debit||'') !== data.fallback_debit || (c.fallback_credit||'') !== data.fallback_credit) changes.push('仕訳科目を変更');
    }
  }

  await api('PUT', '/claims/' + id, { ...data, _skipLog: true });
  if (c) Object.assign(c, data);
  const desc = changes.length
    ? `${_claimLabel(c)} を編集：${changes.join('、')}`
    : `${_claimLabel(c)} を編集しました`;
  logChange('更新', '/claims', desc);
  closeM(); renderClaims();
  toast('保存しました', '#059669');
}

// 編集モーダルの返金情報で仕訳を再マッチング（自動ルールで登録済みの仕訳も救済して紐付ける）
async function rematchClaim(id) {
  const c = allClaims.find(x => x.id === id); if (!c) return;
  const paidDate = (document.getElementById('ec-paid-date')?.value
    ? document.getElementById('ec-paid-date').value.replace(/-/g, '/')
    : (c.paid_date || '').replace(/-/g, '/'));
  const kana    = document.getElementById('ec-kana')?.value ?? (c.person_kana || '');
  const defD    = document.getElementById('ec-debit')?.value || c.fallback_debit || (c.type === 'transport' ? (clSettings.transport_debit || '交通費') : (clSettings.advance_debit || '立替金'));
  const defDS   = document.getElementById('ec-debit-sub')?.value || c.fallback_debit_sub || '';
  const defC    = document.getElementById('ec-credit')?.value || c.fallback_credit || clSettings.refund_credit || '普通預金';
  const defCS   = document.getElementById('ec-credit-sub')?.value || c.fallback_credit_sub || '';
  const amount  = Math.abs(parseInt(c.amount || 0));

  if (!Array.isArray(allTx) || !allTx.length) {
    try { allTx = (await api('GET', '/transactions')).transactions || []; } catch (e) {}
  }
  clBuildTxIndex();

  // 1) すでに登録済みの一致仕訳があれば紐付けるだけ（自動ルール登録済みのケースを救済）
  const existing = clFindJournalTx({ ...c, person_kana: kana });
  if (existing) {
    const e0 = (existing.entries || [])[0] || {};
    const upd = { claim_id: id };
    if (!e0.debit_account)  { upd.debit_account  = defD; upd.debit_sub  = defDS; }
    if (!e0.credit_account) { upd.credit_account = defC; upd.credit_sub = defCS; }
    // 立替は申請メモを摘要の正とする
    const m = buildClaimMemo(c);
    if (m && (c.type !== 'transport' || !existing.memo)) upd.memo = m;
    if (isClaimAutoRuleLabel(existing.auto_rule)) upd.auto_rule = claimAutoRuleLabel(c);
    if (c.receipt_file && !existing.receipt_file) upd.receipt_file = c.receipt_file;
    if (existing.claim_id !== id || Object.keys(upd).length > 1) {
      await api('PUT', '/transactions/' + existing.id, upd); existing.claim_id = id;
    }
    await api('PUT', '/claims/' + id, { pending_match: false, journaled: true, journal_tx_id: existing.id, person_kana: kana, paid_date: paidDate, fallback_debit: defD, fallback_debit_sub: defDS, fallback_credit: defC, fallback_credit_sub: defCS, _skipLog: true });
    Object.assign(c, { pending_match: false, journaled: true, person_kana: kana, paid_date: paidDate, fallback_debit: defD, fallback_credit: defC });
    logChange('更新', '/claims', `${_claimLabel(c)} を登録済み仕訳に紐付けました`);
    allTx = (await api('GET', '/transactions')).transactions || allTx;
    closeM(); renderClaims(); loadDash();
    toast('登録済みの仕訳に紐付けました', '#059669');
    return;
  }

  // 2) 未登録の一致仕訳を探して登録（返金日±3日）
  const d  = new Date(paidDate.replace(/\//g, '-'));
  const d0 = new Date(d); d0.setDate(d0.getDate() - 3);
  const d1 = new Date(d); d1.setDate(d1.getDate() + 3);
  const fmt = dt => dt.toISOString().slice(0, 10).replace(/-/g, '/');
  const matched = (allTx || []).filter(tx => {
    if (tx.registered) return false;
    const txDate = (tx.date || '').replace(/-/g, '/');
    if (txDate < fmt(d0) || txDate > fmt(d1)) return false;
    if (Math.abs(parseInt(tx.amount || 0)) !== amount) return false;
    const party = (tx.party || tx.memo || '').toLowerCase();
    return kana ? (party.includes(kana.toLowerCase()) || party.includes((c.applicant || '').toLowerCase()))
                : party.includes((c.applicant || '').toLowerCase());
  });

  const defMemo = buildClaimMemo(c);
  for (const tx of matched) {
    const e0 = (tx.entries || [])[0] || {};
    const update = { registered: true, claim_id: id };
    if (!e0.debit_account)  { update.debit_account  = defD; update.debit_sub  = defDS; }
    if (!e0.credit_account) { update.credit_account = defC; update.credit_sub = defCS; }
    if (defMemo && (c.type !== 'transport' || !tx.memo)) update.memo = defMemo;
    if (isClaimAutoRuleLabel(tx.auto_rule)) update.auto_rule = claimAutoRuleLabel(c);
    if (c.receipt_file && !tx.receipt_file) update.receipt_file = c.receipt_file;
    await api('PUT', '/transactions/' + tx.id, update);
  }
  const journaled = matched.length > 0;
  await api('PUT', '/claims/' + id, {
    journal_tx_id: journaled ? matched[0].id : (c.journal_tx_id || ''),
    person_kana: kana, paid_date: paidDate,
    fallback_debit: defD, fallback_debit_sub: defDS, fallback_credit: defC, fallback_credit_sub: defCS,
    pending_match: !journaled, journaled, _skipLog: true,
  });
  Object.assign(c, { person_kana: kana, paid_date: paidDate, fallback_debit: defD, fallback_credit: defC, pending_match: !journaled, journaled });
  logChange('更新', '/claims', `${_claimLabel(c)} を再マッチング（${journaled ? matched.length + '件紐付け' : '該当なし・インポート待ち'}）`);
  allTx = (await api('GET', '/transactions')).transactions || allTx;
  closeM(); renderClaims(); loadDash();
  toast(journaled ? `${matched.length}件の仕訳をマッチングしました` : '一致仕訳なし。次回PDF取込で自動マッチングします', journaled ? '#059669' : '#b45309');
}

// 返金を取り消して承認済みに戻す
async function revertClaimPaid(id) {
  const c = allClaims.find(x => x.id === id); if (!c) return;
  if (!confirm('返金を取り消して「承認済み」に戻します。よろしいですか？\n（すでに紐付いた仕訳の登録自体は解除されません）')) return;
  await api('PUT', '/claims/' + id, { status: 'approved', paid_date: '', journaled: false, pending_match: false, _skipLog: true });
  Object.assign(c, { status: 'approved', paid_date: '', journaled: false, pending_match: false });
  logChange('更新', '/claims', `${_claimLabel(c)} の返金を取り消し、承認済みに戻しました`);
  closeM(); renderClaims(); loadDash();
  toast('↩️ 承認済みに戻しました', '#64748b');
}

// ── 新規申請フォーム ──
function initClNew() {
  const dateEl = document.getElementById('cl-date');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

  // 申請者セレクト
  const sel = document.getElementById('cl-applicant');
  if (sel) {
    sel.innerHTML = '<option value="">申請者を選択</option>' +
      allMembers.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
  }
  toggleClType();
}

function toggleClType() {
  const t = document.getElementById('cl-type')?.value;
  const tf = document.getElementById('cl-transport-fields');
  const af = document.getElementById('cl-advance-fields');
  if (tf) tf.style.display = t === 'transport' ? '' : 'none';
  if (af) af.style.display = t === 'advance' ? '' : 'none';
}

async function submitClaim() {
  const type = document.getElementById('cl-type').value;
  const applicant = document.getElementById('cl-applicant').value;
  if (!applicant) { toast('申請者を選択してください', '#f59e0b'); return; }
  const amount = parseInt(document.getElementById('cl-amount').value) || 0;
  if (!amount) { toast('金額を入力してください', '#f59e0b'); return; }

  const data = {
    type, applicant, amount,
    application_date: document.getElementById('cl-date').value.replace(/-/g, '/'),
    memo: document.getElementById('cl-memo').value,
  };

  if (type === 'transport') {
    data.work_destination = document.getElementById('cl-destination').value;
    data.work_date = document.getElementById('cl-work-date').value.replace(/-/g, '/');
    data.from_station = document.getElementById('cl-from').value;
    data.to_station = document.getElementById('cl-to').value;
    data.from_station2 = document.getElementById('cl-from2').value;
    data.to_station2 = document.getElementById('cl-to2').value;
    data.meal_allowance = parseInt(document.getElementById('cl-meal').value) || 0;
    data.description = `${data.work_destination} ${data.from_station}→${data.to_station}`;
  } else {
    data.usage = document.getElementById('cl-usage').value;
    data.store = document.getElementById('cl-store').value;
    data.description = `${data.usage} (${data.store})`;
  }

  const res = await api('POST', '/claims', { ...data, _skipLog: true });
  if (res.ok) {
    allClaims.push(res.claim);
    const tLabel = data.type === 'transport' ? '交通費' : '立替';
    logChange('作成', '/claims', `${applicant}さんの${tLabel}申請を新規作成（${data.application_date}・¥${amount.toLocaleString()}）`);
    toast('申請しました', '#059669');
    // フォームリセット
    ['cl-amount', 'cl-memo', 'cl-destination', 'cl-from', 'cl-to', 'cl-from2', 'cl-to2', 'cl-usage', 'cl-store'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const meal = document.getElementById('cl-meal'); if (meal) meal.value = 0;
    clTab('list');
  }
}

// ── 設定 ──
async function loadClSettings() {
  clSettings = await api('GET', '/settings/claims');
  ['cl-tr-debit', 'cl-ad-debit', 'cl-cr-credit'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = allAcOp('');
  });
  document.getElementById('cl-tr-debit').value = clSettings.transport_debit || '交通費';
  clUpdSub('cl-tr-debit', 'cl-tr-debit-sub');
  document.getElementById('cl-tr-debit-sub').value = clSettings.transport_debit_sub || '';

  document.getElementById('cl-ad-debit').value = clSettings.advance_debit || '立替金';
  clUpdSub('cl-ad-debit', 'cl-ad-debit-sub');
  document.getElementById('cl-ad-debit-sub').value = clSettings.advance_debit_sub || '';

  document.getElementById('cl-cr-credit').value = clSettings.refund_credit || '普通預金';
  clUpdSub('cl-cr-credit', 'cl-cr-credit-sub');
  document.getElementById('cl-cr-credit-sub').value = clSettings.refund_credit_sub || (sts.bank_account_sub || '');
}

function clUpdSub(acId, subId) {
  const ac = document.getElementById(acId), sub = document.getElementById(subId);
  if (ac && sub) sub.innerHTML = subOp(ac.value, '');
}

async function saveClSettings() {
  const data = {
    transport_debit: document.getElementById('cl-tr-debit').value,
    transport_debit_sub: document.getElementById('cl-tr-debit-sub').value,
    advance_debit: document.getElementById('cl-ad-debit').value,
    advance_debit_sub: document.getElementById('cl-ad-debit-sub').value,
    refund_credit: document.getElementById('cl-cr-credit').value,
    refund_credit_sub: document.getElementById('cl-cr-credit-sub').value,
  };
  await api('POST', '/settings/claims', data);
  clSettings = data;
  toast('設定を保存しました', '#059669');
}

// 申請ページ初期化
async function loadClaimsPage() {
  const d = await api('GET', '/claims');
  allClaims = d.claims || [];
  const cs = await api('GET', '/settings/claims');
  clSettings = cs;
  renderClaims();
}

// ── 月次締め切り管理 ──
let _deadlines = {};

async function loadDeadlines() {
  try {
    const d = await api('GET', '/transport-deadlines');
    _deadlines = d.deadlines || {};
    renderDeadlineList();
  } catch(e) {
    console.error('締め切り取得失敗', e);
  }
}

function renderDeadlineList() {
  const el = document.getElementById('deadline-list');
  if (!el) return;
  const months = Object.keys(_deadlines).filter(k => _deadlines[k]).sort().reverse();
  if (!months.length) {
    el.innerHTML = '<span style="font-size:12px;color:#94a3b8">締め切り月なし</span>';
    return;
  }
  el.innerHTML = months.map(m => {
    const [yr, mo] = m.split('-');
    return `<div style="display:inline-flex;align-items:center;gap:6px;background:#fef2f2;border:1px solid #fca5a5;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;color:#b91c1c">
      <span class="ei" data-i="lock"></span>${yr}年${parseInt(mo)}月
      <button onclick="removeDeadline('${escJsAttr(m)}')" style="background:none;border:none;cursor:pointer;color:#b91c1c;font-size:14px;line-height:1;padding:0;margin-left:2px" title="解除">✕</button>
    </div>`;
  }).join('');
}

async function toggleDeadline() {
  const input = document.getElementById('deadline-month-input');
  const monthVal = input ? input.value : '';
  if (!monthVal) { toast('月を選択してください', '#f59e0b'); return; }
  const isClosed = !!_deadlines[monthVal];
  await setDeadline(monthVal, !isClosed);
}

async function removeDeadline(month) {
  await setDeadline(month, false);
}

async function setDeadline(month, closed) {
  try {
    const d = await api('POST', '/transport-deadlines', { month, closed });
    _deadlines = d.deadlines || {};
    renderDeadlineList();
    const [yr, mo] = month.split('-');
    toast(closed ? `${yr}年${parseInt(mo)}月を締め切りました` : `${yr}年${parseInt(mo)}月の締め切りを解除しました`, closed ? '#b91c1c' : '#059669');
  } catch(e) {
    toast('エラーが発生しました', '#ef4444');
  }
}

// 申請の領収書を別タブで開く
function viewClaimReceipt(event, claimId) {
  event.stopPropagation();
  window.open(`${getBase()}/api/claim-receipt/${encodeURIComponent(claimId)}`, '_blank');
}

// 仕訳帳に出す自動仕訳ラベル（自動ルール名と同じ書式）
// 例: 「立替自動:安達 瑠南 ¥6,633」
function claimAutoRuleLabel(c) {
  const kind = c.type === 'transport' ? '交通費自動' : '立替自動';
  return `${kind}:${(c.applicant || '').trim()} ¥${Math.abs(parseInt(c.amount || 0)).toLocaleString()}`;
}

// 申請由来のラベルとして上書きしてよいか（手動で付けたルール名は残す）
function isClaimAutoRuleLabel(label) {
  const l = (label || '').trim();
  return l === '' || l.startsWith('申請自動仕訳') || l.startsWith('立替自動:') || l.startsWith('交通費自動:');
}

// 立替の摘要を生成: 申請の「メモ」をそのまま。空なら用途、
// 用途も無ければ description から店名の括弧を除去（例:「薬品 (Amazon)」→「薬品」）
function buildAdvanceMemo(claim) {
  const memo = (claim.memo || '').trim();
  if (memo) return memo;
  const usage = (claim.usage || '').trim();
  if (usage) return usage;
  return (claim.description || '').replace(/\s*[（(][^（()]*[)）]\s*$/u, '').trim();
}

// 申請種別に応じた摘要
function buildClaimMemo(claim) {
  return claim.type === 'transport' ? buildTransportMemo(claim) : buildAdvanceMemo(claim);
}

// 交通費の摘要を「M/D 目的地交通費」形式で生成
function buildTransportMemo(claim) {
  const workDate = claim.work_date || '';
  // work_date: "2024/4/21" or "2024-04-21" → "4/21"
  let mdPart = '';
  const m = workDate.replace(/-/g, '/').match(/\d{4}\/(\d{1,2})\/(\d{1,2})/);
  if (m) mdPart = `${parseInt(m[1])}/${parseInt(m[2])}`;
  const dest = claim.work_destination || '';
  return [mdPart, dest, '交通費'].filter(Boolean).join('');
}
