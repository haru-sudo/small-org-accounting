#!/usr/bin/env bash
# GitHub Pages 用のデモを作る。_site/ に出力する（.github/workflows/pages.yml から呼ぶ）。
#   bash demo/build.sh
#   → python3 -m http.server -d _site 8000 で http://localhost:8000/ を開いて確かめられる
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site/demo
cp -r static _site/static
cp demo/demo.js _site/demo/demo.js
# index.html は *.github.io で開くと自動で demo.js を読み込む（ブランチから直接公開しても動く）。
# ここでは、どこで開いてもデモになるように読み込みを固定する
python3 - <<'PY'
src = open('index.html', encoding='utf-8').read()
tag = '<script src="static/js/login.js'
assert tag in src, 'login.js の読み込みが見つかりません'
src = src.replace(tag, '<script src="demo/demo.js"></script>\n' + tag, 1)
src = src.replace('<title>会計システム</title>', '<title>デモ | small-org-accounting</title>', 1)
open('_site/index.html', 'w', encoding='utf-8').write(src)
PY
touch _site/.nojekyll
echo "built _site/"
