// ══════════════════════════════════════════════════════════════════════════════
// users.js — ユーザー管理（管理者のみ）
//   管理者   : 全ページを利用できる
//   閲覧専用 : 決算書だけ閲覧できる（更新系の操作は不可）
//   アクセス不可 : ログインできない
// ══════════════════════════════════════════════════════════════════════════════

let appUsers = [];
let appUsersDefaultRole = 'denied';
let appUsersMe = '';

const ROLE_META = {
  admin:  { label: '管理者',      color: '#7c3aed', bg: '#faf5ff', desc: '全ページ利用可' },
  viewer: { label: '閲覧専用',    color: '#0369a1', bg: '#f0f9ff', desc: '決算書のみ閲覧可' },
  denied: { label: 'アクセス不可', color: '#dc2626', bg: '#fef2f2', desc: 'ログイン不可' },
};

function _authBase() { return getBase(); }

async function loadUsers() {
  const el = document.getElementById('users-list');
  if (!el) return;
  el.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">読み込み中...</p>';
  try {
    const r = await fetch(_authBase() + '/auth.php?_path=/auth/users');
    if (r.status === 403) {
      el.innerHTML = '<p style="color:#dc2626;text-align:center;padding:20px">このページは管理者のみ利用できます。</p>';
      return;
    }
    const d = await r.json();
    appUsers = d.users || [];
    appUsersDefaultRole = d.default_role || 'denied';
    appUsersMe = (d.me || '').toLowerCase();
    const sel = document.getElementById('users-default-role');
    if (sel) sel.value = appUsersDefaultRole;
    renderUsers();
  } catch (e) {
    el.innerHTML = `<p style="color:#ef4444;text-align:center;padding:20px">ユーザー一覧の取得に失敗しました。<br><small>${e.message}</small></p>`;
  }
}

function renderUsers() {
  const el = document.getElementById('users-list');
  if (!el) return;

  if (!appUsers.length) {
    el.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">ユーザーが登録されていません。「＋ ユーザーを追加」から登録してください。</p>';
    updateUsersSummary();
    return;
  }

  const rows = appUsers.map((u, i) => {
    const isMe = (u.email || '').toLowerCase() === appUsersMe;
    const roleOpts = Object.entries(ROLE_META).map(([k, m]) =>
      `<option value="${k}"${u.role === k ? ' selected' : ''}>${m.label}</option>`).join('');
    return `<tr>
      <td style="padding:6px 8px">
        <input type="email" value="${(u.email || '').replace(/"/g, '&quot;')}"
          oninput="appUsers[${i}].email=this.value.trim()" placeholder="name@example.com"
          style="width:100%;min-width:200px;box-sizing:border-box;border:1px solid var(--bd);border-radius:5px;padding:4px 7px;font-size:12px">
      </td>
      <td style="padding:6px 8px">
        <input type="text" value="${(u.name || '').replace(/"/g, '&quot;')}"
          oninput="appUsers[${i}].name=this.value" placeholder="氏名（任意）"
          style="width:100%;min-width:110px;box-sizing:border-box;border:1px solid var(--bd);border-radius:5px;padding:4px 7px;font-size:12px">
      </td>
      <td style="padding:6px 8px;white-space:nowrap">
        <select onchange="appUsers[${i}].role=this.value;renderUsers()" ${isMe ? 'disabled' : ''}
          style="border:1px solid var(--bd);border-radius:5px;padding:4px 6px;font-size:12px;background:${ROLE_META[u.role]?.bg || '#fff'};color:${ROLE_META[u.role]?.color || '#334155'};font-weight:600${isMe ? ';opacity:.6' : ''}">
          ${roleOpts}
        </select>
        ${isMe ? '<span style="font-size:10px;color:#94a3b8;margin-left:5px">自分</span>' : ''}
      </td>
      <td style="padding:6px 8px;white-space:nowrap" class="users-pw-col">
        <input type="password" autocomplete="new-password" value="${escHtml(u.new_password || '')}"
          oninput="appUsers[${i}].new_password=this.value;appUsers[${i}].clear_password=false"
          placeholder="${u.has_password ? '設定済み（変えるときだけ）' : '未設定'}"
          style="width:150px;box-sizing:border-box;border:1px solid var(--bd);border-radius:5px;padding:4px 7px;font-size:12px">
        ${u.has_password && !u.clear_password ? `<button onclick="appUsers[${i}].clear_password=true;appUsers[${i}].new_password='';renderUsers()" title="パスワードを消す" style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:11px">消す</button>` : ''}
        ${u.clear_password ? '<span style="font-size:10px;color:#dc2626">保存で消去</span>' : ''}
      </td>
      <td style="padding:6px 8px;width:100%">
        <input type="text" value="${(u.note || '').replace(/"/g, '&quot;')}"
          oninput="appUsers[${i}].note=this.value" placeholder="メモ（任意）"
          style="width:100%;min-width:160px;box-sizing:border-box;border:1px solid var(--bd);border-radius:5px;padding:4px 7px;font-size:12px">
      </td>
      <td style="padding:6px 8px;font-size:11px;color:#94a3b8;white-space:nowrap">${u.added_at || ''}</td>
      <td style="padding:6px 8px;text-align:center">
        ${isMe ? '' : `<button onclick="removeUser(${i})" title="削除"
          style="background:none;border:none;cursor:pointer;color:var(--ex);font-size:15px">×</button>`}
      </td>
    </tr>`;
  }).join('');

  // パスワードログインを使っていなければパスワード欄は出さない
  const pwOn = !!((sts.login_methods || {}).password);
  el.innerHTML = `<div style="overflow-x:auto" class="${pwOn ? '' : 'users-no-pw'}">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e2e8f0;white-space:nowrap">メールアドレス</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e2e8f0;white-space:nowrap">氏名</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e2e8f0;white-space:nowrap">権限</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e2e8f0;white-space:nowrap" class="users-pw-col">パスワード</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e2e8f0">メモ</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e2e8f0;white-space:nowrap">登録日時</th>
        <th style="padding:7px 8px;border-bottom:1px solid #e2e8f0"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  updateUsersSummary();
}

function updateUsersSummary() {
  const el = document.getElementById('users-summary');
  if (!el) return;
  const c = { admin: 0, viewer: 0, denied: 0 };
  appUsers.forEach(u => { if (c[u.role] != null) c[u.role]++; });
  el.innerHTML = Object.entries(ROLE_META).map(([k, m]) =>
    `<span style="background:${m.bg};color:${m.color};border:1px solid ${m.color}33;border-radius:5px;padding:2px 9px;font-size:11px;font-weight:700">${m.label} ${c[k]}名</span>`
  ).join(' ');
}

function addUserRow() {
  appUsers.push({ email: '', name: '', role: 'viewer', note: '', added_at: '', added_by: '' });
  renderUsers();
  // 追加した行のメール欄にフォーカス
  const inputs = document.querySelectorAll('#users-list input[type="email"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeUser(i) {
  const u = appUsers[i];
  if (!confirm(`${u.email || 'この行'} を削除しますか？\n（未保存の変更も含めて一覧から取り除きます）`)) return;
  appUsers.splice(i, 1);
  renderUsers();
}

async function saveUsers() {
  // 入力チェック
  const seen = new Set();
  for (const u of appUsers) {
    const email = (u.email || '').trim().toLowerCase();
    if (!email) { toast('メールアドレスが空の行があります', '#f59e0b'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      toast(`メールアドレスの形式が不正です: ${email}`, '#f59e0b'); return;
    }
    if (seen.has(email)) { toast(`メールアドレスが重複しています: ${email}`, '#f59e0b'); return; }
    seen.add(email);
    if (u.new_password && u.new_password.length < 10) { toast(`${email}: パスワードは10文字以上にしてください`, '#f59e0b'); return; }
  }
  if (!appUsers.some(u => u.role === 'admin')) {
    toast('管理者を最低1人設定してください', '#f59e0b'); return;
  }

  const defaultRole = document.getElementById('users-default-role')?.value || 'denied';
  try {
    const r = await fetch(_authBase() + '/auth.php?_path=/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: appUsers, default_role: defaultRole }),
    });
    const d = await r.json();
    if (!r.ok || d.error) { toast('' + (d.error || '保存に失敗しました'), '#dc2626'); return; }
    appUsers = d.users || appUsers;
    appUsersDefaultRole = defaultRole;
    renderUsers();
    toast('ユーザー設定を保存しました', '#059669');
  } catch (e) {
    toast('保存に失敗しました: ' + e.message, '#dc2626');
  }
}
