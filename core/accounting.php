<?php
// ══════════════════════════════════════════════════════════════════════════════
// accounting.php — 会計ロジック（勘定科目、ルール、決算、元帳）
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';

// ── 会計年度の月 ──
// 会計年度の開始月（設定 → 基本設定。1〜12、既定 4 = 4月始まり）
function fyStartMonth(): int {
    $m = (int)(kvGet('settings', [])['fiscal_year_start'] ?? 4);
    return $m >= 1 && $m <= 12 ? $m : 4;
}
/** 会計年度の月の番号を年度の順に（4月始まりなら 4,5,…,12,1,2,3） */
function fyMonthNums(): array {
    $s = fyStartMonth();
    return array_map(fn($i) => (($s - 1 + $i) % 12) + 1, range(0, 11));
}
/** 会計年度の月の名前を年度の順に（「4月」…「3月」） */
function fyMonths(): array { return array_map(fn($n) => $n . '月', fyMonthNums()); }
/** 上半期・下半期の月 */
function fyHalf1(): array { return array_slice(fyMonths(), 0, 6); }
function fyHalf2(): array { return array_slice(fyMonths(), 6); }

function mnMap(): array {
    static $m = null;
    if ($m === null) {
        // PHPはarray_combine()で数値文字列キーを整数インデックスに変換するため
        // 直接ハードコードしてキーの型崩れを防ぐ
        $m = [
            '4'  => '4月',  '5'  => '5月',  '6'  => '6月',
            '7'  => '7月',  '8'  => '8月',  '9'  => '9月',
            '10' => '10月', '11' => '11月', '12' => '12月',
            '1'  => '1月',  '2'  => '2月',  '3'  => '3月',
        ];
    }
    return $m;
}
function mnMapRev(): array {
    static $r = null;
    if ($r === null) $r = array_flip(mnMap());
    return $r;
}

// ── 勘定科目タイプ ──
function getAccountType(string $name): ?string {
    static $cache = null, $loaded = false;
    if (!$loaded) {
        $cache = [];
        $accounts = kvGet('accounts', []);
        foreach (['assets','liabilities','equity','income','expense'] as $t) {
            foreach ($accounts[$t] ?? [] as $ac) $cache[$ac['name']] = $t;
        }
        $loaded = true;
    }
    return $cache[$name] ?? null;
}

// ── 初めて使うときの勘定科目 ──
// 小さな団体でよく使う科目をひととおり入れておく（勘定科目の画面で自由に変えられる）。
// 一度でも保存した（空にした場合も含む）ら、二度と入れ直さない。
function defaultAccounts(): array {
    $mk = function (string $prefix, array $names): array {
        $out = [];
        foreach (array_values($names) as $i => $n) $out[] = ['code' => (string)($prefix + $i), 'name' => $n, 'sub' => []];
        return $out;
    };
    return [
        'assets'      => $mk('100', ['現金', '普通預金', '立替金', '前払金', '未収金']),
        'liabilities' => $mk('200', ['未払金', '預り金', '前受金']),
        'equity'      => $mk('300', ['繰越金']),
        'income'      => $mk('400', ['会費収入', '入会金収入', 'イベント収入', '補助金収入', '寄付金収入', '雑収入', '受取利息']),
        'expense'     => $mk('500', ['交通費', '会場費', '備品費', '消耗品費', '印刷費', '通信費', '会議費', '支払手数料', '保険料', '雑費']),
    ];
}
function ensureDefaultAccounts(): void {
    if (kvGet('accounts', null) === null) kvSet('accounts', defaultAccounts());
}

// ── 別表（特定の勘定科目だけの収支表） ──
// 設定の sub_report_accounts に勘定科目名を並べると、決算書の下にその科目だけの収支表を付ける
// （例: イベント収入・イベント支出だけの「イベント収支表」）。空なら別表は出さない。
function subReportConfig(): ?array {
    $s = kvGet('settings', []);
    $names = $s['sub_report_accounts'] ?? [];
    if (is_string($names)) $names = preg_split('/[\r\n,、]+/u', $names);
    $names = array_values(array_unique(array_filter(array_map(fn($n) => trim((string)$n), (array)$names), 'strlen')));
    if (!$names) return null;
    $title = trim((string)($s['sub_report_title'] ?? '')) ?: '別表';
    return ['title' => $title, 'accounts' => $names];
}

// ── 摘要変数展開 ──
function resolveVars(string $tpl, string $dateStr, string $party, array $claim = []): string {
    if ($tpl === '') return $tpl;
    $dt = DateTime::createFromFormat('Y/m/d', $dateStr);
    if ($dt) {
        $month = (int)$dt->format('n');
        $year  = (int)$dt->format('Y');
        $tpl   = preg_replace_callback(
            '/\{\$(取引月|取引年)([+\-])?(\d+)?\}/u',
            function($m) use ($month, $year) {
                $isMonth = str_contains($m[1], '月');
                $op  = $m[2] ?? '';
                $num = isset($m[3]) ? (int)$m[3] : 0;
                $delta = $op === '+' ? $num : ($op === '-' ? -$num : 0);
                if ($isMonth) {
                    $v = $month + $delta;
                    return (string)((($v - 1) % 12 + 12) % 12 + 1);
                }
                return (string)($year + $delta);
            }, $tpl);
    }
    $tpl = str_replace('{$相手先}', $party, $tpl);
    $tpl = str_replace('{$苗字}',   mb_strstr($party, ' ', true) ?: $party, $tpl);
    // 利用日・行き先（交通費申請の情報から。{$勤務日}・{$勤務先} は以前の書き方で、同じ意味）
    if (!empty($claim)) {
        $workDate = $claim['work_date'] ?? '';
        $workDate = str_replace('-', '/', $workDate);
        $mdPart = '';
        if (preg_match('/\d{4}\/(\d{1,2})\/(\d{1,2})/', $workDate, $dm)) {
            $mdPart = (int)$dm[1] . '/' . (int)$dm[2];
        }
        $dest = trim($claim['work_destination'] ?? '');
        $tpl = str_replace(['{$利用日}', '{$勤務日}'], $mdPart, $tpl);
        $tpl = str_replace(['{$行き先}', '{$勤務先}'], $dest,   $tpl);
    } else {
        $tpl = str_replace(['{$利用日}', '{$勤務日}', '{$行き先}', '{$勤務先}'], '', $tpl);
    }
    return $tpl;
}

// ══════════════════════════════════════════════════════════════════════════════
// 申請の摘要生成
//   交通費 … 「M/D行き先交通費」
//   立替   … 申請画面の「メモ」をそのまま。メモが空なら用途
//            （用途が無ければ description から店名の括弧を除去。例:「薬品 (Amazon)」→「薬品」）
// ══════════════════════════════════════════════════════════════════════════════
function buildTransportMemoPhp(array $claim): string {
    $workDate = str_replace('-', '/', $claim['work_date'] ?? '');
    $mdPart = '';
    if (preg_match('/\d{4}\/(\d{1,2})\/(\d{1,2})/', $workDate, $dm)) {
        $mdPart = (int)$dm[1] . '/' . (int)$dm[2];
    }
    return trim($mdPart . trim($claim['work_destination'] ?? '') . '交通費');
}

function buildAdvanceMemo(array $claim): string {
    $memo = trim((string)($claim['memo'] ?? ''));
    if ($memo !== '') return $memo;
    $usage = trim((string)($claim['usage'] ?? ''));
    if ($usage !== '') return $usage;
    $desc = trim((string)($claim['description'] ?? ''));
    // 末尾の「 (店名)」を除去
    $desc = preg_replace('/\s*[（(][^（()]*[)）]\s*$/u', '', $desc);
    return trim($desc);
}

function buildClaimMemo(array $claim): string {
    return ($claim['type'] ?? '') === 'transport'
        ? buildTransportMemoPhp($claim)
        : buildAdvanceMemo($claim);
}

// ── 仕訳帳に表示する自動仕訳ラベル（自動ルール名と同じ書式）──
//    例: 「立替自動:安達 瑠南 ¥6,633」「交通費自動:佐藤 葉月 ¥898」
function claimAutoRuleLabel(array $claim): string {
    $kind = ($claim['type'] ?? '') === 'transport' ? '交通費自動' : '立替自動';
    return $kind . ':' . trim((string)($claim['applicant'] ?? ''))
         . ' ¥' . number_format((int)($claim['amount'] ?? 0));
}

// 申請由来のラベルとして上書きしてよいか（手動で付けたルール名は残す）
function isClaimAutoRuleLabel(string $label): bool {
    $label = trim($label);
    return $label === ''
        || str_starts_with($label, '申請自動仕訳')
        || str_starts_with($label, '立替自動:')
        || str_starts_with($label, '交通費自動:');
}

// ── メンバーマスタからカナを補完（申請にカナが未入力でも照合できるように）──
function lookupMemberKana(string $name): string {
    static $map = null;
    if ($map === null) {
        $map = [];
        foreach (kvGet('members', []) as $m) {
            $n = trim((string)($m['name'] ?? ''));
            if ($n !== '') $map[preg_replace('/[\s　]/u', '', $n)] = trim((string)($m['kana'] ?? ''));
        }
    }
    $key = preg_replace('/[\s　]/u', '', trim($name));
    return $map[$key] ?? '';
}

// 申請の照合に使うカナ（申請の person_kana → メンバーマスタ）
function claimMatchKana(array $claim): string {
    $k = trim((string)($claim['person_kana'] ?? ''));
    // 「ﾔﾏﾀﾞ 」のように姓だけの不完全なカナはマスタの値を優先する
    $master = lookupMemberKana((string)($claim['applicant'] ?? ''));
    if ($master !== '' && ($k === '' || (mb_strlen($k) < mb_strlen($master) && str_starts_with($master, $k)))) {
        return $master;
    }
    return $k;
}

// ── メンバーカナの一覧（家族名義判定用）──
function memberKanaSet(): array {
    static $set = null;
    if ($set === null) {
        $set = [];
        foreach (kvGet('members', []) as $m) {
            $k = preg_replace('/[\s　]/u', '', (string)($m['kana'] ?? ''));
            if ($k !== '') $set[mb_strtolower($k)] = true;
        }
    }
    return $set;
}

// 口座名義が家族名義（例: メンバー「山田 花子」への振込が「ﾔﾏﾀﾞ ﾀﾛｳ」名義）の場合に
// 姓だけで照合する。ただしその名義自体が別のメンバーと完全一致する場合は許可しない。
function _partyMatchesFamily(string $party, string $kana): bool {
    $p = preg_replace('/[\s　]/u', '', mb_strtolower($party));
    if ($p === '') return false;
    if (isset(memberKanaSet()[$p])) return false;   // 相手先自身がメンバー → 別人として扱う
    $parts = preg_split('/[\s　]+/u', trim($kana));
    $sur   = $parts[0] ?? '';
    if (mb_strlen($sur) < 2) return false;          // 1文字の姓は照合しない
    return str_contains($p, mb_strtolower($sur));
}

// ── 空文字も「未設定」として扱うフォールバック ──
function firstNonEmpty(...$vals): string {
    foreach ($vals as $v) { $v = trim((string)$v); if ($v !== '') return $v; }
    return '';
}

// ── 申請IDから申請情報を取得（resolveVars用） ──
function getClaimForRule(string $claimId): array {
    if (!$claimId) return [];
    static $cache = [];
    if (isset($cache[$claimId])) return $cache[$claimId];
    $db = new SQLite3(DB_CLAIMS);
    $db->busyTimeout(3000);
    $stmt = $db->prepare('SELECT * FROM claims WHERE id = :id LIMIT 1');
    $stmt->bindValue(':id', $claimId);
    $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    $db->close();
    return $cache[$claimId] = ($row ?: []);
}

// ── ルールの照合用に、カナの書き方の違いをそろえる ──
// 銀行の明細は小さいカナを大きく印字する（キャッシュカード →「ｷﾔﾂｼﾕｶｰﾄﾞ」）。ルールを「ｷｬｯｼｭｶｰﾄﾞ」や
// 全角の「キャッシュカード」で書いても一致するよう、照合の前に両方を半角・大きいカナにそろえる。
function ruleKanaFold(string $s): string {
    $s = mb_convert_kana($s, 'kh');   // 全角カタカナ・ひらがな → 半角カタカナ
    return strtr($s, ['ｧ' => 'ｱ', 'ｨ' => 'ｲ', 'ｩ' => 'ｳ', 'ｪ' => 'ｴ', 'ｫ' => 'ｵ',
                      'ｬ' => 'ﾔ', 'ｭ' => 'ﾕ', 'ｮ' => 'ﾖ', 'ｯ' => 'ﾂ']);
}

// ── ルールのパターンを preg 用の正規表現にする ──
// 区切り文字の「/」をそのまま書いたパターン（例: 「JR/東日本」）でも正規表現が壊れないよう、
// エスケープされていない「/」を「\/」にする。
function ruleRegex(string $pattern, string $flags = 'u'): string {
    return '/' . preg_replace('#(?<!\\\\)/#', '\\/', $pattern) . '/' . $flags;
}

// ── ルール適用 ──
function applyRulesToTx(array &$tx, array $rules): bool {
    usort($rules, fn($a,$b) => ($b['priority'] ?? 0) <=> ($a['priority'] ?? 0));
    foreach ($rules as $rule) {
        $pattern = $rule['pattern'] ?? '';
        if ($pattern !== '') {
            $pNs = ruleKanaFold(preg_replace('/[\s　]/u', '', $pattern));
            $tNs = ruleKanaFold(preg_replace('/[\s　]/u', '', $tx['party'] ?? ''));
            if (@preg_match(ruleRegex($pNs, 'u'), $tNs) !== 1) continue;
        }
        $txAmt = max(
            (int)($tx['debit']?? 0),(int)($tx['credit']?? 0),
            (int)($tx['bank_debit']?? 0),(int)($tx['bank_credit']?? 0)
        );
        $exact = $rule['exact_amount'] ?? '';
        if ($exact !== '' && $exact !== null && (int)$exact !== $txAmt) continue;
        $min = $rule['amount_min'] ?? null;
        $max = $rule['amount_max'] ?? null;
        if ($min !== null && $min !== '' && $txAmt < (float)$min) continue;
        if ($max !== null && $max !== '' && $txAmt > (float)$max) continue;

        // 申請情報を取得（{$利用日}/{$行き先} 解決用）
        $claimId   = $rule['claim_id'] ?? '';
        $claimData = $claimId ? getClaimForRule($claimId) : [];

        // ── 使い切りガード ──
        // 立替・交通費の自動ルールはカナ＋金額だけで一致するため、返金がすでに
        // 仕訳済みの申請のルールを残すと、後日の「同額の別の出金」にまで摘要・科目を
        // 付けてしまう。紐付け先の仕訳が確定している申請のルールは適用しない。
        if ($claimData) {
            $linkedTx = trim((string)($claimData['journal_tx_id'] ?? ''));
            if ($linkedTx !== '' && $linkedTx !== (string)($tx['id'] ?? '')) continue;
        }

        $entries = $rule['entries'] ?? [];
        if ($entries) {
            $tx['entries'] = [];
            foreach ($entries as $e) {
                $tx['entries'][] = [
                    'debit_account'  => $e['debit_account']  ?? '',
                    'debit_sub'      => $e['debit_sub']      ?? '',
                    'credit_account' => $e['credit_account'] ?? '',
                    'credit_sub'     => $e['credit_sub']     ?? '',
                    'amount'         => $e['amount']         ?? 0,
                    'memo'           => resolveVars($e['memo_template'] ?? '', $tx['date'] ?? '', $tx['party'] ?? '', $claimData),
                ];
            }
        } else {
            if (!empty($rule['debit_account']))  { $tx['debit_account']  = $rule['debit_account'];  $tx['debit_sub']  = $rule['debit_sub']  ?? ''; }
            if (!empty($rule['credit_account'])) { $tx['credit_account'] = $rule['credit_account']; $tx['credit_sub'] = $rule['credit_sub'] ?? ''; }
        }
        if (!empty($rule['memo_template']))
            $tx['memo'] = resolveVars($rule['memo_template'], $tx['date'] ?? '', $tx['party'] ?? '', $claimData);

        // 既存 entries 1 件への上書き
        if (!empty($tx['entries']) && count($tx['entries']) === 1) {
            if (!empty($rule['debit_account']))  { $tx['entries'][0]['debit_account']  = $rule['debit_account'];  $tx['entries'][0]['debit_sub']  = $rule['debit_sub']  ?? ''; }
            if (!empty($rule['credit_account'])) { $tx['entries'][0]['credit_account'] = $rule['credit_account']; $tx['entries'][0]['credit_sub'] = $rule['credit_sub'] ?? ''; }
            if (!empty($rule['memo_template']))    $tx['entries'][0]['memo'] = resolveVars($rule['memo_template'], $tx['date'] ?? '', $tx['party'] ?? '', $claimData);
        }

        $tx['registered'] = false;
        $tx['auto_rule']  = $rule['name'] ?? '';
        return true;
    }
    return false;
}

// ── 明細の元の摘要を残す ──
// クレジットカード明細の摘要（「利用日 加盟店」）はルールやAIアシスタントで目的入りの摘要に書き換わる。
// 書き換え前の文字を取引の entry_origins に残しておき、AIアシスタントが過去の似た明細を探すときに使う。
// （明細には固定の ID がないので番号で持ち、金額が一致するときだけ使う）
function rememberEntryOrigins(array &$tx, array $before): void {
    foreach ($tx['entries'] ?? [] as $ix => $e) {
        $old = $before[$ix] ?? null;
        if (!$old || (int)($old['amount'] ?? 0) !== (int)($e['amount'] ?? 0)) continue;
        if ((string)($old['memo'] ?? '') === (string)($e['memo'] ?? '') || (string)($old['memo'] ?? '') === '') continue;
        if (isset($tx['entry_origins'][$ix])) continue;   // いちばん最初の文字を残す
        $tx['entry_origins'][$ix] = ['memo' => (string)$old['memo'], 'amount' => (int)$e['amount']];
    }
}
/** 明細の元の摘要（残っていなければ今の摘要） */
function entryOriginMemo(array $tx, int $ix): string {
    $o = $tx['entry_origins'][$ix] ?? null;
    $e = $tx['entries'][$ix] ?? [];
    if (is_array($o) && (int)($o['amount'] ?? -1) === (int)($e['amount'] ?? -2)) return (string)$o['memo'];
    return (string)($e['memo'] ?? '');
}

// ── 未登録の取引に自動仕訳ルールを一括適用（更新した件数を返す）──
function applyRulesToUnregistered(): int {
    $txs   = getAllTransactions();
    $rules = kvGet('rules', []);
    $updated = 0;
    foreach ($txs as &$tx) {
        if (!empty($tx['registered'])) continue;
        if (!empty($tx['provisional'])) continue; // 仮登録は人が確認済みなので上書きしない
        if (applyRulesToTx($tx, $rules)) {
            if (empty($tx['entries'])) {
                $amt = max((int)($tx['debit']?? 0),(int)($tx['credit']?? 0),
                           (int)($tx['bank_debit']?? 0),(int)($tx['bank_credit']?? 0));
                if (!empty($tx['debit_account']) || !empty($tx['credit_account'])) {
                    $tx['entries'] = [[
                        'debit_account'  => $tx['debit_account']  ?? '',
                        'debit_sub'      => $tx['debit_sub']       ?? '',
                        'credit_account' => $tx['credit_account']  ?? '',
                        'credit_sub'     => $tx['credit_sub']      ?? '',
                        'amount'         => $amt,
                        'memo'           => $tx['memo']            ?? '',
                    ]];
                }
            }
            // 借方・貸方の両方が設定されていれば自動登録
            if (!empty($tx['entries'])) {
                $e = $tx['entries'][0] ?? [];
                if (!empty($e['debit_account']) && !empty($e['credit_account'])) {
                    $tx['registered'] = true;
                }
            }
            upsertTransaction($tx);
            $updated++;
        }
    }
    return $updated;
}

// ── 会計年度 ──
function fiscalYearOf(string $dateStr, int $fyStart = 4): ?int {
    $dt = DateTime::createFromFormat('Y/m/d', $dateStr);
    if (!$dt) return null;
    $m = (int)$dt->format('n'); $y = (int)$dt->format('Y');
    return $m >= $fyStart ? $y : $y - 1;
}
function monthKeyOf(string $dateStr): ?string {
    $dt = DateTime::createFromFormat('Y/m/d', $dateStr);
    if (!$dt) return null;
    return mnMap()[(string)(int)$dt->format('n')] ?? null;
}
function filterByFy(array $txs, string $year, int $fyStart = 4): array {
    return array_values(array_filter($txs,
        fn($t) => fiscalYearOf($t['date'] ?? '', $fyStart) === (int)$year));
}

// ── 決算書の公開月（閲覧専用ユーザーに見せる月）──
function getPublishedMonths(string $year): array {
    $all = kvGet('kessan_published', []);
    $m   = $all[$year] ?? [];
    return is_array($m) ? array_values(array_intersect(fyMonths(), $m)) : [];
}

function setPublishedMonths(string $year, array $months): array {
    $clean = array_values(array_intersect(fyMonths(), $months));
    $all   = kvGet('kessan_published', []);
    if ($clean) $all[$year] = $clean; else unset($all[$year]);
    kvSet('kessan_published', $all);
    return $clean;
}

/**
 * 閲覧専用ユーザーに見せてよい列（月＋集計列）を返す。
 * 上半期・下半期・年度合計は、その期間の月がすべて公開されている時だけ見せる
 * （一部だけ公開の状態で合計を出すと、未公開の月が逆算できてしまうため）。
 */
function visibleKessanCols(array $published): array {
    $cols = $published;
    if (!array_diff(fyHalf1(), $published)) $cols[] = '上半期';
    if (!array_diff(fyHalf2(), $published)) $cols[] = '下半期';
    if (!array_diff(fyMonths(), $published)) $cols[] = '年度合計';
    return $cols;
}

/** 月次配列から非公開の列を取り除く（再帰） */
function stripHiddenMonths(array $data, array $visible): array {
    foreach ($data as $k => $v) {
        if (!is_array($v)) continue;
        if (isset($v['年度合計']) || isset($v['4月'])) {
            // 月次データそのもの
            foreach ($v as $mk => $_) {
                if (!in_array($mk, $visible, true)) unset($v[$mk]);
            }
            $data[$k] = $v;
        } else {
            $data[$k] = stripHiddenMonths($v, $visible);
        }
    }
    return $data;
}

// ── 決算書計算 ──
function emptyM(): array {
    $d = array_fill_keys(fyMonths(), 0);
    $d['上半期'] = $d['下半期'] = $d['年度合計'] = 0;
    return $d;
}
function sumHalves(array &$d): void {
    $d['上半期']   = array_sum(array_map(fn($k)=>$d[$k], fyHalf1()));
    $d['下半期']   = array_sum(array_map(fn($k)=>$d[$k], fyHalf2()));
    $d['年度合計'] = $d['上半期'] + $d['下半期'];
}

/**
 * @param ?array $only 指定した勘定科目名だけで決算書を作る（例: 別表の科目）。
 *                     その場合、期首残高は 0 として収支の累計だけを出す。
 */
function calcKessan(array $txs, string $year, ?array $only = null): array {
    $accounts = kvGet('accounts', []);
    if ($only !== null) {
        foreach (['income', 'expense'] as $t) {
            $accounts[$t] = array_values(array_filter($accounts[$t] ?? [],
                fn($ac) => in_array($ac['name'] ?? '', $only, true)));
        }
    }
    $settings = kvGet('settings', []);
    $fyStart  = (int)($settings['fiscal_year_start'] ?? 4);
    $filtered = filterByFy($txs, $year, $fyStart);

    // 事前に取引の月キャッシュを作る（毎エントリで parse を避ける）
    $txMonths = [];
    foreach ($filtered as $i => $tx) {
        $txMonths[$i] = monthKeyOf($tx['date'] ?? '');
    }

    $buildSection = function(array $accts, string $acctType) use ($filtered, $txMonths): array {
        $secTot = emptyM();
        $groups = [];
        foreach ($accts as $acct) {
            $grp  = ['code'=>$acct['code'] ?? '', 'name'=>$acct['name'] ?? '',
                     'monthly'=>emptyM(), 'sub_total'=>emptyM(), 'sub'=>[]];
            $subs = $acct['sub'] ?? [];
            if ($subs) {
                foreach ($subs as $sub) {
                    $sd = ['code'=>$sub['code'] ?? '', 'name'=>$sub['name'] ?? '', 'monthly'=>emptyM()];
                    foreach ($filtered as $i => $tx) {
                        $mk = $txMonths[$i]; if (!$mk) continue;
                        foreach ($tx['entries'] ?? [] as $e) {
                            $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
                            if (($e['debit_account']?? '') === $acct['name'] && ($e['debit_sub']?? '') === $sub['name'])
                                $sd['monthly'][$mk] += $acctType === 'expense' ? $amt : -$amt;
                            if (($e['credit_account']?? '') === $acct['name'] && ($e['credit_sub']?? '') === $sub['name'])
                                $sd['monthly'][$mk] += $acctType === 'income' ? $amt : -$amt;
                        }
                    }
                    sumHalves($sd['monthly']);
                    $grp['sub'][] = $sd;
                    foreach ($sd['monthly'] as $k => $v) $grp['sub_total'][$k] += $v;
                }
                // 補助科目なし分
                foreach ($filtered as $i => $tx) {
                    $mk = $txMonths[$i]; if (!$mk) continue;
                    foreach ($tx['entries'] ?? [] as $e) {
                        $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
                        if (($e['debit_account']?? '')  === $acct['name'] && empty($e['debit_sub']))
                            $grp['sub_total'][$mk] += $acctType === 'expense' ? $amt : -$amt;
                        if (($e['credit_account']?? '') === $acct['name'] && empty($e['credit_sub']))
                            $grp['sub_total'][$mk] += $acctType === 'income' ? $amt : -$amt;
                    }
                }
                sumHalves($grp['sub_total']);
                $src = $grp['sub_total'];
            } else {
                foreach ($filtered as $i => $tx) {
                    $mk = $txMonths[$i]; if (!$mk) continue;
                    foreach ($tx['entries'] ?? [] as $e) {
                        $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
                        if (($e['debit_account']?? '')  === $acct['name'])
                            $grp['monthly'][$mk] += $acctType === 'expense' ? $amt : -$amt;
                        if (($e['credit_account']?? '') === $acct['name'])
                            $grp['monthly'][$mk] += $acctType === 'income' ? $amt : -$amt;
                    }
                }
                sumHalves($grp['monthly']);
                $src = $grp['monthly'];
            }
            foreach ($secTot as $k => $_) $secTot[$k] += $src[$k];
            $groups[] = $grp;
        }
        return [$groups, $secTot];
    };

    [$incG, $incT] = $buildSection($accounts['income']  ?? [], 'income');
    [$expG, $expT] = $buildSection($accounts['expense'] ?? [], 'expense');

    $net = [];
    foreach ($incT as $k => $v) $net[$k] = $v - ($expT[$k] ?? 0);

    if ($only !== null) {
        // 別表: 期首残高は 0 として、収支の累計だけを出す
        $obVal = 0;
        $breakdown = [];
        $running = 0;
        $mb = [];
        foreach (fyMonths() as $mk) { $running += $net[$mk] ?? 0; $mb[$mk] = $running; }
        $mb['上半期']   = $net['上半期'] ?? 0;
        $mb['下半期']   = $mb['年度合計'] = $net['年度合計'] ?? 0;
    } else {
        // 期末残高は資産科目（立替金を除く）の月末残高の合計。内訳も一緒に返す
        $breakdown = calcBalanceBreakdown($filtered, $txMonths, (string)$year, $accounts, $settings);
        $obVal = array_sum(array_column($breakdown, 'opening'));
        $mb = emptyM();
        foreach ($breakdown as $row) foreach ($row['monthly'] as $k => $v) $mb[$k] += $v;
    }

    return [
        'sections'        => [
            ['name'=>'収入の部','groups'=>$incG,'total'=>$incT],
            ['name'=>'支出の部','groups'=>$expG,'total'=>$expT],
        ],
        'net'             => $net,
        'opening_balance' => $obVal,
        'monthly_balance' => $mb,
        'balance_breakdown' => $breakdown,
    ];
}

/**
 * 期末残高に入れない資産科目。立替金は団体のお金ではなく、精算を待っている立替なので除く
 * （申請の設定で立替の借方を別の資産科目にしている場合はその科目も）。
 */
function balanceExcludedAccounts(?array $settings = null): array {
    $settings ??= kvGet('settings', []);
    $out = ['立替金'];
    $adv = trim((string)($settings['advance_debit'] ?? ''));
    if ($adv !== '' && !in_array($adv, $out, true)) $out[] = $adv;
    return $out;
}

/** 期首残高の設定を「科目」「科目/補助」→金額 にそろえる（旧形式の数値は普通預金） */
function openingBalanceMap(array $settings, string $year): array {
    $raw = $settings['opening_balances'][$year] ?? 0;
    if (!is_array($raw)) return $raw ? ['普通預金' => (int)$raw] : [];
    $out = [];
    foreach ($raw as $k => $v) {
        $k = preg_replace('#\s*/\s*#u', '/', trim((string)$k));
        $out[$k] = ($out[$k] ?? 0) + (int)$v;
    }
    return $out;
}

/**
 * 決算書の期末残高の内訳。資産科目（立替金を除く）ごとの各月末残高。
 * 補助科目がある科目は補助科目ごとに分ける（例: 普通預金 → 三井住友・みずほ）。
 * 現金・預金の科目は 0 でも出し、それ以外（前払金など）は残高があるときだけ出す。
 * @return array<int, array{account:string, sub:?string, name:string, opening:int, monthly:array}>
 */
function calcBalanceBreakdown(array $filtered, array $txMonths, string $year, array $accounts, array $settings): array {
    $excluded = balanceExcludedAccounts($settings);
    $obMap    = openingBalanceMap($settings, $year);
    $months   = fyMonths();
    $toBal = function (int $ob, array $delta) use ($months): array {
        $bal = []; $run = $ob;
        foreach ($months as $mk) { $run += $delta[$mk] ?? 0; $bal[$mk] = $run; }
        $bal['上半期']   = $bal[$months[5]];
        $bal['下半期']   = $bal[$months[11]];
        $bal['年度合計'] = $bal[$months[11]];
        return $bal;
    };

    $rows = [];
    foreach ($accounts['assets'] ?? [] as $ac) {
        $name = (string)($ac['name'] ?? '');
        if ($name === '' || in_array($name, $excluded, true)) continue;
        $subs = array_values(array_filter(array_map(fn($s) => (string)($s['name'] ?? ''), $ac['sub'] ?? []), 'strlen'));

        // 補助科目ごとの増減（一覧にない補助科目・補助なしは「補助科目なし」へ）
        $delta = ['' => array_fill_keys($months, 0)];
        foreach ($subs as $sn) $delta[$sn] = array_fill_keys($months, 0);
        foreach ($filtered as $i => $tx) {
            $mk = $txMonths[$i] ?? null; if (!$mk) continue;
            foreach ($tx['entries'] ?? [] as $e) {
                $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
                if (($e['debit_account'] ?? '') === $name) {
                    $sk = in_array((string)($e['debit_sub'] ?? ''), $subs, true) ? (string)$e['debit_sub'] : '';
                    $delta[$sk][$mk] += $amt;
                }
                if (($e['credit_account'] ?? '') === $name) {
                    $sk = in_array((string)($e['credit_sub'] ?? ''), $subs, true) ? (string)$e['credit_sub'] : '';
                    $delta[$sk][$mk] -= $amt;
                }
            }
        }
        $ob = ['' => 0];
        foreach ($subs as $sn) $ob[$sn] = 0;
        foreach ($obMap as $k => $v) {
            if ($k === $name) { $ob[''] += $v; continue; }
            if (!str_starts_with($k, $name . '/')) continue;
            $sn = substr($k, strlen($name) + 1);
            $ob[in_array($sn, $subs, true) ? $sn : ''] += $v;
        }

        $isCash = (bool)preg_match('/現金|預金/u', $name);
        $keys = $subs ? array_merge($subs, ['']) : [''];
        foreach ($keys as $sk) {
            $bal = $toBal($ob[$sk], $delta[$sk]);
            $nonzero = $ob[$sk] !== 0 || array_filter($delta[$sk]);
            // 補助科目がある科目の「補助なし」分は、動きがあるときだけ出す
            if ($subs && $sk === '' && !$nonzero) continue;
            if (!$isCash && !$nonzero) continue;
            $rows[] = [
                'account' => $name,
                'sub'     => $sk === '' ? null : $sk,
                'name'    => $sk !== '' ? $sk : ($subs ? $name . '（補助科目なし）' : $name),
                'opening' => $ob[$sk],
                'monthly' => $bal,
            ];
        }
    }
    return $rows;
}

/**
 * 資産科目の各月末残高（期首残高 + 借方 − 貸方）。キーは calcKessan の monthly_balance と同じ。
 * 期首残高は settings.opening_balances[年度] の「科目」「科目/補助」の合計。
 */
function calcAccountMonthEndBalance(array $txs, string $year, string $account): array {
    $settings = kvGet('settings', []);
    $fyStart  = (int)($settings['fiscal_year_start'] ?? 4);
    $ob = 0;
    $obRaw = $settings['opening_balances'][$year] ?? [];
    if (is_array($obRaw)) {
        foreach ($obRaw as $k => $v) {
            $k = preg_replace('#\s*/\s*#', '/', (string)$k);
            if ($k === $account || str_starts_with($k, $account . '/')) $ob += (int)$v;
        }
    }
    $delta = array_fill_keys(fyMonths(), 0);
    foreach (filterByFy($txs, $year, $fyStart) as $tx) {
        $mk = monthKeyOf($tx['date'] ?? ''); if (!$mk) continue;
        foreach ($tx['entries'] ?? [] as $e) {
            $amt = (int)($e['amount'] ?? 0);
            if (($e['debit_account'] ?? '')  === $account) $delta[$mk] += $amt;
            if (($e['credit_account'] ?? '') === $account) $delta[$mk] -= $amt;
        }
    }
    $bal = []; $run = $ob;
    foreach (fyMonths() as $mk) { $run += $delta[$mk]; $bal[$mk] = $run; }
    $last = fyMonths()[11];
    $bal['上半期']   = $bal[fyHalf1()[5]];
    $bal['下半期']   = $bal[$last];
    $bal['年度合計'] = $bal[$last];
    return $bal;
}

// ── 元帳サマリー ──
function buildAccountLedgerSummary(array $txs): array {
    $summary = [];
    foreach ($txs as $tx) {
        $memoTx = $tx['memo'] ?? '';
        $party  = $tx['party'] ?? '';
        $date   = $tx['date']  ?? '';
        foreach ($tx['entries'] ?? [] as $e) {
            $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
            $da = $e['debit_account']  ?? '';
            $ca = $e['credit_account'] ?? '';
            $memo = $e['memo'] ?: $memoTx;
            if ($da !== '') {
                if (!isset($summary[$da])) $summary[$da] = ['debit_total'=>0,'credit_total'=>0,'entries'=>[]];
                $summary[$da]['debit_total'] += $amt;
                $summary[$da]['entries'][] = ['date'=>$date,'party'=>$party,'counter_account'=>$ca,'debit'=>$amt,'credit'=>0,'memo'=>$memo];
            }
            if ($ca !== '') {
                if (!isset($summary[$ca])) $summary[$ca] = ['debit_total'=>0,'credit_total'=>0,'entries'=>[]];
                $summary[$ca]['credit_total'] += $amt;
                $summary[$ca]['entries'][] = ['date'=>$date,'party'=>$party,'counter_account'=>$da,'debit'=>0,'credit'=>$amt,'memo'=>$memo];
            }
        }
    }
    return $summary;
}

// ── カナ照合（振込確認チェック用）──
/**
 * 振込名義とメンバーカナを比べられる形にそろえる。
 *   半角カナ→全角・ひらがな→カタカナ・英数→半角・大文字化、
 *   小書き文字（ｯｬｭｮｧ…）→大きい文字（銀行の振込名義は小書き文字を持たないため）、
 *   空白・長音・中黒・括弧などの記号を除去。
 */
function normKana(string $s): string {
    static $small = ['ァ'=>'ア','ィ'=>'イ','ゥ'=>'ウ','ェ'=>'エ','ォ'=>'オ','ッ'=>'ツ',
                     'ャ'=>'ヤ','ュ'=>'ユ','ョ'=>'ヨ','ヮ'=>'ワ','ヵ'=>'カ','ヶ'=>'ケ'];
    $s = mb_convert_kana($s, 'KVCas', 'UTF-8');
    $s = strtr($s, $small);
    $s = preg_replace('/[\s　ー\-‐―−・.,()（）]+/u', '', $s) ?? '';
    return mb_strtoupper($s, 'UTF-8');
}

/**
 * 振込名義がメンバーのカナに一致するか。
 *   2 = 名義にメンバーカナがまるごと含まれる（強い一致）
 *   1 = 名義がメンバーカナの先頭部分（姓だけで振り込んだ等。2文字以上）
 *   0 = 一致しない
 * ★以前は「メンバーカナの途中に名義が含まれる」でも一致扱いにしていた（ｶﾄｳ が ｻｶﾄｳ に当たる）。
 */
function billingKanaScore(string $party, string $kana): int {
    $p = normKana($party);
    $k = normKana($kana);
    if ($p === '' || $k === '') return 0;
    if (str_contains($p, $k)) return 2;
    if (mb_strlen($p) >= 2 && str_starts_with($k, $p)) return 1;
    return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF アップロード後の申請自動マッチング（Python → PHP に移行）
// ══════════════════════════════════════════════════════════════════════════════
function matchPendingClaimsToTransactions(array $newTxIds = []): int {
    $claims = getAllClaims();
    $pending = array_filter($claims, fn($c) =>
        ($c['status'] ?? '') === 'paid'
        && !empty($c['pending_match'])
        && empty($c['journaled']));
    if (!$pending) return 0;

    $allTxs = getAllTransactions();
    $txMap  = [];
    $usedTx = [];   // 同一取引を複数申請で使い回さないための予約表
    foreach ($allTxs as $t) {
        $txMap[$t['id']] = $t;
        if (!empty($t['claim_id'])) $usedTx[$t['id']] = true;
    }

    // paid_date + created_at 順で処理（同日同額の安定性）
    usort($pending, fn($a,$b) =>
        ($a['paid_date'] ?? '') <=> ($b['paid_date'] ?? '')
        ?: ($a['created_at'] ?? '') <=> ($b['created_at'] ?? ''));

    $matched = 0;
    foreach ($pending as $claim) {
        $amount    = (int)($claim['amount'] ?? 0);
        $paidDate  = $claim['paid_date'] ?? '';
        if (!$amount || !$paidDate) continue;
        $d = DateTime::createFromFormat('Y/m/d', str_replace('-','/', $paidDate));
        if (!$d) continue;
        $rs = (clone $d)->modify('-3 days')->format('Y/m/d');
        $re = (clone $d)->modify('+3 days')->format('Y/m/d');

        $kana      = claimMatchKana($claim);
        $applicant = $claim['applicant']   ?? '';
        $isTransport = ($claim['type'] ?? '') === 'transport';

        // 1段目: 氏名・カナが一致する取引。2段目: 家族名義（姓のみ一致）の取引。
        $candidates = [];
        $loose      = [];
        foreach ($txMap as $tx) {
            // 自動仕訳ルールで既に「登録済み」になった取引も、他の申請に紐付いて
            // いなければ対象にする（紐付けのみ行い、科目・摘要は下で補完）
            if (!empty($usedTx[$tx['id']])) continue;
            $txDate = str_replace('-', '/', $tx['date'] ?? '');
            if ($txDate < $rs || $txDate > $re) continue;
            $txAmt = abs((int)(($tx['entries'][0]['amount'] ?? $tx['amount'] ?? 0)));
            if ($txAmt !== $amount) continue;
            if (_partyMatches($tx['party'] ?? '', $kana, $applicant)) { $candidates[] = $tx; continue; }
            if (_partyMatchesFamily($tx['party'] ?? '', $kana)) { $loose[] = $tx; }
        }
        if (!$candidates) $candidates = $loose;
        if (!$candidates) continue;

        // 未登録 → paid_date に近い順（自動ルール登録済みより未登録を優先）
        usort($candidates, function($a, $b) use ($d) {
            $ra = empty($a['registered']) ? 0 : 1;
            $rb = empty($b['registered']) ? 0 : 1;
            if ($ra !== $rb) return $ra <=> $rb;
            $da = DateTime::createFromFormat('Y/m/d', str_replace('-','/', $a['date'] ?? ''));
            $db = DateTime::createFromFormat('Y/m/d', str_replace('-','/', $b['date'] ?? ''));
            return abs((int)($da ? $da->diff($d)->days : 999))
                <=> abs((int)($db ? $db->diff($d)->days : 999));
        });
        $tx = $candidates[0];

        // 科目は申請側で選んだもの（空文字は未設定として扱う）
        $debitAc   = firstNonEmpty($claim['fallback_debit'] ?? '',  $isTransport ? '交通費' : '立替金');
        $debitSub  = (string)($claim['fallback_debit_sub'] ?? '');
        $creditAc  = firstNonEmpty($claim['fallback_credit'] ?? '', '普通預金');
        $creditSub = (string)($claim['fallback_credit_sub'] ?? '');
        $defMemo   = buildClaimMemo($claim);

        $entries = $tx['entries'] ?? [];
        if (!$entries) $entries = [[
            'debit_account'=>'','debit_sub'=>'','credit_account'=>'','credit_sub'=>'',
            'amount'=>$amount,'memo'=>''
        ]];
        if (empty($entries[0]['debit_account'])) {
            $entries[0]['debit_account'] = $debitAc;
            $entries[0]['debit_sub']     = $debitSub;
        }
        if (empty($entries[0]['credit_account'])) {
            $entries[0]['credit_account'] = $creditAc;
            $entries[0]['credit_sub']     = $creditSub;
        }
        if (!(int)($entries[0]['amount'] ?? 0)) $entries[0]['amount'] = $amount;
        // 摘要: 立替は申請メモを正とするため常に上書き。交通費は空欄のみ補完。
        if ($defMemo !== '' && (!$isTransport || empty($tx['memo']))) {
            $tx['memo']         = $defMemo;
            $entries[0]['memo'] = $defMemo;
        }
        $tx['entries']    = $entries;
        $tx['registered'] = true;
        $tx['claim_id']   = $claim['id'];
        if (isClaimAutoRuleLabel((string)($tx['auto_rule'] ?? ''))) {
            $tx['auto_rule'] = claimAutoRuleLabel($claim);
        }
        // 申請側の領収書を仕訳に引き継ぐ
        if (empty($tx['receipt_file']) && !empty($claim['receipt_file'])) {
            $tx['receipt_file'] = $claim['receipt_file'];
        }

        upsertTransaction($tx);
        $txMap[$tx['id']]  = $tx;
        $usedTx[$tx['id']] = true;

        $claim['pending_match'] = false;
        $claim['journaled']     = true;
        $claim['journal_tx_id'] = $tx['id'];
        upsertClaim($claim);

        $matched++;
    }
    return $matched;
}

function _partyMatches(string $party, string $kana, string $applicant): bool {
    $p = preg_replace('/[\s　]/u', '', mb_strtolower($party));
    $k = preg_replace('/[\s　]/u', '', mb_strtolower($kana));
    $n = preg_replace('/[\s　]/u', '', mb_strtolower($applicant));
    return ($k !== '' && str_contains($p, $k)) || ($n !== '' && str_contains($p, $n));
}

// ══════════════════════════════════════════════════════════════════════════════
// 期間リセット用ユーティリティ
// ══════════════════════════════════════════════════════════════════════════════

// 日付を "YYYY/MM/DD" に正規化（不正な値は空文字）
function normDate(string $d): string {
    $d = trim(str_replace('-', '/', $d));
    if (!preg_match('#^(\d{4})/(\d{1,2})/(\d{1,2})$#', $d, $m)) return '';
    return sprintf('%04d/%02d/%02d', (int)$m[1], (int)$m[2], (int)$m[3]);
}

// 仕訳の取込元を判定（pdf: 銀行明細PDF / credit_csv: クレカ明細CSV / manual: 手動追加）
function txSourceKind(array $tx): string {
    $sf = trim((string)($tx['source_file'] ?? ''));
    if ($sf === '' || $sf === '手動入力') return 'manual';
    if (preg_match('/\.pdf$/i', $sf))     return 'pdf';
    if (preg_match('/\.csv$/i', $sf))     return 'credit_csv';
    return 'manual';
}

/** 決算書のセル（科目・補助科目 × 月／半期／年度合計）の内訳となる明細 */
function kessanDetailRows(string $name, string $sub, string $month, string $year): array {
    $sts     = kvGet('settings', []);
    $fyStart = (int)($sts['fiscal_year_start'] ?? 4);
    $txs     = getTransactionsByFy($year, $fyStart, true);

    $mnRev = mnMapRev();
    if ($month === '上半期')       $pm = array_map('strval', array_slice(fyMonthNums(), 0, 6));
    elseif ($month === '下半期')   $pm = array_map('strval', array_slice(fyMonthNums(), 6));
    elseif ($month === '年度合計') $pm = array_map('strval', range(1,12));
    else                            $pm = [(string)($mnRev[$month] ?? '')];
    $pm = array_filter($pm);

    $result = [];
    foreach ($txs as $tx) {
        $dt = DateTime::createFromFormat('Y/m/d', $tx['date'] ?? '');
        if (!$dt || !in_array((string)(int)$dt->format('n'), $pm, true)) continue;
        foreach ($tx['entries'] ?? [] as $e) {
            $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
            $drMatch = ($e['debit_account']  ?? '') === $name;
            $crMatch = ($e['credit_account'] ?? '') === $name;
            if (!$drMatch && !$crMatch) continue;
            if ($sub !== '') {
                if ($drMatch && ($e['debit_sub']  ?? '') !== $sub) continue;
                if ($crMatch && ($e['credit_sub'] ?? '') !== $sub) continue;
            }
            $result[] = [
                'date'       => $tx['date'],
                'party'      => $tx['party']    ?? '',
                'counter'    => $drMatch ? ($e['credit_account'] ?? '') : ($e['debit_account'] ?? ''),
                'debit_amt'  => $drMatch ? $amt : 0,
                'credit_amt' => $crMatch ? $amt : 0,
                'memo'       => $e['memo'] ?: ($tx['memo'] ?? ''),
            ];
        }
    }
    return $result;
}
