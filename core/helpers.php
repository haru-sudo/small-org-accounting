<?php
// ══════════════════════════════════════════════════════════════════════════════
// helpers.php — SQLite データ層 & 共通ユーティリティ（PHP）
// ══════════════════════════════════════════════════════════════════════════════

// ── パス定義 ──
define('BASE_DIR',   __DIR__ . '/..');
define('DATA_DIR',   BASE_DIR . '/data');
define('UPLOAD_DIR',   BASE_DIR . '/uploads');
define('RECEIPT_DIR',  BASE_DIR . '/uploads/receipts');
define('DB_TX',       DATA_DIR . '/transactions.db');
define('DB_CLAIMS',   DATA_DIR . '/claims.db');
define('DB_INVOICES', DATA_DIR . '/invoices.db');
define('DB_BILLING',  DATA_DIR . '/billing.db');
define('DB_MASTER',   DATA_DIR . '/master.db');
define('DB_AI',       DATA_DIR . '/ai_chat.db');   // AIアシスタントの会話履歴
define('RESET_DIR',   DATA_DIR . '/resets');   // 期間リセットのスナップショット（取り消し用）

// ── SQLite 接続（DB別シングルトン + スキーマ初期化 1回のみ）──
function _dbConn(string $path): PDO {
    static $map = [];
    if (isset($map[$path])) return $map[$path];
    if (!is_dir(DATA_DIR)) mkdir(DATA_DIR, 0755, true);
    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec("PRAGMA journal_mode=WAL");
    $pdo->exec("PRAGMA synchronous=NORMAL");
    $pdo->exec("PRAGMA foreign_keys=ON");
    $pdo->exec("PRAGMA cache_size=-4000");
    _initSchema($pdo, $path);
    return $map[$path] = $pdo;
}

function _initSchema(PDO $pdo, string $path): void {
    switch ($path) {
        case DB_TX:
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS transactions (
                    id TEXT PRIMARY KEY, date TEXT NOT NULL,
                    amount INTEGER DEFAULT 0, bank_debit INTEGER DEFAULT 0,
                    bank_credit INTEGER DEFAULT 0, type TEXT DEFAULT '',
                    party TEXT DEFAULT '', group_id TEXT DEFAULT '',
                    memo TEXT DEFAULT '', registered INTEGER DEFAULT 0,
                    auto_rule TEXT DEFAULT '', source_file TEXT DEFAULT '',
                    claim_id TEXT DEFAULT '', billing_sheet_id TEXT DEFAULT '',
                    extra_json TEXT DEFAULT '{}',
                    receipt_file TEXT DEFAULT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
                CREATE INDEX IF NOT EXISTS idx_tx_registered ON transactions(registered);
                CREATE TABLE IF NOT EXISTS entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tx_id TEXT NOT NULL, debit_account TEXT DEFAULT '',
                    debit_sub TEXT DEFAULT '', credit_account TEXT DEFAULT '',
                    credit_sub TEXT DEFAULT '', amount INTEGER DEFAULT 0,
                    memo TEXT DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_entry_tx ON entries(tx_id);
            ");
            // 既存DBへのマイグレーション（カラムが既にある場合は無視）
            try { $pdo->exec("ALTER TABLE transactions ADD COLUMN receipt_file TEXT DEFAULT NULL"); } catch (\Exception $e) {}
            break;
        case DB_CLAIMS:
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS claims (
                    id TEXT PRIMARY KEY, type TEXT DEFAULT '',
                    applicant TEXT DEFAULT '', person_kana TEXT DEFAULT '',
                    amount INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
                    application_date TEXT DEFAULT '', work_date TEXT DEFAULT '',
                    work_destination TEXT DEFAULT '', from_station TEXT DEFAULT '',
                    to_station TEXT DEFAULT '', route_detail TEXT DEFAULT '',
                    description TEXT DEFAULT '', memo TEXT DEFAULT '',
                    paid_date TEXT DEFAULT '', journaled INTEGER DEFAULT 0,
                    pending_match INTEGER DEFAULT 0, journal_tx_id TEXT DEFAULT '',
                    created_at TEXT DEFAULT '', extra_json TEXT DEFAULT '{}',
                    receipt_file TEXT DEFAULT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
            ");
            // 既存DBへのマイグレーション
            try { $pdo->exec("ALTER TABLE claims ADD COLUMN receipt_file TEXT DEFAULT NULL"); } catch (\Exception $e) {}
            break;
        case DB_INVOICES:
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS invoices (
                    id TEXT PRIMARY KEY, invoice_no TEXT DEFAULT '',
                    subject TEXT DEFAULT '', client_name TEXT DEFAULT '',
                    issued_date TEXT DEFAULT '', due_date TEXT DEFAULT '',
                    tax_rate REAL DEFAULT 0, notes TEXT DEFAULT '',
                    status TEXT DEFAULT '未送付', created_at TEXT DEFAULT '',
                    extra_json TEXT DEFAULT '{}'
                );
            "); break;
        case DB_BILLING:
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS billing_sheets (
                    id TEXT PRIMARY KEY, type TEXT DEFAULT '',
                    title TEXT DEFAULT '', period TEXT DEFAULT '',
                    start_date TEXT DEFAULT '', due_date TEXT DEFAULT '',
                    checked_at TEXT DEFAULT '', matched_count INTEGER DEFAULT 0,
                    journaled_count INTEGER DEFAULT 0, created_at TEXT DEFAULT '',
                    extra_json TEXT DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS billing_members (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sheet_id TEXT NOT NULL, name TEXT DEFAULT '',
                    kana TEXT DEFAULT '', fee INTEGER DEFAULT 0,
                    paid INTEGER DEFAULT 0, debit_account TEXT DEFAULT '',
                    debit_sub TEXT DEFAULT '', credit_account TEXT DEFAULT '',
                    credit_sub TEXT DEFAULT '', auto_journal INTEGER DEFAULT 1,
                    memo_template TEXT DEFAULT '', extra_json TEXT DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_bm_sheet ON billing_members(sheet_id);
            "); break;
        case DB_MASTER:
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS kv_store (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}'
                );
            "); break;
        case DB_AI:
            // messages_json … Claude API にそのまま送り返す会話（思考ブロック・ツール呼び出しを含む）
            // pending_json  … 承認待ちの変更操作（null なら承認待ちなし）
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS ai_conversations (
                    id TEXT PRIMARY KEY, title TEXT DEFAULT '',
                    user_email TEXT DEFAULT '', user_name TEXT DEFAULT '',
                    created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '',
                    messages_json TEXT NOT NULL DEFAULT '[]',
                    pending_json TEXT DEFAULT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ai_updated ON ai_conversations(updated_at);
            ");
            // busy_until / busy_by … 誰かの依頼を処理中（同じ会話への同時書き込みを防ぐ）
            try { $pdo->exec("ALTER TABLE ai_conversations ADD COLUMN busy_until TEXT DEFAULT NULL"); } catch (\Exception $e) {}
            try { $pdo->exec("ALTER TABLE ai_conversations ADD COLUMN busy_by TEXT DEFAULT ''"); } catch (\Exception $e) {}
            // scope … admin=管理者で共有する会話 / viewer=閲覧専用ユーザー本人だけの会話（使えるツールも限る）
            try { $pdo->exec("ALTER TABLE ai_conversations ADD COLUMN scope TEXT DEFAULT 'admin'"); } catch (\Exception $e) {}
            // actions_json … 承認・実行したときの変更内容（承認画面の「変更前 → 変更後」をあとから見られるように）
            try { $pdo->exec("ALTER TABLE ai_conversations ADD COLUMN actions_json TEXT DEFAULT NULL"); } catch (\Exception $e) {}
            // 1人1日の送信回数（使いすぎ防止の上限に使う）
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS ai_usage (
                    email TEXT NOT NULL, day TEXT NOT NULL, count INTEGER DEFAULT 0,
                    PRIMARY KEY (email, day)
                );
            ");
            // チャットの添付ファイル（中身は uploads/ai/ に置く）
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS ai_files (
                    id TEXT PRIMARY KEY, conv_id TEXT DEFAULT NULL,
                    name TEXT DEFAULT '', media_type TEXT DEFAULT '', size INTEGER DEFAULT 0,
                    user_name TEXT DEFAULT '', created_at TEXT DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_ai_files_conv ON ai_files(conv_id);
            ");
            break;
    }
}
function txDb(): PDO      { return _dbConn(DB_TX); }
function claimsDb(): PDO  { return _dbConn(DB_CLAIMS); }
function invoiceDb(): PDO { return _dbConn(DB_INVOICES); }
function billingDb(): PDO { return _dbConn(DB_BILLING); }
function masterDb(): PDO  { return _dbConn(DB_MASTER); }
function aiDb(): PDO      { return _dbConn(DB_AI); }

// ── KV ストア（accounts/rules/settings/members/uploads_log）──
// ★1リクエスト内で同じキー（特に settings）を何度も読み・JSON デコードしていたので、
//   リクエスト内だけのキャッシュを持つ。書き込み時に更新する。
function &_kvCache(): array { static $c = []; return $c; }
function kvGet(string $key, $default = []) {
    $cache = &_kvCache();
    if (!array_key_exists($key, $cache)) {
        $stmt = masterDb()->prepare("SELECT value FROM kv_store WHERE key=?");
        $stmt->execute([$key]);
        $r = $stmt->fetchColumn();
        $cache[$key] = $r !== false ? json_decode($r, true) : null;
    }
    return $cache[$key] ?? $default;
}
function kvSet(string $key, $value): void {
    masterDb()->prepare(
        "INSERT INTO kv_store(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )->execute([$key, json_encode($value, JSON_UNESCAPED_UNICODE)]);
    $cache = &_kvCache();
    $cache[$key] = json_decode(json_encode($value, JSON_UNESCAPED_UNICODE), true);
}

/**
 * KV の値を読み・書きを1つのトランザクションで行う（同時に来た要求で上書きし合わないように）。
 * $fn が null を返したら何も書かない。書いた値（または null）を返す。
 */
function kvUpdate(string $key, callable $fn) {
    $db = masterDb();
    $db->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $db->prepare("SELECT value FROM kv_store WHERE key=?");
        $stmt->execute([$key]);
        $r = $stmt->fetchColumn();
        $cur = $r !== false ? json_decode($r, true) : null;
        $next = $fn($cur);
        if ($next !== null) {
            $db->prepare("INSERT INTO kv_store(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
               ->execute([$key, json_encode($next, JSON_UNESCAPED_UNICODE)]);
        }
        $db->exec('COMMIT');
    } catch (\Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
    }
    $cache = &_kvCache();
    unset($cache[$key]);
    return $next;
}

// ══════════════════════════════════════════════════════════════════════════════
// Transactions
// ══════════════════════════════════════════════════════════════════════════════
// SQLite のバインド変数上限（古いビルドは 999）を超えないよう分割して取得する。
// 取引件数が 1000 件を超えると "too many SQL variables" で 500 になっていた。
function _fetchEntries(array $ids): array {
    if (!$ids) return [];
    $pdo = txDb();
    $map = [];
    foreach (array_chunk(array_values($ids), 500) as $chunk) {
        $ph   = implode(',', array_fill(0, count($chunk), '?'));
        $stmt = $pdo->prepare("SELECT * FROM entries WHERE tx_id IN ($ph)");
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll() as $r) {
            $map[$r['tx_id']][] = [
                'debit_account'  => $r['debit_account'],
                'debit_sub'      => $r['debit_sub'],
                'credit_account' => $r['credit_account'],
                'credit_sub'     => $r['credit_sub'],
                'amount'         => (int)$r['amount'],
                'memo'           => $r['memo'],
            ];
        }
    }
    return $map;
}
function _rowToTx(array $r, array $entries): array {
    $extra = json_decode($r['extra_json'] ?? '{}', true) ?: [];
    unset($r['extra_json']);
    $r['registered'] = (bool)$r['registered'];
    $r['entries']    = $entries;
    return array_merge($extra, $r);
}
// ── トップレベル科目 ⇄ entries[0] の同期 ──
// PUT /transactions で debit_account 等をトップレベルに渡しても、従来は extra_json
// にしか入らず entries（＝仕訳帳の表示元）が空のままだった。ここで entries に反映する。
// $force: 呼び出し側が「明示的に指定した」キー名の配列。entries 側が非空でも上書きする。
function syncTxEntryAccounts(array $tx, array $force = []): array {
    static $keys = null;
    if ($keys === null) $keys = ['debit_account','debit_sub','credit_account','credit_sub'];
    $hasTop = false;
    foreach ($keys as $k) { if (($tx[$k] ?? '') !== '') { $hasTop = true; break; } }
    $entries = $tx['entries'] ?? [];

    // entries が無い場合はトップレベル科目から1件生成
    if (!$entries && $hasTop) {
        $amt = max((int)($tx['amount'] ?? 0), (int)($tx['bank_debit'] ?? 0),
                   (int)($tx['bank_credit'] ?? 0), (int)($tx['debit'] ?? 0), (int)($tx['credit'] ?? 0));
        $entries = [[
            'debit_account'  => $tx['debit_account']  ?? '',
            'debit_sub'      => $tx['debit_sub']      ?? '',
            'credit_account' => $tx['credit_account'] ?? '',
            'credit_sub'     => $tx['credit_sub']     ?? '',
            'amount'         => $amt,
            'memo'           => $tx['memo'] ?? '',
        ]];
    } elseif (count($entries) === 1 && $hasTop) {
        // 単一仕訳のときのみ同期。空欄の補完は常に、上書きは $force 指定時のみ。
        foreach ($keys as $k) {
            $v = $tx[$k] ?? '';
            if ($v === '') continue;
            if (($entries[0][$k] ?? '') === '' || in_array($k, $force, true)) {
                $entries[0][$k] = $v;
            }
        }
    }
    if ($entries) $tx['entries'] = $entries;
    // トップレベルの科目キーは entries に集約したので破棄（extra_json の古い値が
    // entries を上書きし続ける事故を防ぐ）
    foreach ($keys as $k) unset($tx[$k]);
    return $tx;
}

function _txRow(array $tx): array {
    static $known = null;
    if ($known === null) $known = array_flip([
        'id','date','amount','bank_debit','bank_credit','type','party',
        'group_id','memo','registered','auto_rule','source_file',
        'claim_id','billing_sheet_id','entries','receipt_file',
        // 科目は entries に持たせる（extra_json に二重保存しない）
        'debit_account','debit_sub','credit_account','credit_sub',
    ]);
    $extra = array_diff_key($tx, $known);
    // 仮登録（provisional）は未登録の取引にだけ意味がある。登録済みになったら外す。
    if (!empty($tx['registered']) || empty($extra['provisional'])) unset($extra['provisional']);
    else $extra['provisional'] = true;
    return [
        $tx['id'] ?? '', $tx['date'] ?? '',
        (int)($tx['amount'] ?? 0), (int)($tx['bank_debit'] ?? 0), (int)($tx['bank_credit'] ?? 0),
        $tx['type'] ?? '', $tx['party'] ?? '', $tx['group_id'] ?? '',
        $tx['memo'] ?? '', empty($tx['registered']) ? 0 : 1,
        $tx['auto_rule'] ?? '', $tx['source_file'] ?? '',
        $tx['claim_id'] ?? '', $tx['billing_sheet_id'] ?? '',
        $extra ? json_encode($extra, JSON_UNESCAPED_UNICODE) : '{}',
    ];
}
function getAllTransactions(): array {
    $rows = txDb()->query("SELECT * FROM transactions ORDER BY date")->fetchAll();
    $emap = _fetchEntries(array_column($rows, 'id'));
    return array_map(fn($r) => _rowToTx($r, $emap[$r['id']] ?? []), $rows);
}
/** 指定した年の範囲（両端含む）の取引。日付の書式ゆれ（ゼロ埋め無し）があっても年だけで絞る */
function getTransactionsByYearRange(int $fromYear, int $toYear): array {
    $stmt = txDb()->prepare(
        "SELECT * FROM transactions WHERE substr(date,1,4) >= ? AND substr(date,1,4) <= ? ORDER BY date");
    $stmt->execute([sprintf('%04d', $fromYear), sprintf('%04d', $toYear)]);
    $rows = $stmt->fetchAll();
    $emap = _fetchEntries(array_column($rows, 'id'));
    return array_map(fn($r) => _rowToTx($r, $emap[$r['id']] ?? []), $rows);
}
function getTransactionsByFy(string $year, int $fyStart = 4, bool $registeredOnly = false): array {
    $start = sprintf('%s/%02d/01', $year, $fyStart);
    $endY  = $fyStart === 1 ? (int)$year : (int)$year + 1;
    $endM  = $fyStart > 1 ? $fyStart - 1 : 12;
    $endD  = cal_days_in_month(CAL_GREGORIAN, $endM, $endY);
    $end   = sprintf('%d/%02d/%02d', $endY, $endM, $endD);
    $sql   = "SELECT * FROM transactions WHERE date >= ? AND date <= ?";
    $params = [$start, $end];
    if ($registeredOnly) { $sql .= " AND registered = 1"; }
    $sql .= " ORDER BY date";
    $stmt  = txDb()->prepare($sql);
    $stmt->execute($params);
    $rows  = $stmt->fetchAll();
    $emap  = _fetchEntries(array_column($rows, 'id'));
    return array_map(fn($r) => _rowToTx($r, $emap[$r['id']] ?? []), $rows);
}
function upsertTransaction(array $tx, array $forceAccountKeys = []): void {
    $pdo = txDb();
    // ★本体と明細の書き換えを1トランザクションにする（途中で落ちて明細が消えたままになるのを防ぎ、
    //   WAL の同期も1回で済ませる）。呼び出し側がトランザクション中ならそれに乗る。
    $own = !$pdo->inTransaction();
    if ($own) $pdo->beginTransaction();
    try {
        _upsertTransactionRow($pdo, $tx, $forceAccountKeys);
        if ($own) $pdo->commit();
    } catch (Throwable $e) {
        if ($own) $pdo->rollBack();
        throw $e;
    }
}
function _upsertTransactionRow(PDO $pdo, array $tx, array $forceAccountKeys): void {
    $tx  = syncTxEntryAccounts($tx, $forceAccountKeys);
    // 申請（claim）に紐付いた仕訳で、まだ領収書が未設定の場合は
    // 申請側の領収書画像を自動で引き継ぐ（返金時の仕訳に領収書を自動添付）。
    if (empty($tx['receipt_file']) && !empty($tx['claim_id'])) {
        try {
            $linkedClaim = getClaim($tx['claim_id']);
            if ($linkedClaim && !empty($linkedClaim['receipt_file'])) {
                $tx['receipt_file'] = $linkedClaim['receipt_file'];
            }
        } catch (\Throwable $e) { /* 領収書引き継ぎ失敗は無視 */ }
    }
    $pdo->prepare(
        "INSERT OR REPLACE INTO transactions
         (id,date,amount,bank_debit,bank_credit,type,party,group_id,memo,
          registered,auto_rule,source_file,claim_id,billing_sheet_id,extra_json,receipt_file)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )->execute(array_merge(_txRow($tx), [$tx['receipt_file'] ?? null]));
    $pdo->prepare("DELETE FROM entries WHERE tx_id=?")->execute([$tx['id']]);
    $ins = $pdo->prepare(
        "INSERT INTO entries(tx_id,debit_account,debit_sub,credit_account,credit_sub,amount,memo)
         VALUES(?,?,?,?,?,?,?)");
    foreach ($tx['entries'] ?? [] as $e) {
        $ins->execute([$tx['id'],
            $e['debit_account'] ?? '', $e['debit_sub'] ?? '',
            $e['credit_account'] ?? '', $e['credit_sub'] ?? '',
            (int)($e['amount'] ?? 0), $e['memo'] ?? '']);
    }
}
function upsertTransactionsBulk(array $list): void {
    $pdo = txDb(); $pdo->beginTransaction();
    try {
        $stTx  = $pdo->prepare(
            "INSERT OR REPLACE INTO transactions
             (id,date,amount,bank_debit,bank_credit,type,party,group_id,memo,
              registered,auto_rule,source_file,claim_id,billing_sheet_id,extra_json,receipt_file)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        $stDel = $pdo->prepare("DELETE FROM entries WHERE tx_id=?");
        $stEnt = $pdo->prepare(
            "INSERT INTO entries(tx_id,debit_account,debit_sub,credit_account,credit_sub,amount,memo)
             VALUES(?,?,?,?,?,?,?)");
        foreach ($list as $tx) {
            $tx = syncTxEntryAccounts($tx);
            $stTx->execute(array_merge(_txRow($tx), [$tx['receipt_file'] ?? null]));
            $stDel->execute([$tx['id']]);
            foreach ($tx['entries'] ?? [] as $e) {
                $stEnt->execute([$tx['id'],
                    $e['debit_account'] ?? '', $e['debit_sub'] ?? '',
                    $e['credit_account'] ?? '', $e['credit_sub'] ?? '',
                    (int)($e['amount'] ?? 0), $e['memo'] ?? '']);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
}
function getTransactionById(string $id): ?array {
    $stmt = txDb()->prepare("SELECT * FROM transactions WHERE id=?");
    $stmt->execute([$id]);
    $r = $stmt->fetch();
    if (!$r) return null;
    $emap = _fetchEntries([$id]);
    return _rowToTx($r, $emap[$id] ?? []);
}
function deleteTransaction(string $id): void {
    $pdo = txDb();
    $pdo->prepare("DELETE FROM transactions WHERE id=?")->execute([$id]);
    $pdo->prepare("DELETE FROM entries WHERE tx_id=?")->execute([$id]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Claims
// ══════════════════════════════════════════════════════════════════════════════
function _rowToClaim(array $r): array {
    $extra = json_decode($r['extra_json'] ?? '{}', true) ?: [];
    unset($r['extra_json']);
    $r['journaled']     = (bool)$r['journaled'];
    $r['pending_match'] = (bool)$r['pending_match'];
    return array_merge($extra, $r);
}
function getAllClaims(): array {
    return array_map('_rowToClaim',
        claimsDb()->query("SELECT * FROM claims ORDER BY created_at DESC")->fetchAll());
}
function getClaim(string $id): ?array {
    $s = claimsDb()->prepare("SELECT * FROM claims WHERE id=?"); $s->execute([$id]);
    $r = $s->fetch(); return $r ? _rowToClaim($r) : null;
}
function upsertClaim(array $c): void {
    static $known = null;
    if ($known === null) $known = array_flip([
        'id','type','applicant','person_kana','amount','status',
        'application_date','work_date','work_destination','from_station',
        'to_station','route_detail','description','memo','paid_date',
        'journaled','pending_match','journal_tx_id','created_at','receipt_file',
    ]);
    $extra = array_diff_key($c, $known);
    claimsDb()->prepare(
        "INSERT OR REPLACE INTO claims
         (id,type,applicant,person_kana,amount,status,application_date,
          work_date,work_destination,from_station,to_station,route_detail,
          description,memo,paid_date,journaled,pending_match,
          journal_tx_id,created_at,receipt_file,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )->execute([
        $c['id'] ?? '', $c['type'] ?? '', $c['applicant'] ?? '',
        $c['person_kana'] ?? '', (int)($c['amount'] ?? 0),
        $c['status'] ?? 'pending', $c['application_date'] ?? '',
        $c['work_date'] ?? '', $c['work_destination'] ?? '',
        $c['from_station'] ?? '', $c['to_station'] ?? '',
        $c['route_detail'] ?? '', $c['description'] ?? '',
        $c['memo'] ?? '', $c['paid_date'] ?? '',
        empty($c['journaled']) ? 0 : 1, empty($c['pending_match']) ? 0 : 1,
        $c['journal_tx_id'] ?? '', $c['created_at'] ?? '',
        $c['receipt_file'] ?? null,
        json_encode($extra, JSON_UNESCAPED_UNICODE),
    ]);
}
function deleteClaim(string $id): void {
    claimsDb()->prepare("DELETE FROM claims WHERE id=?")->execute([$id]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Invoices
// ══════════════════════════════════════════════════════════════════════════════
function _rowToInvoice(array $r): array {
    $extra = json_decode($r['extra_json'] ?? '{}', true) ?: [];
    unset($r['extra_json']); return array_merge($extra, $r);
}
function getAllInvoices(): array {
    return array_map('_rowToInvoice',
        invoiceDb()->query("SELECT * FROM invoices ORDER BY created_at DESC")->fetchAll());
}
function getInvoice(string $id): ?array {
    $s = invoiceDb()->prepare("SELECT * FROM invoices WHERE id=?"); $s->execute([$id]);
    $r = $s->fetch(); return $r ? _rowToInvoice($r) : null;
}
function upsertInvoice(array $inv): void {
    static $known = null;
    if ($known === null) $known = array_flip([
        'id','invoice_no','subject','client_name','issued_date',
        'due_date','tax_rate','notes','status','created_at',
    ]);
    $extra = array_diff_key($inv, $known);
    invoiceDb()->prepare(
        "INSERT OR REPLACE INTO invoices
         (id,invoice_no,subject,client_name,issued_date,due_date,
          tax_rate,notes,status,created_at,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    )->execute([
        $inv['id'] ?? '', $inv['invoice_no'] ?? '', $inv['subject'] ?? '',
        $inv['client_name'] ?? '', $inv['issued_date'] ?? '',
        $inv['due_date'] ?? '', (float)($inv['tax_rate'] ?? 0),
        $inv['notes'] ?? '', $inv['status'] ?? '未送付',
        $inv['created_at'] ?? '', json_encode($extra, JSON_UNESCAPED_UNICODE),
    ]);
}
function deleteInvoice(string $id): void {
    invoiceDb()->prepare("DELETE FROM invoices WHERE id=?")->execute([$id]);
}
function countInvoices(): int {
    return (int)invoiceDb()->query("SELECT COUNT(*) FROM invoices")->fetchColumn();
}

// ══════════════════════════════════════════════════════════════════════════════
// Billing Sheets
// ══════════════════════════════════════════════════════════════════════════════
function _rowToMember(array $r): array {
    $extra = json_decode($r['extra_json'] ?? '{}', true) ?: [];
    unset($r['extra_json'], $r['id'], $r['sheet_id']);
    $r['paid'] = (bool)$r['paid']; $r['auto_journal'] = (bool)$r['auto_journal'];
    return array_merge($extra, $r);
}
function _rowToSheet(array $r, array $members): array {
    $extra = json_decode($r['extra_json'] ?? '{}', true) ?: [];
    unset($r['extra_json']); $r['members'] = $members;
    return array_merge($extra, $r);
}
function getAllSheets(): array {
    // ★シートごとにメンバーを引き直さず（N+1）、2回の SELECT で組み立てる
    $pdo  = billingDb();
    $rows = $pdo->query("SELECT * FROM billing_sheets ORDER BY created_at DESC")->fetchAll();
    $bySheet = [];
    foreach ($pdo->query("SELECT * FROM billing_members ORDER BY id")->fetchAll() as $m) {
        $bySheet[$m['sheet_id']][] = _rowToMember($m);
    }
    return array_map(fn($r) => _rowToSheet($r, $bySheet[$r['id']] ?? []), $rows);
}
function getSheet(string $id): ?array {
    $s = billingDb()->prepare("SELECT * FROM billing_sheets WHERE id=?"); $s->execute([$id]);
    $r = $s->fetch(); if (!$r) return null;
    // 並び順は登録順（編集 API はメンバーを添字で更新するので順序を固定する）
    $m = billingDb()->prepare("SELECT * FROM billing_members WHERE sheet_id=? ORDER BY id"); $m->execute([$id]);
    return _rowToSheet($r, array_map('_rowToMember', $m->fetchAll()));
}
function upsertSheet(array $s): void {
    static $known = null, $knownM = null;
    if ($known === null) {
        $known  = array_flip(['id','type','title','period','start_date','due_date',
                  'checked_at','matched_count','journaled_count','created_at','members']);
        $knownM = array_flip(['name','kana','fee','paid','debit_account','debit_sub',
                   'credit_account','credit_sub','auto_journal','memo_template']);
    }
    $extra = array_diff_key($s, $known);
    $pdo = billingDb();
    $pdo->beginTransaction();
    try {
    $pdo->prepare(
        "INSERT OR REPLACE INTO billing_sheets
         (id,type,title,period,start_date,due_date,checked_at,
          matched_count,journaled_count,created_at,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    )->execute([
        $s['id'] ?? '', $s['type'] ?? '', $s['title'] ?? '',
        $s['period'] ?? '', $s['start_date'] ?? '', $s['due_date'] ?? '',
        $s['checked_at'] ?? '', (int)($s['matched_count'] ?? 0),
        (int)($s['journaled_count'] ?? 0), $s['created_at'] ?? '',
        json_encode($extra, JSON_UNESCAPED_UNICODE),
    ]);
    $pdo->prepare("DELETE FROM billing_members WHERE sheet_id=?")->execute([$s['id']]);
    $ins = $pdo->prepare(
        "INSERT INTO billing_members
         (sheet_id,name,kana,fee,paid,debit_account,debit_sub,
          credit_account,credit_sub,auto_journal,memo_template,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    foreach ($s['members'] ?? [] as $m) {
        $extraM = array_diff_key($m, $knownM);
        $ins->execute([
            $s['id'], $m['name'] ?? '', $m['kana'] ?? '',
            (int)($m['fee'] ?? 0), empty($m['paid']) ? 0 : 1,
            $m['debit_account'] ?? '', $m['debit_sub'] ?? '',
            $m['credit_account'] ?? '', $m['credit_sub'] ?? '',
            isset($m['auto_journal']) ? ($m['auto_journal'] ? 1 : 0) : 1,
            $m['memo_template'] ?? '', json_encode($extraM, JSON_UNESCAPED_UNICODE),
        ]);
    }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}
function deleteSheet(string $id): void {
    $pdo = billingDb();
    $pdo->prepare("DELETE FROM billing_sheets WHERE id=?")->execute([$id]);
    $pdo->prepare("DELETE FROM billing_members WHERE sheet_id=?")->execute([$id]);
}

// ══════════════════════════════════════════════════════════════════════════════
// レスポンス／ユーティリティ
// ══════════════════════════════════════════════════════════════════════════════
function jsonResponse($data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function getRequestBody(): array {
    static $cached = null;
    if ($cached !== null) return $cached;
    $raw = file_get_contents('php://input');
    return $cached = ($raw ? (json_decode($raw, true) ?? []) : []);
}
/**
 * DB に保存された領収書パス（'uploads/receipts/...'）を実ファイルのパスにする。
 * ★領収書ディレクトリの外は返さない。以前は絶対パスや '../' を含む値をそのまま
 *   readfile() しており、receipt_file を書き換えられるとサーバー上の任意のファイル
 *   （DB・設定）を読めた。
 */
function receiptFilePath(string $stored): ?string {
    if ($stored === '') return null;
    $root = realpath(RECEIPT_DIR);
    if ($root === false) return null;
    // 古いデータには絶対パスで入っているものがあるので両方受けるが、どちらも領収書ディレクトリ内に限る
    $real = realpath(str_starts_with($stored, '/') && is_file($stored) ? $stored : BASE_DIR . '/' . ltrim($stored, '/'));
    if ($real === false || !is_file($real)) return null;
    return str_starts_with($real, $root . DIRECTORY_SEPARATOR) ? $real : null;
}
function newUuid(): string {
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}
function now(string $fmt = 'Y/m/d H:i'): string {
    return (new DateTime())->format($fmt);
}

// ══════════════════════════════════════════════════════════════════════════════
// 機能の ON/OFF（設定 → 使う機能）
//   団体によって要らない機能を画面・API・AIアシスタントのツールからまとめて外す。
//   保存先: kv_store['settings']['features'] = { invoice: true, claims: false, ... }
// ══════════════════════════════════════════════════════════════════════════════
const APP_FEATURES = [
    'invoice'     => ['label' => '請求書・見積書',                     'default' => true],
    'billing'     => ['label' => '会費の請求シートと振込確認',          'default' => true],
    'credit_card' => ['label' => 'クレジットカード明細の取り込み',      'default' => true],
    'claims'      => ['label' => '交通費・立替申請（外部の申請フォーム連携）', 'default' => false],
    'ai'          => ['label' => 'AIアシスタント（Claude API）',       'default' => true],
    'ai_slack'    => ['label' => 'AIアシスタントの Slack チャンネル参照', 'default' => false],
];

/** 銀行口座（普通預金）に付ける補助科目（設定 → 基本設定。空なら付けない） */
function bankAccountSub(): string {
    return trim((string)(kvGet('settings', [])['bank_account_sub'] ?? ''));
}

/** 全機能の ON/OFF（未設定は既定値） */
function appFeatures(): array {
    $saved = kvGet('settings', [])['features'] ?? [];
    if (!is_array($saved)) $saved = [];
    $out = [];
    foreach (APP_FEATURES as $k => $meta) {
        $out[$k] = array_key_exists($k, $saved) ? (bool)$saved[$k] : $meta['default'];
    }
    // Slack 参照は AIアシスタントの一部
    if (!$out['ai']) $out['ai_slack'] = false;
    return $out;
}
function featureEnabled(string $feature): bool {
    return appFeatures()[$feature] ?? false;
}

/** API のパスがどの機能に属するか（どれにも属さなければ null = 常に使える） */
function featureForApiPath(string $path): ?string {
    $map = [
        '#^/api/invoices(/|$)#'                         => 'invoice',
        '#^/api/billing/#'                              => 'billing',
        '#^/api/export/billing#'                        => 'billing',
        '#^/api/(upload-credit-csv|credit-csv-uploads|credit-rules|apply-credit-rules)$#' => 'credit_card',
        '#^/api/(claims|claim-receipt|transport-deadlines)(/|$)#' => 'claims',
        '#^/api/settings/claims$#'                      => 'claims',
        '#^/api/ai/slack-test$#'                        => 'ai_slack',
        '#^/api/ai/#'                                   => 'ai',
    ];
    foreach ($map as $re => $feature) {
        if (preg_match($re, $path)) return $feature;
    }
    return null;
}
