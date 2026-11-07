<?php
require_once __DIR__ . '/../core/helpers.php';
require_once __DIR__ . '/../core/accounting.php';
require_once __DIR__ . '/../core/auth_roles.php';
require_once __DIR__ . '/../core/operations.php';
require_once __DIR__ . '/../core/ai_chat.php';

// 共通ヘッダー
// ★CORS の全許可（Access-Control-Allow-Origin: *）は廃止した。
//   この API を叩くのは同一オリジンの管理画面と、サーバー間通信の Worker だけ。
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$method = $_SERVER['REQUEST_METHOD'];
$uri    = $_SERVER['REQUEST_URI'];

// ベースパスを除去（サブディレクトリ対応）
$base = rtrim(dirname(dirname($_SERVER['SCRIPT_NAME'])), '/');
$path = '/' . ltrim(substr((string)parse_url($uri, PHP_URL_PATH), strlen($base)), '/');

// ── 認証チェック ──
// Slack ワークフロー(Cloudflare Worker)が利用するエンドポイント。
// Worker 側で Slack 署名検証済みのため、内部トークンでサーバー間認証する。
$isSlackEndpoint =
    ($path === '/api/claims' && $method === 'POST') ||
    ($path === '/api/transport-deadlines' && $method === 'GET') ||
    (preg_match('#^/api/claim-receipt/[^/]+$#', $path) && $method === 'POST');

// 締切の単月照会（?month=YYYY-MM → closed の真偽だけ返す）は機密を含まないので認証不要。
// Worker を先に更新できない場合でも申請フローの事前チェックが止まらないようにする。
$isPublicDeadlineCheck = $path === '/api/transport-deadlines' && $method === 'GET'
    && preg_match('/^\d{4}-\d{2}$/', (string)($_GET['month'] ?? ''));

// 内部トークン認証（サーバー間リクエスト用）
// ★fail-closed: トークン未設定の場合は通さない（以前は未設定だと無認証で申請を作れた）。
// ★内部トークンで通せるのは Slack 用エンドポイントだけ（管理 API 全体には効かせない）。
$internalToken = (string)($_SERVER['HTTP_X_INTERNAL_TOKEN'] ?? '');
$expectedToken = '';
try {
    $expectedToken = (string)(kvGet('settings', [])['php_internal_token'] ?? '');
} catch (\Throwable $e) { $expectedToken = ''; }
$internalOk = $isSlackEndpoint
    && $internalToken !== ''
    && $expectedToken !== ''
    && hash_equals($expectedToken, $internalToken);

if (!$internalOk && !$isPublicDeadlineCheck) {
    // 通常のブラウザアクセスはセッションログイン必須
    acctSessionStart();
    if (empty($_SESSION['acct_user']['id'])) {
        jsonResponse(['error' => 'Unauthorized'], 401);
    }

    // ★CSRF 対策: セッション認証での更新系リクエストは同一オリジンからのみ受け付ける
    if ($method !== 'GET' && !acctIsSameOriginRequest()) {
        jsonResponse(['error' => 'Forbidden', 'message' => '不正なリクエスト元です'], 403);
    }

    // ── 権限チェック（管理者以外は決算書の閲覧のみ） ──
    $role = resolveRoleForSession($_SESSION['acct_user']);
    // 管理者の「閲覧専用として見る」: X-View-As: viewer が付いた要求は閲覧専用と同じ扱いにする
    // （権限を下げる方向にしか働かないので、管理者以外が付けても何も変わらない）
    if ($role === 'admin' && ($_SERVER['HTTP_X_VIEW_AS'] ?? '') === 'viewer') $role = 'viewer';

    if ($role === 'denied') {
        jsonResponse(['error' => 'Forbidden', 'message' => 'アクセス権限がありません'], 403);
    }

    if ($role !== 'admin') {
        // 閲覧専用: 決算書の表示に必要な GET のみ許可
        // ★/api/members（氏名・カナ・会費）は決算書に不要なので閲覧専用には返さない。
        $viewerGetAllow = [
            '/api/kessan',
            '/api/kessan/detail',
            '/api/kessan/published',
            '/api/export/kessan',
            '/api/transactions',   // 年度セレクトの生成に必要（※後段で日付だけに絞って返す）
            '/api/accounts',
            '/api/settings',       // ※後段で機密キーをマスクして返す
        ];
        $allowed = ($method === 'GET') && in_array($path, $viewerGetAllow, true);
        // AIアシスタント: 閲覧専用でも話せる。使えるツール・見られる会話は ai_chat.php 側で絞る。
        // 設定の変更・承認・添付・Slack は管理者だけ
        $allowed = $allowed
            || ($method === 'GET'  && in_array($path, ['/api/ai/settings', '/api/ai/conversations'], true))
            || ($method === 'GET'  && preg_match('#^/api/ai/conversations/[^/]+$#', $path))
            || ($method === 'POST' && $path === '/api/ai/chat');
        if (!$allowed) {
            jsonResponse([
                'error'   => 'Forbidden',
                'message' => '閲覧専用アカウントです。決算書のみ閲覧できます。',
            ], 403);
        }
        define('ACCT_VIEWER_ONLY', true);
    }
    // セッションの書き込みは不要なので早めに解放する（同一ユーザーの並列リクエストを直列化させない）
    session_write_close();
}
if (!defined('ACCT_VIEWER_ONLY')) define('ACCT_VIEWER_ONLY', false);

// ── 機能の ON/OFF（設定で切った機能の API は使えない）──
// メンバー名簿は会費の請求と申請（カナの照合）の両方で使う
if ($path === '/api/members' && !featureEnabled('billing') && !featureEnabled('claims')) {
    jsonResponse(['error' => 'Not found', 'message' => 'この機能は無効になっています（設定 → 使う機能）'], 404);
}
if (($feat = featureForApiPath($path)) !== null && !featureEnabled($feat)) {
    jsonResponse(['error' => 'Not found', 'message' => 'この機能は無効になっています（設定 → 使う機能）'], 404);
}

// ── ルーティング ──
try {
    // Transactions
    if ($path === '/api/transactions' && $method === 'GET')      { handleGetTx(); }
    elseif ($path === '/api/transactions' && $method === 'POST') { handleAddTx(); }
    elseif (preg_match('#^/api/transactions/([^/]+)$#', $path, $m)) { handleModTx($m[1]); }

    // Masters
    elseif ($path === '/api/accounts')    { handleAccounts(); }
    elseif ($path === '/api/rules')       { handleRules(); }
    elseif ($path === '/api/settings')    { handleSettings(); }
    elseif ($path === '/api/members')     { handleMembers(); }

    // Apply rules
    elseif ($path === '/api/apply-rules' && $method === 'POST') { handleApplyRules(); }

    // PDF upload
    elseif ($path === '/api/upload'  && $method === 'POST') { handleUpload(); }
    elseif ($path === '/api/uploads' && $method === 'GET')  { jsonResponse(['files' => kvGet('uploads_log', [])]); }
    elseif ($path === '/api/upload-dates' && $method === 'GET') { jsonResponse(['dates' => kvGet('upload_dates', [])]); }
    elseif ($path === '/api/upload-credit-csv' && $method === 'POST') { handleCreditCsvUpload(); }

    // 期間リセット（仕訳・取込済み日付の巻き戻し）
    elseif ($path === '/api/reset-period'  && $method === 'POST') { handleResetPeriod(); }
    elseif ($path === '/api/reset-history' && $method === 'GET')  { jsonResponse(['resets' => array_reverse(kvGet('reset_log', []))]); }
    elseif ($path === '/api/reset-undo'    && $method === 'POST') { handleResetUndo(); }
    elseif ($path === '/api/credit-csv-uploads' && $method === 'GET') { jsonResponse(['files' => kvGet('credit_csv_log', [])]); }
    elseif ($path === '/api/credit-rules' && $method === 'GET')  { jsonResponse(['rules' => kvGet('credit_rules', [])]); }
    elseif ($path === '/api/credit-rules' && $method === 'POST') { kvSet('credit_rules', getRequestBody()['rules'] ?? []); jsonResponse(['ok' => true]); }
    elseif ($path === '/api/apply-credit-rules' && $method === 'POST') { handleApplyCreditRules(); }

    // Receipt (領収書)
    elseif ($path === '/api/receipt-upload' && $method === 'POST') { handleReceiptUpload(); }
    elseif (preg_match('#^/api/receipt/([^/]+)$#', $path, $m) && $method === 'GET')    { handleReceiptGet($m[1]); }
    elseif (preg_match('#^/api/receipt/([^/]+)$#', $path, $m) && $method === 'DELETE') { handleReceiptDelete($m[1]); }
    // 申請の領収書取得（Slack経由でアップロードされたファイル）
    elseif (preg_match('#^/api/claim-receipt/([^/]+)$#', $path, $m) && $method === 'GET')  { handleClaimReceiptGet($m[1]); }
    elseif (preg_match('#^/api/claim-receipt/([^/]+)$#', $path, $m) && $method === 'POST') { handleClaimReceiptUpload($m[1]); }

    // Kessan
    elseif ($path === '/api/kessan'        && $method === 'GET') { handleKessan(); }
    elseif ($path === '/api/kessan/detail' && $method === 'GET') { handleKessanDetail(); }
    elseif ($path === '/api/kessan/published')                    { handleKessanPublished(); }

    // Invoices
    elseif ($path === '/api/invoices' || preg_match('#^/api/invoices/([^/]+)$#', $path, $m)) {
        handleInvoices($m[1] ?? null);
    }

    // Billing sheets
    elseif ($path === '/api/billing/sheets' || preg_match('#^/api/billing/sheets/([^/]+)$#', $path, $m)) {
        handleBillingSheets($m[1] ?? null);
    }
    elseif (preg_match('#^/api/billing/check/([^/]+)$#', $path, $m) && $method === 'POST') {
        handleBillingCheck($m[1]);
    }
    elseif (preg_match('#^/api/billing/manual-paid/([^/]+)$#', $path, $m) && $method === 'POST') {
        handleBillingManualPaid($m[1]);
    }

    // Exports
    elseif (str_starts_with($path, '/api/export/') || $path === '/api/billing/excel') {
        handleExport($path);
    }

    // Claims
    elseif ($path === '/api/claims' && $method === 'GET')  { jsonResponse(['claims' => getAllClaims()]); }
    elseif ($path === '/api/claims' && $method === 'POST') { handleCreateClaim(); }
    elseif (preg_match('#^/api/claims/([^/]+)/journal$#', $path, $m) && $method === 'POST') {
        handleJournalClaim($m[1]);
    }
    elseif (preg_match('#^/api/claims/([^/]+)$#', $path, $m)) { handleModClaim($m[1]); }

    // Claims settings
    elseif ($path === '/api/settings/claims') { handleClaimsSettings(); }

    // Transport deadlines (月ごとの締め切り)
    elseif ($path === '/api/transport-deadlines') { handleTransportDeadlines(); }

    // AIアシスタント（Claude API）
    elseif ($path === '/api/ai/settings')      { handleAiSettings(); }
    elseif ($path === '/api/ai/slack-test' && $method === 'POST') { handleAiSlackTest(); }
    elseif ($path === '/api/ai/conversations' && $method === 'GET') { jsonResponse(['conversations' => aiListConversations(aiCurrentUser())]); }
    elseif (preg_match('#^/api/ai/conversations/([^/]+)$#', $path, $m)) { handleAiConversation($m[1]); }
    elseif ($path === '/api/ai/chat'    && $method === 'POST') { handleAiChat(); }
    elseif ($path === '/api/ai/upload'  && $method === 'POST') { handleAiUpload(); }
    elseif (preg_match('#^/api/ai/file/([^/]+)$#', $path, $m) && $method === 'GET') { aiFileServe($m[1]); }
    elseif ($path === '/api/ai/approve' && $method === 'POST') { handleAiApprove(); }

    // 駅サジェスト・経路検索は Cloudflare Worker (Slackモーダル) 側で処理するため廃止
    // (旧: /api/stations, /api/routes)

    else { jsonResponse(['error' => 'Not found', 'path' => $path], 404); }

} catch (Throwable $e) {
    // ★スタックトレース（サーバーの絶対パス・内部構造）は応答に載せず、ログにだけ残す
    error_log('small-org-accounting api: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
    jsonResponse(['error' => $e->getMessage()], 500);
}

// ══════════════════════════════════════════════════════════════════════════════
// Transactions
// ══════════════════════════════════════════════════════════════════════════════
function handleGetTx(): void {
    if (ACCT_VIEWER_ONLY) {
        // 閲覧専用は年度セレクトを作るためだけに使うので、取引の中身（相手先・金額・摘要）は
        // 返さない。未公開月の取引が丸見えになり、決算書の公開設定が素通りしていた。
        $months = txDb()->query("SELECT DISTINCT substr(date,1,7) AS ym FROM transactions WHERE date <> ''")
            ->fetchAll(PDO::FETCH_COLUMN);
        jsonResponse(['transactions' => array_map(fn($ym) => ['date' => $ym . '/01'], $months)]);
    }
    jsonResponse(['transactions' => getAllTransactions()]);
}
function handleAddTx(): void {
    $data = getRequestBody();
    if (empty($data['id']))       $data['id']       = newUuid();
    if (empty($data['group_id'])) $data['group_id'] = newUuid();
    upsertTransaction($data);
    jsonResponse(['ok' => true, 'transaction' => $data]);
}
function handleModTx(string $id): void {
    global $method;
    if ($method === 'DELETE') {
        deleteTransaction($id);
        jsonResponse(['ok' => true]);
    }
    if ($method === 'PUT') {
        $tx = getTransactionById($id);
        if (!$tx) jsonResponse(['error' => 'not found'], 404);
        $body = getRequestBody();
        // リクエストで明示指定された科目は entries にも反映させる（従来は extra_json
        // にしか入らず、仕訳帳の借方/貸方が空のまま登録済みになっていた）
        upsertTransaction(array_merge($tx, $body, ['id' => $id]), array_keys($body));
        jsonResponse(['ok' => true]);
    }
    jsonResponse(['error' => 'Method not allowed'], 405);
}

// ══════════════════════════════════════════════════════════════════════════════
// Masters
// ══════════════════════════════════════════════════════════════════════════════
function handleAccounts(): void {
    global $method;
    if ($method === 'POST') { kvSet('accounts', getRequestBody()); jsonResponse(['ok' => true]); }
    ensureDefaultAccounts();
    jsonResponse(kvGet('accounts', []));
}
function handleRules(): void {
    global $method;
    if ($method === 'POST') { kvSet('rules', getRequestBody()['rules'] ?? []); jsonResponse(['ok' => true]); }
    jsonResponse(['rules' => kvGet('rules', [])]);
}
function handleSettings(): void {
    global $method;
    if ($method === 'POST') {
        $cur  = kvGet('settings', []);
        $body = getRequestBody();
        // 画面に返している計算済みの値は保存しない
        unset($body['features_meta'], $body['feature_meta'], $body['secrets_set'], $body['login_ready']);
        // 秘密の値は空なら変えない（画面には登録済みかどうかしか返していないため）
        foreach (SETTINGS_SECRET_KEYS as $k) {
            if (array_key_exists($k, $body) && trim((string)$body[$k]) === '') unset($body[$k]);
            elseif (array_key_exists($k, $body)) $body[$k] = trim((string)$body[$k]);
        }
        if (array_key_exists('features', $body)) {
            $f = is_array($body['features']) ? $body['features'] : [];
            $body['features'] = [];
            foreach (array_keys(APP_FEATURES) as $k) {
                if (array_key_exists($k, $f)) $body['features'][$k] = (bool)$f[$k];
            }
        }
        if (array_key_exists('login_methods', $body)) {
            $lm = is_array($body['login_methods']) ? $body['login_methods'] : [];
            $lm = ['password' => !empty($lm['password']), 'slack' => !empty($lm['slack']), 'google' => !empty($lm['google'])];
            $next = array_merge($cur, $body, ['login_methods' => $lm]);
            if (!array_filter($lm)) jsonResponse(['error' => 'ログイン方法を1つ以上選んでください'], 400);
            if ($lm['slack'] && (trim((string)($next['slack_client_id'] ?? '')) === '' || trim((string)($next['slack_client_secret'] ?? '')) === '')) {
                jsonResponse(['error' => 'Slack でログインするには Client ID と Client Secret が必要です'], 400);
            }
            if ($lm['google'] && (trim((string)($next['google_client_id'] ?? '')) === '' || trim((string)($next['google_client_secret'] ?? '')) === '')) {
                jsonResponse(['error' => 'Google でログインするには Client ID と Client Secret が必要です'], 400);
            }
            $body['login_methods'] = $lm;
        }
        if (array_key_exists('invoice_seal', $body)) {
            $seal = (string)$body['invoice_seal'];
            if ($seal !== '' && (!preg_match('#^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$#', $seal) || strlen($seal) > 450000)) {
                jsonResponse(['error' => '角印の画像が正しくないか、大きすぎます（300KBまで）'], 400);
            }
        }
        if (array_key_exists('sub_report_accounts', $body)) {
            $body['sub_report_accounts'] = array_values(array_filter(array_map(
                fn($n) => mb_substr(trim((string)$n), 0, 100), (array)$body['sub_report_accounts']), 'strlen'));
        }
        kvSet('settings', array_merge($cur, $body));
        jsonResponse(['ok' => true]);
    }
    jsonResponse(settingsForClient(kvGet('settings', []), ACCT_VIEWER_ONLY));
}
function handleMembers(): void {
    global $method;
    if ($method === 'POST') { kvSet('members', getRequestBody()['members'] ?? []); jsonResponse(['ok' => true]); }
    jsonResponse(['members' => kvGet('members', [])]);
}

function handleApplyRules(): void {
    jsonResponse(['updated' => applyRulesToUnregistered()]);
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF Upload → Python(PDFパースのみ) → PHP(DB保存 + 申請自動マッチング)。処理は core/operations.php
// ══════════════════════════════════════════════════════════════════════════════
function handleUpload(): void {
    if (empty($_FILES['pdf'])) {
        jsonResponse(['success'=>false,'error'=>'ファイルが見つかりません'], 400);
    }
    $file = $_FILES['pdf'];
    if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
        jsonResponse(['success'=>false,'error'=>'アップロードに失敗しました（コード:'.$file['error'].'）'], 400);
    }
    if (!is_dir(UPLOAD_DIR)) mkdir(UPLOAD_DIR, 0755, true);
    // 古いPDFをクリーンアップ（残り物防止）
    foreach (glob(UPLOAD_DIR . '/*.pdf') ?: [] as $old) { @unlink($old); }
    // ★保存名はサーバー側で決める。利用者のファイル名（例: x.php）をそのまま公開ディレクトリに
    //   置かない。元のファイル名はアップロード履歴の表示にだけ使う。
    $dest = UPLOAD_DIR . '/upload_' . bin2hex(random_bytes(8)) . '.pdf';
    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        jsonResponse(['success'=>false,'error'=>'ファイルの保存に失敗しました'], 500);
    }
    try {
        $out = opImportBankPdf($dest, (string)$file['name'], (string)($_POST['period_start'] ?? ''), (string)($_POST['period_end'] ?? ''));
    } catch (OpException $e) {
        @unlink($dest);
        jsonResponse(['success'=>false,'error'=>$e->getMessage()], $e->status);
    }
    // パース完了後に PDF ファイルを削除（ストレージ圧迫防止）
    @unlink($dest);
    jsonResponse(['success' => true, 'count' => $out['count'], 'claim_matched' => $out['claim_matched']]);
}

// ══════════════════════════════════════════════════════════════════════════════
// 期間リセット
//   指定期間の仕訳を削除し、PDF取込済み日付を「未取込」に戻す（＝再アップロード可能）。
//   削除前に data/resets/ へスナップショットを保存し、取り消し（undo）できる。
// ══════════════════════════════════════════════════════════════════════════════
function handleResetPeriod(): void {
    try {
        jsonResponse(opResetPeriod(getRequestBody()));
    } catch (OpException $e) {
        jsonResponse(['error' => $e->getMessage()], $e->status);
    }
}

function handleResetUndo(): void {
    try {
        jsonResponse(opResetUndo((string)(getRequestBody()['id'] ?? '')));
    } catch (OpException $e) {
        jsonResponse(['error' => $e->getMessage()], $e->status);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// クレカ仕訳ルール適用
// ══════════════════════════════════════════════════════════════════════════════
function handleApplyCreditRules(): void {
    jsonResponse(['updated' => opApplyCreditRules()]);
}

// ══════════════════════════════════════════════════════════════════════════════
// クレジットカード明細CSVアップロード（三井住友カード法人カード明細）
// ══════════════════════════════════════════════════════════════════════════════
function handleCreditCsvUpload(): void {
    if (empty($_FILES['csv'])) {
        jsonResponse(['success' => false, 'error' => 'CSVファイルが見つかりません'], 400);
    }
    $file = $_FILES['csv'];
    try {
        $out = opImportCreditCsv((string)$file['tmp_name'], (string)$file['name'], (string)($_POST['payment_date'] ?? ''));
    } catch (OpException $e) {
        jsonResponse(['success' => false, 'error' => $e->getMessage()], $e->status);
    }
    jsonResponse([
        'success'      => true,
        'count'        => $out['count'],
        'skipped'      => $out['skipped'],
        'tx_id'        => $out['tx_id'],
        'registered'   => $out['registered'],
        'auto_applied' => $out['auto_applied'],
    ]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Kessan
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 決算書の月次公開設定。
 * kv_store['kessan_published'] = { "2026": ["4月","5月", ...], ... }
 * 管理者が公開した月だけ、閲覧専用ユーザーに見せる。
 */
function handleKessan(): void {
    $year    = $_GET['year'] ?? date('Y');
    $fyStart = (int)(kvGet('settings', [])['fiscal_year_start'] ?? 4);
    $txs     = getTransactionsByFy($year, $fyStart, true);
    $result  = calcKessan($txs, $year);
    // 本表の下に出す、設定で選んだ勘定科目だけの別表（設定が空なら出さない）
    $sub = subReportConfig();
    if ($sub) {
        $result['sub_report'] = calcKessan($txs, $year, $sub['accounts']);
        $result['sub_report_title'] = $sub['title'];
    }

    // PDF の注釈用: 各月末の立替金残高（期末残高のうち、まだ精算されていない立替の分）
    $result['advance_balance'] = calcAccountMonthEndBalance($txs, (string)$year, '立替金');

    $published = getPublishedMonths((string)$year);
    $result['published_months'] = $published;
    $result['is_admin']         = !ACCT_VIEWER_ONLY;

    if (ACCT_VIEWER_ONLY) {
        $visible = visibleKessanCols($published);
        $result['visible_cols'] = $visible;
        $strip = function(array $res) use ($visible): array {
            if (isset($res['sections'])) $res['sections'] = stripHiddenMonths($res['sections'], $visible);
            foreach (['net','monthly_balance','advance_balance','totals','summary'] as $k) {
                if (isset($res[$k]) && is_array($res[$k])) $res[$k] = stripHiddenMonths([$res[$k]], $visible)[0];
            }
            return $res;
        };
        $result = $strip($result);
        if (isset($result['sub_report'])) $result['sub_report'] = $strip($result['sub_report']);
    }
    jsonResponse($result);
}

/** 公開設定 API: GET は全ユーザー、POST は管理者のみ */
function handleKessanPublished(): void {
    global $method;
    $year = (string)($_GET['year'] ?? date('Y'));

    if ($method === 'POST') {
        if (ACCT_VIEWER_ONLY) {
            jsonResponse(['error' => '管理者のみ変更できます'], 403);
        }
        $body   = getRequestBody();
        $year   = (string)($body['year'] ?? $year);
        $months = is_array($body['months'] ?? null) ? $body['months'] : [];
        $saved  = setPublishedMonths($year, $months);
        jsonResponse(['ok' => true, 'year' => $year, 'months' => $saved]);
    }

    jsonResponse([
        'year'     => $year,
        'months'   => getPublishedMonths($year),
        'all'      => fyMonths(),
        'is_admin' => !ACCT_VIEWER_ONLY,
    ]);
}
function handleKessanDetail(): void {
    $name  = $_GET['name']  ?? '';
    $sub   = $_GET['sub']   ?? '';
    $month = $_GET['month'] ?? '';
    $year  = $_GET['year']  ?? '';

    // 閲覧専用ユーザーは公開済みの月しか内訳を見られない
    if (ACCT_VIEWER_ONLY) {
        $visible = visibleKessanCols(getPublishedMonths((string)$year));
        if (!in_array($month, $visible, true)) {
            jsonResponse(['error' => 'この月はまだ公開されていません'], 403);
        }
    }
    jsonResponse(['transactions' => kessanDetailRows($name, $sub, $month, (string)$year)]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Invoices
// ══════════════════════════════════════════════════════════════════════════════
function handleInvoices(?string $id): void {
    global $method;
    if ($id === null) {
        if ($method === 'POST') {
            $data = getRequestBody();
            if (empty($data['id']))         $data['id']         = newUuid();
            if (empty($data['invoice_no'])) $data['invoice_no'] = str_pad((string)(countInvoices()+1), 4, '0', STR_PAD_LEFT);
            if (empty($data['status']))     $data['status']     = '未送付';
            if (empty($data['created_at'])) $data['created_at'] = now('Y/m/d');
            upsertInvoice($data);
            jsonResponse(['ok'=>true, 'invoice'=>$data]);
        }
        jsonResponse(['invoices' => getAllInvoices()]);
    }
    if ($method === 'DELETE') { deleteInvoice($id); jsonResponse(['ok'=>true]); }
    if ($method === 'PUT') {
        $inv = getInvoice($id);
        if (!$inv) jsonResponse(['error'=>'not found'], 404);
        upsertInvoice(array_merge($inv, getRequestBody(), ['id' => $id]));
        jsonResponse(['ok'=>true]);
    }
    jsonResponse(['error'=>'Method not allowed'], 405);
}

// ══════════════════════════════════════════════════════════════════════════════
// Billing Sheets
// ══════════════════════════════════════════════════════════════════════════════
function handleBillingSheets(?string $id): void {
    global $method;
    if ($id === null) {
        if ($method === 'POST') {
            $data = getRequestBody();
            $data['id']              = newUuid();
            $data['created_at']      = now();
            $data['checked_at']      = null;
            $data['matched_count']   = 0;
            $data['journaled_count'] = 0;
            foreach ($data['members'] ?? [] as &$m) {
                $m['paid'] = false;
                unset($m['paid_tx_id'], $m['paid_date']);
            }
            unset($m);
            upsertSheet($data);
            jsonResponse(['ok'=>true, 'sheet'=>$data]);
        }
        jsonResponse(['sheets' => getAllSheets()]);
    }
    if ($method === 'DELETE') { deleteSheet($id); jsonResponse(['ok'=>true]); }
    if ($method === 'PUT') {
        $existing = getSheet($id);
        if (!$existing) jsonResponse(['error'=>'not found'], 404);
        $data = getRequestBody();
        // membersの摘要・請求額のみ更新（paid/paid_at など決済情報は保持）
        if (isset($data['members']) && is_array($data['members'])) {
            foreach ($existing['members'] as $i => &$em) {
                $up = $data['members'][$i] ?? null;
                if (!is_array($up)) continue;
                if (array_key_exists('fee', $up))          $em['fee']          = max(0, (int)$up['fee']);
                if (array_key_exists('tekiyo', $up))       $em['tekiyo']       = (string)$up['tekiyo'];
                if (array_key_exists('memo_template', $up))$em['memo_template']= (string)$up['memo_template'];
            }
            unset($em);
        }
        if (isset($data['due_date']))  $existing['due_date']  = $data['due_date'];
        if (isset($data['title']))     $existing['title']     = $data['title'];
        if (isset($data['period']))    $existing['period']    = $data['period'];
        upsertSheet($existing);
        jsonResponse(['ok'=>true, 'sheet'=>$existing]);
    }
    jsonResponse(['error'=>'Method not allowed'], 405);
}

function handleBillingCheck(string $sheetId): void {
    try {
        $r = opBillingCheck($sheetId);
    } catch (OpException $e) {
        jsonResponse(['error' => $e->getMessage()], $e->status);
    }
    jsonResponse(['ok'=>true, 'matched'=>$r['matched'], 'journaled'=>$r['journaled']]);
}

function handleBillingManualPaid(string $sheetId): void {
    $data = getRequestBody();
    try {
        $m = opBillingSetManualPaid($sheetId, (int)($data['index'] ?? -1), !empty($data['paid']), (string)($data['date'] ?? ''));
    } catch (OpException $e) {
        jsonResponse(['error' => $e->getMessage()], $e->status);
    }
    jsonResponse(['ok'=>true, 'member'=>$m]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Export (Python で Excel 生成)
// ══════════════════════════════════════════════════════════════════════════════
function handleExport(string $path): void {
    global $method;
    $body = $method === 'POST' ? getRequestBody() : [];

    $segment = ltrim(str_replace('/api/export/', '', $path), '/');

    // 閲覧専用ユーザーは、全月が公開されている年度の決算書だけ出力できる
    if (ACCT_VIEWER_ONLY) {
        $year = (string)($_GET['year'] ?? date('Y'));
        if ($segment !== 'kessan' || array_diff(fyMonths(), getPublishedMonths($year))) {
            jsonResponse(['error' => 'この年度はまだ全月が公開されていないため出力できません'], 403);
        }
    }
    $segment = str_replace('/api/billing/excel', 'billing_excel', $segment);

    try {
        $tmpOut = opExportExcel($segment, $body, $_GET);
    } catch (OpException $e) {
        jsonResponse(['error' => 'Excel生成失敗', 'detail' => $e->getMessage()], $e->status);
    }
    $dlName = opExportName($segment, $body, $_GET);

    header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    header('Content-Disposition: attachment; filename*=UTF-8\'\'' . rawurlencode($dlName));
    header('Content-Length: ' . filesize($tmpOut));
    readfile($tmpOut);
    @unlink($tmpOut);
    exit;
}

// ══════════════════════════════════════════════════════════════════════════════
// Claims
// ══════════════════════════════════════════════════════════════════════════════
function handleCreateClaim(): void {
    try {
        $claim = opCreateClaim(getRequestBody());
    } catch (OpException $e) {
        jsonResponse(['error' => $e->getMessage()], $e->status);
    }
    // Slack通知は Cloudflare Worker (Slackモーダル送信時) 側で行うためここでは送らない
    jsonResponse(['ok'=>true, 'claim'=>$claim]);
}

// 旧 notifySlackTransport() は Cloudflare Worker 側に移行したため削除

function handleModClaim(string $id): void {
    global $method;
    if ($method === 'DELETE') { deleteClaim($id); jsonResponse(['ok' => true]); }
    if ($method === 'PUT') {
        $c = getClaim($id);
        if (!$c) jsonResponse(['error'=>'not found'], 404);
        upsertClaim(array_merge($c, getRequestBody(), ['id' => $id]));
        jsonResponse(['ok' => true]);
    }
    jsonResponse(['error'=>'Method not allowed'], 405);
}

function handleJournalClaim(string $id): void {
    try {
        $tx = opJournalClaim($id, getRequestBody());
    } catch (OpException $e) {
        jsonResponse(['error' => $e->getMessage()], $e->status);
    }
    jsonResponse(['ok'=>true, 'tx'=>$tx]);
}

function handleClaimsSettings(): void {
    global $method;
    $sts = kvGet('settings', []);
    if ($method === 'POST') {
        // 申請まわりの設定だけを受け付ける（ログイン方法など、ほかの設定をここから変えさせない）
        $allowed = ['refund_days', 'transport_debit', 'transport_debit_sub', 'advance_debit', 'advance_debit_sub', 'refund_credit', 'refund_credit_sub'];
        kvSet('settings', array_merge($sts, array_intersect_key(getRequestBody(), array_flip($allowed))));
        jsonResponse(['ok' => true]);
    }
    jsonResponse([
        'refund_days'         => $sts['refund_days']         ?? 3,
        'transport_debit'     => $sts['transport_debit']     ?? '交通費',
        'transport_debit_sub' => $sts['transport_debit_sub'] ?? '',
        'advance_debit'       => $sts['advance_debit']       ?? '立替金',
        'advance_debit_sub'   => $sts['advance_debit_sub']   ?? '',
        'refund_credit'       => $sts['refund_credit']       ?? '普通預金',
        'refund_credit_sub'   => $sts['refund_credit_sub']   ?? bankAccountSub(),
    ]);
}

// ── 交通費 月次締め切り管理 ──
function handleTransportDeadlines(): void {
    global $method;
    // 締め切りは settings の transport_deadlines キーに {"YYYY-MM": true, ...} で保存
    $sts = kvGet('settings', []);
    $deadlines = $sts['transport_deadlines'] ?? [];

    if ($method === 'POST') {
        $body = getRequestBody();
        $month = $body['month'] ?? ''; // "YYYY-MM"
        $closed = $body['closed'] ?? false;
        if (!preg_match('/^\d{4}-\d{2}$/', $month)) {
            jsonResponse(['error' => 'Invalid month format'], 400);
        }
        if ($closed) {
            $deadlines[$month] = true;
        } else {
            unset($deadlines[$month]);
        }
        kvSet('settings', array_merge($sts, ['transport_deadlines' => $deadlines]));
        jsonResponse(['ok' => true, 'deadlines' => $deadlines]);
    }

    if ($method === 'GET') {
        // 申請フォームからの単月チェック: ?month=YYYY-MM
        $checkMonth = $_GET['month'] ?? '';
        if ($checkMonth) {
            $isClosed = !empty($deadlines[$checkMonth]);
            jsonResponse(['month' => $checkMonth, 'closed' => $isClosed]);
        }
        jsonResponse(['deadlines' => $deadlines]);
    }

    jsonResponse(['error' => 'Method not allowed'], 405);
}


// ════════════════════════════════════════════════════════════════════════
// 駅サジェスト / 経路検索は Cloudflare Worker (Slackモーダル) へ移行済み
// 旧 handleStationSuggest() / handleRouteSearch() は削除
// ════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// 領収書アップロード・取得・削除
// ══════════════════════════════════════════════════════════════════════════════

function handleReceiptUpload(): void {
    if (empty($_FILES['receipt'])) {
        jsonResponse(['success' => false, 'error' => 'ファイルが見つかりません'], 400);
        return;
    }
    $txId = $_POST['tx_id'] ?? '';
    if (!$txId) {
        jsonResponse(['success' => false, 'error' => 'tx_id が必要です'], 400);
        return;
    }

    $file = $_FILES['receipt'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        jsonResponse(['success' => false, 'error' => 'アップロードエラー（コード:' . $file['error'] . '）'], 400);
        return;
    }

    // 許可する MIME タイプ
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);
    $allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    if (!in_array($mime, $allowed, true)) {
        jsonResponse(['success' => false, 'error' => '許可されていないファイル形式です（JPEG/PNG/GIF/WebP/PDF のみ）'], 400);
        return;
    }

    // ファイルサイズ上限 10MB
    if ($file['size'] > 10 * 1024 * 1024) {
        jsonResponse(['success' => false, 'error' => 'ファイルサイズが大きすぎます（上限10MB）'], 400);
        return;
    }

    // 拡張子を MIME から決定（安全）
    $extMap = [
        'image/jpeg' => 'jpg', 'image/png' => 'png',
        'image/gif'  => 'gif', 'image/webp' => 'webp',
        'application/pdf' => 'pdf',
    ];
    $ext  = $extMap[$mime];
    $dir  = RECEIPT_DIR . '/' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $txId);
    if (!is_dir($dir)) mkdir($dir, 0755, true);

    // 既存ファイルを削除して置き換え
    foreach (glob($dir . '/*') ?: [] as $old) { @unlink($old); }

    $filename = 'receipt_' . time() . '.' . $ext;
    $dest     = $dir . '/' . $filename;
    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        jsonResponse(['success' => false, 'error' => '保存に失敗しました'], 500);
        return;
    }

    // DB の transactions に receipt_file を保存
    $db = new SQLite3(DB_TX);
    $db->busyTimeout(3000);
    $relPath = 'uploads/receipts/' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $txId) . '/' . $filename;
    $stmt = $db->prepare("UPDATE transactions SET receipt_file = :rf WHERE id = :id");
    $stmt->bindValue(':rf', $relPath);
    $stmt->bindValue(':id', $txId);
    $stmt->execute();
    $db->close();

    jsonResponse(['success' => true, 'path' => $relPath, 'mime' => $mime]);
}

function handleReceiptGet(string $txId): void {
    $dir = RECEIPT_DIR . '/' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $txId);
    $files = glob($dir . '/*') ?: [];
    $file = $files[0] ?? null;

    // txId 直下に領収書がない場合、transactions.receipt_file が指すパスを参照する。
    // （返金時に申請から自動引き継がれた領収書は uploads/receipts/claim_{id}/... に存在するため）
    if (!$file) {
        $tx = getTransactionById($txId);
        $file = receiptFilePath((string)($tx['receipt_file'] ?? ''));
    }

    if (!$file) {
        jsonResponse(['success' => false, 'error' => '領収書が見つかりません'], 404);
        return;
    }
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $file);
    finfo_close($finfo);
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($file));
    header('Cache-Control: private, max-age=3600');
    readfile($file);
    exit;
}

function handleReceiptDelete(string $txId): void {
    opReceiptDelete($txId);
    jsonResponse(['success' => true]);
}

// 申請（claims）に紐付いた領収書ファイルを返す
// Slack ワークフローから保存されたパス（uploads/receipts/claim_{id}/... 等）を参照
function handleClaimReceiptGet(string $claimId): void {
    $claim = getClaim($claimId);
    if (!$claim) { jsonResponse(['error' => '申請が見つかりません'], 404); return; }

    $receiptFile = (string)($claim['receipt_file'] ?? '');
    if (!$receiptFile) { jsonResponse(['error' => '領収書が登録されていません'], 404); return; }

    $filePath = receiptFilePath($receiptFile);
    if ($filePath === null) {
        jsonResponse(['error' => '領収書ファイルが見つかりません'], 404);
        return;
    }

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $filePath);
    finfo_close($finfo);
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($filePath));
    header('Cache-Control: private, max-age=3600');
    readfile($filePath);
    exit;
}

// 申請（claims）に領収書ファイルをアップロードして紐付ける
// Slack ワークフロー（Cloudflare Worker）が立替申請の領収書を転送する際に利用。
// 保存先: uploads/receipts/claim_{id}/receipt_xxx.ext、claims.receipt_file に相対パスを保存。
function handleClaimReceiptUpload(string $claimId): void {
    $claim = getClaim($claimId);
    if (!$claim) {
        jsonResponse(['success' => false, 'error' => '申請が見つかりません'], 404);
        return;
    }
    if (empty($_FILES['receipt'])) {
        jsonResponse(['success' => false, 'error' => 'ファイルが見つかりません'], 400);
        return;
    }
    $file = $_FILES['receipt'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        jsonResponse(['success' => false, 'error' => 'アップロードエラー（コード:' . $file['error'] . '）'], 400);
        return;
    }

    // MIME 判定
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);
    $extMap = [
        'image/jpeg' => 'jpg', 'image/png' => 'png',
        'image/gif'  => 'gif', 'image/webp' => 'webp',
        'application/pdf' => 'pdf',
    ];
    if (!isset($extMap[$mime])) {
        jsonResponse(['success' => false, 'error' => '許可されていないファイル形式です（JPEG/PNG/GIF/WebP/PDF のみ）'], 400);
        return;
    }
    if ($file['size'] > 10 * 1024 * 1024) {
        jsonResponse(['success' => false, 'error' => 'ファイルサイズが大きすぎます（上限10MB）'], 400);
        return;
    }

    $ext     = $extMap[$mime];
    $safeKey = 'claim_' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $claimId);
    $dir     = RECEIPT_DIR . '/' . $safeKey;
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    // 既存ファイルを置き換え
    foreach (glob($dir . '/*') ?: [] as $old) { @unlink($old); }

    $filename = 'receipt_' . time() . '.' . $ext;
    $dest     = $dir . '/' . $filename;
    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        // Worker からの転送では move_uploaded_file が使えないケースに備えフォールバック
        if (!@rename($file['tmp_name'], $dest) && !@copy($file['tmp_name'], $dest)) {
            jsonResponse(['success' => false, 'error' => '保存に失敗しました'], 500);
            return;
        }
    }

    $relPath = 'uploads/receipts/' . $safeKey . '/' . $filename;
    upsertClaim(array_merge($claim, ['receipt_file' => $relPath]));

    // すでに仕訳に紐付いている申請なら、その仕訳の領収書も差し替える
    // （仕訳登録の後で領収書が届くケース＝Slack転送でよく起きる）
    $linkedTxId = $claim['journal_tx_id'] ?? '';
    $db = new SQLite3(DB_TX);
    $db->busyTimeout(3000);
    if ($linkedTxId) {
        $stmt = $db->prepare("UPDATE transactions SET receipt_file = :rf WHERE id = :id");
        $stmt->bindValue(':rf', $relPath);
        $stmt->bindValue(':id', $linkedTxId);
        $stmt->execute();
    }
    $stmt = $db->prepare("UPDATE transactions SET receipt_file = :rf WHERE claim_id = :cid");
    $stmt->bindValue(':rf', $relPath);
    $stmt->bindValue(':cid', $claimId);
    $stmt->execute();
    $db->close();

    jsonResponse(['success' => true, 'path' => $relPath, 'mime' => $mime]);
}

// ══════════════════════════════════════════════════════════════════════════════
// AIアシスタント
// ══════════════════════════════════════════════════════════════════════════════
function aiCurrentUser(): array {
    return ['name' => (string)($_SESSION['acct_user']['name'] ?? ''), 'email' => (string)($_SESSION['acct_user']['email'] ?? ''),
            'viewer' => ACCT_VIEWER_ONLY];
}
function handleAiSettings(): void {
    global $method;
    if ($method === 'POST') { aiSaveSettings(getRequestBody()); }
    jsonResponse(aiPublicSettings(ACCT_VIEWER_ONLY) + ['usage' => aiUsageInfo(aiCurrentUser()),
                 'can_delete' => aiCanDelete(aiCurrentUser())]);
}
function handleAiSlackTest(): void {
    try {
        jsonResponse(aiSlackTest());
    } catch (\RuntimeException $e) {
        jsonResponse(['ok' => false, 'error' => $e->getMessage()]);
    }
}
function handleAiConversation(string $id): void {
    global $method;
    $conv = aiGetConversation($id);
    if (!$conv || !aiCanAccess($conv, aiCurrentUser())) jsonResponse(['error' => '会話が見つかりません'], 404);
    // 会話は記録として残す。削除できるのは AI_DELETE_EMAILS の人だけ
    if ($method === 'DELETE') {
        $user = aiCurrentUser();
        if (!aiCanDelete($user)) jsonResponse(['error' => '会話を削除する権限がありません'], 403);
        if (($conv['busy_until'] ?? '') > now('Y/m/d H:i:s')) jsonResponse(['error' => _aiBusyMessage($id)], 409);
        aiDeleteConversation($id);
        aiEditLog('削除', '/ai', '会話「' . ($conv['title'] ?: '（無題）') . '」を削除', $user);
        jsonResponse(['ok' => true]);
    }
    if ($method !== 'GET') jsonResponse(['error' => 'Method not allowed'], 405);
    jsonResponse(aiDisplay($conv));
}
/**
 * 画面が逐次表示を求めたら（本文の stream: true）、応答を Server-Sent Events で流す。
 * 1行に1つ「data: {JSON}」を送り、最後に t=done で会話の全体を送る。
 * Xserver の前段（nginx）や圧縮でためこまれないよう、バッファを切ってすぐ送る。
 */
function _aiWantsStream(): bool {
    return !empty(getRequestBody()['stream']);
}
function _aiStreamStart(): void {
    @set_time_limit(600);
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    @ini_set('implicit_flush', '1');
    if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
    while (ob_get_level() > 0) @ob_end_clean();
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-store, no-transform');
    header('X-Accel-Buffering: no');   // nginx にためこませない
    // 途中の機器がはじめの数KBをためることがあるので、空のコメントで押し出す
    echo ':' . str_repeat(' ', 2048) . "\n\n";
    @flush();
}
function _aiStreamSend(array $data): void {
    echo 'data: ' . json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
    @flush();
}

/** Claude を呼んで会話を進め、保存して返す。API のエラーは会話を保存せずに伝える */
function _aiRunAndRespond(array $conv): void {
    @set_time_limit(600);
    $stream = _aiWantsStream();
    $emit = null;
    if ($stream) {
        _aiStreamStart();
        // ツールを実行し終えて次の呼び出しに進むたびに、それまでの会話を送り直す（実行したツールの結果を画面に出す）
        $emit = function (array $e) use (&$conv): void {
            if (($e['t'] ?? '') === 'step') $e['view'] = aiDisplay($conv);
            _aiStreamSend($e);
        };
    }
    $error = null;
    try {
        aiRun($conv, aiCurrentUser(), $emit);
    } catch (\Anthropic\Core\Exceptions\AuthenticationException $e) {
        $error = 'Claude の APIキーが正しくありません。AI設定を確認してください。';
    } catch (\Anthropic\Core\Exceptions\RateLimitException $e) {
        $error = 'Claude API の利用上限に達しました。しばらく待ってから「続けて」と送ってください。';
    } catch (\Anthropic\Core\Exceptions\APIStatusException $e) {
        error_log('small-org-accounting ai: ' . $e->getMessage());
        $error = 'Claude API でエラーが発生しました（' . ($e->type?->value ?? 'error') . '）。時間をおいて「続けて」と送ってください。';
    } catch (\Anthropic\Core\Exceptions\APIConnectionException $e) {
        $error = 'Claude API に接続できませんでした。時間をおいて「続けて」と送ってください。';
    } catch (\RuntimeException $e) {
        $error = $e->getMessage();
    } catch (\Throwable $e) {
        // 逐次表示中はヘッダーを送ったあとなので、ルーターの共通のエラー処理（JSON）に任せられない
        if (!$stream) throw $e;
        error_log('small-org-accounting ai: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
        $error = 'AIアシスタントの処理中にエラーが発生しました。「続けて」と送ると再開します。';
    }
    // 失敗しても途中まで（送った発言・実行済みの操作）は残す
    aiSaveConversation($conv);
    aiUnlock($conv['id']);
    $conv['busy_by'] = '';
    $out = aiDisplay($conv) + ['usage' => aiUsageInfo(aiCurrentUser())];
    if ($error !== null) $out['error'] = $error;
    if ($stream) { _aiStreamSend(['t' => 'done', 'view' => $out]); exit; }
    jsonResponse($out);
}
function _aiBusyMessage(string $id): string {
    $who = aiGetConversation($id)['busy_by'] ?? '';
    return ($who !== '' ? "{$who} さんの依頼を" : 'ほかの依頼を') . 'AIアシスタントが処理中です。終わってからもう一度送ってください。';
}
function handleAiUpload(): void {
    if (empty($_FILES['file'])) jsonResponse(['error' => 'ファイルがありません'], 400);
    try {
        jsonResponse(aiFileSave($_FILES['file'], aiCurrentUser()));
    } catch (\RuntimeException $e) {
        jsonResponse(['error' => $e->getMessage()], 400);
    }
}
function handleAiChat(): void {
    $body = getRequestBody();
    $text = trim((string)($body['message'] ?? ''));
    $attachIds = array_slice(array_values(array_filter((array)($body['attachments'] ?? []), 'is_string')), 0, 10);
    if (ACCT_VIEWER_ONLY && $attachIds) jsonResponse(['error' => '閲覧専用ではファイルを添付できません'], 403);
    if ($text === '' && !$attachIds) jsonResponse(['error' => 'メッセージが空です'], 400);
    $id = (string)($body['conversation_id'] ?? '');
    $user = aiCurrentUser();
    if ($id !== '') {
        $existing = aiGetConversation($id);
        if (!$existing || !aiCanAccess($existing, $user)) jsonResponse(['error' => '会話が見つかりません'], 404);
        if (!aiLock($id, $user)) jsonResponse(['error' => _aiBusyMessage($id)], 409);
        // ロックを取ってから読み直す（直前にほかの人が書き込んだ発言を消さないため）
        $conv = aiGetConversation($id);
    } else {
        $first = $attachIds ? (aiFileRow($attachIds[0])['name'] ?? '添付') : '';
        $conv = ['id' => newUuid(), 'title' => mb_substr(preg_replace('/\s+/u', ' ', $text !== '' ? $text : "📎 {$first}"), 0, 40),
                 'user_name' => $user['name'], 'user_email' => $user['email'],
                 'scope' => ACCT_VIEWER_ONLY ? 'viewer' : 'admin',
                 'created_at' => now('Y/m/d H:i:s'), 'messages' => [], 'pending' => null];
    }
    // 1人1日の回数の上限（設定の「AIアシスタント連携」で変えられる）。受け付けると決まってから数える
    if (!aiUsageTake(aiCurrentUser())) {
        $lim = aiDailyLimit(aiCurrentUser());
        jsonResponse(['error' => "今日の利用回数の上限（{$lim}回）に達しました。明日また使えます。", 'usage' => aiUsageInfo(aiCurrentUser())], 429);
    }
    // 承認待ちのまま次の指示が来たら、承認待ちの操作は却下として扱い、指示と一緒に返す
    if (!empty($conv['pending'])) {
        if (!aiClaimPending($conv['id'])) jsonResponse(['error' => '処理中です。少し待ってから送ってください'], 409);
        aiResolvePending($conv, [], $user, '代わりに次の指示に従ってください。');
    }
    // 添付は本文の前に置く（Claude は画像・資料が先にあるほうが読みやすい）。ID は本文にも書いて、
    // attach_receipt で指定できるようにする
    $blocks = []; $attachLines = '';
    foreach ($attachIds as $fid) {
        $row = aiFileAttach($fid, $conv['id']);
        if (!$row) continue;
        $blocks[] = aiFileMarker($row);
        $attachLines .= "[添付: {$row['id']} {$row['name']}]\n";
    }
    // 会話は管理者全員で共有するので、誰が送ったかを発言に残す（Claude にも伝わる）
    $blocks[] = ['type' => 'text', 'text' => aiSenderLine($user) . "\n" . $attachLines
        . ($text !== '' ? $text : '（添付ファイルを見てください）')];
    aiAppendUser($conv['messages'], $blocks);
    _aiRunAndRespond($conv);
}
function handleAiApprove(): void {
    $body = getRequestBody();
    $id = (string)($body['conversation_id'] ?? '');
    $existing = aiGetConversation($id);
    if (!$existing) jsonResponse(['error' => '会話が見つかりません'], 404);
    if (($existing['scope'] ?? 'admin') === 'viewer') jsonResponse(['error' => 'この会話に承認する操作はありません'], 409);
    if (!aiLock($id, aiCurrentUser())) jsonResponse(['error' => _aiBusyMessage($id)], 409);
    $conv = aiGetConversation($id);
    if (empty($conv['pending']) || !aiClaimPending($conv['id'])) jsonResponse(['error' => '承認待ちの操作はありません'], 409);
    $decisions = array_map(fn($v) => (bool)$v, (array)($body['decisions'] ?? []));
    aiResolvePending($conv, $decisions, aiCurrentUser());
    // 実行済みの操作をすぐ保存しておく（このあと処理が落ちても二重に実行しない）
    aiSaveConversation($conv);
    _aiRunAndRespond($conv);
}
