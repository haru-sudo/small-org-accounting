#!/usr/bin/env python3
"""
pdf_parse_cli.py — PDF をパースして JSON を stdout に出力するだけ
  DB 書き込み・ルール適用・申請マッチングは PHP 側で実施
"""
import sys
import json
import os

# stdout を UTF-8 に固定（Windows 環境等での文字化け対策）
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_parser import parse_web21_pdf


def main():
    if len(sys.argv) < 2:
        sys.stdout.write(json.dumps({'success': False, 'error': 'PDFパスが指定されていません'}) + '\n')
        sys.stdout.flush()
        sys.exit(1)
    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        sys.stdout.write(json.dumps({'success': False, 'error': 'ファイルが見つかりません: ' + filepath}) + '\n')
        sys.stdout.flush()
        sys.exit(1)
    try:
        txs = parse_web21_pdf(filepath)
        # ensure_ascii=True（デフォルト）で非ASCII文字をすべて \uXXXX エスケープ
        # → PHP の json_decode が UTF-8 エラーを起こさない
        result = json.dumps({'success': True, 'transactions': txs}, ensure_ascii=True)
        sys.stdout.write(result + '\n')
        sys.stdout.flush()
    except Exception as e:
        import traceback
        err_detail = traceback.format_exc()
        sys.stdout.write(json.dumps(
            {'success': False, 'error': str(e), 'detail': err_detail},
            ensure_ascii=True
        ) + '\n')
        sys.stdout.flush()
        sys.exit(1)


if __name__ == '__main__':
    main()
