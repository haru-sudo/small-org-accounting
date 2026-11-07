<?php
// ══════════════════════════════════════════════════════════════════════════════
// ai_approval.php — AIアシスタントの承認画面に出す「何が・どう変わるか」
//   変更系のツールごとに、対象（どの取引・どのルールか）と、項目ごとの「変更前 → 変更後」を作る。
//   文章を並べるのではなく、変わる項目だけを出す。
//
//   返す形: [
//     'summary' => 'カード明細 3 件を仕訳',          // 1行の見出し
//     'warn'    => '登録済みの取引 1 件を変更します…', // 気をつけてほしいとき（無ければ省略）
//     'rows'    => [[                                // 対象ごとの変更
//         'target'  => '2025/05/12 ｶ)ﾏﾙﾏﾙｼｮｳｼﾞ ¥3,000',
//         'tag'     => '登録済み',                      // 省略可
//         'changes' => [['k' => '借方', 'from' => '', 'to' => '飼料費'], …],   // from が null は「新しく作る」
//         'note'    => '過去の 5/3 の仕訳と同じ',        // AIアシスタントの理由（省略可）
//     ], …],
//     'lines'   => ['…'],                             // 上の形にしにくい補足（省略可）
//   ]
//   承認待ちのあいだは毎回作り直し、承認・却下・実行のときの内容は会話に保存して、あとから見ても
//   「変更前」が残るようにする（aiRememberAction）。
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/accounting.php';

const AI_STATUS_LABEL = ['unregistered' => '未登録', 'provisional' => '仮登録', 'registered' => '登録済み'];

/** 「科目（補助科目）」 */
function aiAcText(?string $ac, ?string $sub = ''): string {
    $ac = (string)$ac; $sub = (string)$sub;
    return $ac === '' ? '' : $ac . ($sub !== '' ? '（' . $sub . '）' : '');
}
function aiYen($v): string { return '¥' . number_format((int)$v); }

/** 1項目の変更。変わらないなら null（出さない）。$from が null なら新しく作る項目 */
function aiChg(string $k, $from, $to): ?array {
    $to = is_array($to) ? implode("\n", $to) : (string)$to;
    if ($from !== null) {
        $from = is_array($from) ? implode("\n", $from) : (string)$from;
        if ($from === $to) return null;
    } elseif ($to === '') {
        return null;
    }
    return ['k' => $k, 'from' => $from, 'to' => $to];
}
function aiRow(string $target, array $changes, ?string $note = null, ?string $tag = null): array {
    $r = ['target' => $target, 'changes' => array_values(array_filter($changes))];
    if ($note !== null && trim($note) !== '') $r['note'] = trim($note);
    if ($tag !== null && $tag !== '') $r['tag'] = $tag;
    return $r;
}
/** 仕訳明細1行の短い文字（複数行の仕訳を比べるとき用） */
function aiEntryLine(array $e): string {
    return aiAcText($e['debit_account'] ?? '', $e['debit_sub'] ?? '') . ' / ' . aiAcText($e['credit_account'] ?? '', $e['credit_sub'] ?? '')
        . ' ' . aiYen($e['amount'] ?? 0) . (trim((string)($e['memo'] ?? '')) !== '' ? '　' . trim((string)$e['memo']) : '');
}
/** 仕訳の前後を、変わった項目だけにする。1行どうしなら項目ごと、複数行なら行ごと */
function aiEntryDiff(array $old, array $new): array {
    if (count($old) <= 1 && count($new) === 1) {
        $o = $old[0] ?? []; $n = $new[0];
        $out = [
            aiChg('借方', aiAcText($o['debit_account'] ?? '', $o['debit_sub'] ?? ''), aiAcText($n['debit_account'] ?? '', $n['debit_sub'] ?? '')),
            aiChg('貸方', aiAcText($o['credit_account'] ?? '', $o['credit_sub'] ?? ''), aiAcText($n['credit_account'] ?? '', $n['credit_sub'] ?? '')),
        ];
        if ((int)($o['amount'] ?? 0) && (int)($n['amount'] ?? 0)) $out[] = aiChg('金額', aiYen($o['amount']), aiYen($n['amount']));
        $out[] = aiChg('摘要', trim((string)($o['memo'] ?? '')), trim((string)($n['memo'] ?? '')));
        return array_values(array_filter($out));
    }
    return array_values(array_filter([aiChg('仕訳', array_map('aiEntryLine', $old), array_map('aiEntryLine', $new))]));
}
function aiTxTarget(?array $tx): string {
    if (!$tx) return '（見つからない取引）';
    $amt = max(aiTxInOut($tx));
    return trim(($tx['date'] ?? '') . ' ' . ($tx['party'] ?? '')) . ($amt ? ' ' . aiYen($amt) : '');
}
function aiTxTag(?array $tx): ?string {
    return $tx && !empty($tx['registered']) ? '登録済み' : null;
}
/** 1つの承認カードに出す行の数が多いとき、画面は先頭だけ出して残りを畳む（ここでは全部返す） */

// ══════════════════════════════════════════════════════════════════════════════
// 登録済みの取引に触るか（「確認なしで実行」でも承認を求め、承認画面で警告する）
// ══════════════════════════════════════════════════════════════════════════════
/** この操作で変わる登録済みの取引の数（触らなければ 0） */
function aiRegisteredTouched(string $name, array $in): int {
    $ids = [];
    switch ($name) {
        case 'classify_transactions': foreach ((array)($in['items'] ?? []) as $it) $ids[] = (string)($it['id'] ?? ''); break;
        case 'classify_entries':      foreach ((array)($in['items'] ?? []) as $it) $ids[] = (string)($it['tx_id'] ?? ''); break;
        case 'update_transaction':
        case 'delete_transaction':    $ids[] = (string)($in['id'] ?? ''); break;
        case 'reset_period':
            try { return (int)(opResetPeriod(aiAppResetBody($in) + ['dry_run' => true])['registered'] ?? 0); }
            catch (Throwable $e) { return 0; }
        default: return 0;
    }
    $n = 0;
    foreach (array_unique(array_filter($ids)) as $id) {
        $tx = getTransactionById($id);
        if ($tx && !empty($tx['registered'])) $n++;
    }
    return $n;
}

// ══════════════════════════════════════════════════════════════════════════════
// 承認したときの内容を会話に残す（実行後に作り直すと「変更前」が今の値になってしまうため）
// ══════════════════════════════════════════════════════════════════════════════
function aiRememberAction(array &$conv, array $use): void {
    if (!aiIsWriteTool((string)$use['name'])) return;
    try {
        $conv['actions'][$use['id']] = aiDescribeAction((string)$use['name'], is_array($use['input'] ?? null) ? $use['input'] : [], 'waiting');
    } catch (Throwable $e) {
        error_log('small-org-accounting ai describe ' . $use['name'] . ': ' . $e->getMessage());
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// 仕訳・自動仕訳ルール（ai_chat.php のツール）の説明
// ══════════════════════════════════════════════════════════════════════════════
function aiDescribeCore(string $name, array $in, string $state): ?array {
    switch ($name) {
        case 'classify_transactions': {
            $mark = ($in['mark'] ?? 'provisional') === 'registered' ? 'registered' : 'provisional';
            $rows = []; $reg = 0;
            foreach ((array)($in['items'] ?? []) as $item) {
                $tx = getTransactionById((string)($item['id'] ?? ''));
                $isReg = $tx && !empty($tx['registered']);
                if ($isReg) $reg++;
                $ch = aiEntryDiff($tx['entries'] ?? [], array_map(fn($e) => (array)$e, (array)($item['entries'] ?? [])));
                if ($tx && !$isReg) $ch[] = aiChg('状態', AI_STATUS_LABEL[aiTxStatus($tx)], AI_STATUS_LABEL[$mark]);
                $rows[] = aiRow(aiTxTarget($tx), $ch, $item['reason'] ?? null, aiTxTag($tx));
            }
            $out = ['summary' => count($rows) . ' 件の取引を仕訳' . ($reg < count($rows) ? '（' . AI_STATUS_LABEL[$mark] . 'にする）' : ''), 'rows' => $rows];
            if ($reg) $out['warn'] = "登録済みの取引 {$reg} 件の仕訳を変えます。決算書の数字が変わります。";
            return $out;
        }
        case 'classify_entries': {
            $mark = ($in['mark'] ?? 'provisional') === 'registered' ? 'registered' : 'provisional';
            $rows = []; $txs = []; $reg = [];
            foreach ((array)($in['items'] ?? []) as $item) {
                $tid = (string)($item['tx_id'] ?? '');
                $tx = $txs[$tid] ??= getTransactionById($tid);
                if ($tx && !empty($tx['registered'])) $reg[$tid] = true;
                $ix = (int)($item['entry_index'] ?? -1);
                $e = $tx['entries'][$ix] ?? null;
                $target = $e ? trim(entryOriginMemo($tx, $ix)) . ' ' . aiYen($e['amount'] ?? 0) : '（見つからない明細）';
                $ch = [aiChg('借方', aiAcText($e['debit_account'] ?? '', $e['debit_sub'] ?? ''), aiAcText($item['debit_account'] ?? '', $item['debit_sub'] ?? ''))];
                if (!empty($item['credit_account'])) $ch[] = aiChg('貸方', aiAcText($e['credit_account'] ?? '', $e['credit_sub'] ?? ''), aiAcText($item['credit_account'], $item['credit_sub'] ?? ''));
                if (isset($item['memo']) && trim((string)$item['memo']) !== '') $ch[] = aiChg('摘要', trim((string)($e['memo'] ?? '')), trim((string)$item['memo']));
                $rows[] = aiRow($target, $ch, $item['reason'] ?? null, aiTxTag($tx));
            }
            $where = array_map(fn($t) => aiTxTarget($t), array_filter($txs));
            $out = ['summary' => count($rows) . ' 件の明細を仕訳' . ($where ? '（' . implode('、', $where) . '）' : ''), 'rows' => $rows];
            if (!$reg) $out['lines'] = ['全明細の科目がそろった取引は「' . AI_STATUS_LABEL[$mark] . '」になる'];
            else $out['warn'] = '登録済みの取引の明細を変えます。決算書の数字が変わります。';
            return $out;
        }
        case 'save_rule': {
            $old = null;
            foreach (kvGet('rules', []) as $r) if (($r['name'] ?? '') === ($in['name'] ?? '')) { $old = $r; break; }
            $cond = function(array $r): string {
                $c = [];
                if (isset($r['exact_amount']) && $r['exact_amount'] !== '') $c[] = '金額 ' . aiYen($r['exact_amount']);
                if (isset($r['amount_min']) && $r['amount_min'] !== '') $c[] = aiYen($r['amount_min']) . ' 以上';
                if (isset($r['amount_max']) && $r['amount_max'] !== '') $c[] = aiYen($r['amount_max']) . ' 以下';
                return $c ? implode('・', $c) : 'なし';
            };
            $f = fn($k) => $old === null ? null : $k;
            $ch = [
                aiChg('相手先', $f((string)($old['pattern'] ?? '')), (string)($in['pattern'] ?? '')),
                aiChg('金額の条件', $old === null ? null : $cond($old), $cond($in)),
                aiChg('借方', $f(aiAcText($old['debit_account'] ?? '', $old['debit_sub'] ?? '')), aiAcText($in['debit_account'] ?? '', $in['debit_sub'] ?? '')),
                aiChg('貸方', $f(aiAcText($old['credit_account'] ?? '', $old['credit_sub'] ?? '')), aiAcText($in['credit_account'] ?? '', $in['credit_sub'] ?? '')),
                aiChg('摘要', $f((string)($old['memo_template'] ?? '')), (string)($in['memo_template'] ?? '')),
            ];
            if ($old === null && ($in['position'] ?? 'top') === 'bottom') $ch[] = aiChg('優先度', null, 'いちばん最後');
            return ['summary' => '自動仕訳ルール「' . ($in['name'] ?? '') . '」を' . ($old ? '変更' : '追加'),
                    'rows' => [aiRow($old ? '今のルール' : '新しいルール', $ch)]];
        }
        case 'delete_rule': {
            $old = null;
            foreach (kvGet('rules', []) as $r) if (($r['name'] ?? '') === ($in['name'] ?? '')) { $old = $r; break; }
            return ['summary' => '自動仕訳ルール「' . ($in['name'] ?? '') . '」を削除',
                    'rows' => $old ? [aiRow('相手先 ' . ($old['pattern'] ?? '') . ' → ' . aiAcText($old['debit_account'] ?? '', $old['debit_sub'] ?? '') . ' / ' . aiAcText($old['credit_account'] ?? '', $old['credit_sub'] ?? ''), [])] : []];
        }
        case 'attach_receipt': {
            $f = aiFileRow((string)($in['file_id'] ?? ''));
            $tx = getTransactionById((string)($in['tx_id'] ?? ''));
            return ['summary' => '領収書を取引に添付',
                    'rows' => [aiRow(aiTxTarget($tx), [aiChg('領収書', !empty($tx['receipt_file']) ? 'あり（置き換える）' : 'なし', $f['name'] ?? '（不明なファイル）')], null, aiTxTag($tx))]];
        }
        case 'apply_rules': {
            // どの取引に当たるかを先に試す（保存はしない）
            $rows = []; $n = 0;
            if ($state === 'waiting') {
                $rules = kvGet('rules', []);
                foreach (getAllTransactions() as $tx) {
                    if (!empty($tx['registered']) || !empty($tx['provisional'])) continue;
                    $copy = $tx;
                    if (!applyRulesToTx($copy, $rules)) continue;
                    $n++;
                    if (count($rows) < 30) {
                        $new = $copy['entries'] ?? [];
                        if (!$new && (!empty($copy['debit_account']) || !empty($copy['credit_account']))) {
                            $new = [['debit_account' => $copy['debit_account'] ?? '', 'debit_sub' => $copy['debit_sub'] ?? '',
                                     'credit_account' => $copy['credit_account'] ?? '', 'credit_sub' => $copy['credit_sub'] ?? '',
                                     'amount' => max(aiTxInOut($tx)), 'memo' => $copy['memo'] ?? '']];
                        }
                        $rows[] = aiRow(aiTxTarget($tx), aiEntryDiff($tx['entries'] ?? [], $new ?: [[]]), 'ルール「' . ($copy['auto_rule'] ?? '') . '」');
                    }
                }
            }
            $out = ['summary' => '自動仕訳ルールを未登録の取引に適用' . ($state === 'waiting' ? "（{$n} 件）" : ''), 'rows' => $rows,
                    'lines' => ['借方・貸方がそろった取引は登録済みになる']];
            if ($n > count($rows)) $out['lines'][] = 'ほか ' . ($n - count($rows)) . ' 件';
            return $out;
        }
        case 'add_account': {
            $types = ['assets' => '資産', 'liabilities' => '負債', 'equity' => '純資産', 'income' => '収入', 'expense' => '支出'];
            $exists = array_key_exists((string)($in['name'] ?? ''), aiAccountIndex());
            return ['summary' => ($exists ? '勘定科目「' . ($in['name'] ?? '') . '」に補助科目を追加' : '勘定科目「' . ($in['name'] ?? '') . '」を追加') . '（' . ($types[$in['type'] ?? ''] ?? '') . '）',
                    'rows' => !empty($in['sub_accounts']) ? [aiRow('補助科目', [aiChg('追加', null, implode('・', (array)$in['sub_accounts']))])] : []];
        }
    }
    return null;
}
