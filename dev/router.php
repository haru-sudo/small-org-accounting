<?php
// ══════════════════════════════════════════════════════════════════════════════
// dev/router.php — 手元で動かすための、PHP 組み込みサーバー用のルーター
//   .htaccess（Apache）と同じ振り分けをする。本番では使わない。
//
//   php -S localhost:8000 dev/router.php
//   → http://localhost:8000/ を開く
// ══════════════════════════════════════════════════════════════════════════════
$root = dirname(__DIR__);
$path = (string)parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

// 内部のディレクトリ・秘密のファイルは見せない（.htaccess と同じ）
if (preg_match('#^/(data|uploads|core|core_py|vendor|dev|\.git)(/|$)#', $path)
    || preg_match('#\.(py|ini|db|log|sqlite|sqlite3|json|diff|patch|md|sh|bak|orig|swp)$#', $path)) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}

if (str_starts_with($path, '/api/')) {
    $_SERVER['SCRIPT_NAME'] = '/api/router.php';
    $_SERVER['SCRIPT_FILENAME'] = $root . '/api/router.php';
    require $root . '/api/router.php';
    return true;
}
if ($path === '/auth.php') {
    $_SERVER['SCRIPT_NAME'] = '/auth.php';
    require $root . '/auth.php';
    return true;
}
if ($path === '/' || $path === '') {
    header('Content-Type: text/html; charset=utf-8');
    readfile($root . '/index.html');
    return true;
}
return false;   // そのほか（static/ など）はそのまま返す
