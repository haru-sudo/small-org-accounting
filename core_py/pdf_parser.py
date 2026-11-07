"""
pdf_parser.py — 三井住友銀行 Value Door の取引明細PDFをパース

日付欄には取引日（上段）と起算日（下段）の2つが印字される。
照会期間の区切りも起算日基準のため、取引の日付には起算日を採用する。
"""
import fitz
import re, uuid, os

_RE_DATE1 = re.compile(r'(\d+)/\s*(\d+)/?\s*(\d*)')
_RE_DATE2 = re.compile(r'(\d+)/(\d+)')
_RE_ZERO_BR = re.compile(r'^\([\s0]+\)$')
REIWA_OFFSET = 2018

# 取引区分の欄（x=390〜430）に出る文字。以前は「振込」「振替」だけを拾っていたため、
# 「現金」（キャッシュカードの引き出し・ATM入金）や「手形」「その他」などの行が丸ごと取り込まれていなかった。
# 見出しの文字だけを除き、漢字・カナの短い語ならどれでも取引の行として扱う（日付と金額のない行は後で捨てる）。
_RE_TX_LABEL = re.compile(r'^[\u4e00-\u9fff\u30a0-\u30ffー]{1,6}$')
_HEADER_WORDS = {'取引区分', '区分', '摘要', '内容', 'お取引内容'}


def _is_tx_label(x, t):
    return 390 <= x <= 430 and t not in _HEADER_WORDS and bool(_RE_TX_LABEL.match(t))


def parse_web21_pdf(filepath):
    """Value Door 形式の PDF を取引データのリストに変換"""
    transactions = []
    doc = fitz.open(filepath)
    src = os.path.basename(filepath)
    try:
        for page in doc:
            all_spans = []
            for block in page.get_text("dict")["blocks"]:
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        x, y = span["origin"]
                        text = span["text"].strip()
                        if text:
                            all_spans.append((round(y), round(x), text))
            # 取引区分（振込・振替・現金など）のある行の y 座標を取得
            tx_ys = sorted({y for y, x, t in all_spans if _is_tx_label(x, t)})

            for ty in tx_ys:
                nearby = [(y, x, t) for y, x, t in all_spans if abs(y - ty) <= 15]
                debit = credit = 0
                tx_type = ''
                date_cands = []
                party_593 = party_510 = party_699 = ''

                for y, x, txt in nearby:
                    txt_nc = txt.replace(',', '')
                    if _is_tx_label(x, txt) and abs(y - ty) <= 2:
                        tx_type = txt
                    elif x < 95:
                        d = _parse_reiwa_date(txt)
                        if d:
                            date_cands.append((y, d))
                    elif 95 <= x < 215:
                        try:
                            v = int(txt_nc)
                            if v > 0:
                                debit = v
                        except ValueError:
                            pass
                    elif 215 <= x < 340:
                        if _RE_ZERO_BR.match(txt):
                            continue
                        try:
                            v = int(txt_nc)
                            if v > 0:
                                credit = v
                        except ValueError:
                            pass
                    elif 490 <= x < 580 and y <= ty + 2:
                        party_510 = (party_510 + ' ' + txt).strip()
                    elif 580 <= x < 690 and y <= ty + 2:
                        party_593 = (party_593 + ' ' + txt).strip()
                    elif x >= 690 and y <= ty + 2:
                        party_699 = (party_699 + ' ' + txt).strip()

                # 日付欄は上段＝取引日／下段＝起算日。会計上は起算日を取引の日付とする
                date_str = max(date_cands)[1] if date_cands else ''
                if not date_str or (debit == 0 and credit == 0):
                    continue

                party_w21 = re.sub(r'^W21\s*', '', party_699).strip()
                if tx_type == '振替':
                    party = party_w21
                elif tx_type == '振込':
                    party = party_593 or party_510
                else:
                    # 現金（キャッシュカード）などは摘要がどの欄に出るか決まっていないので、ある欄を使う
                    party = party_593 or party_510 or party_w21
                amount = credit if credit > 0 else debit
                is_in = credit > 0

                transactions.append({
                    'id':          str(uuid.uuid4()),
                    'date':        date_str,
                    'amount':      amount,
                    'bank_debit':  debit,
                    'bank_credit': credit,
                    'type':        tx_type,
                    'party':       party,
                    'group_id':    str(uuid.uuid4()),
                    'entries': [{
                        'debit_account':  '普通預金' if is_in else '',
                        'debit_sub':      '',
                        'credit_account': '普通預金' if not is_in else '',
                        'credit_sub':     '',
                        'amount':         amount,
                        'memo':           '',
                    }],
                    'memo':        '',
                    'registered':  False,
                    'auto_rule':   '',
                    'source_file': src,
                })
    finally:
        doc.close()
    return transactions


def _parse_reiwa_date(txt):
    """'6/4/1' (令和6年4月1日) → '2024/04/01'"""
    m = _RE_DATE1.match(txt)
    if not m:
        return ''
    reiwa = int(m.group(1))
    mo_str, dy_str = m.group(2), m.group(3)
    if not dy_str:
        m2 = _RE_DATE2.match(txt)
        if not m2:
            return ''
        mo_str, dy_str = m2.group(1), m2.group(2)
    try:
        mo, dy = int(mo_str), int(dy_str)
    except ValueError:
        return ''
    if not (1 <= mo <= 12 and 1 <= dy <= 31 and 1 <= reiwa <= 20):
        return ''
    return f"{REIWA_OFFSET + reiwa}/{mo:02d}/{dy:02d}"
