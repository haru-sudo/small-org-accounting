// ══════════════════════════════════════════════════════════════════════════════
// demo/demo.js — GitHub Pages 用のデモ
//   PHP のサーバーの代わりに、ブラウザの中で API（/api/...・auth.php）をまねて答える。
//   データは架空のサンプルで、この端末のブラウザ（localStorage）にだけ保存する。
//   index.html の、ほかのスクリプトより前に読み込む（.github/workflows/pages.yml が差し込む）。
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  if (window.__soaDemo) return;   // 2回読み込まれても1回だけ動かす
  window.__soaDemo = true;
  const KEY = 'soa-demo-v3';   // サンプルを変えたら番号を上げる（古い保存データを使わない）
  const realFetch = window.fetch.bind(window);

  // ── サンプルデータ ──
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  const pad = n => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}/${pad(m)}/${pad(d)}`;
  const nowStr = () => { const d = new Date(); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

  function seed() {
    const accounts = {
      assets: [
        { code: '100', name: '現金', sub: [] },
        { code: '101', name: '普通預金', sub: [{ code: '10101', name: 'デモ銀行' }] },
        { code: '102', name: '立替金', sub: [] },
        { code: '103', name: '前払金', sub: [] },
      ],
      liabilities: [{ code: '200', name: '未払金', sub: [] }, { code: '201', name: '預り金', sub: [] }],
      equity: [{ code: '300', name: '繰越金', sub: [] }],
      income: [
        { code: '400', name: '会費収入', sub: [{ code: '40001', name: '一般' }, { code: '40002', name: '学生' }] },
        { code: '401', name: '入会金収入', sub: [] },
        { code: '402', name: '合宿収入', sub: [] },
        { code: '403', name: '補助金収入', sub: [] },
        { code: '404', name: '雑収入', sub: [] },
      ],
      expense: [
        { code: '500', name: '会場費', sub: [] },
        { code: '501', name: '備品費', sub: [] },
        { code: '502', name: '合宿費', sub: [] },
        { code: '503', name: '交通費', sub: [] },
        { code: '504', name: '大会参加費', sub: [] },
        { code: '505', name: '保険料', sub: [] },
        { code: '506', name: '支払手数料', sub: [] },
        { code: '507', name: '雑費', sub: [] },
      ],
    };
    const members = [
      ['青木 さくら', 'ｱｵｷ ｻｸﾗ', '一般', 3000], ['石川 大輝', 'ｲｼｶﾜ ﾀﾞｲｷ', '一般', 3000],
      ['上田 美咲', 'ｳｴﾀﾞ ﾐｻｷ', '学生', 1500], ['江口 翔太', 'ｴｸﾞﾁ ｼﾖｳﾀ', '学生', 1500],
      ['大野 陽菜', 'ｵｵﾉ ﾋﾅ', '一般', 3000], ['加藤 蓮', 'ｶﾄｳ ﾚﾝ', '学生', 1500],
      ['木村 結衣', 'ｷﾑﾗ ﾕｲ', '一般', 3000], ['小林 湊', 'ｺﾊﾞﾔｼ ﾐﾅﾄ', '学生', 1500],
    ].map(([name, kana, type, fee]) => ({
      name, kana, type, base_fee: fee, default_sub: type, default_tekiyo: type === '学生' ? '学生会費' : '一般会費',
    }));

    const txs = [];
    const bankSub = 'デモ銀行';
    let bal = 0;
    function bank(date, party, amount, isIn, type, entry, registered = true, autoRule = '') {
      const e = entry ? Object.assign({ amount, memo: '' }, entry) : {
        debit_account: isIn ? '普通預金' : '', debit_sub: isIn ? bankSub : '',
        credit_account: isIn ? '' : '普通預金', credit_sub: isIn ? '' : bankSub, amount, memo: '',
      };
      bal += isIn ? amount : -amount;
      txs.push({
        id: uuid(), group_id: uuid(), date, amount, bank_debit: isIn ? 0 : amount, bank_credit: isIn ? amount : 0,
        type, party, memo: '', registered, auto_rule: autoRule, source_file: 'demo.pdf', entries: [e],
      });
    }
    const inc = (ac, sub, memo) => ({ debit_account: '普通預金', debit_sub: bankSub, credit_account: ac, credit_sub: sub || '', memo });
    const exp = (ac, sub, memo) => ({ debit_account: ac, debit_sub: sub || '', credit_account: '普通預金', credit_sub: bankSub, memo });

    const y = 2026;
    for (const m of [4, 5, 6, 7, 8, 9, 10]) {
      members.forEach((mb, i) => {
        if (m === 10 && i >= 6) return;   // 10月は未入金の人がいる
        bank(ymd(y, m, 3 + (i % 4)), mb.kana, mb.base_fee, true, '振込', inc('会費収入', mb.type, `${mb.name.split(' ')[0]} ${m}月分会費`), true, '会費の入金');
      });
      bank(ymd(y, m, 10), 'ﾏﾙﾏﾙｼﾐﾝﾃﾆｽｺ-ﾄ', 12000 + (m % 3) * 2000, false, '振込', exp('会場費', '', `${m}月 テニスコート利用料`), true, 'テニスコート');
      bank(ymd(y, m, 10), 'ﾌﾘｺﾐﾃｽｳﾘﾖｳ', 330, false, '振替', exp('支払手数料', '', '振込手数料'), true, '振込手数料');
    }
    bank(ymd(y, 4, 15), 'ｶ)ｽﾎﾟ-ﾂﾖｳﾋﾝﾃﾝ', 18700, false, '振込', exp('備品費', '', 'ボール 6ダース'));
    bank(ymd(y, 4, 20), 'ﾆﾕｳｶｲｷﾝ ﾏﾄﾒ', 8000, true, '振込', inc('入会金収入', '', '新入会員 入会金 4名'));
    bank(ymd(y, 5, 8), 'ｽﾎﾟ-ﾂﾎｹﾝ', 6400, false, '振替', exp('保険料', '', 'スポーツ安全保険'));
    bank(ymd(y, 6, 30), 'ｼﾐﾝｶﾂﾄﾞｳｼｴﾝ', 30000, true, '振込', inc('補助金収入', '', '市民活動支援補助金'));
    bank(ymd(y, 7, 20), 'ｶﾞﾂｼﾕｸﾋ ﾏﾄﾒ', 96000, true, '振込', inc('合宿収入', '', '夏合宿 参加費 8名'));
    bank(ymd(y, 8, 18), 'ｶ)ﾔﾏﾉﾔﾄﾞ', 88000, false, '振込', exp('合宿費', '', '夏合宿 宿泊費'));
    bank(ymd(y, 8, 25), 'ｼｴｲﾀｲｶｲ ｼﾞﾑｷﾖｸ', 6000, false, '振込', exp('大会参加費', '', '市民大会 参加費'));
    bank(ymd(y, 9, 12), 'ｶ)ｽﾎﾟ-ﾂﾖｳﾋﾝﾃﾝ', 9900, false, '振込', exp('備品費', '', 'ネット 補修'));
    // 未登録（明細を取り込んだだけで、まだ仕訳していない）
    bank(ymd(y, 10, 21), 'ｶ)ｽﾎﾟ-ﾂﾖｳﾋﾝﾃﾝ', 4400, false, '振込', null, false);
    bank(ymd(y, 10, 24), 'ﾔﾏﾀﾞ ﾊﾅｺ', 2000, true, '振込', null, false);
    bank(ymd(y, 10, 28), 'ｺﾝﾋﾞﾆ ATM', 10000, false, '現金', null, false);
    // 現金の手入力
    txs.push({ id: uuid(), group_id: uuid(), date: ymd(y, 9, 20), amount: 1200, bank_debit: 0, bank_credit: 0, type: '手動', party: 'コンビニ', memo: '', registered: true, auto_rule: '', source_file: '手動入力',
      entries: [{ debit_account: '雑費', debit_sub: '', credit_account: '現金', credit_sub: '', amount: 1200, memo: '大会 飲み物' }] });

    // 交通費・立替申請（外部の申請フォームから届いた想定）
    const claim = (o) => Object.assign({ id: uuid(), status: 'pending', journaled: false, pending_match: false, journal_tx_id: '', created_at: o.application_date + ' 21:00', memo: '', description: '' }, o);
    const paidTxId = uuid();
    const claims = [
      claim({ type: 'transport', applicant: '上田 美咲', person_kana: 'ｳｴﾀﾞ ﾐｻｷ', amount: 1240, application_date: '2026/10/26', work_date: '2026/10/25',
        work_destination: '市民大会', from_station: '中央駅', to_station: '運動公園前', ticket_type: 'ic',
        route_detail: '【往路】\n中央駅 → 運動公園前（市営バス）620円\n【復路】\n運動公園前 → 中央駅（市営バス）620円' }),
      claim({ type: 'advance', applicant: '石川 大輝', person_kana: 'ｲｼｶﾜ ﾀﾞｲｷ', amount: 3280, application_date: '2026/10/27',
        usage: 'テニスボール', store: 'スポーツ用品店', description: 'テニスボール (スポーツ用品店)', memo: 'テニスボール 2缶' }),
      claim({ type: 'transport', applicant: '江口 翔太', person_kana: 'ｴｸﾞﾁ ｼﾖｳﾀ', amount: 880, application_date: '2026/10/19', work_date: '2026/10/18',
        work_destination: '練習試合', from_station: '北駅', to_station: '中央駅', ticket_type: 'ic', status: 'approved',
        route_detail: '【往路】\n北駅 → 中央駅 440円\n【復路】\n中央駅 → 北駅 440円' }),
      claim({ type: 'advance', applicant: '木村 結衣', person_kana: 'ｷﾑﾗ ﾕｲ', amount: 2200, application_date: '2026/10/08',
        usage: '救急セット', store: 'ドラッグストア', description: '救急セット (ドラッグストア)', memo: '救急セット 補充',
        status: 'paid', paid_date: '2026/10/15', journaled: true, journal_tx_id: paidTxId }),
      claim({ type: 'transport', applicant: '加藤 蓮', person_kana: 'ｶﾄｳ ﾚﾝ', amount: 1240, application_date: '2026/10/27', work_date: '2026/10/25',
        work_destination: '市民大会', from_station: '中央駅', to_station: '運動公園前', ticket_type: 'ic', status: 'rejected',
        memo: '同じ日の申請が2件あったため却下', route_detail: '【往路】\n中央駅 → 運動公園前 620円\n【復路】\n運動公園前 → 中央駅 620円' }),
    ];
    // 返金済みの立替の仕訳（返金の振込）
    txs.push({ id: paidTxId, group_id: uuid(), date: '2026/10/15', amount: 2200, bank_debit: 2200, bank_credit: 0, type: '振込', party: 'ｷﾑﾗ ﾕｲ', memo: '救急セット 補充',
      registered: true, auto_rule: '申請自動仕訳:advance', source_file: 'demo.pdf', claim_id: claims[3].id,
      entries: [{ debit_account: '立替金', debit_sub: '', credit_account: '普通預金', credit_sub: bankSub, amount: 2200, memo: '救急セット 補充' }] });

    const rules = [
      { name: 'テニスコート', pattern: 'ﾏﾙﾏﾙｼﾐﾝﾃﾆｽｺ-ﾄ', debit_account: '会場費', debit_sub: '', credit_account: '普通預金', credit_sub: bankSub, memo_template: '{$取引月}月 テニスコート利用料', priority: 10 },
      { name: '振込手数料', pattern: 'ﾌﾘｺﾐﾃｽｳﾘﾖｳ', debit_account: '支払手数料', debit_sub: '', credit_account: '普通預金', credit_sub: bankSub, memo_template: '振込手数料', priority: 9 },
      { name: 'スポーツ用品店', pattern: 'ｽﾎﾟ-ﾂﾖｳﾋﾝﾃﾝ', debit_account: '備品費', debit_sub: '', credit_account: '普通預金', credit_sub: bankSub, memo_template: '', priority: 5 },
    ];

    const sheetMembers = members.map((mb, i) => ({
      name: mb.name, kana: mb.kana, fee: mb.base_fee, paid: i < 6, paid_at: i < 6 ? ymd(y, 10, 3 + (i % 4)) : '',
      debit_account: '普通預金', debit_sub: bankSub, credit_account: '会費収入', credit_sub: mb.type,
      auto_journal: true, tekiyo: mb.default_tekiyo, memo_template: '{$相手先} {$取引月}月分会費',
    }));
    const sheets = [{
      id: uuid(), type: 'buhi', title: '', period: '2026/10', start_date: '2026/10/01', due_date: '2026/10/10',
      checked_at: '2026/10/12 21:00', matched_count: 6, journaled_count: 6, created_at: '2026/09/25 20:00', members: sheetMembers,
    }];

    const invoices = [{
      id: uuid(), invoice_no: 'INV-2026-001', subject: '市民大会 運営協力費', client_name: '○○市テニス協会',
      issued_date: '2026/09/30', due_date: '2026/10/31', tax_rate: 0, notes: 'デモ銀行 中央支店 普通 1234567\nﾃﾞﾓ ﾃﾆｽｻ-ｸﾙ',
      status: '入金済', created_at: '2026/09/30 10:00', doc_type: '請求書',
      items: [{ name: '大会運営スタッフ 3名 × 2日', qty: 1, unit_price: 30000 }],
      from_name: 'デモ テニスサークル', from_zip: '', from_addr: '', from_tel: '',
    }];

    const settings = {
      club_name: 'デモ テニスサークル', fiscal_year_start: 4, payment_grace_days: 7, bank_account_sub: bankSub,
      opening_balances: { '2026': { '普通預金/デモ銀行': 152000, '現金': 10000 } },
      features: { invoice: true, billing: true, credit_card: true, claims: true, ai: true, ai_slack: false },
      login_methods: { password: true, slack: false, google: false },
      fee_presets: '3000 一般会費\n1500 学生会費',
      sub_report_title: '合宿収支表', sub_report_accounts: ['合宿収入', '合宿費'],
      invoice_from_name: 'デモ テニスサークル', invoice_notes: 'デモ銀行 中央支店 普通 1234567\nﾃﾞﾓ ﾃﾆｽｻ-ｸﾙ',
    };
    const uploadDates = [];
    for (let m = 4; m <= 10; m++) for (let d = 1; d <= (m === 10 ? 31 : new Date(y, m, 0).getDate()); d++) uploadDates.push(ymd(y, m, d));

    return {
      accounts, members, transactions: txs, rules, credit_rules: [], sheets, invoices, settings,
      published: { '2026': ['4月', '5月', '6月', '7月', '8月', '9月'] },
      upload_dates: uploadDates, claims, deadlines: { '2026-09': true },
      users: [
        { email: 'demo@example.com', name: 'デモ 管理者', slack_id: '', role: 'admin', note: 'デモ用', added_at: '2026/04/01 10:00:00', added_by: 'setup', has_password: true },
        { email: 'member@example.com', name: 'デモ メンバー', slack_id: '', role: 'viewer', note: '', added_at: '2026/04/01 10:00:00', added_by: 'demo@example.com', has_password: true },
      ],
      default_role: 'denied',
      logs: [{ id: uuid(), ts: '2026/11/01 09:00:00', action: 'ログイン', target: 'auth', detail: 'パスワードでログインしました（管理者）', user_name: 'デモ 管理者', user_email: 'demo@example.com' }],
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { db = null; }
  if (!db || !db.accounts) db = seed();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 保存できなくても画面は動く */ } };
  save();
  window.demoReset = () => { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); };

  // ── 決算書の計算（core/accounting.php の calcKessan と同じ）──
  const fyStart = () => { const m = parseInt(db.settings.fiscal_year_start || 4, 10); return m >= 1 && m <= 12 ? m : 4; };
  const fyMonths = () => Array.from({ length: 12 }, (_, i) => ((fyStart() - 1 + i) % 12 + 1) + '月');
  const fyOf = date => { const [y, m] = date.split('/').map(Number); return m >= fyStart() ? y : y - 1; };
  const monthKey = date => parseInt(date.split('/')[1], 10) + '月';
  function emptyM() { const d = {}; fyMonths().forEach(m => d[m] = 0); d['上半期'] = d['下半期'] = d['年度合計'] = 0; return d; }
  function sumHalves(d) { const ms = fyMonths(); d['上半期'] = ms.slice(0, 6).reduce((s, k) => s + d[k], 0); d['下半期'] = ms.slice(6).reduce((s, k) => s + d[k], 0); d['年度合計'] = d['上半期'] + d['下半期']; }
  function calcKessan(year, only) {
    const txs = db.transactions.filter(t => t.registered && t.date && fyOf(t.date) === parseInt(year, 10));
    const pick = t => (db.accounts[t] || []).filter(a => !only || only.includes(a.name));
    const add = (d, mk, e, ac, sub, side, type) => {
      const amt = parseInt(e.amount || 0, 10); if (!amt) return;
      if (e.debit_account === ac && (sub === undefined || (sub === null ? !e.debit_sub : e.debit_sub === sub))) d[mk] += type === 'expense' ? amt : -amt;
      if (e.credit_account === ac && (sub === undefined || (sub === null ? !e.credit_sub : e.credit_sub === sub))) d[mk] += type === 'income' ? amt : -amt;
    };
    function section(accts, type) {
      const tot = emptyM(); const groups = [];
      accts.forEach(a => {
        const g = { code: a.code || '', name: a.name, monthly: emptyM(), sub_total: emptyM(), sub: [] };
        let src;
        if ((a.sub || []).length) {
          a.sub.forEach(s => {
            const sd = { code: s.code || '', name: s.name, monthly: emptyM() };
            txs.forEach(t => (t.entries || []).forEach(e => add(sd.monthly, monthKey(t.date), e, a.name, s.name, null, type)));
            sumHalves(sd.monthly); g.sub.push(sd);
            Object.keys(sd.monthly).forEach(k => g.sub_total[k] += sd.monthly[k]);
          });
          txs.forEach(t => (t.entries || []).forEach(e => add(g.sub_total, monthKey(t.date), e, a.name, null, null, type)));
          sumHalves(g.sub_total); src = g.sub_total;
        } else {
          txs.forEach(t => (t.entries || []).forEach(e => add(g.monthly, monthKey(t.date), e, a.name, undefined, null, type)));
          sumHalves(g.monthly); src = g.monthly;
        }
        Object.keys(tot).forEach(k => tot[k] += src[k]);
        groups.push(g);
      });
      return [groups, tot];
    }
    const [incG, incT] = section(pick('income'), 'income');
    const [expG, expT] = section(pick('expense'), 'expense');
    const net = {}; Object.keys(incT).forEach(k => net[k] = incT[k] - expT[k]);
    const obRaw = only ? 0 : (db.settings.opening_balances || {})[String(year)] || 0;
    const ob = typeof obRaw === 'object' ? Object.values(obRaw).reduce((s, v) => s + parseInt(v || 0, 10), 0) : parseInt(obRaw || 0, 10);
    const mb = {}; let run = ob; const ms = fyMonths();
    ms.forEach(m => { run += net[m] || 0; mb[m] = run; });
    mb['上半期'] = ob + net['上半期']; mb['下半期'] = mb[ms[5]] + net['下半期']; mb['年度合計'] = ob + net['年度合計'];
    return { sections: [{ name: '収入の部', groups: incG, total: incT }, { name: '支出の部', groups: expG, total: expT }], net, opening_balance: ob, monthly_balance: mb };
  }
  function advanceBalance(year) {
    const bal = {}; let run = 0; const delta = {}; const ms = fyMonths(); ms.forEach(m => delta[m] = 0);
    db.transactions.filter(t => t.registered && t.date && fyOf(t.date) === parseInt(year, 10)).forEach(t => (t.entries || []).forEach(e => {
      const a = parseInt(e.amount || 0, 10);
      if (e.debit_account === '立替金') delta[monthKey(t.date)] += a;
      if (e.credit_account === '立替金') delta[monthKey(t.date)] -= a;
    }));
    ms.forEach(m => { run += delta[m]; bal[m] = run; });
    bal['上半期'] = bal[ms[5]]; bal['下半期'] = bal['年度合計'] = bal[ms[11]];
    return bal;
  }
  function kessanDetail(name, sub, month, year) {
    const ms = fyMonths().map(m => parseInt(m, 10));
    const pm = month === '上半期' ? ms.slice(0, 6) : month === '下半期' ? ms.slice(6) : month === '年度合計' ? ms : [parseInt(month, 10)];
    const out = [];
    db.transactions.filter(t => t.registered && t.date && fyOf(t.date) === parseInt(year, 10) && pm.includes(parseInt(t.date.split('/')[1], 10)))
      .forEach(t => (t.entries || []).forEach(e => {
        const amt = parseInt(e.amount || 0, 10); if (!amt) return;
        const dr = e.debit_account === name, cr = e.credit_account === name;
        if (!dr && !cr) return;
        if (sub && ((dr && e.debit_sub !== sub) || (cr && e.credit_sub !== sub))) return;
        out.push({ date: t.date, party: t.party || '', counter: dr ? e.credit_account : e.debit_account, debit_amt: dr ? amt : 0, credit_amt: cr ? amt : 0, memo: e.memo || t.memo || '' });
      }));
    return out;
  }
  // 自動仕訳ルールを未登録の取引に当てる（core/accounting.php の applyRulesToTx の簡易版）
  function applyRules() {
    const fold = s => String(s || '').replace(/[\s　]/g, '');
    let n = 0;
    const rules = [...db.rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    db.transactions.filter(t => !t.registered).forEach(t => {
      const r = rules.find(r => { try { return !r.pattern || new RegExp(fold(r.pattern), 'i').test(fold(t.party)); } catch (e) { return false; } });
      if (!r) return;
      const m = parseInt(t.date.split('/')[1], 10);
      const memo = String(r.memo_template || '').replace(/\{\$取引月\}/g, m).replace(/\{\$取引年\}/g, t.date.slice(0, 4)).replace(/\{\$相手先\}/g, t.party || '');
      const e = t.entries[0] || (t.entries[0] = { amount: t.amount });
      if (r.debit_account) { e.debit_account = r.debit_account; e.debit_sub = r.debit_sub || ''; }
      if (r.credit_account) { e.credit_account = r.credit_account; e.credit_sub = r.credit_sub || ''; }
      if (memo) e.memo = memo;
      t.auto_rule = r.name || '';
      if (e.debit_account && e.credit_account) t.registered = true;
      n++;
    });
    return n;
  }

  // ── デモの AIアシスタントの返答 ──
  function aiView(conv) {
    return { conversation_id: conv.id, title: conv.title, items: conv.items, pending: false, updated_at: conv.updated_at || '', busy_by: '' };
  }
  const yenS = v => (v < 0 ? '−¥' : '¥') + Math.abs(Math.round(v)).toLocaleString();
  function aiDemoAnswer(msg) {
    const note = '\n\n※ デモの返答です。サーバーに置いて Claude の APIキーを登録すると、AIが帳簿を読んで質問に答え、仕訳やルールの作成も代わりに行います（変更は実行の前に承認を求めます）。';
    const fy = 2026;
    const fyTx = db.transactions.filter(t => t.date && fyOf(t.date) === fy);
    if (/未登録|仕訳して|片付/.test(msg)) {
      const un = fyTx.filter(t => !t.registered);
      if (!un.length) return 'まだ登録していない取引はありません。' + note;
      const guess = t => /ｽﾎﾟ-ﾂ/.test(t.party) ? '備品費' : /ATM/.test(t.party) ? '現金（引き出し）' : t.bank_credit ? '会費収入（名簿にない名前なので要確認）' : '雑費';
      return `まだ登録していない取引が ${un.length}件あります。過去の仕訳をもとに、次のように付けるのはどうでしょう。\n\n| 日付 | 相手先 | 金額 | 提案する科目 |\n|---|---|---|---|\n`
        + un.map(t => `| ${t.date} | ${t.party} | ${yenS(t.bank_credit || -t.bank_debit || t.amount)} | ${guess(t)} |`).join('\n')
        + '\n\nよければ「この内容で仕訳して」と送ってください。実際の版では、承認すると仕訳帳に反映されます。' + note;
    }
    if (/支出|使った|科目/.test(msg)) {
      const k = calcKessan(String(fy));
      const rows = k.sections[1].groups.map(g => [g.name, (g.sub && g.sub.length ? g.sub_total : g.monthly)['年度合計']]).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
      const tot = rows.reduce((s, r) => s + r[1], 0);
      return `${fy}年度の支出は合計 ${yenS(tot)} です。多い順に並べると次のとおりです。\n\n| 科目 | 金額 | 割合 |\n|---|---|---|\n`
        + rows.map(r => `| ${r[0]} | ${yenS(r[1])} | ${Math.round(r[1] / tot * 100)}% |`).join('\n')
        + `\n\nいちばん大きいのは **${rows[0][0]}** です。` + note;
    }
    if (/会費|入金状況|未入金/.test(msg)) {
      const sh = db.sheets[0];
      if (!sh) return 'まだ会費の請求シートがありません。' + note;
      const un = sh.members.filter(x => !x.paid);
      return `「${sh.period}月分 会費」は ${sh.members.length}人中 ${sh.members.length - un.length}人が入金済みです。`
        + (un.length ? `\n\nまだ入金がないのは次の ${un.length}人です。\n\n` + un.map(x => `- ${x.name}（${yenS(x.fee)}）`).join('\n') : '\n\n全員の入金を確認できました。') + note;
    }
    if (/申請/.test(msg)) {
      const p = db.claims.filter(c => (c.status || 'pending') === 'pending');
      if (!p.length) return '未承認の申請はありません。' + note;
      return `未承認の申請が ${p.length}件あります。\n\n| 申請者 | 種類 | 金額 | 内容 |\n|---|---|---|---|\n`
        + p.map(c => `| ${c.applicant} | ${c.type === 'transport' ? '交通費' : '立替'} | ${yenS(c.amount)} | ${c.type === 'transport' ? `${c.work_date} ${c.work_destination}` : (c.memo || c.usage || '')} |`).join('\n') + note;
    }
    if (/残高/.test(msg)) {
      const k = calcKessan(String(fy));
      const ms = fyMonths().filter(mm => fyTx.some(t => monthKey(t.date) === mm));
      return `${fy}年度の月末の残高（期首残高＋登録済みの取引）は次のとおりです。\n\n| 月 | 月末の残高 |\n|---|---|\n`
        + ms.map(mm => `| ${mm} | ${yenS(k.monthly_balance[mm])} |`).join('\n') + note;
    }
    if (/ルール/.test(msg)) {
      const cnt = {};
      fyTx.forEach(t => { if (t.party && t.bank_debit) cnt[t.party] = (cnt[t.party] || 0) + 1; });
      const ruled = new Set(db.rules.map(r => r.pattern));
      const cand = Object.entries(cnt).filter(([p, n]) => n >= 2 && !ruled.has(p)).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!cand.length) return 'くり返し出てくる相手先には、すでにルールがあります。' + note;
      return 'くり返し出てくる出金の相手先で、まだルールがないものです。ルールにすると、次から自動で科目が入ります。\n\n| 相手先 | 回数 |\n|---|---|\n'
        + cand.map(([p, n]) => `| ${p} | ${n}回 |`).join('\n') + note;
    }
    return 'こんにちは。会計のことなら何でも聞いてください。たとえば「未登録の取引を仕訳して」「今年度の支出が多い科目を教えて」「今月の会費の入金状況を教えて」のように頼めます。' + note;
  }

  // ── API ──
  const FEATURE_META = {
    invoice: { label: '請求書・見積書' }, billing: { label: '会費の請求シートと振込確認' },
    credit_card: { label: 'クレジットカード明細の取り込み' }, claims: { label: '交通費・立替申請（外部の申請フォーム連携）' },
    ai: { label: 'AIアシスタント（Claude API）' }, ai_slack: { label: 'AIアシスタントの Slack チャンネル参照' },
  };
  const DEMO_ONLY = 'デモでは使えません（サーバーに置くと使えます）';
  function settingsOut() {
    const s = JSON.parse(JSON.stringify(db.settings));
    s.features = Object.assign({ invoice: true, billing: true, credit_card: true, claims: false, ai: true, ai_slack: false }, s.features || {});
    if (!s.features.ai) s.features.ai_slack = false;
    s.feature_meta = FEATURE_META;
    s.secrets_set = { slack_client_secret: false, google_client_secret: false, php_internal_token: false };
    return s;
  }
  function log(action, target, detail) {
    db.logs.push({ id: uuid(), ts: nowStr(), action, target, detail: String(detail || '').slice(0, 1000), user_name: 'デモ 管理者', user_email: 'demo@example.com' });
  }
  async function bodyOf(init) {
    if (!init || !init.body) return {};
    if (typeof init.body === 'string') { try { return JSON.parse(init.body); } catch (e) { return {}; } }
    return {};   // FormData（ファイルのアップロード）は扱わない
  }

  // 「設定」の保存はデモでは受け付けない（だれが開いても同じデモになるように）
  const SETTINGS_WRITE = ['/settings', '/settings/claims', '/accounts', '/rules', '/credit-rules', '/ai/settings'];
  const SETTINGS_MSG = 'デモでは設定は保存できません（画面の表示が変わっても、読み込み直すと元に戻ります）';

  async function api(path, method, q, b) {
    let m;
    if (method !== 'GET' && SETTINGS_WRITE.includes(path)) return [403, { error: SETTINGS_MSG, message: SETTINGS_MSG, demo_blocked: true }];
    // 取引
    if (path === '/transactions' && method === 'GET') return { transactions: db.transactions };
    if (path === '/transactions' && method === 'POST') { const t = Object.assign({ id: uuid(), group_id: uuid() }, b); db.transactions.push(t); return { ok: true, transaction: t }; }
    if ((m = path.match(/^\/transactions\/([^/]+)$/))) {
      const i = db.transactions.findIndex(t => t.id === m[1]);
      if (method === 'DELETE') { if (i >= 0) db.transactions.splice(i, 1); return { ok: true }; }
      if (i < 0) return [404, { error: 'not found' }];
      const t = Object.assign(db.transactions[i], b);
      if (!b.entries && ['debit_account', 'credit_account'].some(k => k in b) && t.entries && t.entries.length === 1) {
        ['debit_account', 'debit_sub', 'credit_account', 'credit_sub'].forEach(k => { if (k in b) t.entries[0][k] = b[k]; });
      }
      return { ok: true };
    }
    // マスタ
    if (path === '/accounts') { if (method === 'POST') { db.accounts = b; return { ok: true }; } return db.accounts; }
    if (path === '/rules') { if (method === 'POST') { db.rules = b.rules || []; return { ok: true }; } return { rules: db.rules }; }
    if (path === '/credit-rules') { if (method === 'POST') { db.credit_rules = b.rules || []; return { ok: true }; } return { rules: db.credit_rules }; }
    if (path === '/members') { if (method === 'POST') { db.members = b.members || []; return { ok: true }; } return { members: db.members }; }
    if (path === '/settings') {
      if (method === 'POST') {
        ['feature_meta', 'secrets_set'].forEach(k => delete b[k]);
        if (b.login_methods && (b.login_methods.slack || b.login_methods.google)) return [400, { error: 'デモでは Slack・Google のログインは設定できません' }];
        Object.assign(db.settings, b); return { ok: true };
      }
      return settingsOut();
    }
    if (path === '/apply-rules') return { updated: applyRules() };
    if (path === '/apply-credit-rules') return { updated: 0 };
    // 決算書
    if (path === '/kessan') {
      const year = q.get('year') || '2026';
      const r = calcKessan(year);
      const sub = db.settings.sub_report_accounts || [];
      if (sub.length) { r.sub_report = calcKessan(year, sub); r.sub_report_title = db.settings.sub_report_title || '別表'; }
      r.advance_balance = advanceBalance(year);
      r.published_months = db.published[year] || [];
      r.is_admin = true;
      return r;
    }
    if (path === '/kessan/detail') return { transactions: kessanDetail(q.get('name') || '', q.get('sub') || '', q.get('month') || '', q.get('year') || '') };
    if (path === '/kessan/published') {
      if (method === 'POST') { const y = String(b.year); db.published[y] = fyMonths().filter(x => (b.months || []).includes(x)); return { ok: true, year: y, months: db.published[y] }; }
      const y = q.get('year') || '2026'; return { year: y, months: db.published[y] || [], all: fyMonths(), is_admin: true };
    }
    // 請求書
    if (path === '/invoices') {
      if (method === 'POST') { const inv = Object.assign({ id: uuid(), created_at: nowStr() }, b); db.invoices.unshift(inv); return { ok: true, invoice: inv }; }
      return { invoices: db.invoices };
    }
    if ((m = path.match(/^\/invoices\/([^/]+)$/))) {
      const i = db.invoices.findIndex(x => x.id === m[1]);
      if (method === 'DELETE') { if (i >= 0) db.invoices.splice(i, 1); return { ok: true }; }
      if (i >= 0) Object.assign(db.invoices[i], b); return { ok: true };
    }
    // 請求シート
    if (path === '/billing/sheets') {
      if (method === 'POST') { const s = Object.assign({ id: uuid(), created_at: nowStr(), matched_count: 0, journaled_count: 0 }, b); s.members = (s.members || []).map(x => Object.assign({ paid: false }, x)); db.sheets.unshift(s); return { ok: true, sheet: s }; }
      return { sheets: db.sheets };
    }
    if ((m = path.match(/^\/billing\/sheets\/([^/]+)$/))) {
      const i = db.sheets.findIndex(x => x.id === m[1]);
      if (method === 'DELETE') { if (i >= 0) db.sheets.splice(i, 1); return { ok: true }; }
      if (i < 0) return [404, { error: 'not found' }];
      const s = db.sheets[i]; const mem = b.members; delete b.members;
      Object.assign(s, b);
      if (Array.isArray(mem)) s.members.forEach((x, k) => { if (mem[k]) Object.assign(x, { fee: mem[k].fee, tekiyo: mem[k].tekiyo, memo_template: mem[k].memo_template }); });
      return { ok: true };
    }
    if ((m = path.match(/^\/billing\/check\/([^/]+)$/))) {
      const s = db.sheets.find(x => x.id === m[1]); if (s) s.checked_at = nowStr().slice(0, 16);
      return { ok: true, matched: s ? s.members.filter(x => x.paid).length : 0, journaled: 0 };
    }
    if ((m = path.match(/^\/billing\/manual-paid\/([^/]+)$/))) {
      const s = db.sheets.find(x => x.id === m[1]); const mb = s && s.members[b.index];
      if (!mb) return [404, { error: 'メンバーが見つかりません' }];
      Object.assign(mb, { paid: !!b.paid, manual_paid: !!b.paid, paid_at: b.paid ? (b.date || nowStr().slice(0, 10)) : '' });
      return { ok: true, member: mb };
    }
    // 取り込み
    if (path === '/upload-dates') return { dates: db.upload_dates };
    if (path === '/uploads' || path === '/credit-csv-uploads') return { files: [] };
    if (path === '/reset-history') return { resets: [] };
    if (['/upload', '/upload-credit-csv', '/reset-period', '/reset-undo', '/receipt-upload'].includes(path)) return [400, { success: false, error: DEMO_ONLY }];
    // 申請
    if (path === '/claims') { if (method === 'POST') { const c = Object.assign({ id: uuid(), status: 'pending', created_at: nowStr() }, b); db.claims.unshift(c); return { ok: true, claim: c }; } return { claims: db.claims }; }
    if ((m = path.match(/^\/claims\/([^/]+)$/))) {
      const i = db.claims.findIndex(x => x.id === m[1]);
      if (method === 'DELETE') { if (i >= 0) db.claims.splice(i, 1); return { ok: true }; }
      if (i >= 0) Object.assign(db.claims[i], b); return { ok: true };
    }
    if ((m = path.match(/^\/claims\/([^/]+)\/journal$/))) {
      // 返金の仕訳を作る（core/operations.php の opJournalClaim と同じ）
      const c = db.claims.find(x => x.id === m[1]); if (!c) return [404, { error: '申請が見つかりません' }];
      const tr = c.type === 'transport';
      const memo = b.memo || (tr ? `${(c.work_date || '').split('/').slice(1).map(Number).join('/')}${c.work_destination || ''}交通費` : (c.memo || c.usage || ''));
      const e = { debit_account: b.debit_account || c.fallback_debit || (tr ? '交通費' : '立替金'), debit_sub: b.debit_sub || c.fallback_debit_sub || '',
        credit_account: b.credit_account || c.fallback_credit || '普通預金', credit_sub: b.credit_sub || c.fallback_credit_sub || (db.settings.bank_account_sub || ''), amount: parseInt(c.amount || 0, 10), memo };
      const tx = { id: uuid(), group_id: uuid(), date: c.paid_date || nowStr().slice(0, 10), party: c.applicant || '', memo, registered: true,
        auto_rule: '申請自動仕訳:' + c.type, claim_id: c.id, type: '手動', source_file: '手動入力', entries: [e] };
      db.transactions.push(tx);
      Object.assign(c, { journaled: true, journal_tx_id: tx.id, pending_match: false });
      return { ok: true, tx };
    }
    if (path === '/settings/claims') {
      if (method === 'POST') { Object.assign(db.settings, b); return { ok: true }; }
      const s = db.settings;
      return { refund_days: s.refund_days ?? 3, transport_debit: s.transport_debit || '交通費', transport_debit_sub: s.transport_debit_sub || '', advance_debit: s.advance_debit || '立替金', advance_debit_sub: s.advance_debit_sub || '', refund_credit: s.refund_credit || '普通預金', refund_credit_sub: s.refund_credit_sub || s.bank_account_sub || '' };
    }
    if (path === '/transport-deadlines') {
      if (method === 'POST') { if (b.closed) db.deadlines[b.month] = true; else delete db.deadlines[b.month]; return { ok: true, deadlines: db.deadlines }; }
      return { deadlines: db.deadlines };
    }
    // AIアシスタント（デモでは Claude を呼ばず、サンプルのデータから決まった形の返答を作る）
    if (path.startsWith('/ai/')) {
      db.aiConvs = db.aiConvs || [];
      if (path === '/ai/settings' && method === 'GET') return { has_key: true, key_hint: 'デモ', model: 'claude-opus-5-5', effort: 'medium', auto_approve: false, instructions: '',
        has_slack: false, slack_channels: '', viewer_daily_limit: 20, admin_daily_limit: 0, models: { 'claude-opus-5-5': 'AIアシスタント Pro（デモ）' }, efforts: ['low', 'medium', 'high'], viewer: false };
      if (path === '/ai/conversations' && method === 'GET') return { conversations: db.aiConvs.map(c => ({ id: c.id, title: c.title, updated_at: c.updated_at, user_name: 'デモ 管理者' })).reverse() };
      if ((m = path.match(/^\/ai\/conversations\/([^/]+)$/))) {
        const i = db.aiConvs.findIndex(c => c.id === m[1]);
        if (i < 0) return [404, { error: '会話が見つかりません' }];
        if (method === 'DELETE') { db.aiConvs.splice(i, 1); return { ok: true }; }
        return aiView(db.aiConvs[i]);
      }
      if (path === '/ai/chat') {
        const msg = String(b.message || '').trim();
        let conv = db.aiConvs.find(c => c.id === b.conversation_id);
        if (!conv) { conv = { id: uuid(), title: msg.slice(0, 30), items: [] }; db.aiConvs.push(conv); }
        conv.items.push({ kind: 'user', text: msg, author: 'デモ 管理者', email: 'demo@example.com', at: nowStr() });
        conv.items.push({ kind: 'assistant', text: aiDemoAnswer(msg) });
        conv.updated_at = nowStr();
        return aiView(conv);
      }
      if (path === '/ai/approve') return [400, { error: 'デモでは変更の実行はできません' }];
      return [400, { error: 'デモでは使えません（Claude の APIキーを登録したサーバーで使えます）' }];
    }
    if (path.startsWith('/export/') || path === '/billing/excel') return [400, { error: DEMO_ONLY }];
    return [404, { error: 'Not found', path }];
  }

  async function auth(p, method, b) {
    if (p === '/auth/config') return { methods: { password: true, slack: false, google: false }, needs_setup: false, club_name: db.settings.club_name || '' };
    if (p === '/auth/me') return { user: { id: 'pw:demo@example.com', name: 'デモ 管理者', email: 'demo@example.com', picture: '', provider: 'password', role: 'admin' }, logged_in: true, role: 'admin' };
    if (p === '/auth/users') {
      if (method === 'POST') return [403, { error: SETTINGS_MSG, demo_blocked: true }];
      if (false) {
        if (b.users) db.users = b.users.map(u => Object.assign({}, u, { has_password: u.has_password || !!u.new_password, new_password: undefined }));
        if (b.default_role) db.default_role = b.default_role;
        return { ok: true, users: db.users };
      }
      return { users: db.users, default_role: db.default_role, me: 'demo@example.com' };
    }
    if (p === '/auth/logs') {
      if (method === 'POST') { log(b.action || '', b.target || '', b.detail || ''); return { ok: true }; }
      return { logs: [...db.logs].reverse() };
    }
    if (p === '/auth/logout') return { ok: true };
    if (p === '/auth/password' || p === '/auth/login' || p === '/auth/setup') return [400, { error: DEMO_ONLY }];
    return [404, { error: 'Not found' }];
  }

  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  window.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = ((init && init.method) || 'GET').toUpperCase();
    let out = null;
    if (url.pathname.endsWith('/auth.php')) {
      out = await auth(url.searchParams.get('_path') || '', method, await bodyOf(init));
    } else {
      const i = url.pathname.indexOf('/api/');
      if (i >= 0) out = await api(url.pathname.slice(i + 4), method, url.searchParams, await bodyOf(init));
    }
    if (out === null) return realFetch(input, init);
    if (method !== 'GET') save();
    // 保存できなかったことを、画面の「保存しました」より後に知らせる
    if (Array.isArray(out) && out[1] && out[1].demo_blocked) {
      setTimeout(() => { if (typeof window.toast === 'function') window.toast('' + SETTINGS_MSG, '#d97706'); }, 350);
    }
    return Array.isArray(out) ? json(out[0], out[1]) : json(200, out);
  };

  // ── デモの帯 ──
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = '<span class="demo-long">デモ版です。データは架空のサンプルで、このブラウザにだけ保存されます。設定の保存・明細の取り込み・Excel 出力はできず、AIアシスタントはお試しの返答です。</span><span class="demo-short">デモ版（架空のデータ）</span>'
      + '<button type="button" onclick="demoReset()">最初の状態に戻す</button>'
      + '<a href="https://github.com/haru-sudo/small-org-accounting" target="_blank" rel="noopener">GitHub</a>';
    document.body.prepend(bar);
    const st = document.createElement('style');
    st.textContent = '.demo-bar{position:sticky;top:0;z-index:10000;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:center;background:#fef3c7;color:#78350f;border-bottom:1px solid #fcd34d;padding:6px 16px;font-size:12px;line-height:1.5}'
      + '.demo-bar button{background:#fff;border:1px solid #f59e0b;border-radius:5px;padding:2px 10px;font-size:12px;cursor:pointer;color:#78350f}'
      + '.demo-bar a{color:#78350f;font-weight:700}.demo-short{display:none}'
      + '@media(max-width:768px){.demo-long{display:none}.demo-short{display:inline}.demo-bar{padding:5px 10px}}';
    document.head.appendChild(st);
  });
})();
