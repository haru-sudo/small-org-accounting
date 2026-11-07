<?php
// ══════════════════════════════════════════════════════════════════════════════
// ai_files.php — AIアシスタントのチャットに添付するファイル（画像・PDF・CSV/テキスト）
//   ・uploads/ai/ に保存し（.htaccess で直接は見られない）、ai_conversations と同じ DB で管理する
//   ・会話には {"type":"_file","id":...} という目印だけを残し、Claude に送るときに中身を入れる
//     （DB に base64 を重ねて保存しない。中身は毎回同じなので、送る会話は毎回同じになる）
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';

define('AI_FILE_DIR', UPLOAD_DIR . '/ai');
const AI_FILE_TYPES = [
    // MIME => [拡張子, 種類, 上限バイト]
    'image/jpeg'      => ['jpg',  'image',    5 * 1024 * 1024],   // Claude API の画像の上限は 5MB
    'image/png'       => ['png',  'image',    5 * 1024 * 1024],
    'image/gif'       => ['gif',  'image',    5 * 1024 * 1024],
    'image/webp'      => ['webp', 'image',    5 * 1024 * 1024],
    'application/pdf' => ['pdf',  'pdf',     20 * 1024 * 1024],
    'text/plain'      => ['txt',  'text',     1 * 1024 * 1024],
    'text/csv'        => ['csv',  'text',     1 * 1024 * 1024],
    // AIアシスタントが作る Excel（export_excel）。ユーザーは添付できず、Claude にも中身は送らない
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => ['xlsx', 'file', 20 * 1024 * 1024],
];
const AI_FILE_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function aiFileRow(string $id): ?array {
    $st = aiDb()->prepare("SELECT * FROM ai_files WHERE id=?");
    $st->execute([$id]);
    return $st->fetch() ?: null;
}
function aiFilePath(array $row): string {
    return AI_FILE_DIR . '/' . $row['id'] . '.' . AI_FILE_TYPES[$row['media_type']][0];
}

/** アップロードされたファイルを保存して、画面に返す情報を返す */
function aiFileSave(array $file, array $user): array {
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        throw new RuntimeException('アップロードに失敗しました（コード:' . ($file['error'] ?? '?') . '）');
    }
    $name = mb_substr(trim(basename((string)($file['name'] ?? 'file'))), 0, 120) ?: 'file';
    $mime = (string)(new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
    // CSV は環境によって text/plain や application/csv と判定される
    if (in_array($mime, ['application/csv', 'text/x-csv', 'application/vnd.ms-excel'], true)
        || ($mime === 'text/plain' && preg_match('/\.csv$/i', $name))) $mime = 'text/csv';
    if ($mime === 'image/heic' || $mime === 'image/heif') {
        throw new RuntimeException('HEIC 形式の写真は読めません。JPEG で保存し直すか、スクリーンショットを添付してください。');
    }
    if (!isset(AI_FILE_TYPES[$mime]) || AI_FILE_TYPES[$mime][1] === 'file') {
        throw new RuntimeException('添付できるのは画像（JPEG/PNG/GIF/WebP）・PDF・CSV・テキストです。');
    }
    [$ext, $kind, $max] = AI_FILE_TYPES[$mime];
    if ($file['size'] > $max) {
        throw new RuntimeException('ファイルが大きすぎます（' . $kind . ' は ' . round($max / 1048576) . 'MB まで）。');
    }
    if (!is_dir(AI_FILE_DIR)) mkdir(AI_FILE_DIR, 0755, true);
    aiFileCleanup();

    $id = bin2hex(random_bytes(12));
    $dest = AI_FILE_DIR . "/{$id}.{$ext}";
    if ($kind === 'text') {
        // 銀行の CSV は Shift_JIS のことが多い。UTF-8 にそろえて保存する
        $raw = (string)file_get_contents($file['tmp_name']);
        if (!mb_check_encoding($raw, 'UTF-8')) $raw = mb_convert_encoding($raw, 'UTF-8', 'SJIS-win');
        if (file_put_contents($dest, $raw) === false) throw new RuntimeException('保存に失敗しました');
    } elseif (!move_uploaded_file($file['tmp_name'], $dest)) {
        throw new RuntimeException('保存に失敗しました');
    }
    aiDb()->prepare("INSERT INTO ai_files(id,conv_id,name,media_type,size,user_name,created_at) VALUES(?,?,?,?,?,?,?)")
        ->execute([$id, null, $name, $mime, filesize($dest), $user['name'] ?: $user['email'], now('Y/m/d H:i:s')]);
    return ['id' => $id, 'name' => $name, 'kind' => $kind, 'media_type' => $mime, 'size' => filesize($dest)];
}

/**
 * AIアシスタントが作ったファイル（Excel の出力など）を添付と同じ場所に置き、画面から開ける URL を返す。
 * $srcPath のファイルはここへ移動する。$convId を付けると会話と一緒に残る（無ければ1日で消える）。
 */
function aiFileRegister(string $srcPath, string $name, string $mime, ?string $convId, array $user): array {
    if (!isset(AI_FILE_TYPES[$mime])) throw new RuntimeException('扱えないファイルの種類です: ' . $mime);
    [$ext, $kind] = AI_FILE_TYPES[$mime];
    if (!is_dir(AI_FILE_DIR)) mkdir(AI_FILE_DIR, 0755, true);
    $id = bin2hex(random_bytes(12));
    $dest = AI_FILE_DIR . "/{$id}.{$ext}";
    if (!@rename($srcPath, $dest) && !copy($srcPath, $dest)) throw new RuntimeException('ファイルの保存に失敗しました');
    @unlink($srcPath);
    $name = mb_substr(trim(basename($name)), 0, 120) ?: "file.{$ext}";
    aiDb()->prepare("INSERT INTO ai_files(id,conv_id,name,media_type,size,user_name,created_at) VALUES(?,?,?,?,?,?,?)")
        ->execute([$id, $convId, $name, $mime, filesize($dest), $user['name'] ?: ($user['email'] ?? ''), now('Y/m/d H:i:s')]);
    // 画面（index.html）からの相対パス。サブディレクトリに置いても届く
    return ['id' => $id, 'name' => $name, 'kind' => $kind, 'url' => 'api/ai/file/' . $id, 'size' => filesize($dest)];
}

/** 送らずに放置された添付（1日以上前）を消す */
function aiFileCleanup(): void {
    $st = aiDb()->prepare("SELECT * FROM ai_files WHERE conv_id IS NULL AND created_at < ?");
    $st->execute([date('Y/m/d H:i:s', time() - 86400)]);
    foreach ($st->fetchAll() as $row) {
        @unlink(aiFilePath($row));
        aiDb()->prepare("DELETE FROM ai_files WHERE id=?")->execute([$row['id']]);
    }
}
/** 会話に添付を結びつける（会話は消せないので、添付も残り続ける） */
function aiFileAttach(string $id, string $convId): ?array {
    $row = aiFileRow($id);
    if (!$row || ($row['conv_id'] !== null && $row['conv_id'] !== $convId)) return null;
    aiDb()->prepare("UPDATE ai_files SET conv_id=? WHERE id=?")->execute([$convId, $id]);
    return $row;
}

/** 会話に残す目印 */
function aiFileMarker(array $row): array {
    return ['type' => '_file', 'id' => $row['id'], 'name' => $row['name'], 'media_type' => $row['media_type']];
}

/** 目印を Claude API に送る内容ブロックにする */
function aiFileApiBlock(array $marker): array {
    $row = aiFileRow((string)($marker['id'] ?? ''));
    $path = $row ? aiFilePath($row) : '';
    if (!$row || !is_file($path)) {
        return ['type' => 'text', 'text' => '（添付ファイル「' . ($marker['name'] ?? '') . '」は削除されたため読めません）'];
    }
    $kind = AI_FILE_TYPES[$row['media_type']][1];
    if ($kind === 'image') {
        return ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $row['media_type'],
                'data' => base64_encode((string)file_get_contents($path))]];
    }
    if ($kind === 'pdf') {
        return ['type' => 'document', 'title' => $row['name'], 'source' => ['type' => 'base64',
                'media_type' => 'application/pdf', 'data' => base64_encode((string)file_get_contents($path))]];
    }
    if ($kind === 'file') {
        return ['type' => 'text', 'text' => '（ファイル「' . $row['name'] . '」はAIアシスタントが作った出力で、中身は読めません）'];
    }
    return ['type' => 'document', 'title' => $row['name'], 'source' => ['type' => 'text',
            'media_type' => 'text/plain', 'data' => (string)file_get_contents($path)]];
}

/** 画面で見るための配信（管理者だけ。router の権限チェックを通ったあとで呼ぶ） */
function aiFileServe(string $id): void {
    $row = preg_match('/^[0-9a-f]{24}$/', $id) ? aiFileRow($id) : null;
    $path = $row ? aiFilePath($row) : '';
    if (!$row || !is_file($path)) jsonResponse(['error' => 'ファイルが見つかりません'], 404);
    $kind = AI_FILE_TYPES[$row['media_type']][1];
    $type = $kind === 'text' ? 'text/plain; charset=utf-8' : $row['media_type'];
    header('Content-Type: ' . $type);
    header('Content-Length: ' . filesize($path));
    // Excel などの出力はブラウザで開けないのでダウンロードさせる
    header('Content-Disposition: ' . ($kind === 'file' ? 'attachment' : 'inline') . "; filename*=UTF-8''" . rawurlencode($row['name']));
    header('Cache-Control: private, max-age=86400');
    readfile($path);
    exit;
}

/** AIアシスタントの attach_receipt: 添付の画像・PDFを取引の領収書にする */
function aiFileToReceipt(string $fileId, string $txId): array {
    $row = aiFileRow($fileId);
    if (!$row || !is_file(aiFilePath($row))) return ['error' => '添付ファイルが見つかりません'];
    if (AI_FILE_TYPES[$row['media_type']][1] === 'text') return ['error' => '領収書にできるのは画像か PDF です'];
    $tx = getTransactionById($txId);
    if (!$tx) return ['error' => '取引が見つかりません'];
    $safe = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $txId);
    $dir = RECEIPT_DIR . '/' . $safe;
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    $replaced = (bool)(glob($dir . '/*') ?: []) || !empty($tx['receipt_file']);
    foreach (glob($dir . '/*') ?: [] as $old) @unlink($old);   // 画面からの領収書アップロードと同じく置き換え
    $filename = 'receipt_' . time() . '.' . AI_FILE_TYPES[$row['media_type']][0];
    if (!copy(aiFilePath($row), $dir . '/' . $filename)) return ['error' => '保存に失敗しました'];
    txDb()->prepare("UPDATE transactions SET receipt_file=? WHERE id=?")
        ->execute(['uploads/receipts/' . $safe . '/' . $filename, $txId]);
    return ['ok' => true, 'tx_id' => $txId, 'replaced_existing_receipt' => $replaced];
}
