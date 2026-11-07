<?php
// ══════════════════════════════════════════════════════════════════════════════
// core/auth_roles.php — ユーザー権限（ロール）の共通ロジック
//   auth.php（画面・ユーザー管理API）と api/router.php（APIの権限チェック）の
//   両方から読み込む。
//
//   role: 'admin'  … 全ページ利用可
//         'viewer' … 決算書のみ閲覧可（更新系APIは不可）
//         'denied' … アクセス不可
//
//   保存先: master.db の kv_store['app_users']
//     [{ email, name, slack_id, role, note, added_at, added_by }, ...]
//   未登録ユーザーの扱い: kv_store['settings']['default_user_role']（既定 viewer）
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';

const ACCT_ROLES = ['admin', 'viewer', 'denied'];

/**
 * セッション開始（Cookie 属性をそろえる）。
 * ★SameSite=Lax を明示する。ブラウザ任せ（属性なし）だと、Firefox/Safari では
 *   他サイトからのフォーム POST にもログイン Cookie が付き、CSRF が成立していた。
 */
function acctSessionStart(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
          || (bool)ini_get('session.cookie_secure');   // サーバー側で Secure 指定済みなら弱めない
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/**
 * 更新系リクエストが同一オリジンから来たか（CSRF 対策）。
 * ブラウザは他サイトからの POST に必ず Origin / Sec-Fetch-Site を付けるので、それで判定する。
 * どちらも無い（curl 等のブラウザ以外）ときは Cookie が付かないので通してよい。
 */
function acctIsSameOriginRequest(): bool {
    $site = (string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '');
    if ($site !== '') return $site === 'same-origin' || $site === 'none';
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? ($_SERVER['HTTP_REFERER'] ?? ''));
    if ($origin === '') return true;
    $host = (string)parse_url($origin, PHP_URL_HOST);
    $port = parse_url($origin, PHP_URL_PORT);
    $hp   = strtolower($host . ($port ? ':' . $port : ''));
    return $hp !== '' && $hp === strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
}

const ACCT_ROLE_LABELS = [
    'admin'  => '管理者',
    'viewer' => '閲覧専用',
    'denied' => 'アクセス不可',
];

function normEmail(?string $e): string {
    return strtolower(trim((string)$e));
}

/** 登録済みユーザー一覧 */
function getAppUsers(): array {
    $list = kvGet('app_users', []);
    return is_array($list) ? array_values($list) : [];
}

function saveAppUsers(array $users): void {
    kvSet('app_users', array_values($users));
}

/**
 * 未登録ユーザーの既定ロール（viewer / denied）。
 * ★既定は denied。Slack・Google のログインは、登録していない人（よその Slack ワークスペースの人・
 *   ふつうの Google アカウント）も通ってくるため、未登録の人に決算書を見せるのは明示的に選んだときだけ。
 */
function getDefaultRole(): string {
    $s = kvGet('settings', []);
    $r = $s['default_user_role'] ?? 'denied';
    return in_array($r, ['viewer', 'denied'], true) ? $r : 'denied';
}

function setDefaultRole(string $role): void {
    if (!in_array($role, ['viewer', 'denied'], true)) return;
    kvSet('settings', array_merge(kvGet('settings', []), ['default_user_role' => $role]));
}

/** 名前の照合用に空白（全角・半角）を除く */
function normUserName(?string $n): string {
    return preg_replace('/[\s\x{3000}]+/u', '', trim((string)$n));
}

/**
 * ログインユーザーのロールを解決する（メールアドレス → Slack のユーザーID → 名前 の順に照合）。
 *
 * Slack のメールアドレスを変えても入れるように、メールで見つからなければ Slack のユーザーID、
 * それでも見つからなければ名前で登録を探す。ID・名前で見つかったときは、その登録のメールアドレスを
 * 新しいものに書き換え、ユーザーIDを紐付ける（以後はメール・IDで照合する）。
 * ★名前は本人が変えられるので、名前での照合は「ユーザーIDがまだ紐付いていない登録」で
 *   「同じ名前の登録が1件だけ」のときに限る。IDが紐付いた登録は、別の人が同じ名前にしても取られない。
 *
 * 誰も登録されていない状態では誰も入れない（最初の管理者は初回セットアップ画面で作る）。
 */
function resolveRoleForEmail(string $email, string $name = '', string $slackId = ''): string {
    $email = normEmail($email);
    $slackId = trim($slackId);
    if ($email === '' && $slackId === '') return getDefaultRole();

    $users = getAppUsers();

    // 登録ゼロ（初回セットアップ前）は誰も入れない
    if (!$users) return 'denied';

    $found = null;
    if ($email !== '') {
        foreach ($users as $i => $u) {
            if (normEmail($u['email'] ?? '') === $email) { $found = $i; break; }
        }
    }
    if ($found === null && $slackId !== '') {
        foreach ($users as $i => $u) {
            if (($u['slack_id'] ?? '') === $slackId) { $found = $i; break; }
        }
    }
    if ($found === null && $slackId !== '' && ($key = normUserName($name)) !== '') {
        $hits = array_keys(array_filter($users, fn($u) => normUserName($u['name'] ?? '') === $key));
        if (count($hits) === 1 && ($users[$hits[0]]['slack_id'] ?? '') === '') $found = $hits[0];
    }
    if ($found === null) return getDefaultRole();

    // ユーザーIDの紐付け・メールアドレスの更新（変わったときだけ保存）
    $u = $users[$found];
    $changed = false;
    if ($slackId !== '' && ($u['slack_id'] ?? '') === '') { $u['slack_id'] = $slackId; $changed = true; }
    if ($email !== '' && normEmail($u['email'] ?? '') !== $email
        && !array_filter($users, fn($x) => normEmail($x['email'] ?? '') === $email)) {
        $u['note'] = trim(($u['note'] ?? '') . ' メール変更: ' . ($u['email'] ?? '') . ' → ' . $email);
        $u['email'] = $email;
        $changed = true;
    }
    if ($changed) { $users[$found] = $u; saveAppUsers($users); }

    $r = $u['role'] ?? 'viewer';
    return in_array($r, ACCT_ROLES, true) ? $r : 'viewer';
}

/** セッションのユーザーの権限（Slack のユーザーIDでの照合は Slack でログインしたときだけ） */
function resolveRoleForSession(array $u): string {
    // 設定で切ったログイン方法で入っているセッションは使えなくする
    $provider = (string)($u['provider'] ?? '');
    if ($provider !== '' && empty(loginMethods()[$provider])) return 'denied';
    $slackId = $provider === 'slack' ? (string)($u['id'] ?? '') : '';
    return resolveRoleForEmail((string)($u['email'] ?? ''), (string)($u['name'] ?? ''), $slackId);
}

/**
 * 閲覧専用ユーザーに返す設定から機密情報を取り除く。
 * （settings には Slack トークン・APIキーが平文で入っているため）
 */
function maskSettingsForViewer(array $settings): array {
    $secretKeys = [
        'slack_client_id', 'slack_client_secret', 'slack_bot_token', 'slack_signing_secret',
        'slack_webhook_url', 'slack_app_token', 'php_internal_token', 'api_key',
        'google_api_key', 'openai_api_key', 'service_account', 'worker_token',
    ];
    foreach ($settings as $k => $v) {
        $lk = strtolower((string)$k);
        $isSecret = in_array($lk, $secretKeys, true)
            || str_contains($lk, 'token')
            || str_contains($lk, 'secret')
            || str_contains($lk, 'password')
            || str_contains($lk, 'api_key')
            || str_contains($lk, 'apikey')
            || str_contains($lk, 'webhook');
        if ($isSecret) unset($settings[$k]);
    }
    return $settings;
}

/** 画面に値を返さない設定（登録済みかどうかだけ secrets_set で返す） */
const SETTINGS_SECRET_KEYS = ['slack_client_secret', 'google_client_secret', 'php_internal_token'];

/**
 * 画面（/api/settings）に返す設定。
 * 秘密の値は管理者にも返さず、登録済みかどうかだけを secrets_set に入れる。
 * 機能の ON/OFF は既定値を埋めて features に、機能の名前は feature_meta に入れる。
 */
function settingsForClient(array $settings, bool $viewer): array {
    $set = [];
    foreach (SETTINGS_SECRET_KEYS as $k) {
        $set[$k] = trim((string)($settings[$k] ?? '')) !== '';
        unset($settings[$k]);
    }
    if ($viewer) {
        $settings = maskSettingsForViewer($settings);
        foreach (['slack_client_id', 'google_client_id', 'login_methods', 'invoice_seal', 'invoice_notes',
                  'invoice_from_addr', 'invoice_from_tel', 'invoice_from_zip', 'fee_presets'] as $k) unset($settings[$k]);
    } else {
        $settings['secrets_set'] = $set;
        $settings['login_methods'] = loginMethods();
    }
    // 年度 → 金額 の連想配列。空のときに [] で返すと、画面側で年度を足しても JSON に載らない
    if (empty($settings['opening_balances']) || !is_array($settings['opening_balances'])) $settings['opening_balances'] = new stdClass();
    $settings['features'] = appFeatures();
    $settings['feature_meta'] = array_map(fn($m) => ['label' => $m['label']], APP_FEATURES);
    return $settings;
}

/** 有効なログイン方法（未設定ならパスワードだけ） */
function loginMethods(): array {
    $s  = kvGet('settings', []);
    $lm = $s['login_methods'] ?? null;
    if (!is_array($lm)) {
        // 以前の版（Slack ログインだけ）から移ってきた場合は Slack ログインを続けて使えるようにする
        $slack = trim((string)($s['slack_client_id'] ?? '')) !== '' && trim((string)($s['slack_client_secret'] ?? '')) !== '';
        return ['password' => true, 'slack' => $slack, 'google' => false];
    }
    return ['password' => !empty($lm['password']), 'slack' => !empty($lm['slack']), 'google' => !empty($lm['google'])];
}

// ══════════════════════════════════════════════════════════════════════════════
// パスワードログイン
// ══════════════════════════════════════════════════════════════════════════════
/** パスワードの条件を満たさなければ理由を返す */
function passwordPolicyError(string $pass): ?string {
    if (mb_strlen($pass) < 10) return 'パスワードは10文字以上にしてください';
    if (strlen($pass) > 72) return 'パスワードは72バイト以内にしてください';
    return null;
}
function setUserPasswordHash(string $email, string $hash): void {
    $email = normEmail($email);
    kvUpdate('app_users', function ($users) use ($email, $hash) {
        $users = is_array($users) ? $users : [];
        foreach ($users as &$u) if (normEmail($u['email'] ?? '') === $email) $u['password_hash'] = $hash;
        unset($u);
        return array_values($users);
    });
}
/** 画面に返すユーザー（パスワードのハッシュは返さず、設定済みかどうかだけ） */
function publicAppUser(array $u): array {
    $u['has_password'] = !empty($u['password_hash']);
    unset($u['password_hash']);
    return $u;
}

// ── ログイン失敗の回数制限（同じメールアドレスは5回、同じ IP は20回の失敗で15分止める）──
//   IP は大学・会社のネットワークで多くの人が共有するので、メールアドレスより緩くする。
const LOGIN_LOCK_SECONDS = 900;
function loginLocked(string $key): bool {
    $max = str_starts_with($key, 'ip:') ? 20 : 5;
    $f = kvGet('login_failures', [])[$key] ?? null;
    return is_array($f) && ($f['count'] ?? 0) >= $max && time() - ($f['last'] ?? 0) < LOGIN_LOCK_SECONDS;
}
function loginFailed(string $key): void {
    kvUpdate('login_failures', function ($all) use ($key) {
        $all = is_array($all) ? $all : [];
        $now = time();
        // 古い記録は捨てる
        $all = array_filter($all, fn($f) => $now - ($f['last'] ?? 0) < LOGIN_LOCK_SECONDS);
        $f = $all[$key] ?? ['count' => 0, 'last' => 0];
        $all[$key] = ['count' => ($f['count'] ?? 0) + 1, 'last' => $now];
        return $all;
    });
}
function loginClear(string $key): void {
    kvUpdate('login_failures', function ($all) use ($key) {
        if (!is_array($all) || !isset($all[$key])) return null;
        unset($all[$key]);
        return $all;
    });
}

