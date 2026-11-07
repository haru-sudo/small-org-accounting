// ══════════════════════════════════════════════════════════════════════════════
// login.js — ログイン画面
//   /auth/config で使えるログイン方法（パスワード / Slack / Google）と、
//   初回セットアップが必要か（ユーザーが1人もいないか）を聞いて、画面を組み立てる。
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  const base = window.location.pathname.replace(/\/[^\/]*$/, '').replace(/\/$/, '');
  const authUrl = p => base + '/auth.php?_path=' + p;
  const $ = id => document.getElementById(id);

  function setErr(msg) { const el = $('login-err'); if (el) el.textContent = msg || ''; }

  async function postJson(path, body) {
    const r = await fetch(authUrl(path), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let d = {};
    try { d = await r.json(); } catch (e) { /* 本文なし */ }
    if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  async function render(msg) {
    setErr(msg || '');
    let conf;
    try {
      conf = await (await fetch(authUrl('/auth/config'))).json();
    } catch (e) {
      setErr('サーバーに接続できません。設定を確認してください。');
      return;
    }
    $('login-club').textContent = conf.club_name || '';
    if (conf.club_name) document.title = conf.club_name + ' 会計';
    const m = conf.methods || {};
    $('login-setup').style.display = conf.needs_setup ? '' : 'none';
    $('login-password').style.display = !conf.needs_setup && m.password ? '' : 'none';
    $('login-slack').style.display = !conf.needs_setup && m.slack ? '' : 'none';
    $('login-google').style.display = !conf.needs_setup && m.google ? '' : 'none';
    $('login-or').style.display = !conf.needs_setup && m.password && (m.slack || m.google) ? '' : 'none';
    $('login-slack').href = authUrl('/auth/slack');
    $('login-google').href = authUrl('/auth/google');
  }

  // ログイン画面を出す（未ログイン・ログアウト時に globals.js からも呼ぶ）
  window.showLogin = function (msg) {
    $('login-lock').style.display = 'flex';
    render(msg);
  };

  window.loginPassword = async function () {
    setErr('');
    try {
      await postJson('/auth/login', { email: $('lp-email').value.trim(), password: $('lp-pass').value });
      location.reload();
    } catch (e) { setErr(e.message); }
  };

  window.loginSetup = async function () {
    setErr('');
    if ($('ls-pass').value !== $('ls-pass2').value) { setErr('パスワードが一致しません'); return; }
    try {
      await postJson('/auth/setup', { name: $('ls-name').value.trim(), email: $('ls-email').value.trim(), password: $('ls-pass').value });
      location.reload();
    } catch (e) { setErr(e.message); }
  };

  fetch(authUrl('/auth/me'))
    .then(r => r.json())
    .then(d => { if (!d.logged_in || d.role === 'denied') window.showLogin(d.logged_in ? 'このアカウントでは使えません。別の方法でログインしてください。' : ''); })
    .catch(() => window.showLogin('サーバーに接続できません。設定を確認してください。'));
})();
