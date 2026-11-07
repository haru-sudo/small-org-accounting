<?php
// ══════════════════════════════════════════════════════════════════════════════
// ai_examples.php — 過去の仕訳から「この団体の付け方」を探す（AIアシスタントの find_similar_examples）
//   登録済みの仕訳を1明細ずつ並べ、相手先・摘要の文字の近さ（2文字ずつの重なり）と
//   金額の近さで似ているものを選ぶ。人が直して登録した仕訳もそのまま次の判断材料になる。
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/accounting.php';

const AI_EX_MAX_TARGETS = 30;

/** 比べるための文字列にそろえる（半角カナ→全角、英数は半角大文字、空白・記号・数字は除く） */
function aiExNorm(string $s): string {
    $s = mb_convert_kana($s, 'KVas');
    $s = mb_strtoupper($s);
    // 先頭の利用日（クレジットカード明細の「YYYY/MM/DD 」）や金額・日付の数字は似ているかの判断に使わない
    $s = preg_replace('/[0-9０-９]+/u', '', $s);
    return preg_replace('/[\s　\/\\\\()（）\[\]「」・.,、。:：\-ー_*＊#＃]+/u', '', $s);
}
function aiExBigrams(string $norm): array {
    $chars = mb_str_split($norm);
    $n = count($chars);
    if ($n === 0) return [];
    if ($n === 1) return [$chars[0] => true];
    $set = [];
    for ($i = 0; $i < $n - 1; $i++) $set[$chars[$i] . $chars[$i + 1]] = true;
    return $set;
}
function aiExSimilarity(array $a, array $b): float {
    if (!$a || !$b) return 0.0;
    $inter = count(array_intersect_key($a, $b));
    return $inter / (count($a) + count($b) - $inter);
}
function aiExAmountScore(int $a, int $b): float {
    if ($a <= 0 || $b <= 0) return 0.0;
    if ($a === $b) return 1.0;
    return 1 / (1 + abs(log($a / $b)) * 3);
}
/** 明細の比べる文字列。銀行の取引は相手先を主に、クレカの明細は明細の摘要（＋書き換え前の摘要）を使う */
function aiExText(array $tx, int $ix): string {
    $strip = fn($m) => preg_replace('#^\d{4}/\d{1,2}/\d{1,2}\s*#', '', (string)$m);
    $e = $tx['entries'][$ix] ?? [];
    $memo = $strip($e['memo'] ?? '');
    $origin = $strip(entryOriginMemo($tx, $ix));
    if ($origin !== $memo) $memo = trim($origin . ' ' . $memo);
    // クレジットカードの明細（摘要が利用日で始まる、または明細が複数）は明細の摘要だけで比べる
    if (count($tx['entries'] ?? []) > 1 || preg_match('#^\d{4}/\d{1,2}/\d{1,2}\s#', entryOriginMemo($tx, $ix))) return $memo;
    return trim(($tx['party'] ?? '') . ' ' . $memo . ' ' . ($tx['memo'] ?? ''));
}

/** 意味のある単語のかたまり（英字の語・カタカナの語・漢字2文字ずつ）。「ETC」「AMAZON」などで一致させる */
function aiExTokens(string $text): array {
    $s = mb_strtoupper(mb_convert_kana($text, 'KVas'));
    preg_match_all('/[A-Z]{2,}|[ァ-ヶー]{2,}|[一-龠々]{2,}/u', $s, $m);
    $set = [];
    foreach ($m[0] as $w) {
        if (preg_match('/^[一-龠々]+$/u', $w)) {
            $c = mb_str_split($w);
            for ($i = 0; $i < count($c) - 1; $i++) $set[$c[$i] . $c[$i + 1]] = true;
        } else {
            $set[$w] = true;
        }
    }
    return $set;
}

/** 登録済みの全明細（新しい順） */
function aiExIndex(bool $rebuild = false): array {
    static $idx = null;
    if ($idx !== null && !$rebuild) return $idx;
    $idx = [];
    foreach (getAllTransactions() as $tx) {
        if (empty($tx['registered'])) continue;
        foreach ($tx['entries'] ?? [] as $ix => $e) {
            if (($e['debit_account'] ?? '') === '' || ($e['credit_account'] ?? '') === '') continue;
            $text = aiExText($tx, $ix);
            $idx[] = [
                'grams'  => aiExBigrams(aiExNorm($text)),
                'tokens' => aiExTokens($text),
                'date'   => $tx['date'] ?? '',
                'text'   => mb_substr($text, 0, 80),
                'amount' => (int)($e['amount'] ?? 0),
                'debit'  => trim(($e['debit_account'] ?? '') . (($e['debit_sub'] ?? '') !== '' ? '/' . $e['debit_sub'] : '')),
                'credit' => trim(($e['credit_account'] ?? '') . (($e['credit_sub'] ?? '') !== '' ? '/' . $e['credit_sub'] : '')),
                'memo'   => (string)($e['memo'] ?? ''),
                'rule'   => (string)($tx['auto_rule'] ?? ''),
            ];
        }
    }
    usort($idx, fn($a, $b) => strcmp((string)$b['date'], (string)$a['date']));
    return $idx;
}
/** 単語ごとの重み（めったに出ない単語ほど重い） */
function aiExIdf(bool $rebuild = false): array {
    static $idf = null;
    if ($idf !== null && !$rebuild) return $idf;
    $df = [];
    foreach (aiExIndex() as $row) foreach ($row['tokens'] as $t => $_) $df[$t] = ($df[$t] ?? 0) + 1;
    $n = max(1, count(aiExIndex()));
    $idf = [];
    foreach ($df as $t => $c) $idf[$t] = log(1 + $n / $c);
    return $idf;
}
/** 単語の一致度。過去に一度も出ていない単語は判断材料にならないので分母に入れない */
function aiExTokenScore(array $target, array $row): float {
    $idf = aiExIdf();
    $total = 0.0; $hit = 0.0;
    foreach ($target as $t => $_) {
        if (!isset($idf[$t])) continue;
        $total += $idf[$t];
        if (isset($row[$t])) $hit += $idf[$t];
    }
    return $total > 0 ? $hit / $total : 0.0;
}

function aiExSearch(string $text, int $amount, int $limit): array {
    $grams = aiExBigrams(aiExNorm($text));
    $tokens = aiExTokens($text);
    $scored = [];
    foreach (aiExIndex() as $row) {
        // 文字の重なりと単語の一致の、よいほう（単語は少し割り引く）
        $sim = max(aiExSimilarity($grams, $row['grams']), aiExTokenScore($tokens, $row['tokens']) * 0.85);
        if ($sim < 0.12) continue;
        $score = $sim * 0.8 + aiExAmountScore($amount, $row['amount']) * 0.2;
        $scored[] = [$score, $row];
    }
    // 点数の高い順（同点なら新しい順のまま）
    usort($scored, fn($a, $b) => $b[0] <=> $a[0]);
    $top = array_slice($scored, 0, 40);

    // 付け方の傾向（上位の似た例で、借方/貸方の組み合わせが何回使われたか）
    $patterns = [];
    foreach ($top as [$score, $row]) {
        if ($score < 0.3) continue;
        $k = $row['debit'] . ' ／ ' . $row['credit'];
        $patterns[$k] ??= ['debit' => $row['debit'], 'credit' => $row['credit'], 'count' => 0, 'memo_examples' => []];
        $patterns[$k]['count']++;
        if (count($patterns[$k]['memo_examples']) < 3 && $row['memo'] !== '') $patterns[$k]['memo_examples'][] = $row['memo'];
    }
    usort($patterns, fn($a, $b) => $b['count'] <=> $a['count']);

    return [
        'examples' => array_map(fn($p) => [
            'similarity' => round($p[0], 2),
            'date'   => $p[1]['date'],
            'text'   => $p[1]['text'],
            'amount' => $p[1]['amount'],
            'debit'  => $p[1]['debit'],
            'credit' => $p[1]['credit'],
            'memo'   => $p[1]['memo'],
        ] + ($p[1]['rule'] !== '' ? ['auto_rule' => $p[1]['rule']] : []), array_slice($top, 0, $limit)),
        'patterns' => array_slice($patterns, 0, 5),
    ];
}

function aiFindSimilarExamples(array $in): array {
    $limit = max(1, min(15, (int)($in['limit'] ?? 6)));
    // 毎回作り直す（同じリクエストの中で直前に登録した仕訳も例に入れるため）
    aiExIndex(true);
    aiExIdf(true);
    if (!aiExIndex()) return ['note' => '登録済みの仕訳がまだありません。一般的な会計の考え方で判断してください。', 'results' => []];
    $results = [];
    if (trim((string)($in['query'] ?? '')) !== '') {
        $results[] = ['query' => (string)$in['query']] + aiExSearch((string)$in['query'], (int)($in['amount'] ?? 0), $limit);
    }
    $cache = [];
    foreach (array_slice((array)($in['targets'] ?? []), 0, AI_EX_MAX_TARGETS) as $t) {
        $id = (string)($t['tx_id'] ?? '');
        $tx = $cache[$id] ??= getTransactionById($id);
        if (!$tx) { $results[] = ['tx_id' => $id, 'error' => '取引が見つかりません']; continue; }
        $ix = isset($t['entry_index']) ? (int)$t['entry_index'] : null;
        if ($ix !== null && !isset($tx['entries'][$ix])) { $results[] = ['tx_id' => $id, 'entry_index' => $ix, 'error' => 'その番号の明細はありません']; continue; }
        $e = $ix !== null ? $tx['entries'][$ix] : ['memo' => $tx['memo'] ?? '', 'amount' => max((int)($tx['bank_debit'] ?? 0), (int)($tx['bank_credit'] ?? 0), (int)($tx['amount'] ?? 0))];
        // 1明細の取引なら相手先で、明細の多い取引なら明細の摘要で探す
        $text = $ix !== null ? aiExText($tx, $ix) : trim(($tx['party'] ?? '') . ' ' . ($tx['memo'] ?? ''));
        $results[] = ['tx_id' => $id] + ($ix !== null ? ['entry_index' => $ix] : [])
                   + ['target' => mb_substr($text, 0, 80), 'amount' => (int)($e['amount'] ?? 0)]
                   + aiExSearch($text, (int)($e['amount'] ?? 0), $limit);
    }
    return ['results' => $results,
            'note' => 'patterns は似た過去の仕訳での借方/貸方の組み合わせと回数。多数派に合わせ、例と違う付け方をするときは理由を書く。'];
}
