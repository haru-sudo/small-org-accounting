"""
excel.py — openpyxl を使った Excel 生成関数群
"""
import io
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

# ── スタイルヘルパー ──
_HDR_FILL = PatternFill('solid', start_color='1E293B')
_SECTION_FILL = PatternFill('solid', start_color='334155')
_TOTAL_FILL = PatternFill('solid', start_color='DBEAFE')
_NET_FILL = PatternFill('solid', start_color='1E293B')
_BAL_FILL = PatternFill('solid', start_color='F0FDF4')
_FONT_HDR = Font(bold=True, color='FFFFFF', size=10)
_FONT_SECTION = Font(bold=True, color='FFFFFF')
_FONT_NET = Font(bold=True, color='FFFFFF')
_FONT_BAL = Font(bold=True, color='065F46')
_FONT_BOLD = Font(bold=True)
_ALIGN_CENTER = Alignment(horizontal='center', vertical='center')


def _hdrs(ws, cols, row=1):
    """ヘッダー行を描画"""
    for c, h in enumerate(cols, 1):
        cell = ws.cell(row, c, h)
        cell.font = _FONT_HDR
        cell.fill = _HDR_FILL
        cell.alignment = _ALIGN_CENTER


def _num(cell, value):
    """金額セル（0 は空のまま）"""
    if value:
        cell.value = value
        cell.number_format = '#,##0'


def _widths(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _save(wb):
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


# ══════════════════════════════════════════════════════════════════════════════
# 仕訳帳
# ══════════════════════════════════════════════════════════════════════════════
def create_journal_excel(txs):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '仕訳帳'
    _hdrs(ws, ['No','取引日','相手先','借方科目','借方補助','貸方科目','貸方補助','金額','摘要','登録状態'])
    r = 2
    for idx, tx in enumerate(txs):
        entries = tx.get('entries') or [{
            'debit_account': '', 'debit_sub': '',
            'credit_account': '', 'credit_sub': '',
            'amount': max(tx.get('debit', 0), tx.get('credit', 0)),
            'memo': tx.get('memo', ''),
        }]
        for ei, e in enumerate(entries):
            ws.cell(r, 1, idx + 1 if ei == 0 else '')
            ws.cell(r, 2, tx.get('date', '') if ei == 0 else '')
            ws.cell(r, 3, tx.get('party', '') if ei == 0 else '')
            ws.cell(r, 4, e.get('debit_account', ''))
            ws.cell(r, 5, e.get('debit_sub', ''))
            ws.cell(r, 6, e.get('credit_account', ''))
            ws.cell(r, 7, e.get('credit_sub', ''))
            _num(ws.cell(r, 8), int(e.get('amount', 0) or 0))
            ws.cell(r, 9, e.get('memo') or tx.get('memo', ''))
            ws.cell(r, 10, '登録済' if tx.get('registered') else ('仮登録' if tx.get('provisional') else '未登録'))
            r += 1
    _widths(ws, [6, 12, 20, 14, 12, 14, 12, 12, 22, 8])
    return _save(wb)


# ══════════════════════════════════════════════════════════════════════════════
# 内訳（決算書の科目別詳細）
# ══════════════════════════════════════════════════════════════════════════════
def create_detail_excel(txs, title):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '内訳'
    ws.merge_cells('A1:E1')
    ws['A1'] = title
    ws['A1'].font = Font(bold=True, size=13)
    _hdrs(ws, ['日付', '相手先', '相手科目', '金額', '摘要'], row=2)
    for r, tx in enumerate(txs, 3):
        ws.cell(r, 1, tx.get('date', ''))
        ws.cell(r, 2, tx.get('party', ''))
        ws.cell(r, 3, tx.get('counter', ''))
        amt = int(tx.get('debit_amt', 0) or 0) + int(tx.get('credit_amt', 0) or 0)
        _num(ws.cell(r, 4), amt)
        ws.cell(r, 5, tx.get('memo', ''))
    _widths(ws, [12, 20, 16, 14, 24])
    return _save(wb)


# ══════════════════════════════════════════════════════════════════════════════
# 決算書（収支表）
# ══════════════════════════════════════════════════════════════════════════════
_KMX = ['4月','5月','6月','7月','8月','9月','上半期',
        '10月','11月','12月','1月','2月','3月','下半期','年度合計']


def set_months(months):
    """会計年度の月の並び（12か月）から、決算書の列（月・上半期・下半期・年度合計）を作る。"""
    global _KMX
    _KMX = list(months[:6]) + ['上半期'] + list(months[6:]) + ['下半期', '年度合計']


def create_kessan_excel(data, year, extra_tables=()):
    """決算書を出力する。extra_tables は (見出し, データ, 最終行ラベル) の並びで、
    本表の下に別表として続けて書く（例: 特定の科目だけの収支表）。"""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '収支表'

    r = _write_kessan_table(ws, 1, data, f'{year}年度 収支表', '期末残高', show_opening=True)
    for title, d, label in extra_tables:
        r = _write_kessan_table(ws, r + 2, d, title, label)

    ws.column_dimensions['A'].width = 10
    ws.column_dimensions['B'].width = 22
    for i in range(3, len(_KMX) + 3):
        ws.column_dimensions[get_column_letter(i)].width = 11
    return _save(wb)


def _write_kessan_table(ws, r, data, title, balance_label, show_opening=False):
    """r 行目から収支表を1つ書き、最後に書いた行番号を返す。
    show_opening のときは見出しの下に前期繰越（年度の開始残高）を書く。"""
    n_cols = len(_KMX) + 2
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=n_cols)
    ws.cell(r, 1, title).font = Font(bold=True, size=14)
    ws.cell(r, 1).alignment = _ALIGN_CENTER
    r += 1
    _hdrs(ws, ['分類', '科目'] + _KMX, row=r)
    r += 1
    if show_opening:
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        ws.cell(r, 1, f"前期繰越　開始残高：{int(data.get('opening_balance', 0)):,}").font = _FONT_BOLD
        ws.cell(r, 1).alignment = _ALIGN_CENTER
        r += 1

    for sec in data.get('sections', []):
        ws.cell(r, 1, sec['name'])
        for c in range(1, n_cols + 1):
            cell = ws.cell(r, c)
            cell.fill = _SECTION_FILL
            cell.font = _FONT_SECTION
        r += 1

        for g in sec['groups']:
            if g.get('sub'):
                ws.cell(r, 2, f"{g['code']} {g['name']}").font = _FONT_BOLD
                r += 1
                for s in g['sub']:
                    ws.cell(r, 2, f"  {s['code']} {s['name']}")
                    for i, m in enumerate(_KMX, 3):
                        _num(ws.cell(r, i), s['monthly'].get(m, 0))
                    r += 1
                ws.cell(r, 2, f"{g['name']}小計").font = _FONT_BOLD
                for i, m in enumerate(_KMX, 3):
                    _num(ws.cell(r, i), g['sub_total'].get(m, 0))
                r += 1
            else:
                ws.cell(r, 2, f"{g['code']} {g['name']}")
                for i, m in enumerate(_KMX, 3):
                    _num(ws.cell(r, i), g['monthly'].get(m, 0))
                r += 1

        # セクション合計
        ws.cell(r, 2, f"{sec['name']}合計").font = _FONT_BOLD
        for i, m in enumerate(_KMX, 3):
            cell = ws.cell(r, i, sec['total'].get(m, 0))
            cell.number_format = '#,##0'
        for c in range(1, n_cols + 1):
            ws.cell(r, c).fill = _TOTAL_FILL
        r += 2

    # 収支差額
    ws.cell(r, 2, '収支差額')
    for i, m in enumerate(_KMX, 3):
        cell = ws.cell(r, i, data['net'].get(m, 0))
        cell.number_format = '#,##0'
    for c in range(1, n_cols + 1):
        cell = ws.cell(r, c)
        cell.fill = _NET_FILL
        cell.font = _FONT_NET
    r += 1

    # 期末残高の内訳（口座・現金ごとの月末残高。立替金は含めない）
    breakdown = data.get('balance_breakdown') or []
    if len(breakdown) > 1:
        r += 1
        ws.cell(r, 1, '期末残高の内訳')
        for c in range(1, n_cols + 1):
            cell = ws.cell(r, c)
            cell.fill = _SECTION_FILL
            cell.font = _FONT_SECTION
        r += 1
        for row in breakdown:
            ws.cell(r, 2, f"  {row['name']}")
            for i, m in enumerate(_KMX, 3):
                cell = ws.cell(r, i, row['monthly'].get(m, 0))
                cell.number_format = '#,##0'
            r += 1

    # 期末残高（別表では収支累計）
    ws.cell(r, 2, balance_label)
    for i, m in enumerate(_KMX, 3):
        cell = ws.cell(r, i, data['monthly_balance'].get(m, 0))
        cell.number_format = '#,##0'
    for c in range(1, n_cols + 1):
        cell = ws.cell(r, c)
        cell.fill = _BAL_FILL
        cell.font = _FONT_BAL
    return r


# ══════════════════════════════════════════════════════════════════════════════
# 月次仕訳日記帳
# ══════════════════════════════════════════════════════════════════════════════
def create_monthly_excel(txs, summary, by_account):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '月次仕訳日記帳'

    if by_account and summary:
        r = 1
        for name, s in summary.items():
            total = int(s.get('debit_total', 0) or 0) + int(s.get('credit_total', 0) or 0)
            ws.cell(r, 1, name).font = Font(bold=True, size=12)
            ws.cell(r, 5, f'合計金額: {total:,}')
            r += 1
            _hdrs(ws, ['日付', '相手先', '相手科目', '摘要', '金額'], row=r)
            r += 1
            for row in s['entries']:
                amt = int(row.get('debit', 0) or 0) + int(row.get('credit', 0) or 0)
                ws.cell(r, 1, row['date'])
                ws.cell(r, 2, row['party'])
                ws.cell(r, 3, row['counter_account'])
                ws.cell(r, 4, row['memo'])
                _num(ws.cell(r, 5), amt)
                r += 1
            r += 1
    else:
        _hdrs(ws, ['日付', '相手先', '借方科目', '借方補助', '貸方科目', '貸方補助', '金額', '摘要'])
        r = 2
        for tx in txs:
            for e in tx.get('entries', []):
                ws.cell(r, 1, tx.get('date', ''))
                ws.cell(r, 2, tx.get('party', ''))
                ws.cell(r, 3, e.get('debit_account', ''))
                ws.cell(r, 4, e.get('debit_sub', ''))
                ws.cell(r, 5, e.get('credit_account', ''))
                ws.cell(r, 6, e.get('credit_sub', ''))
                _num(ws.cell(r, 7), int(e.get('amount', 0) or 0))
                ws.cell(r, 8, e.get('memo') or tx.get('memo', ''))
                r += 1
    _widths(ws, [12, 20, 14, 12, 14, 12, 12, 22])
    return _save(wb)


# ══════════════════════════════════════════════════════════════════════════════
# 会費請求シート
# ══════════════════════════════════════════════════════════════════════════════
def create_billing_excel(members):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '会費請求'
    _hdrs(ws, ['氏名', '振込名義（半角カナ）', '種別', '請求額'])
    total = 0
    for r, m in enumerate(members, 2):
        ws.cell(r, 1, m.get('name', ''))
        ws.cell(r, 2, m.get('kana', ''))
        ws.cell(r, 3, m.get('type', ''))
        fee = int(m.get('base_fee', 0) or 0)
        _num(ws.cell(r, 4), fee)
        total += fee
    tr = len(members) + 2
    ws.cell(tr, 1, '合計').font = _FONT_BOLD
    cell = ws.cell(tr, 4, total)
    cell.font = _FONT_BOLD
    cell.number_format = '#,##0'
    _widths(ws, [20, 24, 10, 14])
    return _save(wb)
