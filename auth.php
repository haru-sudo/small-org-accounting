<?php
// ══════════════════════════════════════════════════════════════════════════════
// auth.php — ログイン（パスワード / Slack / Google）・ユーザー管理・編集ログ
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/core/helpers.php';
require_once __DIR__ . '/core/auth_roles.php';

acctSessionStart();
header('X-Content-Type-Options: nosniff');

$base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
$uri  = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = $_GET['_path'] ?? ('/' . ltrim(substr($uri, strlen($base)), '/'));

// ── ログインの設定（設定ページから保存） ──
function getOAuthConf(): array {
    $s = kvGet('settings', []);
    return [
        'slack_client_id'      => trim((string)($s['slack_client_id']      ?? '')),
        'slack_client_secret'  => trim((string)($s['slack_client_secret']  ?? '')),
        'google_client_id'     => trim((string)($s['google_client_id']     ?? '')),
        'google_client_secret' => trim((string)($s['google_client_secret'] ?? '')),
    ];
}

// ── 現在のログインユーザー（セッション） ──
function currentUser(): array {
    $u = $_SESSION['acct_user'] ?? [];
    if (!empty($u['id'])) {
        // ロールは毎回解決し直す（管理画面での変更を再ログインなしで反映）
        $u['role'] = resolveRoleForSession($u);
        $_SESSION['acct_user']['role'] = $u['role'];
    }
    return $u;
}

function isLoggedIn(): bool {
    return !empty($_SESSION['acct_user']['id']);
}

function currentRole(): string {
    if (!isLoggedIn()) return 'denied';
    return currentUser()['role'] ?? 'viewer';
}

function isAdmin(): bool {
    return currentRole() === 'admin';
}

function requireAdmin(): void {
    if (!isAdmin()) {
        http_response_code(403);
        echo json_encode(['error' => 'Forbidden', 'message' => '管理者のみ操作できます']);
        exit;
    }
}

// ── ルーティング ──
if ($path === '/auth/me') {
    header('Content-Type: application/json; charset=utf-8');
    $u = currentUser();
    echo json_encode([
        'user'      => $u,
        'logged_in' => isLoggedIn(),
        'role'      => isLoggedIn() ? ($u['role'] ?? 'viewer') : '',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// ── ログイン画面の設定（未ログインでも読める。秘密の値は含まない）──
if ($path === '/auth/config') {
    header('Content-Type: application/json; charset=utf-8');
    $lm = loginMethods();
    echo json_encode([
        'methods'     => $lm,
        'needs_setup' => !getAppUsers(),
        'club_name'   => (string)(kvGet('settings', [])['club_name'] ?? ''),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// ── 初回セットアップ（ユーザーが1人もいないときだけ。最初の管理者をパスワード付きで作る）──
if ($path === '/auth/setup') {
    header('Content-Type: application/json; charset=utf-8');
    authRequirePostJson();
    if (getAppUsers()) authFail(403, 'セットアップは完了しています。ログインしてください。');
    $body  = json_decode(file_get_contents('php://input'), true) ?? [];
    $email = normEmail($body['email'] ?? '');
    $name  = trim((string)($body['name'] ?? ''));
    $pass  = (string)($body['password'] ?? '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) authFail(400, 'メールアドレスの形式が正しくありません');
    if ($err = passwordPolicyError($pass)) authFail(400, $err);
    // 同時に2人がセットアップしても、管理者になるのは先の1人だけにする
    $created = kvUpdate('app_users', function ($users) use ($email, $name, $pass) {
        if (!empty($users)) return null;
        return [[
            'email' => $email, 'name' => $name, 'slack_id' => '', 'role' => 'admin',
            'password_hash' => password_hash($pass, PASSWORD_DEFAULT),
            'note' => '初回セットアップで作成', 'added_at' => (new DateTime())->format('Y/m/d H:i:s'), 'added_by' => 'setup',
        ]];
    });
    if (!$created) authFail(403, 'セットアップは完了しています。ログインしてください。');
    // 初回はパスワードログインを有効にしておく（あとで設定画面から切り替えられる）
    $s = kvGet('settings', []);
    if (!is_array($s['login_methods'] ?? null)) {
        $s['login_methods'] = loginMethods();
        $s['login_methods']['password'] = true;
        kvSet('settings', $s);
    }
    authStartSession(['id' => 'pw:' . $email, 'name' => $name ?: $email, 'email' => $email, 'picture' => '', 'provider' => 'password', 'role' => 'admin']);
    addEditLog('作成', '/users', '初回セットアップで管理者を作成しました', $name, $email);
    echo json_encode(['ok' => true]);
    exit;
}

// ── パスワードでログイン ──
if ($path === '/auth/login') {
    header('Content-Type: application/json; charset=utf-8');
    authRequirePostJson();
    if (!loginMethods()['password']) authFail(403, 'パスワードでのログインは無効です');
    $body  = json_decode(file_get_contents('php://input'), true) ?? [];
    $email = normEmail($body['email'] ?? '');
    $pass  = (string)($body['password'] ?? '');
    $ipKey = 'ip:' . hash('sha256', (string)($_SERVER['REMOTE_ADDR'] ?? ''));
    $emKey = 'em:' . hash('sha256', $email);
    if (loginLocked($ipKey) || loginLocked($emKey)) {
        authFail(429, 'ログインの失敗が続いたため、しばらく（15分）ログインできません');
    }
    $user = null;
    foreach (getAppUsers() as $u) {
        if (normEmail($u['email'] ?? '') === $email) { $user = $u; break; }
    }
    $hash = (string)($user['password_hash'] ?? '');
    // ユーザーがいなくても同じだけ時間をかける（登録済みのメールアドレスを推測させない）
    $ok = password_verify($pass, $hash !== '' ? $hash : password_hash('dummy-password', PASSWORD_DEFAULT));
    if (!$user || $hash === '' || !$ok) {
        loginFailed($ipKey); loginFailed($emKey);
        authFail(401, 'メールアドレスまたはパスワードが違います');
    }
    $role = resolveRoleForEmail($email, (string)($user['name'] ?? ''));
    if ($role === 'denied') authFail(403, 'このアカウントにはアクセス権限がありません');
    loginClear($ipKey); loginClear($emKey);
    if (password_needs_rehash($hash, PASSWORD_DEFAULT)) setUserPasswordHash($email, password_hash($pass, PASSWORD_DEFAULT));
    authStartSession(['id' => 'pw:' . $email, 'name' => (string)($user['name'] ?? '') ?: $email, 'email' => $email, 'picture' => '', 'provider' => 'password', 'role' => $role]);
    addEditLog('ログイン', 'auth', 'パスワードでログインしました（' . (ACCT_ROLE_LABELS[$role] ?? $role) . '）', (string)($user['name'] ?? ''), $email);
    echo json_encode(['ok' => true]);
    exit;
}

// ── 自分のパスワードを変える（ログイン中の本人だけ）──
if ($path === '/auth/password') {
    header('Content-Type: application/json; charset=utf-8');
    authRequirePostJson();
    if (!isLoggedIn()) authFail(401, 'ログインしてください');
    $me    = currentUser();
    $email = normEmail($me['email'] ?? '');
    $body  = json_decode(file_get_contents('php://input'), true) ?? [];
    $cur   = (string)($body['current'] ?? '');
    $new   = (string)($body['password'] ?? '');
    $user  = null;
    foreach (getAppUsers() as $u) if (normEmail($u['email'] ?? '') === $email) { $user = $u; break; }
    if (!$user) authFail(404, 'ユーザー管理に登録されていません');
    // すでにパスワードがあるなら、いまのパスワードを確かめる
    if (($user['password_hash'] ?? '') !== '' && !password_verify($cur, (string)$user['password_hash'])) {
        authFail(400, 'いまのパスワードが違います');
    }
    if ($err = passwordPolicyError($new)) authFail(400, $err);
    setUserPasswordHash($email, password_hash($new, PASSWORD_DEFAULT));
    addEditLog('更新', '/users', 'パスワードを変更しました', $me['name'] ?? '', $email);
    echo json_encode(['ok' => true]);
    exit;
}

// ── ユーザー管理 API（管理者のみ） ──
if ($path === '/auth/users') {
    header('Content-Type: application/json; charset=utf-8');
    if (!isLoggedIn()) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }
    requireAdmin();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        echo json_encode([
            'users'        => array_map('publicAppUser', getAppUsers()),
            'default_role' => getDefaultRole(),
            'me'           => normEmail(currentUser()['email'] ?? ''),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!acctIsSameOriginRequest()) {
            http_response_code(403);
            echo json_encode(['error' => 'Forbidden']);
            exit;
        }
        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        $me   = currentUser();

        // 既定ロールだけの更新
        if (isset($body['default_role']) && !isset($body['users'])) {
            setDefaultRole((string)$body['default_role']);
            addEditLog('更新', '/users', '未登録ユーザーの既定権限を変更しました', $me['name'] ?? '', $me['email'] ?? '');
            echo json_encode(['ok' => true]);
            exit;
        }

        $incoming = is_array($body['users'] ?? null) ? $body['users'] : [];
        // Slack のユーザーIDは画面から受け取らず、保存済みの登録から引き継ぐ（メールアドレスで対応付け）
        // パスワードのハッシュも同じく保存済みの登録から引き継ぐ（新しいパスワードが来たときだけ変える）
        $slackIds = [];
        $hashes   = [];
        foreach (getAppUsers() as $u) {
            if (!empty($u['slack_id'])) $slackIds[normEmail($u['email'] ?? '')] = $u['slack_id'];
            if (!empty($u['password_hash'])) $hashes[normEmail($u['email'] ?? '')] = $u['password_hash'];
        }
        $pwChanged = [];
        $clean    = [];
        $seen     = [];
        foreach ($incoming as $u) {
            $email = normEmail($u['email'] ?? '');
            if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) continue;
            if (isset($seen[$email])) continue;   // 重複除去
            $seen[$email] = true;
            $role = $u['role'] ?? 'viewer';
            if (!in_array($role, ACCT_ROLES, true)) $role = 'viewer';
            $hash = $hashes[$email] ?? '';
            $newPass = (string)($u['new_password'] ?? '');
            if ($newPass !== '') {
                if ($err = passwordPolicyError($newPass)) {
                    http_response_code(400);
                    echo json_encode(['error' => "{$email}: {$err}"], JSON_UNESCAPED_UNICODE);
                    exit;
                }
                $hash = password_hash($newPass, PASSWORD_DEFAULT);
                $pwChanged[] = $email;
            } elseif (!empty($u['clear_password'])) {
                if ($hash !== '') $pwChanged[] = $email;
                $hash = '';
            }
            $clean[] = [
                'email'    => $email,
                'name'     => trim((string)($u['name'] ?? '')),
                'slack_id' => $slackIds[$email] ?? '',
                'role'     => $role,
                'password_hash' => $hash,
                'note'     => trim((string)($u['note'] ?? '')),
                'added_at' => $u['added_at'] ?? (new DateTime())->format('Y/m/d H:i:s'),
                'added_by' => $u['added_by'] ?? ($me['email'] ?? ''),
            ];
        }

        // 管理者が0人になる保存は拒否（自分で締め出さないため）
        $admins = array_values(array_filter($clean, fn($u) => $u['role'] === 'admin'));
        if (!$admins) {
            http_response_code(400);
            echo json_encode(['error' => '管理者を最低1人残してください'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        // 自分自身の管理者権限は外せない（他の管理者が外すのは可）
        $meEmail = normEmail($me['email'] ?? '');
        $meRow   = null;
        foreach ($clean as $u) { if ($u['email'] === $meEmail) { $meRow = $u; break; } }
        if ($meEmail !== '' && (!$meRow || $meRow['role'] !== 'admin')) {
            http_response_code(400);
            echo json_encode(['error' => '自分自身の管理者権限は変更できません'], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 差分をログに残す
        $before = [];
        foreach (getAppUsers() as $u) $before[normEmail($u['email'] ?? '')] = $u['role'] ?? 'viewer';
        $roleLbl = ACCT_ROLE_LABELS;
        $diffs = [];
        foreach ($clean as $u) {
            $old = $before[$u['email']] ?? null;
            if ($old === null)          $diffs[] = "{$u['email']} を追加（{$roleLbl[$u['role']]}）";
            elseif ($old !== $u['role']) $diffs[] = "{$u['email']} を{$roleLbl[$old]}→{$roleLbl[$u['role']]}に変更";
            unset($before[$u['email']]);
        }
        foreach (array_keys($before) as $goneEmail) $diffs[] = "{$goneEmail} を削除";
        foreach ($pwChanged as $pwEmail) $diffs[] = "{$pwEmail} のパスワードを変更";

        saveAppUsers($clean);
        if (isset($body['default_role'])) setDefaultRole((string)$body['default_role']);

        if ($diffs) {
            addEditLog('更新', '/users', implode('、', $diffs), $me['name'] ?? '', $me['email'] ?? '');
        }
        echo json_encode(['ok' => true, 'users' => array_map('publicAppUser', $clean)], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

if ($path === '/auth/logout') {
    $user = currentUser();
    if (!empty($user['name'])) {
        addEditLog('ログアウト', 'auth', 'ログアウトしました', $user['name'] ?? '', $user['email'] ?? '');
    }
    $_SESSION = [];
    session_destroy();
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true]);
    exit;
}

// ── Slack でログイン（OpenID Connect）──
if ($path === '/auth/slack') {
    $conf = getOAuthConf();
    if (!loginMethods()['slack'] || $conf['slack_client_id'] === '') authHtmlError('Slack でのログインは無効です。設定 → ログイン方法 で有効にしてください。');
    $state = bin2hex(random_bytes(16));
    $_SESSION['oauth_state'] = $state;
    $_SESSION['oauth_nonce'] = $nonce = bin2hex(random_bytes(16));
    $url = 'https://slack.com/openid/connect/authorize?' . http_build_query([
        'response_type' => 'code',
        'client_id'     => $conf['slack_client_id'],
        'redirect_uri'  => _selfBase() . '/auth.php?_path=/auth/slack/callback',
        'state'         => $state,
        'scope'         => 'openid profile email',
        'nonce'         => $nonce,
    ], '', '&', PHP_QUERY_RFC3986);
    header('Location: ' . $url);
    exit;
}

if ($path === '/auth/slack/callback') {
    $conf = getOAuthConf();
    if (!loginMethods()['slack']) authHtmlError('Slack でのログインは無効です。');
    authCheckState();
    $resp = _httpPost('https://slack.com/api/openid.connect.token', [
        'client_id'     => $conf['slack_client_id'],
        'client_secret' => $conf['slack_client_secret'],
        'code'          => (string)($_GET['code'] ?? ''),
        'redirect_uri'  => _selfBase() . '/auth.php?_path=/auth/slack/callback',
        'grant_type'    => 'authorization_code',
    ]);
    $data = json_decode($resp, true);
    if (empty($data['ok']) || empty($data['access_token'])) authHtmlError('Slack のトークンを取得できませんでした: ' . ($data['error'] ?? 'unknown'));
    $uData = json_decode(_httpGet('https://slack.com/api/openid.connect.userInfo', $data['access_token']), true) ?: [];
    if (isset($uData['email_verified']) && !$uData['email_verified']) authHtmlError('Slack のメールアドレスが確認されていません。');
    finishOAuthLogin([
        'id'       => $uData['sub'] ?? '',
        'name'     => $uData['name'] ?? $uData['given_name'] ?? '',
        'email'    => $uData['email'] ?? '',
        'picture'  => $uData['picture'] ?? '',
        'provider' => 'slack',
    ], 'Slack', (string)($uData['sub'] ?? ''));
}

// ── Google でログイン（OpenID Connect）──
if ($path === '/auth/google') {
    $conf = getOAuthConf();
    if (!loginMethods()['google'] || $conf['google_client_id'] === '') authHtmlError('Google でのログインは無効です。設定 → ログイン方法 で有効にしてください。');
    $state = bin2hex(random_bytes(16));
    $_SESSION['oauth_state'] = $state;
    $_SESSION['oauth_nonce'] = $nonce = bin2hex(random_bytes(16));
    $url = 'https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query([
        'response_type' => 'code',
        'client_id'     => $conf['google_client_id'],
        'redirect_uri'  => _selfBase() . '/auth.php?_path=/auth/google/callback',
        'scope'         => 'openid email profile',
        'state'         => $state,
        'nonce'         => $nonce,
        'prompt'        => 'select_account',
    ], '', '&', PHP_QUERY_RFC3986);
    header('Location: ' . $url);
    exit;
}

if ($path === '/auth/google/callback') {
    $conf = getOAuthConf();
    if (!loginMethods()['google']) authHtmlError('Google でのログインは無効です。');
    authCheckState();
    $data = json_decode(_httpPost('https://oauth2.googleapis.com/token', [
        'client_id'     => $conf['google_client_id'],
        'client_secret' => $conf['google_client_secret'],
        'code'          => (string)($_GET['code'] ?? ''),
        'redirect_uri'  => _selfBase() . '/auth.php?_path=/auth/google/callback',
        'grant_type'    => 'authorization_code',
    ]), true) ?: [];
    if (empty($data['access_token'])) authHtmlError('Google のトークンを取得できませんでした: ' . ($data['error_description'] ?? $data['error'] ?? 'unknown'));
    $uData = json_decode(_httpGet('https://openidconnect.googleapis.com/v1/userinfo', $data['access_token']), true) ?: [];
    if (empty($uData['email']) || empty($uData['email_verified'])) authHtmlError('Google のメールアドレスが確認されていません。');
    finishOAuthLogin([
        'id'       => 'google:' . ($uData['sub'] ?? ''),
        'name'     => $uData['name'] ?? '',
        'email'    => $uData['email'],
        'picture'  => $uData['picture'] ?? '',
        'provider' => 'google',
    ], 'Google');
}

// ── 編集ログ API ──
// ★以前は認証が無く（しかも CORS 全許可）、誰でも全ログ（氏名・メール・金額）を読めて、
//   任意の名前で偽のログを書き込めた。書き込まれた文字列は管理者のログ画面に
//   そのまま描画されていた（保存型 XSS）。
//   いまは: 閲覧は管理者のみ、書き込みはログイン中の本人の名義でのみ。
if ($path === '/auth/logs') {
    header('Content-Type: application/json; charset=utf-8');
    if (!isLoggedIn()) { http_response_code(401); echo json_encode(['error' => 'Unauthorized']); exit; }
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        requireAdmin();
        echo json_encode(['logs' => getEditLogs()], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        if (!isAdmin() || !acctIsSameOriginRequest()) {
            http_response_code(403);
            echo json_encode(['error' => 'Forbidden']);
            exit;
        }
        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        $user = currentUser();
        addEditLog(
            mb_substr((string)($body['action'] ?? ''), 0, 20),
            mb_substr((string)($body['target'] ?? ''), 0, 100),
            mb_substr((string)($body['detail'] ?? ''), 0, 1000),
            (string)($user['name']  ?? ''),
            (string)($user['email'] ?? ''),
        );
        echo json_encode(['ok' => true]);
        exit;
    }
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── 閲覧ログ API（無効化：閲覧は記録しない）──
if ($path === '/auth/view-log') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true]);
    exit;
}


http_response_code(404);
echo 'Not found';
exit;

// ── ヘルパー ──
function authFail(int $status, string $message): void {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
/** 更新系（ログイン・セットアップ）は同一オリジンからの POST だけ受け付ける */
function authRequirePostJson(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') authFail(405, 'Method not allowed');
    if (!acctIsSameOriginRequest()) authFail(403, 'Forbidden');
}
function authHtmlError(string $message): void {
    http_response_code(400);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
       . '<div style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center;padding:0 16px">'
       . '<h2 style="font-size:17px;color:#1e293b">ログインできませんでした</h2>'
       . '<p style="font-size:13px;color:#64748b;line-height:1.7">' . htmlspecialchars($message, ENT_QUOTES) . '</p>'
       . '<p><a href="' . htmlspecialchars(_selfBase() . '/', ENT_QUOTES) . '" style="font-size:13px">ログイン画面に戻る</a></p></div>';
    exit;
}
function authCheckState(): void {
    $state = (string)($_GET['state'] ?? '');
    $saved = (string)($_SESSION['oauth_state'] ?? '');
    unset($_SESSION['oauth_state']);
    if (empty($_GET['code']) || $saved === '' || !hash_equals($saved, $state)) authHtmlError('認証エラー: state が一致しません。もう一度ログインしてください。');
}
/** ログイン済みのセッションを作る（セッション固定攻撃の対策で ID を振り直す） */
function authStartSession(array $user): void {
    session_regenerate_id(true);
    $_SESSION['acct_user'] = $user;
}
/** Slack / Google のログインの最後: 権限を確かめてセッションを作る */
function finishOAuthLogin(array $newUser, string $providerLabel, string $slackId = ''): void {
    if (($newUser['email'] ?? '') === '' || ($newUser['id'] ?? '') === '') authHtmlError("{$providerLabel} からメールアドレスを取得できませんでした。");
    $newUser['role'] = resolveRoleForEmail($newUser['email'], $newUser['name'] ?? '', $slackId);
    if ($newUser['role'] === 'denied') {
        addEditLog('ログイン', 'auth', 'アクセス権限がないためログインを拒否しました', $newUser['name'] ?? '', $newUser['email'] ?? '');
        $_SESSION = [];
        session_destroy();
        authHtmlError(($newUser['email'] ?? '') . ' はこのシステムに登録されていません。会計担当者にユーザー登録を依頼してください。');
    }
    authStartSession($newUser);
    $roleLabel = ACCT_ROLE_LABELS[$newUser['role']] ?? $newUser['role'];
    addEditLog('ログイン', 'auth', "{$providerLabel}でログインしました（{$roleLabel}）", $newUser['name'] ?? '', $newUser['email'] ?? '');
    header('Location: ' . _selfBase() . '/');
    exit;
}

function _selfBase(): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'];
    $dir    = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
    return $scheme . '://' . $host . $dir;
}

function _httpPost(string $url, array $params): string {
    $ctx = stream_context_create(['http' => [
        'method'  => 'POST',
        'header'  => "Content-Type: application/x-www-form-urlencoded\r\n",
        'content' => http_build_query($params),
        'timeout' => 15,
    ]]);
    return @file_get_contents($url, false, $ctx) ?: '{}';
}

function _httpGet(string $url, string $token): string {
    $ctx = stream_context_create(['http' => [
        'method'  => 'GET',
        'header'  => "Authorization: Bearer {$token}\r\n",
        'timeout' => 15,
    ]]);
    return @file_get_contents($url, false, $ctx) ?: '{}';
}

// ── 編集ログ（masterDB の kv_store に保存） ──
function getEditLogs(): array {
    $logs = kvGet('edit_logs', []);
    return array_reverse($logs); // 新しい順
}

function addEditLog(string $action, string $target, string $detail, string $userName, string $userEmail): void {
    $logs = kvGet('edit_logs', []);
    $logs[] = [
        'id'         => bin2hex(random_bytes(8)),
        'ts'         => (new DateTime())->format('Y/m/d H:i:s'),
        'action'     => $action,
        'target'     => $target,
        'detail'     => $detail,
        'user_name'  => $userName,
        'user_email' => $userEmail,
    ];
    // 最新2000件だけ保持
    if (count($logs) > 2000) $logs = array_slice($logs, -2000);
    kvSet('edit_logs', $logs);
}
