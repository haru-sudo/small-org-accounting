// ══════════════════════════════════════════════════════════════════════════════
// AIアシスタント（Claude API）
//   会話・ツール実行はサーバー側（core/ai_chat.php）。ここは表示と承認操作だけ。
//   背景の文字と波は ai-bg.js。
// ══════════════════════════════════════════════════════════════════════════════
let aiConvId = '';
let aiBusy = false;
let aiView = null;       // 直近のサーバー応答（会話の表示内容）
let aiSettingsCache = null;
let aiThinkTimer = null; // 考え中に波を出し続けるタイマー
let aiPollTimer = null;  // 開いている会話を読み直すタイマー（ほかの管理者の発言を反映）
let aiLive = [];         // 返答を受け取っている最中の思考・本文・ツール（{kind, text}）。サーバーから逐次届く
let aiLiveRaf = 0;

// 閲覧専用の人に出す候補（公開済みの決算書でわかること）
const AI_VIEWER_SUGGESTIONS = [
  '今年度の収支をざっくり教えて',
  '支出が多い科目は？',
  '決算書の見方を教えて',
  '先月と比べて何が変わった？',
];
const AI_SUGGESTIONS = [
  '未登録の取引を仕訳して',
  '今月の未登録の取引を一覧にして',
  'よく出てくる相手先の自動仕訳ルールを提案して',
  '今年度の支出が多い科目を教えて',
  { text: '未承認の申請を確認して', feature: 'claims' },
  { text: '今月の会費の入金状況を教えて', feature: 'billing' },
  '普通預金の月別残高を見せて',
];
const AI_MODEL_SHORT = { 'claude-opus-5-5': 'AIアシスタント Pro', 'claude-sonnet-5-5': 'AIアシスタント', 'claude-haiku-5-5': 'AIアシスタント Lite' };
const AI_EFFORT_SHORT = { low: '低', medium: '中', high: '高', xhigh: '最高' };
const aiIsViewer = () => typeof isAdminUser === 'function' && !isAdminUser();
const aiIsTouch = () => window.matchMedia('(pointer: coarse)').matches;

// 右下の丸いボタンのアイコン
document.getElementById('tz-fab-pony').innerHTML = tzPonySvg(2);

// スマホで右下のボタンを隠す（この端末だけ。パソコンでは常に出す）
function aiSetFabHidden(hidden) {
  document.body.classList.toggle('tz-fab-off', hidden);
  try { localStorage.setItem('tz_fab_hidden', hidden ? '1' : ''); } catch (e) { /* 保存できなくてもこの画面では効く */ }
  aiRenderFabToggle();
  if (hidden && typeof toast === 'function') toast('右下のボタンを隠しました。AIアシスタントの画面の下の「右下ボタン」から戻せます');
}
function aiRenderFabToggle() {
  const el = document.getElementById('tz-fab-toggle');
  if (el) el.textContent = document.body.classList.contains('tz-fab-off') ? '右下ボタン：非表示' : '右下ボタン：表示中';
}
try { if (localStorage.getItem('tz_fab_hidden') === '1') document.body.classList.add('tz-fab-off'); } catch (e) { /* 読めなければ表示 */ }
aiRenderFabToggle();

// ── 決算書の画面の右下の丸いボタンから開く、浮かぶAIアシスタント ──
// AIアシスタントの画面（#page-ai）をそのまま、右下のパネルとして重ねて出す（スマホは全画面）
function aiOpenFloat() {
  document.body.classList.add('tz-float');
  loadAiPage();
}
function aiCloseFloat() {
  document.body.classList.remove('tz-float');
}
function aiToggleFloat() {
  if (document.body.classList.contains('tz-float')) aiCloseFloat(); else aiOpenFloat();
}
const aiIsOpen = () => document.getElementById('page-ai')?.classList.contains('active') || document.body.classList.contains('tz-float');
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('tz-float')
      && document.getElementById('tz-settings').hidden && document.getElementById('tz-history').hidden) aiCloseFloat();
});

async function loadAiPage() {
  tzBgStart();
  document.getElementById('tz-pony').innerHTML = tzPonySvg(3);
  // 閲覧専用: 設定・添付は使えない（サーバー側でも拒否）。モデルは AIアシスタント（低）固定
  const viewer = aiIsViewer();
  document.getElementById('tz').classList.toggle('viewer', viewer);
  if (!viewer) aiSetupDrop();
  document.getElementById('tz-hint').textContent = aiIsTouch() ? '' : 'Enter で送信 ・ Shift+Enter で改行';
  aiRender();
  await Promise.all([aiLoadSettings(), aiLoadConvs()]);
  aiRender();
  if (!aiPollTimer) aiPollTimer = setInterval(aiPoll, 8000);
}

// 会話は管理者全員で共有している。開いている会話にほかの人が書き込んだら反映する
async function aiPoll() {
  if (!aiIsOpen() || document.hidden || aiBusy || !aiConvId) return;
  try {
    const d = await api('GET', '/ai/conversations/' + encodeURIComponent(aiConvId));
    if (aiBusy || !d.conversation_id || d.conversation_id !== aiConvId) return;
    if (d.updated_at === aiView?.updated_at && d.busy_by === aiView?.busy_by) return;
    aiView = d;
    aiRender();
  } catch (e) { /* 次の回に任せる */ }
}
const aiIsMe = it => !it.email || (currentUser?.email || '').toLowerCase() === it.email.toLowerCase();

// ── 設定 ──
async function aiLoadSettings() {
  const s = await api('GET', '/ai/settings');
  aiSettingsCache = s;
  const sel = document.getElementById('ai-model');
  sel.innerHTML = Object.entries(s.models || {}).map(([id, label]) =>
    `<option value="${escHtml(id)}"${id === s.model ? ' selected' : ''}>${escHtml(label)}</option>`).join('');
  document.getElementById('ai-effort').value = s.effort || 'medium';
  document.getElementById('ai-auto').checked = !!s.auto_approve;
  document.getElementById('ai-instr').value = s.instructions || '';
  if (!s.viewer) aiFillIntegrations(s);
  aiShowUsage(s.usage);
  document.getElementById('tz-model-chip').textContent =
    `${AI_MODEL_SHORT[s.model] || s.model} ${AI_EFFORT_SHORT[s.effort] || ''}`;
  const mode = document.getElementById('tz-mode-chip');
  mode.textContent = s.viewer ? '閲覧専用（質問だけ）' : s.auto_approve ? '自動実行' : '✓ 承認してから実行';
  mode.classList.toggle('warn', !!s.auto_approve);
  // APIキーは「設定」ページで登録する。未登録なら案内を出す
  aiShowError(s.has_key ? '' : s.viewer
    ? 'AIアシスタントはまだ使えるようになっていません（会計担当がAPIキーを登録すると使えます）。'
    : 'Claude APIキーが未登録です。左の「設定」ページの「AIアシスタント連携」で登録してください。');
}

// 「設定」ページの「AIアシスタント連携」（Claude APIキー・Slack 連携）
/** 下の行に「今日あと N 回」（上限があるときだけ） */
function aiShowUsage(u) {
  const el = document.getElementById('tz-usage');
  if (!el || !u) return;
  el.hidden = !u.limit;
  el.textContent = u.limit ? `今日あと ${u.left} 回` : '';
  el.classList.toggle('warn', !!u.limit && u.left <= 3);
}

function aiFillIntegrations(s) {
  if (!document.getElementById('ai-key')) return;
  document.getElementById('ai-limit-viewer').value = s.viewer_daily_limit ?? 20;
  document.getElementById('ai-limit-admin').value = s.admin_daily_limit ?? 0;
  document.getElementById('ai-key').value = '';
  document.getElementById('ai-key-state').textContent = s.has_key ? `登録済み（${s.key_hint}）。変えるときだけ入力` : '未登録';
  document.getElementById('ai-slack-token').value = '';
  document.getElementById('ai-slack-state').textContent = s.has_slack ? `登録済み（${s.slack_hint}）。変えるときだけ入力` : '未登録（Slack のチャンネルを読むときに必要）';
  document.getElementById('ai-slack-channels').value = s.slack_channels || '';
}
async function aiLoadIntegrations() {
  document.getElementById('ai-slack-result').textContent = '';
  aiFillIntegrations(await api('GET', '/ai/settings'));
}
async function aiSaveIntegrations() {
  const body = { slack_channels: document.getElementById('ai-slack-channels').value, _skipLog: true,
    viewer_daily_limit: document.getElementById('ai-limit-viewer').value,
    admin_daily_limit: document.getElementById('ai-limit-admin').value };
  const key = document.getElementById('ai-key').value.trim();
  if (key) body.api_key = key;
  const slack = document.getElementById('ai-slack-token').value.trim();
  if (slack) body.slack_bot_token = slack;
  const r = await api('POST', '/ai/settings', body);
  if (r.error) { toast('' + r.error, '#dc2626'); return; }
  logEdit('更新', '/ai', 'AIアシスタント連携（APIキー・Slack）を変更しました').catch(() => {});
  toast('AIアシスタント連携を保存しました', '#059669');
  aiFillIntegrations(r);
}

function aiOpenSettings() {
  aiCloseHistory();
  document.getElementById('tz-settings').hidden = false;
}
function aiCloseSettings() { document.getElementById('tz-settings').hidden = true; }

async function aiSaveSettings() {
  const body = {
    model: document.getElementById('ai-model').value,
    effort: document.getElementById('ai-effort').value,
    auto_approve: document.getElementById('ai-auto').checked,
    instructions: document.getElementById('ai-instr').value,
    _skipLog: true,
  };
  const r = await api('POST', '/ai/settings', body);
  if (r.error) { toast('' + r.error, '#dc2626'); return; }
  logEdit('更新', '/ai', 'AI設定を変更しました').catch(() => {});
  toast('AI設定を保存しました', '#059669');
  aiCloseSettings();
  aiLoadSettings();
}

// Slack の接続テスト（保存してから試す）
async function aiSlackTest() {
  const out = document.getElementById('ai-slack-result');
  out.textContent = '確認中…';
  out.style.color = 'var(--mu)';
  const slack = document.getElementById('ai-slack-token').value.trim();
  const save = { slack_channels: document.getElementById('ai-slack-channels').value, _skipLog: true };
  if (slack) save.slack_bot_token = slack;
  await api('POST', '/ai/settings', save);
  const r = await api('POST', '/ai/slack-test', { _skipLog: true });
  if (!r.ok) { out.textContent = '✕ ' + (r.error || '接続できません'); out.style.color = '#dc2626'; return; }
  const ch = (r.channels || []).map(c => `${c.ok ? '✓' : '✕'} ${c.label}${c.ok ? '' : `（${c.error}）`}`).join('　');
  out.textContent = `✓ ${r.team} に接続（${r.bot}）　${ch || 'チャンネル未設定'}`;
  out.style.color = (r.channels || []).every(c => c.ok) && r.channels.length ? '#059669' : '#dc2626';
  aiFillIntegrations(await api('GET', '/ai/settings'));
}

// ── 会話の履歴 ──
async function aiLoadConvs() {
  const d = await api('GET', '/ai/conversations');
  const el = document.getElementById('ai-conv-list');
  const list = d.conversations || [];
  if (!list.length) { el.innerHTML = '<p class="tz-conv-empty">会話はまだありません</p>'; return; }
  el.innerHTML = list.map(c => `
    <div class="tz-conv${c.id === aiConvId ? ' active' : ''}" onclick="aiOpenConv('${escJsAttr(c.id)}')">
      <span class="t">${Number(c.has_pending) ? '<span class="ei" data-i="hourglass"></span>' : ''}${c.scope === 'viewer' && !aiIsViewer() ? '<span class="ei" data-i="eye"></span>' : ''}${escHtml(c.title || '（無題）')}
        <small>${escHtml(c.user_name || '')}</small></span>
      <span class="d">${escHtml((c.updated_at || '').slice(5, 16))}</span>
      ${c.id === aiConvId ? '<span class="ck">✓</span>' : ''}
      ${aiSettingsCache?.can_delete ? `<button class="tz-conv-del" title="この会話を削除" onclick="aiDeleteConv(event,'${escJsAttr(c.id)}')"><span class="ei" data-i="trash"></span></button>` : ''}
    </div>`).join('');
}
// 会話の削除（設定で許可された人だけ。サーバーでも確認する）
async function aiDeleteConv(e, id) {
  e.stopPropagation();
  if (!confirm('この会話を削除します。元に戻せません。よろしいですか？')) return;
  const r = await api('DELETE', '/ai/conversations/' + encodeURIComponent(id), { _skipLog: true });
  if (r.error) { toast('' + r.error, '#dc2626'); return; }
  if (id === aiConvId) { aiConvId = ''; aiView = null; aiRender(); }
  toast('会話を削除しました', '#059669');
  aiLoadConvs();
}

function aiToggleHistory(e) {
  e?.stopPropagation();
  const pop = document.getElementById('tz-history');
  if (!pop.hidden) { aiCloseHistory(); return; }
  pop.hidden = false;
  aiLoadConvs();
  // 外側を押したら閉じる
  setTimeout(() => document.addEventListener('pointerdown', aiHistoryOutside), 0);
}
function aiHistoryOutside(e) {
  if (!document.getElementById('tz-history').contains(e.target)) aiCloseHistory();
}
function aiCloseHistory() {
  document.getElementById('tz-history').hidden = true;
  document.removeEventListener('pointerdown', aiHistoryOutside);
}

function aiNewChat() {
  if (aiBusy) return;
  aiConvId = '';
  aiView = null;
  aiShowError('');
  aiCloseHistory();
  aiRender();
  tzWaveFrom(document.getElementById('tz-scroll'), 0.8);
  if (!aiIsTouch()) document.getElementById('ai-input').focus();
}

async function aiOpenConv(id) {
  if (aiBusy) return;
  const d = await api('GET', '/ai/conversations/' + encodeURIComponent(id));
  if (d.error) { toast('' + d.error, '#dc2626'); return; }
  aiConvId = id;
  aiView = d;
  aiShowError('');
  aiCloseHistory();
  aiRender();
}

// ── 添付（＋ボタン・貼り付け・ドロップ） ──
let aiAtt = [];   // { key, name, kind, preview, status: 'uploading'|'done'|'error', id, error }
const AI_IMG_MAX_EDGE = 2000;   // 長い辺がこれより大きい写真は縮めて送る（Claude の画像は 5MB まで）

function aiKindOf(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  return 'text';
}

/** 大きな写真を縮めて JPEG にする（縮める必要がなければそのまま） */
async function aiShrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return file; }   // 読めない形式はサーバーで判定
  const scale = Math.min(1, AI_IMG_MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) { bmp.close?.(); return file; }
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.86));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

async function aiPickFiles(list) {
  const files = [...(list || [])];
  if (!files.length) return;
  if (aiAtt.length + files.length > 10) { aiShowError('添付は1回に10個までです'); return; }
  for (const f of files) {
    const a = { key: Math.random().toString(36).slice(2), name: f.name || '貼り付けた画像.png', kind: aiKindOf(f), status: 'uploading' };
    if (a.kind === 'image') a.preview = URL.createObjectURL(f);
    aiAtt.push(a);
    aiRenderTray();
    aiUpload(a, f);
  }
}

async function aiUpload(a, f) {
  try {
    const file = await aiShrinkImage(f);
    const fd = new FormData();
    fd.append('file', file, a.name);
    const r = await fetch(getBase() + '/api/ai/upload', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({ error: 'アップロードに失敗しました' }));
    if (d.error || !d.id) throw new Error(d.error || 'アップロードに失敗しました');
    Object.assign(a, { id: d.id, name: d.name, kind: d.kind, status: 'done' });
  } catch (e) {
    Object.assign(a, { status: 'error', error: e.message });
  }
  aiRenderTray();
}

function aiRemoveAtt(key) {
  const a = aiAtt.find(x => x.key === key);
  if (a?.preview) URL.revokeObjectURL(a.preview);
  aiAtt = aiAtt.filter(x => x.key !== key);
  aiRenderTray();
}

const AI_KIND_ICON = { pdf: '<span class="ei" data-i="file"></span>', text: '<span class="ei" data-i="chart"></span>', image: '<span class="ei" data-i="image"></span>', file: '<span class="ei" data-i="file"></span>' };
function aiRenderTray() {
  const tray = document.getElementById('ai-tray');
  if (!tray) return;
  tray.innerHTML = aiAtt.map(a => `<div class="tz-att${a.status === 'error' ? ' err' : ''}">
    ${a.preview ? `<img src="${escHtml(a.preview)}" alt="">` : `<span class="ic">${AI_KIND_ICON[a.kind] || '<span class="ei" data-i="clip"></span>'}</span>`}
    <span class="nm">${escHtml(a.name)}<span class="st">${a.status === 'uploading' ? '送信の準備中…' : a.status === 'error' ? escHtml(a.error) : '添付済み'}</span></span>
    <button class="rm" onclick="aiRemoveAtt('${escJsAttr(a.key)}')" aria-label="添付を外す">✕</button>
  </div>`).join('');
  document.querySelector('.tz-input')?.classList.toggle('has-text',
    document.getElementById('ai-input').value.trim() !== '' || aiAtt.some(a => a.status === 'done'));
}

/** 画面への貼り付け・ドラッグ＆ドロップで添付できるようにする（最初に一度だけ） */
function aiSetupDrop() {
  const tz = document.getElementById('tz');
  if (!tz || tz.dataset.dropReady) return;
  tz.dataset.dropReady = '1';
  document.getElementById('ai-input').addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); aiPickFiles(files); }
  });
  let depth = 0;
  tz.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; tz.classList.add('drag'); } });
  tz.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; tz.classList.remove('drag'); } });
  tz.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  tz.addEventListener('drop', e => {
    depth = 0; tz.classList.remove('drag');
    if (e.dataTransfer?.files?.length) { e.preventDefault(); aiPickFiles(e.dataTransfer.files); }
  });
}

// ── 入力欄 ──
function aiGrow(el) {
  el.closest('.tz-input')?.classList.toggle('has-text', el.value.trim() !== '' || aiAtt.some(a => a.status === 'done'));
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}
function aiKey(e) {
  // 日本語入力の変換確定の Enter では送らない。スマホの Enter は改行
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  if (e.shiftKey || aiIsTouch()) return;
  e.preventDefault();
  aiSend();
}

// ── 送信・承認 ──
async function aiSend(text) {
  const input = document.getElementById('ai-input');
  const msg = (text ?? input.value).trim();
  const useAtt = text === undefined;   // 候補ボタンから送るときは添付を付けない
  const att = useAtt ? aiAtt.filter(a => a.status === 'done') : [];
  if ((!msg && !att.length) || aiBusy) return;
  if (useAtt && aiAtt.some(a => a.status === 'uploading')) { aiShowError('添付の準備が終わるまで待ってください'); return; }
  input.value = '';
  if (useAtt) { aiAtt.forEach(a => a.preview && URL.revokeObjectURL(a.preview)); aiAtt = []; aiRenderTray(); }
  aiGrow(input);
  tzWaveFrom(document.getElementById('ai-send'), 1);
  // 返事を待つ間、自分の発言を先に出しておく
  aiView = aiView || { items: [] };
  aiView.items = [...aiView.items.filter(it => it.state !== 'waiting'),
    { kind: 'user', text: msg, author: currentUser?.name || '', email: currentUser?.email || '',
      attachments: att.map(a => ({ id: a.id, name: a.name, kind: a.kind })) }];
  aiView.pending = false;
  await aiRequest('/ai/chat', { conversation_id: aiConvId, message: msg, attachments: att.map(a => a.id) });
}

async function aiApprove(approveAll) {
  if (aiBusy || !aiView) return;
  const decisions = {};
  const waiting = aiView.items.filter(it => it.kind === 'tool' && it.state === 'waiting');
  waiting.forEach(it => {
    const cb = document.getElementById('ai-ok-' + it.id);
    decisions[it.id] = approveAll === null ? false : (approveAll || !cb || cb.checked);
  });
  // 登録済みの取引を変えるなど注意が要る操作は、もう一度はっきり確かめる
  const risky = waiting.filter(it => decisions[it.id] && it.warn);
  if (risky.length && !confirm('次の操作を実行します。よろしいですか？\n\n' + risky.map(it => '・' + it.summary + '\n　' + it.warn).join('\n'))) return;
  await aiRequest('/ai/approve', { conversation_id: aiConvId, decisions });
}

// 返答を逐次受け取る。サーバーは Server-Sent Events（1行に「data: {JSON}」）で、
// 思考・本文の差分、ツールの開始、ツール実行後の会話（step）、最後に会話の全体（done）を送る。
// 受け付けられなかったとき（上限・処理中など）は普通の JSON が返る
async function aiFetchStream(path, body) {
  const res = await fetch(getBase() + '/api' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!(res.headers.get('content-type') || '').includes('text/event-stream') || !res.body) return res.json();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
      if (ev.t === 'done') done = ev.view; else aiOnStreamEvent(ev);
    }
    if (end) break;
  }
  if (!done) throw new Error('返答が途中で切れました。「続けて」と送ってください');
  return done;
}
function aiOnStreamEvent(ev) {
  const last = aiLive[aiLive.length - 1];
  if (ev.t === 'block') {
    aiLive.push({ kind: ev.kind, text: '' });
  } else if (ev.t === 'thinking' || ev.t === 'text') {
    if (last && last.kind === ev.t) last.text += ev.d; else aiLive.push({ kind: ev.t, text: ev.d });
  } else if (ev.t === 'tool') {
    aiLive.push({ kind: 'tool', text: ev.label || ev.name });
  } else if (ev.t === 'step' && ev.view) {
    // ツールを実行し終えた。ここまでの会話（ツールの結果を含む）に置き換えて、次の返答を待つ
    aiView = { ...ev.view, busy_by: '' };
    aiLive = [];
    aiRender();
    return;
  }
  if (!aiLiveRaf) aiLiveRaf = requestAnimationFrame(() => { aiLiveRaf = 0; aiRenderLive(); });
}

async function aiRequest(path, body) {
  aiBusy = true;
  aiLive = [];
  aiShowError('');
  aiRender();
  // 考えている間は、アイコンのあたりから小さな波を出し続ける
  aiThinkTimer = setInterval(() => tzWaveFrom(document.getElementById('tz-pony'), 0.45), 1400);
  try {
    const d = await aiFetchStream(path, body);
    aiShowUsage(d.usage);
    if (d.conversation_id) {
      aiConvId = d.conversation_id;
      aiView = d;
    } else if (!aiConvId) {
      aiView = null;   // 新しい会話で受け付けられなかった（上限など）。送ったつもりの発言を消す
    } else if (aiConvId) {
      // ほかの人が処理中などで受け付けられなかった。送ったつもりの発言を消して、今の状態を出す
      const cur = await api('GET', '/ai/conversations/' + encodeURIComponent(aiConvId));
      if (cur.conversation_id) aiView = cur;
    }
    if (d.error) aiShowError(d.error);
    // 帳簿を変更したら、ほかの画面が使っているデータを読み直す
    if ((d.items || []).some(it => it.kind === 'tool' && it.write && it.state === 'done')) aiRefreshData();
  } catch (e) {
    aiShowError('通信に失敗しました: ' + e.message);
  } finally {
    clearInterval(aiThinkTimer);
    aiBusy = false;
    aiLive = [];
    aiRender();
    tzWaveFrom(document.getElementById('tz-scroll'), 0.7);
  }
}

// AIアシスタントが帳簿・科目・ルール・設定・名簿・申請・請求書を変えたあと、ほかのページの表示を最新にする
async function aiRefreshData() {
  try {
    const [t, a, r, s, m, c, i] = await Promise.all([
      api('GET', '/transactions'), api('GET', '/accounts'), api('GET', '/rules'), api('GET', '/settings'),
      (hasFeature('billing') || hasFeature('claims')) ? api('GET', '/members') : null,
      hasFeature('claims') ? api('GET', '/claims') : null,
      hasFeature('invoice') ? api('GET', '/invoices') : null,
    ]);
    allTx = t.transactions || allTx;
    allAc = a || allAc;
    allRu = r.rules || allRu;
    if (s && !s.error) sts = s;
    if (m && m.members) allMembers = m.members;
    if (c && c.claims) allClaims = c.claims;
    if (i && i.invoices) allInv = i.invoices;
    updAcF();
    popFy();
    const lbl = document.getElementById('club-lbl');
    if (lbl && sts.club_name !== undefined) lbl.textContent = sts.club_name || '';
  } catch (e) { /* 表示用の再読込なので失敗は無視 */ }
}

function aiShowError(msg) {
  const el = document.getElementById('ai-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// ── 表示 ──
function aiRender() {
  const box = document.getElementById('ai-msgs');
  if (!box) return;
  document.getElementById('ai-send').disabled = aiBusy;
  document.getElementById('tz').classList.toggle('busy', aiBusy);
  document.getElementById('tz-title').textContent = aiView?.title || '新しい会話';
  const items = aiView?.items || [];
  // 会話が始まったら背景の文字と波を止める（最初の画面だけ動かす）
  tzBgSetQuiet(items.length > 0 || aiBusy);
  if (!items.length && !aiBusy) {
    box.innerHTML = `<div class="tz-hero">
      <div class="tz-hero-pony">${tzPonySvg(7)}</div>
      <h1>AIアシスタント</h1>
      ${aiIsViewer()
        ? `<p>団体の会計を手伝う、AIアシスタント。<br>公開されている決算書について、収支や科目の意味などを質問できます。</p>
      <div class="tz-chips">${AI_VIEWER_SUGGESTIONS.map(s => `<button class="tz-sugg" onclick="aiSend('${escJsAttr(s)}')">${escHtml(s)}</button>`).join('')}</div>
      <p class="tz-hero-note">閲覧専用のため、個々の取引の確認や仕訳はできません。会話はあなただけに表示されます。</p>`
        : `<p>団体の会計を手伝う、AIアシスタント。<br>仕訳や明細の取り込みから、申請・請求・決算の確認、設定の変更まで、画面でできることはほぼ頼めます。</p>
      <div class="tz-chips">${AI_SUGGESTIONS.filter(s => typeof s === 'string' || hasFeature(s.feature)).map(s => typeof s === 'string' ? s : s.text).map(s => `<button class="tz-sugg" onclick="aiSend('${escJsAttr(s)}')">${escHtml(s)}</button>`).join('')}</div>
      <p class="tz-hero-note">帳簿を変える操作は、実行の前にあなたの承認を求めます。</p>`}
    </div>`;
    return;
  }
  const html = items.map(aiRenderItem);
  const waiting = items.filter(it => it.kind === 'tool' && it.state === 'waiting');
  const otherBusy = !aiBusy && aiView?.busy_by;
  if (waiting.length && !aiBusy && !otherBusy) {
    html.push(`<div class="tz-approve">
      <span class="msg">${waiting.some(it => it.warn) ? '<b class="risk"><span class="ei" data-i="alert"></span>登録済みの取引などに影響する操作があります。</b>' : ''}内容を確認して実行してください。別の指示を送ると却下になります。</span>
      <div class="btns">
        <button class="tz-btn" onclick="aiApprove(null)">すべて却下</button>
        ${waiting.length > 1 ? `<button class="tz-btn" onclick="aiApprove(false)">チェックしたものだけ実行</button>` : ''}
        <button class="tz-btn go" onclick="aiApprove(true)">✓ ${waiting.length > 1 ? 'すべて' : ''}実行する</button>
      </div>
    </div>`);
  }
  if (aiBusy) html.push('<div id="tz-live"></div>');
  else if (otherBusy) html.push(`<div class="tz-thinking"><span class="dots"><i></i><i></i><i></i></span>${escHtml(aiView.busy_by)} さんの依頼をAIアシスタントが処理中…</div>`);
  box.innerHTML = html.join('');
  if (aiBusy) aiRenderLive(true);
  const sc = document.getElementById('tz-scroll');
  sc.scrollTop = sc.scrollHeight;
}

// 受け取り中の返答だけを描き直す（会話全体を毎回作り直さない）
function aiRenderLive(noScroll) {
  const el = document.getElementById('tz-live');
  if (!el) return;
  const sc = document.getElementById('tz-scroll');
  const atBottom = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const html = aiLive.map((seg, i) => {
    const isLast = i === aiLive.length - 1;
    if (seg.kind === 'thinking') {
      if (!seg.text) return isLast ? aiThinkingDots('考えています…') : '';
      return aiRenderThinking(seg.text, isLast);
    }
    if (seg.kind === 'text') return seg.text ? `<div class="tz-msg assistant">${aiMd(seg.text)}</div>` : '';
    return `<div class="tz-tool running"><span class="br">⎿</span>${escHtml(seg.text)}…</div>`;
  });
  const last = aiLive[aiLive.length - 1];
  if (!last || last.kind === 'tool' || (last.kind === 'text' && !last.text)) html.push(aiThinkingDots(last?.kind === 'tool' ? '確認しています…' : 'AIアシスタントが考えています…'));
  el.innerHTML = html.join('');
  if (!noScroll && atBottom) sc.scrollTop = sc.scrollHeight;
}
const aiThinkingDots = label => `<div class="tz-thinking"><span class="dots"><i></i><i></i><i></i></span>${escHtml(label)}</div>`;
// 思考の要約。考えている最中は開いて流し、終わったものは「思考」として畳む
function aiRenderThinking(text, live) {
  return `<details class="tz-think${live ? ' live' : ''}"${live ? ' open' : ''}><summary>${live ? '考えています…' : '思考'}</summary>`
    + `<div class="tz-think-body">${aiMd(text)}</div></details>`;
}

function aiRenderItem(it) {
  if (it.kind === 'thinking') return aiRenderThinking(it.text, false);
  if (it.kind === 'user') {
    const mine = aiIsMe(it);
    const who = it.author ? `<div class="tz-who">${mine ? 'あなた' : escHtml(it.author)}${it.at ? ` ・ ${escHtml(it.at.slice(5))}` : ''}</div>` : '';
    const files = (it.attachments || []).map(f => {
      const url = `${getBase()}/api/ai/file/${encodeURIComponent(f.id)}`;
      return f.kind === 'image'
        ? `<a href="${escHtml(url)}" target="_blank" rel="noopener"><img src="${escHtml(url)}" alt="${escHtml(f.name)}" loading="lazy"></a>`
        : `<a class="doc" href="${escHtml(url)}" target="_blank" rel="noopener">${AI_KIND_ICON[f.kind] || '<span class="ei" data-i="clip"></span>'} ${escHtml(f.name)}</a>`;
    }).join('');
    return `<div class="tz-umsg${mine ? ' mine' : ' other'}">${who}${files ? `<div class="tz-files">${files}</div>` : ''}`
      + `${it.text ? `<div class="tz-msg user">${escHtml(it.text)}</div>` : ''}</div>`;
  }
  if (it.kind === 'assistant') return `<div class="tz-msg assistant">${aiMd(it.text)}</div>`;
  if (!it.write) {
    const err = it.state === 'error';
    return `<div class="tz-tool${err ? ' err' : ''}"><span class="br">⎿</span>${escHtml(it.label)}${err ? '（失敗）' : ''}</div>`;
  }
  const st = {
    waiting:  '承認待ち',
    done:     '実行済み',
    rejected: '却下',
    error:    '失敗',
    unknown:  '未実行',
  }[it.state] || '';
  const check = it.state === 'waiting'
    ? `<input type="checkbox" id="ai-ok-${escHtml(it.id)}" checked aria-label="実行する">` : '<span class="pen">✎</span>';
  const lines = (it.lines || []).map(l => `<li>${escHtml(l)}</li>`).join('');
  let extra = '';
  if (it.state === 'error' && it.error) extra = `<div class="e">${escHtml(it.error)}</div>`;
  const errs = it.result?.errors || [];
  if (errs.length) extra += `<div class="w"><span class="ei" data-i="alert"></span>${errs.length}件は実行できませんでした: ${escHtml(errs.map(e => e.error).join(' / '))}</div>`;
  // 対象ごとの「変更前 → 変更後」。多いときは先頭だけ出して残りは畳む
  const rows = (it.rows || []).map(aiRenderActRow);
  const SHOW = 6;
  const rowsHtml = rows.length > SHOW
    ? rows.slice(0, SHOW).join('') + `<details class="more"><summary>ほか ${rows.length - SHOW} 件を表示</summary>${rows.slice(SHOW).join('')}</details>`
    : rows.join('');
  const warn = it.warn && it.state === 'waiting' ? `<div class="warn"><span class="ei" data-i="alert"></span>${escHtml(it.warn)}</div>` : '';
  return `<div class="tz-act ${it.state}${it.warn ? ' risky' : ''}">
    <label class="hd">${check}<span class="s">${escHtml(it.summary || it.label)}</span><span class="st">${st}${it.by ? `：${escHtml(it.by)}` : ''}</span></label>
    ${warn}${rowsHtml ? `<div class="rows">${rowsHtml}</div>` : ''}
    ${lines ? `<ul>${lines}</ul>` : ''}${extra}
  </div>`;
}
function aiRenderActRow(r) {
  const val = v => escHtml(v).replace(/\n/g, '<br>');
  const chg = (r.changes || []).map(c => {
    const isNew = c.from === null || c.from === undefined;
    const from = isNew ? '' : `<span class="old">${c.from === '' ? '（空）' : val(c.from)}</span><span class="ar">→</span>`;
    return `<div class="k">${escHtml(c.k)}</div><div class="v">${from}<span class="new">${c.to === '' ? '（空）' : val(c.to)}</span></div>`;
  }).join('');
  return `<div class="row">
    <div class="tg">${escHtml(r.target || '')}${r.tag ? `<span class="tag">${escHtml(r.tag)}</span>` : ''}</div>
    ${chg ? `<div class="chg">${chg}</div>` : ''}
    ${r.note ? `<div class="why">${escHtml(r.note)}</div>` : ''}
  </div>`;
}

// AIアシスタントの返答（Markdown）を最小限で HTML にする。先に全体をエスケープしてから整形するので、
// 返答に HTML が混じっていてもタグとしては解釈されない。
function aiMd(src) {
  // リンクは https:// か、このアプリ内のパス（api/ai/file/… など。export_excel の出力）だけ通す。
  // 文字列は先にエスケープ済みなので、URL に引用符や < > は入らない
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|api\/)[^\s()]+)\)/g, (m, text, url) =>
      `<a href="${url.startsWith('api/') ? getBase() + '/' + url : url}" target="_blank" rel="noopener">${text}</a>`);
  const lines = escHtml(src).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 表
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tz-tbl"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>` +
        rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>');
      continue;
    }
    // 箇条書き
    const ul = /^\s*[-*・]\s+(.*)$/, ol = /^\s*\d+[.)]\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const re = ul.test(line) ? ul : ol, tag = re === ul ? 'ul' : 'ol';
      const li = [];
      while (i < lines.length && re.test(lines[i])) li.push(`<li>${inline(lines[i++].match(re)[1])}</li>`);
      out.push(`<${tag}>${li.join('')}</${tag}>`);
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { out.push(`<h4>${inline(h[1])}</h4>`); i++; continue; }
    out.push(line.trim() === '' ? '<div class="sp"></div>' : `<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('');
}
