#!/usr/bin/env python3
"""
excel_cli.py — Excel 生成 CLI（PHP から呼ばれる）

引数: <input_json> <output_xlsx> <segment> <query_string>
  segment ∈ {journal, detail, kessan, monthly, billing_excel}

DB は SQLite を直接参照（軽量化のため最小限のクエリだけ）。
"""
import sys
import os
import json
import re
import shutil
import sqlite3
import calendar
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from excel import (
    create_journal_excel, create_detail_excel,
    create_kessan_excel,  create_monthly_excel,
    create_billing_excel,
    set_months as excel_set_months,
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
DB_TX     = os.path.join(DATA_DIR, 'transactions.db')
DB_MASTER = os.path.join(DATA_DIR, 'master.db')


# ── SQLite ユーティリティ ──
def _open(path):
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


def kv_get(key, default):
    with _open(DB_MASTER) as c:
        r = c.execute("SELECT value FROM kv_store WHERE key=?", (key,)).fetchone()
    return json.loads(r[0]) if r else default


def get_all_transactions():
    with _open(DB_TX) as c:
        rows = c.execute("SELECT * FROM transactions ORDER BY date").fetchall()
        if not rows:
            return []
        ids = [r['id'] for r in rows]
        ph  = ','.join('?' * len(ids))
        eres = c.execute(f"SELECT * FROM entries WHERE tx_id IN ({ph})", ids).fetchall()
    emap = {}
    for r in eres:
        emap.setdefault(r['tx_id'], []).append({
            'debit_account':  r['debit_account'],
            'debit_sub':      r['debit_sub'],
            'credit_account': r['credit_account'],
            'credit_sub':     r['credit_sub'],
            'amount':         r['amount'],
            'memo':           r['memo'],
        })
    result = []
    for r in rows:
        d = dict(r)
        extra = json.loads(d.pop('extra_json', '{}') or '{}')
        d.update(extra)
        d['registered'] = bool(d['registered'])
        d['entries']    = emap.get(d['id'], [])
        result.append(d)
    return result


# ── 会計ロジック（Excel 生成で必要な最小限） ──
MONTHS = ['4月','5月','6月','7月','8月','9月','10月','11月','12月','1月','2月','3月']
HALF1  = MONTHS[:6]
HALF2  = MONTHS[6:]
MN_MAP = {str(m): f'{m}月' for m in range(1, 13)}


def set_fiscal_start(fy_start):
    """会計年度の開始月に合わせて、月の並び（MONTHS・HALF1・HALF2）を作り直す。"""
    global MONTHS, HALF1, HALF2
    s = fy_start if 1 <= fy_start <= 12 else 4
    MONTHS = [f'{(s - 1 + i) % 12 + 1}月' for i in range(12)]
    HALF1, HALF2 = MONTHS[:6], MONTHS[6:]
    excel_set_months(MONTHS)


def fiscal_year_of(date_str, fy_start=4):
    try:
        dt = datetime.strptime(date_str, '%Y/%m/%d')
        return dt.year if dt.month >= fy_start else dt.year - 1
    except Exception:
        return None


def month_key_of(date_str):
    try:
        return MN_MAP.get(str(datetime.strptime(date_str, '%Y/%m/%d').month))
    except Exception:
        return None


def filter_by_fy(txs, year, fy_start=4):
    y = int(year)
    return [t for t in txs if fiscal_year_of(t.get('date', ''), fy_start) == y]


def _empty_m():
    d = {m: 0 for m in MONTHS}
    d['上半期'] = d['下半期'] = d['年度合計'] = 0
    return d


def _sum_halves(d):
    d['上半期']   = sum(d[m] for m in HALF1)
    d['下半期']   = sum(d[m] for m in HALF2)
    d['年度合計'] = d['上半期'] + d['下半期']


def sub_report_config(settings):
    """決算書の別表の設定（core/accounting.php の subReportConfig と同じ）。空なら None。"""
    names = settings.get('sub_report_accounts') or []
    if isinstance(names, str):
        names = re.split(r'[\r\n,、]+', names)
    out = []
    for n in names:
        n = str(n).strip()
        if n and n not in out:
            out.append(n)
    if not out:
        return None
    return (str(settings.get('sub_report_title') or '').strip() or '別表', out)


def calc_kessan(txs, year, only=None):
    """only を指定すると、その勘定科目だけで作る（期首残高は 0）。"""
    accounts = dict(kv_get('accounts', {}))
    if only is not None:
        for t in ('income', 'expense'):
            accounts[t] = [a for a in accounts.get(t, []) if a.get('name') in only]
    settings = kv_get('settings', {})
    fy_start = int(settings.get('fiscal_year_start', 4))
    filtered = filter_by_fy(txs, year, fy_start)
    # 月キャッシュ
    tx_months = [month_key_of(t.get('date', '')) for t in filtered]

    def _build(accts, acct_type):
        sec_tot = _empty_m()
        groups = []
        for acct in accts:
            grp = {'code': acct.get('code', ''), 'name': acct.get('name', ''),
                   'monthly': _empty_m(), 'sub_total': _empty_m(), 'sub': []}
            subs = acct.get('sub') or []
            if subs:
                for sub in subs:
                    sd = {'code': sub.get('code', ''), 'name': sub.get('name', ''),
                          'monthly': _empty_m()}
                    for i, tx in enumerate(filtered):
                        mk = tx_months[i]
                        if not mk:
                            continue
                        for e in tx.get('entries', []):
                            amt = int(e.get('amount', 0) or 0)
                            if not amt:
                                continue
                            if e.get('debit_account') == acct['name'] and e.get('debit_sub') == sub['name']:
                                sd['monthly'][mk] += amt if acct_type == 'expense' else -amt
                            if e.get('credit_account') == acct['name'] and e.get('credit_sub') == sub['name']:
                                sd['monthly'][mk] += amt if acct_type == 'income' else -amt
                    _sum_halves(sd['monthly'])
                    grp['sub'].append(sd)
                    for k, v in sd['monthly'].items():
                        grp['sub_total'][k] += v
                # 補助科目なし分
                for i, tx in enumerate(filtered):
                    mk = tx_months[i]
                    if not mk:
                        continue
                    for e in tx.get('entries', []):
                        amt = int(e.get('amount', 0) or 0)
                        if not amt:
                            continue
                        if e.get('debit_account') == acct['name'] and not e.get('debit_sub'):
                            grp['sub_total'][mk] += amt if acct_type == 'expense' else -amt
                        if e.get('credit_account') == acct['name'] and not e.get('credit_sub'):
                            grp['sub_total'][mk] += amt if acct_type == 'income' else -amt
                _sum_halves(grp['sub_total'])
                src = grp['sub_total']
            else:
                for i, tx in enumerate(filtered):
                    mk = tx_months[i]
                    if not mk:
                        continue
                    for e in tx.get('entries', []):
                        amt = int(e.get('amount', 0) or 0)
                        if not amt:
                            continue
                        if e.get('debit_account') == acct['name']:
                            grp['monthly'][mk] += amt if acct_type == 'expense' else -amt
                        if e.get('credit_account') == acct['name']:
                            grp['monthly'][mk] += amt if acct_type == 'income' else -amt
                _sum_halves(grp['monthly'])
                src = grp['monthly']
            for k in sec_tot:
                sec_tot[k] += src[k]
            groups.append(grp)
        return groups, sec_tot

    inc_g, inc_t = _build(accounts.get('income', []), 'income')
    exp_g, exp_t = _build(accounts.get('expense', []), 'expense')

    net = {k: inc_t[k] - exp_t.get(k, 0) for k in inc_t}

    if only is not None:
        # 別表: 期首残高は 0 として、収支の累計だけを出す
        ob = 0
        breakdown = []
        running = 0
        mb = {}
        for mk in MONTHS:
            running += net.get(mk, 0)
            mb[mk] = running
        mb['上半期'] = net.get('上半期', 0)
        mb['下半期'] = mb['年度合計'] = net.get('年度合計', 0)
    else:
        # 期末残高は資産科目（立替金を除く）の月末残高の合計（core/accounting.php と同じ）
        breakdown = calc_balance_breakdown(filtered, tx_months, str(year), accounts, settings)
        ob = sum(r['opening'] for r in breakdown)
        mb = _empty_m()
        for r in breakdown:
            for k, v in r['monthly'].items():
                mb[k] += v

    return {
        'sections': [
            {'name': '収入の部', 'groups': inc_g, 'total': inc_t},
            {'name': '支出の部', 'groups': exp_g, 'total': exp_t},
        ],
        'net': net,
        'opening_balance': ob,
        'monthly_balance': mb,
        'balance_breakdown': breakdown,
    }


def balance_excluded_accounts(settings):
    """期末残高に入れない資産科目（core/accounting.php の balanceExcludedAccounts と同じ）。"""
    out = ['立替金']
    adv = str(settings.get('advance_debit') or '').strip()
    if adv and adv not in out:
        out.append(adv)
    return out


def opening_balance_map(settings, year):
    """期首残高を「科目」「科目/補助」→金額 にそろえる（旧形式の数値は普通預金）。"""
    raw = (settings.get('opening_balances') or {}).get(str(year), 0) or 0
    if not isinstance(raw, dict):
        return {'普通預金': int(raw)} if raw else {}
    out = {}
    for k, v in raw.items():
        k = re.sub(r'\s*/\s*', '/', str(k).strip())
        out[k] = out.get(k, 0) + int(v or 0)
    return out


def calc_balance_breakdown(filtered, tx_months, year, accounts, settings):
    """期末残高の内訳（core/accounting.php の calcBalanceBreakdown と同じ）。"""
    excluded = balance_excluded_accounts(settings)
    ob_map = opening_balance_map(settings, year)

    def to_bal(ob, delta):
        bal, run = {}, ob
        for mk in MONTHS:
            run += delta.get(mk, 0)
            bal[mk] = run
        bal['上半期'] = bal[MONTHS[5]]
        bal['下半期'] = bal['年度合計'] = bal[MONTHS[11]]
        return bal

    rows = []
    for ac in accounts.get('assets', []) or []:
        name = str(ac.get('name') or '')
        if not name or name in excluded:
            continue
        subs = [str(s.get('name') or '') for s in (ac.get('sub') or []) if s.get('name')]
        delta = {sk: {m: 0 for m in MONTHS} for sk in [''] + subs}
        for i, tx in enumerate(filtered):
            mk = tx_months[i]
            if not mk:
                continue
            for e in tx.get('entries', []):
                amt = int(e.get('amount', 0) or 0)
                if not amt:
                    continue
                if e.get('debit_account') == name:
                    sk = e.get('debit_sub') or ''
                    delta[sk if sk in subs else ''][mk] += amt
                if e.get('credit_account') == name:
                    sk = e.get('credit_sub') or ''
                    delta[sk if sk in subs else ''][mk] -= amt
        ob = {sk: 0 for sk in [''] + subs}
        for k, v in ob_map.items():
            if k == name:
                ob[''] += v
            elif k.startswith(name + '/'):
                sn = k[len(name) + 1:]
                ob[sn if sn in subs else ''] += v

        is_cash = bool(re.search(r'現金|預金', name))
        for sk in (subs + [''] if subs else ['']):
            nonzero = ob[sk] != 0 or any(delta[sk].values())
            if subs and sk == '' and not nonzero:
                continue
            if not is_cash and not nonzero:
                continue
            rows.append({
                'account': name,
                'sub': sk or None,
                'name': sk if sk else (f'{name}（補助科目なし）' if subs else name),
                'opening': ob[sk],
                'monthly': to_bal(ob[sk], delta[sk]),
            })
    return rows


def build_account_ledger_summary(txs):
    summary = {}
    for tx in txs:
        memo_tx = tx.get('memo', '')
        party   = tx.get('party', '')
        date    = tx.get('date', '')
        for e in tx.get('entries', []):
            amt = int(e.get('amount', 0) or 0)
            if not amt:
                continue
            da = e.get('debit_account', '')
            ca = e.get('credit_account', '')
            memo = e.get('memo', '') or memo_tx
            if da:
                s = summary.setdefault(da, {'debit_total': 0, 'credit_total': 0, 'entries': []})
                s['debit_total'] += amt
                s['entries'].append({'date': date, 'party': party, 'counter_account': ca,
                                     'debit': amt, 'credit': 0, 'memo': memo})
            if ca:
                s = summary.setdefault(ca, {'debit_total': 0, 'credit_total': 0, 'entries': []})
                s['credit_total'] += amt
                s['entries'].append({'date': date, 'party': party, 'counter_account': da,
                                     'debit': 0, 'credit': amt, 'memo': memo})
    return summary


# ── メイン ──
def main():
    if len(sys.argv) < 4:
        print('usage: excel_cli.py <input_json> <output_xlsx> <segment> [<qs>]',
              file=sys.stderr)
        sys.exit(1)

    body   = json.loads(open(sys.argv[1], encoding='utf-8').read() or '{}')
    outf   = sys.argv[2]
    seg    = sys.argv[3]
    qs_str = sys.argv[4] if len(sys.argv) > 4 else ''
    qs = dict(p.split('=', 1) for p in qs_str.split('&') if '=' in p)

    settings = kv_get('settings', {})
    fs = int(settings.get('fiscal_year_start', 4))
    set_fiscal_start(fs)

    if seg == 'journal':
        p = create_journal_excel(body.get('transactions', []))
    elif seg == 'detail':
        p = create_detail_excel(body.get('transactions', []), body.get('title', '内訳'))
    elif seg == 'kessan':
        year = qs.get('year', str(datetime.now().year))
        txs  = [t for t in get_all_transactions() if t.get('registered')]
        # 本表の下に、設定で選んだ勘定科目だけの別表を付ける（設定が空なら付けない）
        sub = sub_report_config(settings)
        extra = [(f'{year}年度 {sub[0]}', calc_kessan(txs, year, sub[1]), '収支累計')] if sub else []
        p = create_kessan_excel(calc_kessan(txs, year), year, extra)
    elif seg == 'monthly':
        txs = [t for t in get_all_transactions() if t.get('registered')]
        yr  = body.get('year', '')
        mo  = body.get('month', '')
        by_acc = bool(body.get('by_account', False))
        if yr:
            txs = filter_by_fy(txs, yr, fs)
        if mo:
            mo_int = int(mo)
            txs = [t for t in txs
                   if (t.get('date', '') or '').count('/') >= 2
                   and int(t['date'].split('/')[1]) == mo_int]
        txs.sort(key=lambda t: t.get('date', ''))
        summary = build_account_ledger_summary(txs) if by_acc else None
        p = create_monthly_excel(txs, summary, by_acc)
    elif seg == 'billing_excel':
        members = body.get('members') or kv_get('members', [])
        p = create_billing_excel(members)
    else:
        print(f'error: unknown segment: {seg}', file=sys.stderr)
        sys.exit(1)

    # BytesIO → ファイル
    with open(outf, 'wb') as f:
        f.write(p.getvalue())


if __name__ == '__main__':
    main()
