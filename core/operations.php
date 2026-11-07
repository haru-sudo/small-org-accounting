<?php
// ══════════════════════════════════════════════════════════════════════════════
// operations.php — 画面の API とAIアシスタントの両方から使う「操作」のまとまり
//   PDF・CSV の取り込み、期間リセット、振込確認チェック、申請の仕訳、Excel 出力など、
//   以前は api/router.php の中にだけあった処理をここに置き、HTTP に依存しない形にした。
//   失敗は OpException（message と HTTP ステータス）で知らせる。
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/accounting.php';

class OpException extends RuntimeException {
    public int $status;
    public function __construct(string $message, int $status = 400) {
        parent::__construct($message);
        $this->status = $status;
    }
}

function _pythonBin(): string {
    static $bin = null;
    if ($bin !== null) return $bin;
    foreach (['/home/xs151159/miniconda3/bin/python3', '/usr/bin/python3', 'python3'] as $p) {
        if ($p === 'python3' || file_exists($p)) { return $bin = $p; }
    }
    return $bin = 'python3';
}

// ══════════════════════════════════════════════════════════════════════════════
// 銀行明細 PDF の取り込み（Python でパース → ルール適用 → 保存 → 申請の照合）
// ══════════════════════════════════════════════════════════════════════════════
/** PDF 由来の取引を見分けるキー（日付・出金・入金・相手先） */
function _uploadTxKey(array $tx): string {
    return implode('|', [$tx['date'] ?? '', (int)($tx['bank_debit'] ?? 0), (int)($tx['bank_credit'] ?? 0),
        preg_replace('/[\s　]/u', '', (string)($tx['party'] ?? ''))]);
}

/**
 * @param string $pdfPath     サーバー上の PDF（呼び出し側が置いたもの。ここでは消さない）
 * @param string $origName    履歴に出す元のファイル名
 * @param string $periodStart 取引期間の開始日（YYYY-MM-DD か YYYY/MM/DD。空なら期間で絞らない）
 * @param string $periodEnd   取引期間の終了日
 */
function opImportBankPdf(string $pdfPath, string $origName, string $periodStart, string $periodEnd): array {
    $script = BASE_DIR . '/core_py/pdf_parse_cli.py';
    $cmd = _pythonBin() . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($pdfPath) . ' 2>&1';
    $output = shell_exec($cmd);
    if ($output === null) throw new OpException('PDFパースの実行に失敗しました（shell_exec無効？）', 500);
    // JSON 行だけ取り出す（警告混入対応）
    $jsonLine = '';
    foreach (array_reverse(preg_split('/\R/', trim((string)$output))) as $line) {
        $line = trim($line);
        if ($line !== '' && $line[0] === '{') { $jsonLine = $line; break; }
    }
    if (!$jsonLine) throw new OpException('PDFパース出力が空です。Pythonの実行環境を確認してください。', 500);
    $parsed = json_decode($jsonLine, true);
    if ($parsed === null) throw new OpException('PDFパース結果のJSON解析に失敗しました: ' . json_last_error_msg(), 500);
    if (empty($parsed['success'])) throw new OpException($parsed['error'] ?? 'PDFパースに失敗しました', 500);

    $periodStart = $periodStart !== '' ? normDate($periodStart) : '';
    $periodEnd   = $periodEnd   !== '' ? normDate($periodEnd)   : '';

    // アップロード済み日付を取得
    $uploadedDates = kvGet('upload_dates', []);
    $uploadedSet   = array_flip($uploadedDates);

    // パース結果をフィルタリング（期間指定 & アップロード済み日付除外）
    $newTxs = $parsed['transactions'] ?? [];
    // 普通預金の側に、設定の補助科目（例: 三井住友銀行）を付ける
    $bankSub = bankAccountSub();
    foreach ($newTxs as &$nt) {
        foreach ($nt['entries'] ?? [] as $ei => $en) {
            if (($en['debit_account'] ?? '') === '普通預金')  $nt['entries'][$ei]['debit_sub']  = $bankSub;
            if (($en['credit_account'] ?? '') === '普通預金') $nt['entries'][$ei]['credit_sub'] = $bankSub;
        }
    }
    unset($nt);
    if ($periodStart || $periodEnd) {
        $ps = $periodStart ?: '0000/01/01';
        $pe = $periodEnd   ?: '9999/12/31';
        // 以前のパーサーは取引区分が「振込」「振替」の行しか取り込めず、「現金」（キャッシュカード）などの行が
        // 抜けていた。取り込み済みの日付でも、その種類の行は、同じ日付・金額・摘要の取引がまだ無ければ追加する。
        $existingKeys = [];
        foreach (getAllTransactions() as $et) $existingKeys[_uploadTxKey($et)] = true;
        $newTxs = array_values(array_filter($newTxs, function($tx) use ($ps, $pe, $uploadedSet, &$existingKeys) {
            $d = $tx['date'] ?? '';
            if ($d < $ps || $d > $pe) return false;
            if (isset($uploadedSet[$d])) {
                if (in_array($tx['type'] ?? '', ['振込', '振替'], true)) return false;
                $k = _uploadTxKey($tx);
                if (isset($existingKeys[$k])) return false;
                $existingKeys[$k] = true;   // 同じPDFに同じ行が2つあれば両方入れたいが、区別できないので1つにする
            }
            return true;
        }));
    }

    // パース結果に自動ルール適用 → DB 保存
    $rules = kvGet('rules', []);
    $autoRegistered = 0;
    foreach ($newTxs as &$tx) {
        $ruleMatched = applyRulesToTx($tx, $rules);
        // 自動仕訳ルールにマッチし、科目が設定されていれば自動登録
        if ($ruleMatched && !empty($tx['entries'])) {
            $e = $tx['entries'][0] ?? [];
            if (!empty($e['debit_account']) && !empty($e['credit_account'])) {
                $tx['registered'] = true;
                $autoRegistered++;
            }
        }
    }
    unset($tx);
    if ($newTxs) upsertTransactionsBulk($newTxs);

    // 申請(paid & pending_match) と新規取引の自動マッチング
    $matched = matchPendingClaimsToTransactions();

    // アップロード済み日付を更新
    if ($periodStart && $periodEnd) {
        $cur = new DateTime(str_replace('/', '-', $periodStart));
        $end = new DateTime(str_replace('/', '-', $periodEnd));
        while ($cur <= $end) {
            $ds = $cur->format('Y/m/d');
            if (!isset($uploadedSet[$ds])) {
                $uploadedDates[] = $ds;
                $uploadedSet[$ds] = true;
            }
            $cur->modify('+1 day');
        }
        sort($uploadedDates);
        kvSet('upload_dates', $uploadedDates);
    }

    // アップロード履歴
    $log = kvGet('uploads_log', []);
    $log[] = [
        'name'        => basename($origName),
        'uploaded_at' => now(),
        'count'       => count($newTxs),
        'period'      => $periodStart && $periodEnd ? $periodStart . '〜' . $periodEnd : '',
    ];
    kvSet('uploads_log', $log);

    return [
        'success'         => true,
        'count'           => count($newTxs),
        'auto_registered' => $autoRegistered,
        'claim_matched'   => $matched,
        'period'          => $periodStart && $periodEnd ? $periodStart . '〜' . $periodEnd : '',
    ];
}

// ══════════════════════════════════════════════════════════════════════════════
// クレジットカード明細CSVの取り込み（三井住友カード法人カード明細）
// 明細全件を1つの振替トランザクション + 複数 entries として登録する
// ══════════════════════════════════════════════════════════════════════════════
/**
 * クレカCSVの金額欄を符号付きで解釈する。
 * 全角数字、全角マイナス、▲△、括弧書き "(1,000)" のマイナス表記に対応。
 */
function parseCreditAmount(string $raw): int {
    $s = mb_convert_kana(trim($raw), 'n');           // 全角数字 → 半角
    $s = str_replace(['−', '－', 'ー', '▲', '△', '―'], '-', $s);
    $neg = false;
    if (preg_match('/^\((.*)\)$/', $s, $m)) { $neg = true; $s = $m[1]; }  // (1,000) = -1,000
    if (strpos($s, '-') !== false) $neg = true;
    $digits = preg_replace('/[^0-9]/', '', $s);
    if ($digits === '') return 0;
    $n = (int)$digits;
    return $neg ? -$n : $n;
}

/**
 * クレカ仕訳ルールを1明細に適用する。
 *
 * 通常の利用明細は「借方=未設定 / 貸方=普通預金」、
 * 返品明細は「借方=普通預金 / 貸方=未設定」で作られている。
 * ルールが持つのは費用科目（debit_account）だけなので、
 * 返品明細ではそれを貸方側に入れないと符号が逆になる。
 */
function applyCreditRuleToEntry(array &$e, array $rules): bool {
    if (!empty($e['debit_account']) && !empty($e['credit_account'])) return false;

    // 普通預金がすでに借方にある＝返品明細（貸借が逆向き）
    $isRefund = !empty($e['debit_account']) && empty($e['credit_account']);
    $party    = $e['memo'] ?? '';

    foreach ($rules as $rule) {
        $pattern = $rule['pattern'] ?? '';
        if ($pattern !== '') {
            $pNs = ruleKanaFold(preg_replace('/[\s　]/u', '', $pattern));
            $tNs = ruleKanaFold(preg_replace('/[\s　]/u', '', $party));
            if (@preg_match('/' . $pNs . '/ui', $tNs) !== 1) continue;
        }
        // ルールの借方（費用科目）は、返品なら貸方へ入れる
        if (!empty($rule['debit_account'])) {
            if ($isRefund) { $e['credit_account'] = $rule['debit_account']; $e['credit_sub'] = $rule['debit_sub'] ?? ''; }
            else           { $e['debit_account']  = $rule['debit_account']; $e['debit_sub']  = $rule['debit_sub'] ?? ''; }
        }
        if (!empty($rule['credit_account'])) {
            if ($isRefund) { $e['debit_account']  = $rule['credit_account']; $e['debit_sub']  = $rule['credit_sub'] ?? ''; }
            else           { $e['credit_account'] = $rule['credit_account']; $e['credit_sub'] = $rule['credit_sub'] ?? ''; }
        }
        if (!empty($rule['memo_template'])) $e['memo'] = $rule['memo_template'];
        return true;
    }
    return false;
}

/** クレカ由来の取引か */
function _isCreditTx(array $tx): bool {
    $p = (string)($tx['party'] ?? '');
    return ($tx['source'] ?? '') === 'credit_csv' || $p === 'ｸﾚｼﾞﾂﾄ ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ' || strpos($p, 'ｸﾚｼﾞﾂﾄ ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ') === 0;
}

/** 未登録のクレカ取引すべてにクレカ仕訳ルールを適用する（更新した取引数を返す） */
function opApplyCreditRules(): int {
    $creditRules = kvGet('credit_rules', []);
    $updated = 0;
    foreach (getAllTransactions() as $tx) {
        if (($tx['source'] ?? '') !== 'credit_csv' && ($tx['party'] ?? '') !== 'ｸﾚｼﾞﾂﾄ ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ') continue;
        if (!empty($tx['registered'])) continue;
        if (!empty($tx['provisional'])) continue; // 仮登録は人が確認済みなので上書きしない

        $entries = $tx['entries'] ?? [];
        $before  = $entries;
        $changed = false;
        foreach ($entries as &$e) {
            if (applyCreditRuleToEntry($e, $creditRules)) $changed = true;
        }
        unset($e);

        if ($changed) {
            $tx['entries'] = $entries;
            rememberEntryOrigins($tx, $before);
            $allDone = true;
            foreach ($entries as $e) {
                if (empty($e['debit_account']) || empty($e['credit_account'])) { $allDone = false; break; }
            }
            if ($allDone) $tx['registered'] = true;
            upsertTransaction($tx);
            $updated++;
        }
    }
    return $updated;
}

/**
 * @param string $csvPath      サーバー上の CSV（Shift_JIS か UTF-8）
 * @param string $origName     履歴に出す元のファイル名
 * @param string $paymentMonth 引き落とし月 YYYY-MM（銀行PDFの振替日の月）
 */
function opImportCreditCsv(string $csvPath, string $origName, string $paymentMonth): array {
    $paymentMonth = str_replace('/', '-', trim($paymentMonth));
    if (!preg_match('/^\d{4}-\d{2}$/', $paymentMonth)) {
        throw new OpException('引き落とし日（振替年月）は必須です。銀行PDFの振替日を YYYY-MM 形式で指定してください。');
    }
    $raw  = (string)file_get_contents($csvPath);
    $utf8 = mb_check_encoding($raw, 'UTF-8') ? $raw : mb_convert_encoding($raw, 'UTF-8', 'SJIS-win');
    $lines = explode("\n", $utf8);

    $entries  = [];   // 全明細を entries として蓄積
    $totalAmt = 0;    // 符号付きの正味合計（返品はマイナス）
    $refunds  = 0;    // 返品（マイナス）明細の件数
    $csvDate  = '';
    $skipped  = 0;

    foreach ($lines as $rawLine) {
        $line = trim($rawLine);
        if ($line === '') continue;
        $cols = str_getcsv($line);

        // 明細行：col[0] = YYYY/MM/DD
        // 列: 0=利用日 1=加盟店 2=利用金額 3=支払回数 4=今回回数 5=今回支払額 6=備考
        if (count($cols) >= 3 && preg_match('/^\d{4}\/\d{2}\/\d{2}$/', trim($cols[0]))) {
            $date   = trim($cols[0]);
            $party  = mb_convert_kana(trim($cols[1]), 'KVa');
            $note   = trim($cols[6] ?? '');

            // 今回の引き落とし額は col[5]（今回支払額）が正。
            // 分割払いでは col[2]（利用金額）は総額なので使えず、
            // キャッシュバック等は col[2] が空で col[5] にだけ入る。
            $amount = parseCreditAmount($cols[5] ?? '');
            if ($amount === 0 && trim($cols[5] ?? '') === '') {
                $amount = parseCreditAmount($cols[2] ?? '');   // col[5] が無いCSV形式へのフォールバック
            }
            if ($amount === 0) { $skipped++; continue; }

            $isRefund = $amount < 0;   // 返品・キャンセルはカード会社からの戻り
            $abs      = abs($amount);
            if ($isRefund) $refunds++;

            // 通常: 借方(未定・ルールで補完) / 貸方 普通預金
            // 返品: 借方 普通預金 / 貸方(未定・ルールで補完)  ← 貸借を逆にする
            $entries[] = [
                'debit_account'  => $isRefund ? '普通預金' : '',
                'debit_sub'      => $isRefund ? bankAccountSub() : '',
                'credit_account' => $isRefund ? '' : '普通預金',
                'credit_sub'     => $isRefund ? '' : bankAccountSub(),
                'amount'         => $abs,
                'memo'           => $date . ' ' . implode(' / ', array_filter([$party, $note], fn($s) => $s !== '')),
            ];
            $totalAmt += $amount;   // 符号付きで加算（返品は引き落とし額を減らす）
            if ($date > $csvDate) $csvDate = $date;
        }
    }
    if (!$entries) throw new OpException('取り込める明細がありませんでした');

    // YYYY-MM → 月初日 YYYY/MM/01 を仕訳dateに使う
    $txDate      = str_replace('-', '/', $paymentMonth) . '/01';
    $monthPrefix = str_replace('-', '/', $paymentMonth); // "YYYY/MM"

    // ── 引き落とし月で既存クレカTX（未登録）を検索して上書き（重複防止）──
    $existingId      = null;
    $existingGroupId = newUuid();
    $existingDate    = null;
    $allExisting     = getAllTransactions();
    // 優先1: 引き落とし月が同じ未登録クレカTX → 銀行明細由来の正確な振替日を引き継ぐ
    foreach ($allExisting as $et) {
        if (!_isCreditTx($et) || !empty($et['registered'])) continue;
        if (strpos($et['date'] ?? '', $monthPrefix) !== 0) continue;
        $existingId = $et['id']; $existingGroupId = $et['group_id'] ?? $existingGroupId; $existingDate = $et['date'];
        break;
    }
    // 優先2: 合計金額が同じ未登録クレカTX（月をまたいだ再インポート対策）
    if (!$existingId) {
        foreach ($allExisting as $et) {
            if (!_isCreditTx($et) || !empty($et['registered'])) continue;
            if ((int)($et['amount'] ?? 0) !== abs($totalAmt)) continue;
            $existingId = $et['id']; $existingGroupId = $et['group_id'] ?? $existingGroupId; $existingDate = $et['date'];
            break;
        }
    }

    $tx = [
        'id'          => $existingId ?? newUuid(),
        'date'        => $existingDate ?? $txDate,
        'amount'      => abs($totalAmt),
        // 返品が多く正味がマイナスになる月は「入金」として記録する
        'bank_debit'  => $totalAmt >= 0 ? $totalAmt  : 0,
        'bank_credit' => $totalAmt <  0 ? -$totalAmt : 0,
        'type'        => '振替',
        'party'       => 'ｸﾚｼﾞﾂﾄ ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ',
        'group_id'    => $existingGroupId,
        'memo'        => 'クレジットカード明細 ' . count($entries) . '件' . ($refunds ? "（うち返品{$refunds}件）" : ''),
        'registered'  => 0,   // 借方科目は未設定なので常に未登録（クレカ仕訳ルール適用後に登録される）
        'source_file' => basename($origName),
        'entries'     => $entries,
    ];
    upsertTransaction($tx);

    // ── CSVインポート直後にクレカ仕訳ルールを自動適用 ──
    $creditRules = kvGet('credit_rules', []);
    if ($creditRules) {
        $ft = getTransactionById($tx['id']);
        if ($ft) {
            $entries2 = $ft['entries'] ?? [];
            $before2  = $entries2;
            $changed  = false;
            foreach ($entries2 as &$e2) {
                if (applyCreditRuleToEntry($e2, $creditRules)) $changed = true;
            }
            unset($e2);
            if ($changed) {
                $ft['entries'] = $entries2;
                rememberEntryOrigins($ft, $before2);
                $allDone = array_reduce($entries2, fn($c, $e) => $c && !empty($e['debit_account']) && !empty($e['credit_account']), true);
                if ($allDone) $ft['registered'] = true;
                upsertTransaction($ft);
                $tx = $ft;
            }
        }
    }

    $log   = kvGet('credit_csv_log', []);
    $log[] = [
        'name'        => basename($origName),
        'uploaded_at' => now(),
        'count'       => count($entries),
        'skipped'     => $skipped,
        'tx_id'       => $tx['id'],
    ];
    kvSet('credit_csv_log', $log);

    $autoApplied = 0;
    foreach (($tx['entries'] ?? []) as $ae) {
        if (!empty($ae['debit_account']) && !empty($ae['credit_account'])) $autoApplied++;
    }
    return [
        'success'      => true,
        'count'        => count($entries),
        'skipped'      => $skipped,
        'refunds'      => $refunds,
        'tx_id'        => $tx['id'],
        'date'         => $tx['date'],
        'amount'       => $tx['amount'],
        'replaced_existing' => $existingId !== null,
        'registered'   => !empty($tx['registered']),
        'auto_applied' => $autoApplied,
    ];
}

// ══════════════════════════════════════════════════════════════════════════════
// 期間リセット
//   指定期間の仕訳を削除し、PDF取込済み日付を「未取込」に戻す（＝再アップロード可能）。
//   削除前に data/resets/ へスナップショットを保存し、取り消し（undo）できる。
// ══════════════════════════════════════════════════════════════════════════════
function _resetCollectTx(string $start, string $end, array $sources): array {
    $targets = [];
    foreach (getAllTransactions() as $tx) {
        $d = normDate((string)($tx['date'] ?? ''));
        if ($d === '' || $d < $start || $d > $end) continue;
        if (!in_array(txSourceKind($tx), $sources, true)) continue;
        $targets[] = $tx;
    }
    return $targets;
}
function _resetDatesInRange(array $dates, string $start, string $end): array {
    $hit = [];
    foreach ($dates as $d) {
        $n = normDate((string)$d);
        if ($n !== '' && $n >= $start && $n <= $end) $hit[] = $n;
    }
    return $hit;
}

/**
 * @param array $b start / end / sources[] / dry_run / clear_upload_dates
 */
function opResetPeriod(array $b): array {
    $start = normDate((string)($b['start'] ?? ''));
    $end   = normDate((string)($b['end'] ?? ''));
    if ($start === '' || $end === '') throw new OpException('期間の開始日と終了日を指定してください');
    if ($start > $end)                throw new OpException('開始日が終了日より後です');

    $dryRun  = !empty($b['dry_run']);
    $sources = array_values(array_intersect(
        ['pdf', 'credit_csv', 'manual'],
        is_array($b['sources'] ?? null) ? $b['sources'] : ['pdf']
    ));
    if (!$sources) throw new OpException('リセット対象の取込元を1つ以上選んでください');
    // 取込済みカレンダーを戻すか（既定: PDFを対象に含むときだけ戻す）
    $clearDates = array_key_exists('clear_upload_dates', $b)
        ? !empty($b['clear_upload_dates'])
        : in_array('pdf', $sources, true);

    $targets = _resetCollectTx($start, $end, $sources);
    $txIds   = array_column($targets, 'id');
    $txIdSet = array_flip($txIds);

    $bySource   = ['pdf' => 0, 'credit_csv' => 0, 'manual' => 0];
    $registered = 0; $billingLinked = 0; $withReceipt = 0; $amount = 0;
    $claimIdSet = [];
    foreach ($targets as $tx) {
        $bySource[txSourceKind($tx)]++;
        if (!empty($tx['registered']))       $registered++;
        if (!empty($tx['billing_sheet_id'])) $billingLinked++;
        if (!empty($tx['receipt_file']))     $withReceipt++;
        if (!empty($tx['claim_id']))         $claimIdSet[$tx['claim_id']] = true;
        $amount += (int)($tx['amount'] ?? 0);
    }

    // 紐付いた申請 → 「返金済み・仕訳待ち」に戻す（再取込で自動マッチできる状態）
    $claimTargets = [];
    foreach (getAllClaims() as $c) {
        $hit = (!empty($c['journal_tx_id']) && isset($txIdSet[$c['journal_tx_id']]))
            || isset($claimIdSet[$c['id']]);
        if ($hit) $claimTargets[] = $c;
    }

    $uploadDates = kvGet('upload_dates', []);
    $datesHit    = $clearDates ? _resetDatesInRange($uploadDates, $start, $end) : [];

    $summary = [
        'start'              => $start,
        'end'                => $end,
        'sources'            => $sources,
        'tx_count'           => count($targets),
        'by_source'          => $bySource,
        'registered'         => $registered,
        'billing_linked'     => $billingLinked,
        'receipt_count'      => $withReceipt,
        'claim_count'        => count($claimTargets),
        'amount'             => $amount,
        'upload_dates'       => count($datesHit),
        'clear_upload_dates' => $clearDates,
    ];
    if ($dryRun) return array_merge(['ok' => true, 'dry_run' => true], $summary);
    if (!$targets && !$datesHit) {
        return array_merge(['ok' => true, 'dry_run' => false, 'reset_id' => '', 'claims_reset' => 0], $summary);
    }

    // ── アップロード履歴から巻き戻す分を抽出 ──
    $uploadsLog = kvGet('uploads_log', []);
    $keepUploads = []; $removedUploads = [];
    if (in_array('pdf', $sources, true)) {
        foreach ($uploadsLog as $row) {
            $p = (string)($row['period'] ?? '');
            if ($p !== '' && preg_match('/^(.+)〜(.+)$/u', $p, $mm)) {
                $ps = normDate($mm[1]); $pe = normDate($mm[2]);
                // 期間がまるごとリセット範囲に入る履歴だけ削除（部分的に重なる分は残す）
                if ($ps !== '' && $pe !== '' && $ps >= $start && $pe <= $end) { $removedUploads[] = $row; continue; }
            }
            $keepUploads[] = $row;
        }
    } else {
        $keepUploads = $uploadsLog;
    }
    $creditLog = kvGet('credit_csv_log', []);
    $keepCredit = []; $removedCredit = [];
    if (in_array('credit_csv', $sources, true)) {
        foreach ($creditLog as $row) {
            if (!empty($row['tx_id']) && isset($txIdSet[$row['tx_id']])) { $removedCredit[] = $row; continue; }
            $keepCredit[] = $row;
        }
    } else {
        $keepCredit = $creditLog;
    }

    // ── スナップショット保存（取り消し用）。保存できなければ何も消さない ──
    $resetId = date('Ymd_His') . '_' . substr(newUuid(), 0, 8);
    if (!is_dir(RESET_DIR) && !@mkdir(RESET_DIR, 0755, true) && !is_dir(RESET_DIR)) {
        throw new OpException('リセット前バックアップの保存先を作成できませんでした。処理を中止しました。', 500);
    }
    $snapFile = RESET_DIR . '/' . $resetId . '.json';
    $snapshot = [
        'id'             => $resetId,
        'created_at'     => now(),
        'start'          => $start,
        'end'            => $end,
        'sources'        => $sources,
        'transactions'   => $targets,
        'claims'         => $claimTargets,
        'upload_dates'   => $datesHit,
        'uploads_log'    => $removedUploads,
        'credit_csv_log' => $removedCredit,
    ];
    if (@file_put_contents($snapFile, json_encode($snapshot, JSON_UNESCAPED_UNICODE)) === false) {
        throw new OpException('リセット前バックアップの保存に失敗しました。処理を中止しました。', 500);
    }

    // ── 仕訳を削除 ──
    $pdo = txDb();
    $pdo->beginTransaction();
    try {
        $delEntry = $pdo->prepare("DELETE FROM entries WHERE tx_id=?");
        $delTx    = $pdo->prepare("DELETE FROM transactions WHERE id=?");
        foreach ($txIds as $id) { $delEntry->execute([$id]); $delTx->execute([$id]); }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    // ── 申請の紐付けを解除（返金済みなら再マッチ待ちに戻す）──
    $claimsReset = 0;
    foreach ($claimTargets as $c) {
        $c['journaled']     = false;
        $c['journal_tx_id'] = '';
        $c['pending_match'] = (($c['status'] ?? '') === 'paid');
        upsertClaim($c);
        $claimsReset++;
    }

    // ── 取込済み日付・アップロード履歴を巻き戻す ──
    if ($datesHit) {
        $hitSet = array_flip($datesHit);
        $rest   = [];
        foreach ($uploadDates as $d) {
            $n = normDate((string)$d);
            if ($n !== '' && isset($hitSet[$n])) continue;
            $rest[] = $d;
        }
        sort($rest);
        kvSet('upload_dates', $rest);
    }
    if ($removedUploads) kvSet('uploads_log',    $keepUploads);
    if ($removedCredit)  kvSet('credit_csv_log', $keepCredit);

    // ── リセット履歴（古いスナップショットは20件で打ち切り）──
    $log   = kvGet('reset_log', []);
    $log[] = [
        'id'           => $resetId,
        'created_at'   => now(),
        'start'        => $start,
        'end'          => $end,
        'sources'      => $sources,
        'tx_count'     => count($targets),
        'claim_count'  => $claimsReset,
        'upload_dates' => count($datesHit),
        'amount'       => $amount,
        'undone'       => false,
    ];
    if (count($log) > 20) {
        foreach (array_slice($log, 0, count($log) - 20) as $old) {
            $f = RESET_DIR . '/' . ($old['id'] ?? '') . '.json';
            if (($old['id'] ?? '') !== '' && is_file($f)) @unlink($f);
        }
        $log = array_slice($log, -20);
    }
    kvSet('reset_log', $log);

    return array_merge(['ok' => true, 'dry_run' => false, 'reset_id' => $resetId, 'claims_reset' => $claimsReset], $summary);
}

/** 期間リセットの取り消し（スナップショットから復元）。$id が空なら最新の未取消のもの */
function opResetUndo(string $id): array {
    $id = trim($id);
    $log = kvGet('reset_log', []);
    if ($id === '') {
        foreach (array_reverse($log) as $row) {
            if (empty($row['undone'])) { $id = (string)($row['id'] ?? ''); break; }
        }
    }
    if ($id === '' || !preg_match('/^\d{8}_\d{6}_[0-9a-f]{8}$/', $id)) {
        throw new OpException('取り消せるリセットが見つかりません', 404);
    }
    $snapFile = RESET_DIR . '/' . $id . '.json';
    if (!is_file($snapFile)) throw new OpException('リセットのバックアップが見つかりません（古い履歴は自動削除されます）', 404);
    $snap = json_decode((string)file_get_contents($snapFile), true);
    if (!is_array($snap)) throw new OpException('バックアップの読み込みに失敗しました', 500);

    $txs = $snap['transactions'] ?? [];
    if ($txs) upsertTransactionsBulk($txs);
    foreach ($snap['claims'] ?? [] as $c) upsertClaim($c);

    if (!empty($snap['upload_dates'])) {
        $dates = array_values(array_unique(array_merge(kvGet('upload_dates', []), $snap['upload_dates'])));
        sort($dates);
        kvSet('upload_dates', $dates);
    }
    if (!empty($snap['uploads_log'])) {
        $l = array_merge(kvGet('uploads_log', []), $snap['uploads_log']);
        usort($l, fn($a, $b) => (string)($a['uploaded_at'] ?? '') <=> (string)($b['uploaded_at'] ?? ''));
        kvSet('uploads_log', $l);
    }
    if (!empty($snap['credit_csv_log'])) {
        $l = array_merge(kvGet('credit_csv_log', []), $snap['credit_csv_log']);
        usort($l, fn($a, $b) => (string)($a['uploaded_at'] ?? '') <=> (string)($b['uploaded_at'] ?? ''));
        kvSet('credit_csv_log', $l);
    }
    foreach ($log as &$row) { if (($row['id'] ?? '') === $id) $row['undone'] = true; }
    unset($row);
    kvSet('reset_log', $log);

    return [
        'ok'                    => true,
        'id'                    => $id,
        'tx_restored'           => count($txs),
        'claim_restored'        => count($snap['claims'] ?? []),
        'upload_dates_restored' => count($snap['upload_dates'] ?? []),
    ];
}

// ══════════════════════════════════════════════════════════════════════════════
// 振込確認チェック（請求シートの各メンバーに入金を照合し、未仕訳なら自動仕訳する）
//   - 1つの入金は1人にしか割り当てない（全体で優先度順に貪欲に割り当てる）
//   - 他の請求シート・申請（返金）に紐付いた入金は使わない（存在しないシートへの紐付けは未照合として扱う）
//   - 前回このシートで照合した入金（paid_tx_id / billing_sheet_id）を最優先で維持する
//   - 姓だけの名義など弱い一致は、同じ金額のメンバーの中で1人に決まるときだけ採用する
//   - 照合した取引ID・入金日をメンバーごとに保存し、詳細画面はそれを表示する
//   - 手動で振込済みにしたメンバー（manual_paid）は照合せず、そのまま振込済みにしておく
// ══════════════════════════════════════════════════════════════════════════════
/** 入金額（普通預金の借方合計。仕訳が無ければ銀行明細の入金額） */
function billingTxCredit(array $tx): int {
    $bc = 0;
    foreach ($tx['entries'] ?? [] as $e) {
        if (($e['debit_account'] ?? '') === '普通預金') $bc += (int)($e['amount'] ?? 0);
    }
    if (!$bc) $bc = (int)($tx['bank_credit'] ?? 0) ?: (int)($tx['credit'] ?? 0);
    return $bc;
}

function opBillingCheck(string $sheetId): array {
    $sheet = getSheet($sheetId);
    if (!$sheet) throw new OpException('請求シートが見つかりません', 404);

    $graceDays = max(0, (int)(kvGet('settings', [])['payment_grace_days'] ?? 7));

    // ── 照合期間（'Y/m/d' 文字列で比較する。時刻を持ち込まない）──
    $wsStr = '0000/01/01';
    if (($sheet['type'] ?? '') === 'other' && !empty($sheet['start_date'])) {
        $d = normDate((string)$sheet['start_date']);
        if ($d !== '') $wsStr = $d;
    } elseif (!empty($sheet['period']) && preg_match('#^(\d{4})[/-](\d{1,2})$#', (string)$sheet['period'], $pm)) {
        $wsStr = sprintf('%04d/%02d/01', (int)$pm[1], (int)$pm[2]);
    }
    if (!empty($sheet['due_date'])) {
        $due = DateTime::createFromFormat('!Y/m/d', normDate((string)$sheet['due_date']));
        if (!$due) throw new OpException('振込期限の日付が不正です: ' . $sheet['due_date']);
        $weStr = $due->modify("+{$graceDays} days")->format('Y/m/d');
    } else {
        $weStr = (new DateTime('today'))->modify('+365 days')->format('Y/m/d');
    }

    // ── 候補の入金（期間内・入金額 > 0・他の請求シート／申請に紐付いていない）──
    // 削除済みなど存在しないシートへの紐付けは無効とみなし、未照合の入金として扱う
    $sheetIds = array_flip(billingDb()->query("SELECT id FROM billing_sheets")->fetchAll(PDO::FETCH_COLUMN));
    $cands = [];
    foreach (getTransactionsByYearRange((int)substr($wsStr, 0, 4), (int)substr($weStr, 0, 4)) as $tx) {
        $d = normDate((string)($tx['date'] ?? ''));
        if ($d === '' || $d < $wsStr || $d > $weStr) continue;
        $linked = (string)($tx['billing_sheet_id'] ?? '');
        if ($linked !== '' && !isset($sheetIds[$linked])) $linked = '';   // 存在しないシート → 未照合
        if ($linked !== '' && $linked !== $sheetId) continue;   // 他のシートで照合済み
        if (!empty($tx['claim_id'])) continue;                  // 申請（返金）の取引
        $amt = billingTxCredit($tx);
        if ($amt <= 0) continue;
        $cands[$tx['id']] = ['tx' => $tx, 'date' => $d, 'amt' => $amt, 'linked' => $linked === $sheetId];
    }

    // ── メンバー × 入金 の組を作る（金額一致・カナ一致）──
    $members = $sheet['members'] ?? [];
    $pairs = [];
    $weakCount = [];
    foreach ($members as $i => $mc) {
        $fee = (int)($mc['fee'] ?? 0);
        if ($fee <= 0 || !empty($mc['manual_paid'])) continue;
        foreach ($cands as $txId => $c) {
            if ($c['amt'] !== $fee) continue;
            $score = billingKanaScore((string)($c['tx']['party'] ?? ''), (string)($mc['kana'] ?? ''));
            if ($score === 0) continue;
            if ($score === 1) $weakCount[$txId] = ($weakCount[$txId] ?? 0) + 1;
            $pairs[] = [
                'm' => $i, 'tx' => $txId, 'score' => $score, 'date' => $c['date'],
                'kept' => ($mc['paid_tx_id'] ?? '') === $txId ? 1 : 0,
                'linked' => $c['linked'] ? 1 : 0,
            ];
        }
    }
    $pairs = array_values(array_filter($pairs,
        fn($p) => $p['score'] === 2 || ($weakCount[$p['tx']] ?? 0) === 1));
    usort($pairs, fn($a, $b) =>
        [$b['kept'], $b['linked'], $b['score'], $a['date'], $a['m']]
        <=> [$a['kept'], $a['linked'], $a['score'], $b['date'], $b['m']]);

    $assigned = []; $usedTx = [];
    foreach ($pairs as $p) {
        if (isset($assigned[$p['m']]) || isset($usedTx[$p['tx']])) continue;
        $assigned[$p['m']] = $p['tx'];
        $usedTx[$p['tx']]  = true;
    }

    // ── 反映（メンバーの入金状況 + 未仕訳の入金を自動仕訳）──
    $matched = $journaled = $journaledTotal = 0;
    $ruleName = ($sheet['type'] ?? '') === 'other'
        ? (string)($sheet['title'] ?? '')
        : '会費:' . ($sheet['period'] ?? '');
    $pdo = txDb();
    $pdo->beginTransaction();
    try {
        foreach ($members as $i => &$mc) {
            if (!empty($mc['manual_paid'])) continue;            // 手動で振込済み（照合結果で上書きしない）
            $txId = $assigned[$i] ?? null;
            if ($txId === null) {
                $mc['paid'] = false;
                unset($mc['paid_tx_id'], $mc['paid_date']);
                continue;
            }
            $c = $cands[$txId];
            $mc['paid']       = true;
            $mc['paid_tx_id'] = $txId;
            $mc['paid_date']  = $c['date'];
            $matched++;

            if ($c['linked']) { $journaledTotal++; continue; }   // このシートで仕訳済み（再チェックで上書きしない）
            $da = $mc['debit_account'] ?? ''; $ds = $mc['debit_sub'] ?? '';
            $ca = $mc['credit_account'] ?? ''; $cs = $mc['credit_sub'] ?? '';
            if (!($mc['auto_journal'] ?? true) || !$da || !$ca) continue;

            $fee  = (int)$mc['fee'];
            // 会費シートの摘要「{$取引月}月分」は請求の対象月にする。その他請求は入金日のまま。
            $memoDate = ($sheet['type'] ?? '') === 'other' ? $c['date'] : $wsStr;
            $memo = !empty($mc['memo_template'])
                ? resolveVars((string)$mc['memo_template'], $memoDate, (string)($mc['name'] ?? ''))
                : (string)($c['tx']['memo'] ?? '');
            upsertTransaction(array_merge($c['tx'], [
                'entries'          => [[
                    'debit_account'=>$da,'debit_sub'=>$ds,
                    'credit_account'=>$ca,'credit_sub'=>$cs,
                    'amount'=>$fee,'memo'=>$memo,
                ]],
                'registered'       => true,
                'auto_rule'        => $ruleName,
                'billing_sheet_id' => $sheetId,
            ]));
            $journaled++;
            $journaledTotal++;
        }
        unset($mc);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $sheet['members']         = $members;
    $sheet['checked_at']      = now();
    $sheet['matched_count']   = $matched;
    $sheet['journaled_count'] = $journaledTotal;
    upsertSheet($sheet);
    return ['ok' => true, 'matched' => $matched, 'journaled' => $journaled,
            'unpaid' => count(array_filter($members, fn($m) => empty($m['paid']) && (int)($m['fee'] ?? 0) > 0))];
}

/**
 * メンバーを手動で振込済みにする／手動の振込済みを取り消す（現金で受け取ったときなど）。
 *   - 手動の振込済みは取引に紐付けず、仕訳もしない。振込確認チェックでも上書きしない
 *   - 取り消せるのは手動で振込済みにしたメンバーだけ（照合した入金は振込確認チェックで決まる）
 * 変更後のメンバーを返す。
 */
function opBillingSetManualPaid(string $sheetId, int $index, bool $paid, string $date = ''): array {
    $sheet = getSheet($sheetId);
    if (!$sheet) throw new OpException('請求シートが見つかりません', 404);
    $m = $sheet['members'][$index] ?? null;
    if (!is_array($m)) throw new OpException('メンバーが見つかりません', 404);
    $name = (string)($m['name'] ?? '');

    if ($paid) {
        if (!empty($m['paid'])) {
            throw new OpException(!empty($m['manual_paid']) ? "{$name} はすでに手動で振込済みです" : "{$name} はすでに入金を照合済みです");
        }
        if ($date === '') {
            $date = date('Y/m/d');
        } else {
            $date = normDate($date);
            if ($date === '' || !checkdate((int)substr($date, 5, 2), (int)substr($date, 8, 2), (int)substr($date, 0, 4))) throw new OpException('入金日の日付が不正です');
        }
        $m['paid'] = true;
        $m['manual_paid'] = true;
        $m['paid_date'] = $date;
        unset($m['paid_tx_id']);
    } else {
        if (empty($m['manual_paid'])) throw new OpException("{$name} は手動で振込済みにしていません");
        $m['paid'] = false;
        unset($m['manual_paid'], $m['paid_date'], $m['paid_tx_id']);
    }
    $sheet['members'][$index] = $m;
    upsertSheet($sheet);
    return $m;
}

// ══════════════════════════════════════════════════════════════════════════════
// 申請（交通費・立替）
// ══════════════════════════════════════════════════════════════════════════════
/** 新しい申請を作る（Slack の Worker と画面の両方から）。作った申請を返す */
function opCreateClaim(array $data): array {
    // ★サーバーが管理する項目は申請者（Slack）側から受け取らない。
    foreach (['status', 'journaled', 'journal_tx_id', 'pending_match', 'paid_date',
              'receipt_file', 'created_at', 'fallback_debit', 'fallback_debit_sub',
              'fallback_credit', 'fallback_credit_sub'] as $k) {
        unset($data[$k]);
    }
    if (!in_array($data['type'] ?? '', ['transport', 'advance'], true)) throw new OpException('申請の種類が不正です');
    $data['amount'] = max(0, (int)($data['amount'] ?? 0));
    // ID は Worker が採番して領収書の転送に使う。形式を限定し、既存の申請の上書きは許さない。
    if (empty($data['id'])) {
        $data['id'] = newUuid();
    } elseif (!preg_match('/^[A-Za-z0-9-]{8,64}$/', (string)$data['id']) || getClaim((string)$data['id'])) {
        throw new OpException('申請IDが不正です', 409);
    }
    $data['status']     = 'pending';
    $data['created_at'] = now();

    // 交通費の場合、利用日の月が締め切り済みなら拒否
    if (($data['type'] ?? '') === 'transport') {
        $month = substr(str_replace('/', '-', (string)($data['work_date'] ?? '')), 0, 7); // "YYYY-MM"
        if (strlen($month) === 7) {
            $deadlines = kvGet('settings', [])['transport_deadlines'] ?? [];
            if (!empty($deadlines[$month])) throw new OpException("{$month} は締め切り済みのため申請できません。");
        }
    }
    upsertClaim($data);
    return $data;
}

/** 承認済みの申請の返金を仕訳として登録する。作った取引を返す */
function opJournalClaim(string $id, array $req): array {
    $claim = getClaim($id);
    if (!$claim) throw new OpException('申請が見つかりません', 404);
    $type = $claim['type'] ?? '';

    // 空文字は「未指定」として扱い、申請側で選んだ科目 → 既定科目の順に採用する
    $debitAccount  = firstNonEmpty($req['debit_account']  ?? '', $claim['fallback_debit']  ?? '',
                                   $type === 'transport' ? '交通費' : '立替金');
    $debitSub      = firstNonEmpty($req['debit_sub']      ?? '', $claim['fallback_debit_sub']  ?? '');
    $creditAccount = firstNonEmpty($req['credit_account'] ?? '', $claim['fallback_credit'] ?? '', '普通預金');
    $creditSub     = firstNonEmpty($req['credit_sub']     ?? '', $claim['fallback_credit_sub'] ?? '',
                                   bankAccountSub());
    $amount        = (int)($claim['amount'] ?? 0);
    // 摘要: 交通費は「M/D行き先交通費」、立替は申請画面のメモ（無ければ用途）
    $memo = firstNonEmpty($req['memo'] ?? '', buildClaimMemo($claim));

    $txId = newUuid();
    $tx = [
        'id'         => $txId,
        'group_id'   => newUuid(),
        'date'       => $claim['paid_date'] ?: now('Y/m/d'),
        'party'      => $claim['applicant'] ?? '',
        'memo'       => $memo,
        'registered' => true,
        'auto_rule'  => claimAutoRuleLabel($claim),
        'claim_id'   => $id,
        'entries'    => [[
            'debit_account'=>$debitAccount, 'debit_sub'=>$debitSub,
            'credit_account'=>$creditAccount,'credit_sub'=>$creditSub,
            'amount'=>$amount,'memo'=>$memo,
        ]],
    ];
    // 申請に領収書がある場合、その仕訳にも receipt_file を設定（upsertTransaction が引き継ぐ）
    if (!empty($claim['receipt_file'])) $tx['receipt_file'] = $claim['receipt_file'];
    upsertTransaction($tx);
    upsertClaim(array_merge($claim, ['journaled' => true, 'journal_tx_id' => $txId]));
    return $tx;
}

// ══════════════════════════════════════════════════════════════════════════════
// 領収書
// ══════════════════════════════════════════════════════════════════════════════
function opReceiptDelete(string $txId): void {
    $dir = RECEIPT_DIR . '/' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $txId);
    foreach (glob($dir . '/*') ?: [] as $f) { @unlink($f); }
    @rmdir($dir);
    txDb()->prepare("UPDATE transactions SET receipt_file = NULL WHERE id = ?")->execute([$txId]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Excel 出力（Python で生成）
// ══════════════════════════════════════════════════════════════════════════════
/** 生成した xlsx の一時ファイルのパスを返す（呼び出し側が消す） */
function opExportExcel(string $segment, array $body, array $qs): string {
    $tmpIn  = tempnam(sys_get_temp_dir(), 'acct_in_');
    $tmpOut = tempnam(sys_get_temp_dir(), 'acct_out_');
    file_put_contents($tmpIn, json_encode($body, JSON_UNESCAPED_UNICODE));

    $script = BASE_DIR . '/core_py/excel_cli.py';
    $cmd = 'cd ' . escapeshellarg(BASE_DIR)
         . ' && ' . _pythonBin() . ' ' . escapeshellarg($script)
         . ' ' . escapeshellarg($tmpIn) . ' ' . escapeshellarg($tmpOut)
         . ' ' . escapeshellarg($segment) . ' ' . escapeshellarg(http_build_query($qs)) . ' 2>&1';
    $err = shell_exec($cmd);
    @unlink($tmpIn);
    if (!file_exists($tmpOut) || filesize($tmpOut) === 0) {
        @unlink($tmpOut);
        throw new OpException(trim((string)$err) ?: 'Excel の生成に失敗しました', 500);
    }
    return $tmpOut;
}
/** ダウンロード時のファイル名 */
function opExportName(string $segment, array $body, array $qs): string {
    return [
        'journal'       => '仕訳帳.xlsx',
        'detail'        => ($body['title'] ?? '内訳') . '.xlsx',
        'kessan'        => ($qs['year'] ?? date('Y')) . '年度決算書.xlsx',
        'monthly'       => '月次仕訳日記帳_' . ($body['year'] ?? '') . '年度.xlsx',
        'billing_excel' => '請求シート.xlsx',
    ][$segment] ?? 'export.xlsx';
}
