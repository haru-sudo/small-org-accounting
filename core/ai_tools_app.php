<?php
// ══════════════════════════════════════════════════════════════════════════════
// ai_tools_app.php — AIアシスタントがアプリの各機能を扱うためのツール
//   仕訳帳（取引の追加・編集・削除）・元帳・資産残高・ダッシュボード・勘定科目の編集・
//   クレカ仕訳ルール・設定（期首残高・申請の既定科目・交通費の締切・決算書の公開）・
//   メンバー名簿・請求書・請求シートと振込確認・申請（承認・返金・仕訳）・明細の取り込み・
//   期間リセット・Excel 出力・編集ログ・AIアシスタント自身の設定。
//   ユーザー管理（権限の付与・変更）だけは扱わない。
//   ツールの定義は aiAppToolDefs()、実行は aiAppExecTool()、承認画面の説明は aiAppDescribeAction()。
//   ai_chat.php の既存のツール（仕訳・自動仕訳ルール・決算書など）と合わせて使う。
// ══════════════════════════════════════════════════════════════════════════════
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/accounting.php';
require_once __DIR__ . '/operations.php';
require_once __DIR__ . '/ai_files.php';

// 変更系（承認が必要）
const AI_APP_WRITE_TOOLS = [
    'add_transaction', 'update_transaction', 'delete_transaction', 'delete_receipt',
    'update_account', 'delete_account',
    'save_credit_rule', 'delete_credit_rule', 'apply_credit_rules',
    'update_settings', 'set_opening_balance', 'set_transport_deadline', 'set_published_months',
    'save_member', 'delete_member',
    'save_invoice', 'delete_invoice',
    'create_billing_sheet', 'update_billing_sheet', 'delete_billing_sheet', 'check_billing_sheet', 'set_billing_member_paid',
    'create_claim', 'update_claim', 'journal_claim', 'rematch_claim', 'delete_claim',
    'import_bank_pdf', 'import_credit_csv', 'reset_period', 'undo_reset',
    'update_ai_settings',
];
const AI_APP_ACCOUNT_TYPES = ['assets' => '資産', 'liabilities' => '負債', 'equity' => '純資産', 'income' => '収入', 'expense' => '支出'];
const AI_APP_CLAIM_STATUS  = ['pending' => '未承認', 'approved' => '承認済', 'paid' => '返金済', 'rejected' => '却下'];
const AI_APP_INVOICE_STATUS = ['未送付', '送付済', '入金済', 'キャンセル'];

// ══════════════════════════════════════════════════════════════════════════════
// ツール定義
// ══════════════════════════════════════════════════════════════════════════════
function aiAppToolDefs(): array {
    $obj = fn(array $props, array $req = []) => ['type' => 'object', 'properties' => $props ?: new stdClass] + ($req ? ['required' => $req] : []);
    $str = fn(string $d = '') => ['type' => 'string'] + ($d !== '' ? ['description' => $d] : []);
    $int = fn(string $d = '') => ['type' => 'integer'] + ($d !== '' ? ['description' => $d] : []);
    $bool = fn(string $d = '') => ['type' => 'boolean'] + ($d !== '' ? ['description' => $d] : []);
    $entry = $obj([
        'debit_account'  => $str('借方の勘定科目名（get_accounts にある名前）'),
        'debit_sub'      => $str('借方の補助科目名。なければ空文字'),
        'credit_account' => $str('貸方の勘定科目名'),
        'credit_sub'     => $str('貸方の補助科目名'),
        'amount'         => $int('金額（円）'),
        'memo'           => $str('摘要'),
    ], ['amount']);
    $acctFields = [
        'debit_account' => $str(), 'debit_sub' => $str(), 'credit_account' => $str(), 'credit_sub' => $str(),
    ];
    return [
        // ── 帳簿を読む ──
        [
            'name' => 'get_transaction',
            'description' => '取引1件の詳細（仕訳明細・状態・取込元・領収書の有無・紐付いた申請や請求シート）を返す。',
            'input_schema' => $obj(['id' => $str('取引ID')], ['id']),
        ],
        [
            'name' => 'get_ledger',
            'description' => '元帳（総勘定元帳）。指定した勘定科目について、会計年度の登録済みの仕訳を日付順に、相手科目・相手先・摘要・借方・貸方・残高つきで返す。期首残高は設定の値。',
            'input_schema' => $obj([
                'account' => $str('勘定科目名'),
                'sub'     => $str('補助科目名で絞るとき（省略可）'),
                'year'    => $int('会計年度'),
                'limit'   => $int('最大行数（既定200、上限500）'),
            ], ['account', 'year']),
        ],
        [
            'name' => 'get_balances',
            'description' => '資産残高。会計年度の資産科目ごとの期首残高・現在の残高・補助科目の内訳と、月ごとの月末残高（登録済みの仕訳だけ）を返す。既定では「現金」「預金」を含む科目だけ月別を出す。',
            'input_schema' => $obj([
                'year'       => $int('会計年度'),
                'all_assets' => $bool('true なら全部の資産科目の月別残高も返す'),
                'with_sub'   => $bool('true なら補助科目ごとの月別残高も返す'),
            ], ['year']),
        ],
        [
            'name' => 'get_dashboard',
            'description' => 'ダッシュボード。会計年度の収入合計・支出合計・収支差額・期末残高（推計。資産科目の残高の合計で、立替金は含まない）・未登録と仮登録の件数、申請の未処理件数、請求シートの未入金、最近の取り込みをまとめて返す。',
            'input_schema' => $obj(['year' => $int('会計年度（省略で今の年度）')]),
        ],
        [
            'name' => 'get_members',
            'description' => 'メンバー名簿（氏名・振込名義カナ・種別・会費の基本額・既定の摘要・既定の補助科目）を返す。請求シートや振込確認で使う。',
            'input_schema' => $obj([]),
        ],
        [
            'name' => 'get_credit_rules',
            'description' => 'クレジットカード明細用の仕訳ルール（加盟店名のパターン → 借方科目）を優先度順に返す。銀行明細用の自動仕訳ルール（get_rules）とは別。',
            'input_schema' => $obj([]),
        ],
        [
            'name' => 'list_invoices',
            'description' => '請求書・見積書の一覧（番号・宛先・件名・発行日・期限・状態・合計金額）を新しい順に返す。',
            'input_schema' => $obj([
                'status'   => $str('未送付 / 送付済 / 入金済 / キャンセル で絞る（省略で全部）'),
                'doc_type' => $str('請求書 / 見積書 で絞る'),
                'limit'    => $int('最大件数（既定50）'),
            ]),
        ],
        [
            'name' => 'get_invoice',
            'description' => '請求書・見積書1件の全項目（品目・差出人・備考を含む）を返す。',
            'input_schema' => $obj(['id' => $str('請求書ID')], ['id']),
        ],
        [
            'name' => 'list_billing_sheets',
            'description' => '会費などの請求シートの一覧（対象月またはタイトル・振込期限・人数・請求総額・入金済み人数・最後に振込確認した日時）を新しい順に返す。',
            'input_schema' => $obj(['limit' => $int('最大件数（既定30）')]),
        ],
        [
            'name' => 'get_billing_sheet',
            'description' => '請求シート1件の詳細（メンバーごとの請求額・摘要・入金済みかどうか・入金日・照合した取引ID）を返す。',
            'input_schema' => $obj(['id' => $str('請求シートID')], ['id']),
        ],
        [
            'name' => 'get_claim',
            'description' => '交通費・立替の申請1件の全項目（経路・用途・店名・メモ・返金日・申請者カナ・仕訳に使う科目・紐付いた取引・領収書の有無）を返す。',
            'input_schema' => $obj(['id' => $str('申請ID')], ['id']),
        ],
        [
            'name' => 'get_import_history',
            'description' => '明細の取り込み状況。銀行明細PDFの取込履歴と取込済みの日付の範囲、クレジットカードCSVの取込履歴、期間リセットの履歴（取り消し済みかどうか）を返す。',
            'input_schema' => $obj([]),
        ],
        [
            'name' => 'get_edit_logs',
            'description' => '編集ログ（誰がいつ何を変更したか）を新しい順に返す。AIアシスタントが実行した変更も含む。',
            'input_schema' => $obj([
                'limit'     => $int('最大件数（既定50、上限200）'),
                'keyword'   => $str('内容・対象の部分一致'),
                'user'      => $str('名前またはメールの部分一致'),
                'date_from' => $str('YYYY/MM/DD（含む）'),
                'date_to'   => $str('YYYY/MM/DD（含む）'),
            ]),
        ],
        [
            'name' => 'export_excel',
            'description' => 'Excel ファイルを作る（決算書・仕訳帳・月次仕訳日記帳・請求シート）。結果の url をそのまま Markdown のリンク [ファイル名](url) にして返答に貼ると、ユーザーがダウンロードできる。',
            'input_schema' => $obj([
                'kind'       => ['type' => 'string', 'enum' => ['kessan', 'journal', 'monthly', 'billing'], 'description' => 'kessan=決算書、journal=仕訳帳（登録済み）、monthly=月次仕訳日記帳、billing=請求シート（メンバー名簿）'],
                'year'       => $int('会計年度（kessan / journal / monthly）。省略で今の年度'),
                'month'      => $int('月（monthly で1か月分だけにするとき。1〜12）'),
                'by_account' => $bool('monthly で科目別の集計も付けるとき true'),
            ], ['kind']),
        ],
        // ── 仕訳帳（変更系） ──
        [
            'name' => 'add_transaction',
            'description' => '取引を手入力で追加する（銀行明細に無い現金の取引や、修正仕訳など）。明細の金額の合計が取引額になる。既定では仮登録にする。',
            'input_schema' => $obj([
                'date'      => $str('取引日 YYYY/MM/DD'),
                'party'     => $str('相手先'),
                'type'      => ['type' => 'string', 'enum' => ['振込', '振替', '現金', '手動'], 'description' => '種別（既定: 手動）'],
                'entries'   => ['type' => 'array', 'items' => $entry, 'description' => '仕訳明細（1件以上）'],
                'memo'      => $str('取引の摘要（省略すると最初の明細の摘要）'),
                'status'    => ['type' => 'string', 'enum' => ['unregistered', 'provisional', 'registered'], 'description' => '既定 provisional（仮登録）。unregistered のときだけ科目が空の明細を許す'],
                'direction' => ['type' => 'string', 'enum' => ['in', 'out'], 'description' => '入金か出金か（省略すると科目から推定）'],
                'reason'    => $str('この取引を追加する理由（承認画面に表示）'),
            ], ['date', 'entries']),
        ],
        [
            'name' => 'update_transaction',
            'description' => '取引を編集する（日付・相手先・摘要・種別・仕訳明細・状態）。指定した項目だけ変わる。登録済みの取引も変えられるので、登録済みを変えるときはユーザーの意図を確かめてから使う。明細を渡すと全明細が置き換わる。銀行明細由来の取引は明細の金額の合計を取引額と一致させる。',
            'input_schema' => $obj([
                'id'      => $str('取引ID'),
                'date'    => $str('YYYY/MM/DD'),
                'party'   => $str(),
                'type'    => $str(),
                'memo'    => $str(),
                'entries' => ['type' => 'array', 'items' => $entry],
                'status'  => ['type' => 'string', 'enum' => ['unregistered', 'provisional', 'registered']],
                'reason'  => $str('変更の理由（承認画面に表示）'),
            ], ['id']),
        ],
        [
            'name' => 'delete_transaction',
            'description' => '取引を削除する（元に戻せない）。申請に紐付いていれば申請の紐付けを外す。取り込み直しが目的なら reset_period を使う。',
            'input_schema' => $obj(['id' => $str('取引ID'), 'reason' => $str('削除の理由')], ['id']),
        ],
        [
            'name' => 'delete_receipt',
            'description' => '取引に付いている領収書を外す（ファイルを消す）。',
            'input_schema' => $obj(['tx_id' => $str('取引ID')], ['tx_id']),
        ],
        // ── 勘定科目（変更系） ──
        [
            'name' => 'update_account',
            'description' => '勘定科目を編集する。名前の変更（仕訳・ルール・期首残高・請求シートの参照も一緒に書き換える）、コードの変更、補助科目の追加・名前の変更・削除。補助科目の削除は、その補助科目を使った仕訳が無いときだけできる。',
            'input_schema' => $obj([
                'type'     => ['type' => 'string', 'enum' => array_keys(AI_APP_ACCOUNT_TYPES)],
                'name'     => $str('今の勘定科目名'),
                'new_name' => $str('新しい勘定科目名'),
                'code'     => $str('科目コード'),
                'add_sub_accounts'    => ['type' => 'array', 'items' => $str()],
                'remove_sub_accounts' => ['type' => 'array', 'items' => $str()],
                'rename_sub_accounts' => ['type' => 'array', 'items' => $obj(['from' => $str(), 'to' => $str()], ['from', 'to'])],
            ], ['type', 'name']),
        ],
        [
            'name' => 'delete_account',
            'description' => '勘定科目（sub を指定すると補助科目）を削除する。仕訳・自動仕訳ルール・クレカ仕訳ルールで使われていると削除できない。',
            'input_schema' => $obj([
                'type' => ['type' => 'string', 'enum' => array_keys(AI_APP_ACCOUNT_TYPES)],
                'name' => $str('勘定科目名'),
                'sub'  => $str('補助科目名（補助科目だけ消すとき）'),
            ], ['type', 'name']),
        ],
        // ── クレカ仕訳ルール（変更系） ──
        [
            'name' => 'save_credit_rule',
            'description' => 'クレジットカード明細用の仕訳ルールを追加する（同じ名前があれば上書き）。明細の「利用日 加盟店 / 備考」に pattern が一致したら借方科目（貸方は普通預金に固定）を付ける。',
            'input_schema' => $obj([
                'name'          => $str('ルール名'),
                'pattern'       => $str('加盟店名に対する正規表現（部分一致・空白無視・大文字小文字無視）'),
                'debit_account' => $str('借方科目'),
                'debit_sub'     => $str('借方補助科目'),
                'memo_template' => $str('摘要（空なら加盟店名のまま）'),
                'position'      => ['type' => 'string', 'enum' => ['top', 'bottom'], 'description' => '優先度。top=最優先（既定）'],
            ], ['name', 'pattern', 'debit_account']),
        ],
        [
            'name' => 'delete_credit_rule',
            'description' => 'クレカ仕訳ルールを名前で削除する。',
            'input_schema' => $obj(['name' => $str()], ['name']),
        ],
        [
            'name' => 'apply_credit_rules',
            'description' => '未登録（仮登録を除く）のクレジットカード取引の明細すべてにクレカ仕訳ルールを適用する。全明細の科目がそろった取引は登録済みになる。',
            'input_schema' => $obj([]),
        ],
        // ── 設定（変更系） ──
        [
            'name' => 'get_settings',
            'description' => 'アプリの設定を返す: 団体名・会計年度開始月・振込確認の猶予日数・期首残高（年度ごと、「科目 / 補助科目」が鍵）・申請の既定科目と返金日数・交通費の締め切り済みの月・決算書の公開月・AIアシスタント自身の設定（モデル・考える深さ・追加の指示・回数上限・Slack チャンネル）。APIキーなどの秘密は返さない。',
            'input_schema' => $obj([]),
        ],
        [
            'name' => 'update_settings',
            'description' => 'アプリの基本設定と申請の既定科目を変更する。指定した項目だけ変わる。期首残高は set_opening_balance、締切は set_transport_deadline、決算書の公開は set_published_months、AIアシスタントの設定は update_ai_settings を使う。Slack ログインや内部トークンなどの秘密の設定は変えられない（設定画面を案内する）。',
            'input_schema' => $obj([
                'club_name'           => $str('団体名'),
                'fiscal_year_start'   => ['type' => 'integer', 'minimum' => 1, 'maximum' => 12, 'description' => '会計年度の開始月'],
                'payment_grace_days'  => $int('振込確認の猶予日数'),
                'refund_days'         => $int('申請の返金までの日数の目安'),
                'transport_debit'     => $str('交通費申請の既定の借方科目'),
                'transport_debit_sub' => $str(),
                'advance_debit'       => $str('立替申請の既定の借方科目'),
                'advance_debit_sub'   => $str(),
                'refund_credit'       => $str('返金の既定の貸方科目'),
                'refund_credit_sub'   => $str(),
            ]),
        ],
        [
            'name' => 'set_opening_balance',
            'description' => '年度の期首残高を設定する（科目・補助科目ごと）。remove=true でその項目を消す。',
            'input_schema' => $obj([
                'year'    => $int('会計年度'),
                'account' => $str('勘定科目名（資産・負債など）'),
                'sub'     => $str('補助科目名（省略可）'),
                'amount'  => $int('金額（円）'),
                'remove'  => $bool('true で削除'),
            ], ['year', 'account']),
        ],
        [
            'name' => 'set_transport_deadline',
            'description' => '交通費申請の月ごとの締め切りを設定する。締め切った月は Slack からの申請を受け付けなくなる。',
            'input_schema' => $obj([
                'month'  => $str('YYYY-MM'),
                'closed' => $bool('true=締め切る、false=締め切りを解除'),
            ], ['month', 'closed']),
        ],
        [
            'name' => 'set_published_months',
            'description' => '決算書を閲覧専用ユーザーに公開する月を設定する。上半期・下半期・年度合計は、その期間の月が全部公開されたときだけ見える。',
            'input_schema' => $obj([
                'year'   => $int('会計年度'),
                'months' => ['type' => 'array', 'items' => $str(), 'description' => '「4月」「5月」…「3月」。all で全月'],
                'mode'   => ['type' => 'string', 'enum' => ['set', 'add', 'remove'], 'description' => 'set=この一覧にする（既定）、add=追加、remove=取り消し'],
            ], ['year', 'months']),
        ],
        // ── メンバー名簿（変更系） ──
        [
            'name' => 'save_member',
            'description' => 'メンバーを追加または編集する（同じ氏名があれば編集）。kana は振込確認の照合に使う振込名義のカナ。',
            'input_schema' => $obj([
                'name'           => $str('氏名'),
                'new_name'       => $str('氏名を変えるとき'),
                'kana'           => $str('振込名義のカナ（例: ﾔﾏﾀﾞ ﾊﾅｺ）'),
                'type'           => $str('区分（例: 一般・学生・OB。自由入力）'),
                'base_fee'       => $int('会費の基本額（円）'),
                'default_tekiyo' => $str('会費の既定の摘要（例: 一般会費）'),
                'default_sub'    => $str('会費収入の既定の補助科目'),
            ], ['name']),
        ],
        [
            'name' => 'delete_member',
            'description' => 'メンバーを名簿から削除する（過去の請求シートは変わらない）。',
            'input_schema' => $obj(['name' => $str('氏名')], ['name']),
        ],
        // ── 請求書・見積書（変更系） ──
        [
            'name' => 'save_invoice',
            'description' => '請求書・見積書を作成または編集する（id があれば編集。指定した項目だけ変わる）。品目は {name, qty, unit_price}。PDF は画面の「請求書」ページからダウンロードする。',
            'input_schema' => $obj([
                'id'          => $str('編集するときの請求書ID'),
                'doc_type'    => ['type' => 'string', 'enum' => ['請求書', '見積書']],
                'invoice_no'  => $str('番号（省略で自動採番）'),
                'client_name' => $str('宛先'),
                'subject'     => $str('件名'),
                'issued_date' => $str('発行日 YYYY/MM/DD'),
                'due_date'    => $str('支払期限（見積書は有効期限）YYYY/MM/DD'),
                'tax_rate'    => $int('消費税率（%）'),
                'notes'       => $str('備考'),
                'items'       => ['type' => 'array', 'items' => $obj(['name' => $str(), 'qty' => $int(), 'unit_price' => $int()], ['name', 'unit_price'])],
                'from_name'   => $str('差出人名'),
                'from_zip'    => $str(),
                'from_addr'   => $str(),
                'from_tel'    => $str(),
                'status'      => ['type' => 'string', 'enum' => AI_APP_INVOICE_STATUS],
            ]),
        ],
        [
            'name' => 'delete_invoice',
            'description' => '請求書・見積書を削除する。',
            'input_schema' => $obj(['id' => $str()], ['id']),
        ],
        // ── 請求シート・振込確認（変更系） ──
        [
            'name' => 'create_billing_sheet',
            'description' => '請求シートを作る。type=buhi は会費（名簿の全員が対象。会費の基本額と既定の摘要を使う。members で個別に上書きできる）、type=other はその他の請求（members で対象者と金額を指定）。作ったあと check_billing_sheet で入金を照合する。',
            'input_schema' => $obj([
                'type'       => ['type' => 'string', 'enum' => ['buhi', 'other']],
                'period'     => $str('会費の対象月 YYYY/MM（buhi）'),
                'title'      => $str('請求のタイトル（other）'),
                'start_date' => $str('入金の判定開始日 YYYY/MM/DD（other）'),
                'due_date'   => $str('振込期限 YYYY/MM/DD'),
                'debit_account'  => $str('入金の借方科目（既定: 普通預金）'),
                'debit_sub'      => $str('借方補助（既定: 三井住友銀行）'),
                'credit_account' => $str('貸方科目（buhi の既定: 会費収入）'),
                'credit_sub'     => $str('貸方補助（buhi はメンバーごとの既定の補助科目）'),
                'members'    => ['type' => 'array', 'description' => '対象のメンバー。buhi では省略で全員', 'items' => $obj([
                    'name'          => $str('氏名（名簿にある名前）'),
                    'fee'           => $int('請求額（円）'),
                    'tekiyo'        => $str('会費の摘要（buhi）'),
                    'memo_template' => $str('仕訳の摘要（other）'),
                    'credit_sub'    => $str('この人の貸方補助科目'),
                ], ['name'])],
            ], ['type', 'due_date']),
        ],
        [
            'name' => 'update_billing_sheet',
            'description' => '請求シートの振込期限・タイトル・対象月、メンバーごとの請求額と摘要を変える（入金の記録は保持）。',
            'input_schema' => $obj([
                'id'       => $str('請求シートID'),
                'due_date' => $str('YYYY/MM/DD'),
                'title'    => $str(),
                'period'   => $str('YYYY/MM'),
                'members'  => ['type' => 'array', 'items' => $obj([
                    'name' => $str('氏名'), 'fee' => $int(), 'tekiyo' => $str(), 'memo_template' => $str(),
                ], ['name'])],
            ], ['id']),
        ],
        [
            'name' => 'delete_billing_sheet',
            'description' => '請求シートを削除する（照合済みの仕訳は残る）。',
            'input_schema' => $obj(['id' => $str()], ['id']),
        ],
        [
            'name' => 'check_billing_sheet',
            'description' => '振込確認チェックを実行する。請求シートのメンバーごとに、金額が一致し振込名義にメンバーのカナが含まれる入金を探して入金済みにし、未仕訳の入金はシートの科目で自動仕訳（登録済み）する。',
            'input_schema' => $obj(['id' => $str('請求シートID')], ['id']),
        ],
        [
            'name' => 'set_billing_member_paid',
            'description' => '請求シートのメンバーを手動で振込済みにする（paid=true。現金で受け取ったときや、名義違いで振込確認チェックが照合できない入金など）、または手動の振込済みを取り消す（paid=false）。手動の振込済みは取引に紐付けず仕訳もしない（必要なら add_transaction で別に仕訳する）。振込確認チェックを再実行しても上書きされない。取り消せるのは手動で振込済みにしたメンバーだけ。',
            'input_schema' => $obj([
                'id'        => $str('請求シートID'),
                'name'      => $str('メンバーの氏名（シートにある名前）'),
                'paid'      => $bool('true=手動で振込済みにする、false=手動の振込済みを取り消す'),
                'paid_date' => $str('入金日 YYYY/MM/DD（paid=true のとき。省略で今日）'),
            ], ['id', 'name', 'paid']),
        ],
        // ── 申請（変更系） ──
        [
            'name' => 'create_claim',
            'description' => '交通費・立替の申請を手入力で作る（通常は Slack から届く）。',
            'input_schema' => $obj([
                'type'             => ['type' => 'string', 'enum' => ['transport', 'advance']],
                'applicant'        => $str('申請者の氏名（名簿の名前）'),
                'amount'           => $int('金額（円）'),
                'application_date' => $str('申請日 YYYY/MM/DD（省略で今日）'),
                'memo'             => $str('メモ'),
                'work_date'        => $str('利用日 YYYY/MM/DD（transport）'),
                'work_destination' => $str('行き先（transport）'),
                'from_station'     => $str('出発駅（transport）'),
                'to_station'       => $str('到着駅（transport）'),
                'usage'            => $str('用途（advance）'),
                'store'            => $str('店名（advance）'),
            ], ['type', 'applicant', 'amount']),
        ],
        [
            'name' => 'update_claim',
            'description' => '申請の状態や内容を変える。status を approved=承認、rejected=却下、paid=返金済み（返金日と申請者カナで銀行明細の出金と自動で照合し、同じカナ×金額の自動仕訳ルールも作る）、approved に戻す=返金の取り消し。',
            'input_schema' => $obj([
                'id'               => $str('申請ID'),
                'status'           => ['type' => 'string', 'enum' => array_keys(AI_APP_CLAIM_STATUS)],
                'paid_date'        => $str('返金日 YYYY/MM/DD（paid のとき。省略で今日）'),
                'person_kana'      => $str('振込名義のカナ（paid のとき。省略で名簿のカナ）'),
                'amount'           => $int(),
                'memo'             => $str(),
                'description'      => $str('内容'),
                'work_date'        => $str(),
                'work_destination' => $str(),
            ] + $acctFields + ['reason' => $str('変更の理由')], ['id']),
        ],
        [
            'name' => 'journal_claim',
            'description' => '申請の返金を、新しい取引（登録済み）として仕訳帳に直接登録する。銀行明細に出てこない現金での返金などに使う。銀行振込なら update_claim で paid にして明細と照合するほうがよい。',
            'input_schema' => $obj([
                'id'        => $str('申請ID'),
                'paid_date' => $str('返金日 YYYY/MM/DD（省略で申請の返金日か今日）'),
                'memo'      => $str('摘要（省略で自動）'),
            ] + $acctFields, ['id']),
        ],
        [
            'name' => 'rematch_claim',
            'description' => '返金済みの申請を、取り込み済みの銀行明細ともう一度照合する（返金日の前後3日・同じ金額・名義にカナか氏名を含む出金）。',
            'input_schema' => $obj(['id' => $str('申請ID')], ['id']),
        ],
        [
            'name' => 'delete_claim',
            'description' => '申請を削除する（紐付いた仕訳は残る）。',
            'input_schema' => $obj(['id' => $str('申請ID'), 'reason' => $str()], ['id']),
        ],
        // ── 取り込み・リセット（変更系） ──
        [
            'name' => 'import_bank_pdf',
            'description' => 'チャットに添付された三井住友銀行 Value Door の明細 PDF を取り込む。period_start〜period_end の取引だけを入れ、取込済みの日付は飛ばす。自動仕訳ルールを適用し、返金済みの申請と照合する。',
            'input_schema' => $obj([
                'file_id'      => $str('添付の ID（「[添付: ID 名前]」の ID）'),
                'period_start' => $str('取引期間の開始日 YYYY/MM/DD'),
                'period_end'   => $str('終了日 YYYY/MM/DD（ダウンロードした日は含めない）'),
            ], ['file_id', 'period_start', 'period_end']),
        ],
        [
            'name' => 'import_credit_csv',
            'description' => 'チャットに添付された三井住友カードの明細 CSV を取り込む。1か月分を1つの取引（明細は entries）にし、クレカ仕訳ルールを適用する。同じ引き落とし月の未登録のクレカ取引があれば置き換える。',
            'input_schema' => $obj([
                'file_id'       => $str('添付の ID'),
                'payment_month' => $str('引き落とし月 YYYY-MM（銀行明細の振替日の月）'),
            ], ['file_id', 'payment_month']),
        ],
        [
            'name' => 'reset_period',
            'description' => '期間リセット: 指定期間の取引を取込元ごとに削除し、取込済みの日付を未取込に戻す（PDF を取り込み直すため）。削除前にバックアップを取り、undo_reset で戻せる。承認画面に削除される件数を出す。必ずユーザーが期間と取込元を明示したときだけ使う。',
            'input_schema' => $obj([
                'start'   => $str('YYYY/MM/DD'),
                'end'     => $str('YYYY/MM/DD'),
                'sources' => ['type' => 'array', 'items' => ['type' => 'string', 'enum' => ['pdf', 'credit_csv', 'manual']], 'description' => '削除する取込元（既定: pdf だけ）'],
                'clear_upload_dates' => $bool('取込済みの日付も戻すか（既定: pdf を含むとき true）'),
            ], ['start', 'end']),
        ],
        [
            'name' => 'undo_reset',
            'description' => '期間リセットを取り消して、削除した取引・申請の紐付け・取込済みの日付を復元する。',
            'input_schema' => $obj(['id' => $str('リセットID（get_import_history の reset_log の id。省略で最新の未取消のもの）')]),
        ],
        // ── AIアシスタント自身の設定（変更系） ──
        [
            'name' => 'update_ai_settings',
            'description' => 'AIアシスタントの設定を変える: モデル・考える深さ・会計担当からの追加の指示・1人1日の回数上限・読む Slack チャンネル。APIキー・Bot トークン・「確認なしで実行」は変えられない。',
            'input_schema' => $obj([
                'model'              => $str('claude-opus-5-5（AIアシスタント Pro）/ claude-sonnet-5-5（AIアシスタント）/ claude-haiku-5-5（AIアシスタント Lite）'),
                'effort'             => ['type' => 'string', 'enum' => ['low', 'medium', 'high', 'xhigh']],
                'instructions'       => $str('追加の指示（全文を置き換える）'),
                'viewer_daily_limit' => $int('閲覧専用の1人1日の回数（0 で無制限）'),
                'admin_daily_limit'  => $int('管理者の1人1日の回数（0 で無制限）'),
                'slack_channels'     => $str('1行に1つ。「名前 チャンネルID」か「#チャンネル名」'),
            ]),
        ],
    ];
}

function aiAppToolLabel(string $name): ?string {
    return [
        'get_transaction'      => '取引の詳細を確認',
        'get_ledger'           => '元帳を確認',
        'get_balances'         => '資産残高を確認',
        'get_dashboard'        => 'ダッシュボードを確認',
        'get_members'          => 'メンバー名簿を確認',
        'get_credit_rules'     => 'クレカ仕訳ルールを確認',
        'list_invoices'        => '請求書を確認',
        'get_invoice'          => '請求書の詳細を確認',
        'list_billing_sheets'  => '請求シートを確認',
        'get_billing_sheet'    => '請求シートの詳細を確認',
        'get_claim'            => '申請の詳細を確認',
        'get_import_history'   => '取り込み状況を確認',
        'get_edit_logs'        => '編集ログを確認',
        'get_settings'         => '設定を確認',
        'export_excel'         => 'Excel を作成',
        'add_transaction'      => '取引を追加',
        'update_transaction'   => '取引を編集',
        'delete_transaction'   => '取引を削除',
        'delete_receipt'       => '領収書を外す',
        'update_account'       => '勘定科目を編集',
        'delete_account'       => '勘定科目を削除',
        'save_credit_rule'     => 'クレカ仕訳ルールを保存',
        'delete_credit_rule'   => 'クレカ仕訳ルールを削除',
        'apply_credit_rules'   => 'クレカ仕訳ルールを適用',
        'update_settings'      => '設定を変更',
        'set_opening_balance'  => '期首残高を設定',
        'set_transport_deadline' => '交通費の締め切りを設定',
        'set_published_months' => '決算書の公開月を設定',
        'save_member'          => 'メンバーを保存',
        'delete_member'        => 'メンバーを削除',
        'save_invoice'         => '請求書を保存',
        'delete_invoice'       => '請求書を削除',
        'create_billing_sheet' => '請求シートを作成',
        'update_billing_sheet' => '請求シートを編集',
        'delete_billing_sheet' => '請求シートを削除',
        'check_billing_sheet'  => '振込確認チェックを実行',
        'set_billing_member_paid' => 'メンバーを手動で振込済みに',
        'create_claim'         => '申請を作成',
        'update_claim'         => '申請を更新',
        'journal_claim'        => '申請の返金を仕訳',
        'rematch_claim'        => '申請を明細と照合',
        'delete_claim'         => '申請を削除',
        'import_bank_pdf'      => '銀行明細 PDF を取り込み',
        'import_credit_csv'    => 'クレカ明細 CSV を取り込み',
        'reset_period'         => '期間リセット',
        'undo_reset'           => '期間リセットを取り消し',
        'update_ai_settings'   => 'AIアシスタントの設定を変更',
    ][$name] ?? null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 共通の小道具
// ══════════════════════════════════════════════════════════════════════════════
function aiAppFyStart(): int { return (int)(kvGet('settings', [])['fiscal_year_start'] ?? 4); }
function aiAppCurrentFy(): int { return fiscalYearOf(date('Y/m/d'), aiAppFyStart()) ?? (int)date('Y'); }
/** 会計年度の月の並び（4月始まりなら 4,5,…,3） */
function aiAppMonths(int $fs): array { $m = []; for ($i = 0; $i < 12; $i++) $m[] = (($fs - 1 + $i) % 12) + 1; return $m; }
/** 年度の期首残高を「科目/補助」→金額 の形にそろえる（旧形式の数値は普通預金） */
function aiAppOpeningMap(string $year): array {
    $raw = kvGet('settings', [])['opening_balances'][$year] ?? 0;
    if (!is_array($raw)) return $raw ? ['普通預金' => (int)$raw] : [];
    $out = [];
    foreach ($raw as $k => $v) $out[preg_replace('/\s*\/\s*/u', '/', (string)$k)] = (int)$v;
    return $out;
}
/** 科目（補助科目を省略すると補助分も合算）の期首残高 */
function aiAppOpeningFor(array $map, string $ac, ?string $sub = null): int {
    $v = 0;
    foreach ($map as $k => $amt) {
        if ($sub === null) { if ($k === $ac || str_starts_with($k, $ac . '/')) $v += $amt; }
        else               { if ($k === ($sub === '' ? $ac : $ac . '/' . $sub)) $v += $amt; }
    }
    return $v;
}
function aiAppTxBrief(array $tx): string {
    return sprintf('%s %s ¥%s', $tx['date'] ?? '', $tx['party'] ?? '', number_format(max(aiTxInOut($tx))));
}
function aiAppEntryText(array $e): string {
    return sprintf('%s%s / %s%s ¥%s%s',
        $e['debit_account'] ?? '', !empty($e['debit_sub']) ? '（' . $e['debit_sub'] . '）' : '',
        $e['credit_account'] ?? '', !empty($e['credit_sub']) ? '（' . $e['credit_sub'] . '）' : '',
        number_format((int)($e['amount'] ?? 0)), !empty($e['memo']) ? '　' . $e['memo'] : '');
}
/** 仕訳明細の入力を整えて科目を確かめる。[明細, エラー] */
function aiAppParseEntries(array $list, bool $allowEmpty): array {
    $idx = aiAccountIndex();
    $entries = [];
    foreach ($list as $i => $e) {
        $row = [
            'debit_account'  => trim((string)($e['debit_account'] ?? '')),
            'debit_sub'      => trim((string)($e['debit_sub'] ?? '')),
            'credit_account' => trim((string)($e['credit_account'] ?? '')),
            'credit_sub'     => trim((string)($e['credit_sub'] ?? '')),
            'amount'         => (int)($e['amount'] ?? 0),
            'memo'           => trim((string)($e['memo'] ?? '')),
        ];
        if ($row['amount'] <= 0) return [[], '明細 ' . ($i + 1) . ' の金額が 0 以下です'];
        foreach (['debit' => '借方', 'credit' => '貸方'] as $side => $label) {
            if ($allowEmpty && $row[$side . '_account'] === '') continue;
            $err = aiCheckAccount($idx, $row[$side . '_account'], $row[$side . '_sub'], $label);
            if ($err) return [[], '明細 ' . ($i + 1) . ': ' . $err];
        }
        $entries[] = $row;
    }
    if (!$entries) return [[], '仕訳明細がありません'];
    return [$entries, null];
}
function aiAppClaimLabel(array $c): string {
    $type = ($c['type'] ?? '') === 'transport' ? '交通費' : '立替';
    return sprintf('%s %s ¥%s（%s）', $c['applicant'] ?? '', $type, number_format((int)($c['amount'] ?? 0)),
        $c['application_date'] ?? $c['created_at'] ?? '');
}
function aiAppSheetTitle(array $s): string {
    return ($s['type'] ?? '') === 'other' ? (string)($s['title'] ?? '') : ($s['period'] ?? '') . '月分 会費';
}
function aiAppInvoiceTotal(array $inv): array {
    $sub = 0;
    foreach ((array)($inv['items'] ?? []) as $it) $sub += max(1, (int)($it['qty'] ?? 1)) * (int)($it['unit_price'] ?? 0);
    $tax = (int)floor($sub * (float)($inv['tax_rate'] ?? 0) / 100);
    return ['subtotal' => $sub, 'tax' => $tax, 'total' => $sub + $tax];
}
function aiAppInvoiceBrief(array $inv): array {
    return array_intersect_key($inv, array_flip(['id', 'doc_type', 'invoice_no', 'client_name', 'subject', 'issued_date', 'due_date', 'status', 'tax_rate']))
        + aiAppInvoiceTotal($inv) + ['item_count' => count((array)($inv['items'] ?? []))];
}
function aiAppClaimSettings(): array {
    $s = kvGet('settings', []);
    return [
        'refund_days'         => $s['refund_days']         ?? 3,
        'transport_debit'     => $s['transport_debit']     ?? '交通費',
        'transport_debit_sub' => $s['transport_debit_sub'] ?? '',
        'advance_debit'       => $s['advance_debit']       ?? '立替金',
        'advance_debit_sub'   => $s['advance_debit_sub']   ?? '',
        'refund_credit'       => $s['refund_credit']       ?? '普通預金',
        'refund_credit_sub'   => $s['refund_credit_sub']   ?? bankAccountSub(),
    ];
}
/** 連続した日付を「開始〜終了」の範囲にまとめる */
function aiAppDateRanges(array $dates): array {
    $ds = array_values(array_unique(array_filter(array_map(fn($d) => normDate((string)$d), $dates))));
    sort($ds);
    $out = []; $start = null; $prev = null;
    foreach ($ds as $d) {
        if ($prev !== null && (new DateTime(str_replace('/', '-', $prev)))->modify('+1 day')->format('Y/m/d') === $d) { $prev = $d; continue; }
        if ($start !== null) $out[] = $start === $prev ? $start : "{$start}〜{$prev}";
        $start = $prev = $d;
    }
    if ($start !== null) $out[] = $start === $prev ? $start : "{$start}〜{$prev}";
    return $out;
}
/** 添付（画像・PDF・CSV）の実ファイルのパス。無ければ null */
function aiAppAttachedFile(string $fileId, array $kinds): ?array {
    $row = preg_match('/^[0-9a-f]{24}$/', $fileId) ? aiFileRow($fileId) : null;
    if (!$row || !is_file(aiFilePath($row))) return null;
    if (!in_array(AI_FILE_TYPES[$row['media_type']][1] ?? '', $kinds, true)) return null;
    return $row + ['path' => aiFilePath($row)];
}

// ══════════════════════════════════════════════════════════════════════════════
// 読み取り
// ══════════════════════════════════════════════════════════════════════════════
function aiAppTxFull(array $tx): array {
    [$in, $out] = aiTxInOut($tx);
    $ents = [];
    foreach ($tx['entries'] ?? [] as $ix => $e) {
        $ents[] = ['index' => $ix] + array_intersect_key($e, array_flip(['debit_account', 'debit_sub', 'credit_account', 'credit_sub', 'amount', 'memo']));
    }
    return [
        'id' => $tx['id'], 'date' => $tx['date'] ?? '', 'type' => $tx['type'] ?? '', 'party' => $tx['party'] ?? '',
        'in' => $in, 'out' => $out, 'amount' => (int)($tx['amount'] ?? 0), 'memo' => $tx['memo'] ?? '',
        'status' => aiTxStatus($tx), 'source' => txSourceKind($tx), 'source_file' => $tx['source_file'] ?? '',
        'auto_rule' => $tx['auto_rule'] ?? '', 'has_receipt' => !empty($tx['receipt_file']),
        'claim_id' => $tx['claim_id'] ?? '', 'billing_sheet_id' => $tx['billing_sheet_id'] ?? '',
        'entries' => $ents,
    ];
}

function aiAppGetLedger(array $in): array {
    $ac   = trim((string)($in['account'] ?? ''));
    $sub  = isset($in['sub']) && trim((string)$in['sub']) !== '' ? trim((string)$in['sub']) : null;
    $year = (string)(int)($in['year'] ?? aiAppCurrentFy());
    $limit = max(1, min(500, (int)($in['limit'] ?? 200)));
    $acType = getAccountType($ac);
    if ($acType === null) return ['error' => "勘定科目「{$ac}」はありません"];
    $debitInc = in_array($acType, ['assets', 'expense'], true);
    $ob = aiAppOpeningFor(aiAppOpeningMap($year), $ac, $sub);
    $run = $ob; $rows = []; $dr = 0; $cr = 0;
    foreach (getTransactionsByFy($year, aiAppFyStart(), true) as $tx) {
        foreach ($tx['entries'] ?? [] as $e) {
            $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
            $isDr = ($e['debit_account'] ?? '') === $ac && ($sub === null || ($e['debit_sub'] ?? '') === $sub);
            $isCr = ($e['credit_account'] ?? '') === $ac && ($sub === null || ($e['credit_sub'] ?? '') === $sub);
            if (!$isDr && !$isCr) continue;
            $d = $isDr ? $amt : 0; $c = $isCr ? $amt : 0;
            $run += $debitInc ? $d - $c : $c - $d;
            $dr += $d; $cr += $c;
            $rows[] = ['date' => $tx['date'], 'tx_id' => $tx['id'], 'counter' => $isDr ? ($e['credit_account'] ?? '') : ($e['debit_account'] ?? ''),
                       'party' => $tx['party'] ?? '', 'memo' => $e['memo'] ?: ($tx['memo'] ?? ''), 'debit' => $d, 'credit' => $c, 'balance' => $run];
        }
    }
    return ['account' => $ac, 'sub' => $sub, 'type' => $acType, 'fiscal_year' => (int)$year, 'opening_balance' => $ob,
            'debit_total' => $dr, 'credit_total' => $cr, 'closing_balance' => $run,
            'count' => count($rows), 'rows' => array_slice($rows, 0, $limit), 'truncated' => count($rows) > $limit];
}

function aiAppGetBalances(array $in): array {
    $year = (string)(int)($in['year'] ?? aiAppCurrentFy());
    $fs = aiAppFyStart(); $months = aiAppMonths($fs);
    $txs = getTransactionsByFy($year, $fs, true);
    $ob = aiAppOpeningMap($year);
    $deltas = function(string $ac, ?string $sub) use ($txs, $months): array {
        $idx = array_flip($months); $d = array_fill(0, 12, 0);
        foreach ($txs as $tx) {
            $m = (int)substr((string)($tx['date'] ?? ''), 5, 2); if (!isset($idx[$m])) continue;
            foreach ($tx['entries'] ?? [] as $e) {
                $amt = (int)($e['amount'] ?? 0); if (!$amt) continue;
                if (($e['debit_account'] ?? '') === $ac && ($sub === null || ($e['debit_sub'] ?? '') === $sub))  $d[$idx[$m]] += $amt;
                if (($e['credit_account'] ?? '') === $ac && ($sub === null || ($e['credit_sub'] ?? '') === $sub)) $d[$idx[$m]] -= $amt;
            }
        }
        return $d;
    };
    $monthly = function(int $opening, array $d) use ($months): array {
        $run = $opening; $out = [];
        foreach ($months as $i => $m) { $run += $d[$i]; $out["{$m}月"] = ['change' => $d[$i], 'balance' => $run]; }
        return $out;
    };
    $all = !empty($in['all_assets']); $withSub = !empty($in['with_sub']);
    $out = [];
    foreach (kvGet('accounts', [])['assets'] ?? [] as $ac) {
        $name = (string)($ac['name'] ?? '');
        $d = $deltas($name, null);
        $op = aiAppOpeningFor($ob, $name, null);
        $row = ['account' => $name, 'opening_balance' => $op, 'balance' => $op + array_sum($d)];
        $isCash = (bool)preg_match('/現金|預金/u', $name);
        if ($all || $isCash) $row['monthly'] = $monthly($op, $d);
        $subs = [];
        foreach ($ac['sub'] ?? [] as $s) {
            $sn = (string)($s['name'] ?? '');
            $sd = $deltas($name, $sn); $sop = aiAppOpeningFor($ob, $name, $sn);
            $srow = ['name' => $sn, 'opening_balance' => $sop, 'balance' => $sop + array_sum($sd)];
            if ($withSub && ($all || $isCash)) $srow['monthly'] = $monthly($sop, $sd);
            $subs[] = $srow;
        }
        if ($subs) $row['sub'] = $subs;
        $out[] = $row;
    }
    return ['fiscal_year' => (int)$year, 'note' => '登録済みの仕訳だけで集計。期首残高は設定の値', 'assets' => $out];
}

function aiAppGetDashboard(array $in): array {
    $year = (string)(int)($in['year'] ?? aiAppCurrentFy());
    $fs = aiAppFyStart();
    $all = getTransactionsByFy($year, $fs, false);
    $tIn = 0; $tOut = 0; $unreg = 0; $prov = 0; $byAccount = [];
    foreach ($all as $tx) {
        if (empty($tx['registered'])) { $unreg++; if (!empty($tx['provisional'])) $prov++; continue; }
        foreach ($tx['entries'] ?? [] as $e) {
            $amt = (int)($e['amount'] ?? 0);
            $dt = getAccountType((string)($e['debit_account'] ?? '')); $ct = getAccountType((string)($e['credit_account'] ?? ''));
            if ($ct === 'income')  { $tIn += $amt;  $byAccount['income'][$e['credit_account']] = ($byAccount['income'][$e['credit_account']] ?? 0) + $amt; }
            if ($dt === 'income')  { $tIn -= $amt;  $byAccount['income'][$e['debit_account']]  = ($byAccount['income'][$e['debit_account']]  ?? 0) - $amt; }
            if ($dt === 'expense') { $tOut += $amt; $byAccount['expense'][$e['debit_account']] = ($byAccount['expense'][$e['debit_account']] ?? 0) + $amt; }
            if ($ct === 'expense') { $tOut -= $amt; $byAccount['expense'][$e['credit_account']] = ($byAccount['expense'][$e['credit_account']] ?? 0) - $amt; }
        }
    }
    foreach ($byAccount as &$m) arsort($m);
    unset($m);
    // 期末残高は決算書と同じく、資産科目（立替金を除く）の残高の合計
    $k = calcKessan(getTransactionsByFy($year, $fs, true), $year);
    $ob = $k['opening_balance'];
    $closing = $k['monthly_balance']['年度合計'] ?? 0;
    $claims = getAllClaims();
    $cnt = fn(callable $f) => count(array_filter($claims, $f));
    $sheets = [];
    foreach (getAllSheets() as $s) {
        $unpaid = array_filter($s['members'] ?? [], fn($m) => empty($m['paid']) && (int)($m['fee'] ?? 0) > 0);
        if ($unpaid) $sheets[] = ['id' => $s['id'], 'title' => aiAppSheetTitle($s), 'due_date' => $s['due_date'] ?? '',
            'unpaid_count' => count($unpaid), 'unpaid_total' => array_sum(array_map(fn($m) => (int)$m['fee'], $unpaid)), 'checked_at' => $s['checked_at'] ?? ''];
    }
    $up = kvGet('uploads_log', []); $cs = kvGet('credit_csv_log', []);
    return [
        'fiscal_year' => (int)$year,
        'income_total' => $tIn, 'expense_total' => $tOut, 'net' => $tIn - $tOut,
        'opening_balance' => $ob, 'estimated_closing_balance' => $closing,
        'top_income' => array_slice($byAccount['income'] ?? [], 0, 8, true),
        'top_expense' => array_slice($byAccount['expense'] ?? [], 0, 8, true),
        'unregistered_count' => $unreg, 'provisional_count' => $prov,
        'claims' => [
            'pending'  => $cnt(fn($c) => ($c['status'] ?? '') === 'pending'),
            'approved_unpaid' => $cnt(fn($c) => ($c['status'] ?? '') === 'approved' && empty($c['journaled'])),
            'paid_waiting_match' => $cnt(fn($c) => ($c['status'] ?? '') === 'paid' && empty($c['journaled'])),
        ],
        'billing_sheets_with_unpaid' => $sheets,
        'last_bank_pdf_import' => $up ? end($up) : null,
        'last_credit_csv_import' => $cs ? end($cs) : null,
        'bank_pdf_imported_ranges' => array_slice(aiAppDateRanges(kvGet('upload_dates', [])), -5),
    ];
}

function aiAppGetSettings(): array {
    $s = kvGet('settings', []);
    $ai = aiSettings();
    $dl = array_keys(array_filter((array)($s['transport_deadlines'] ?? [])));
    sort($dl);
    return [
        'club_name' => $s['club_name'] ?? '', 'fiscal_year_start' => (int)($s['fiscal_year_start'] ?? 4),
        'payment_grace_days' => (int)($s['payment_grace_days'] ?? 7),
        'opening_balances' => $s['opening_balances'] ?? [],
        'claims' => aiAppClaimSettings(),
        'transport_closed_months' => $dl,
        'kessan_published' => kvGet('kessan_published', []),
        'tazuna' => [
            'model' => $ai['model'], 'model_label' => AI_MODELS[$ai['model']] ?? $ai['model'], 'effort' => $ai['effort'],
            'auto_approve' => (bool)$ai['auto_approve'], 'instructions' => $ai['instructions'],
            'viewer_daily_limit' => (int)$ai['viewer_daily_limit'], 'admin_daily_limit' => (int)$ai['admin_daily_limit'],
            'slack_channels' => $ai['slack_channels'], 'has_api_key' => (string)$ai['api_key'] !== '',
            'has_slack_bot_token' => (string)$ai['slack_bot_token'] !== '',
        ],
        'slack_login_configured' => !empty($s['slack_client_id']) && !empty($s['slack_client_secret']),
        'internal_token_configured' => !empty($s['php_internal_token']),
    ];
}

function aiAppExportExcel(array $in, array $user): array {
    $kind = (string)($in['kind'] ?? '');
    $year = (string)(int)($in['year'] ?? aiAppCurrentFy());
    $fs = aiAppFyStart();
    $body = []; $qs = [];
    switch ($kind) {
        case 'kessan':  $seg = 'kessan'; $qs = ['year' => $year]; break;
        case 'journal': $seg = 'journal'; $body = ['transactions' => getTransactionsByFy($year, $fs, true)]; break;
        case 'monthly':
            $seg = 'monthly';
            $body = ['year' => $year, 'by_account' => !empty($in['by_account'])];
            if (!empty($in['month'])) $body['month'] = (string)(int)$in['month'];
            break;
        case 'billing': $seg = 'billing_excel'; $body = ['members' => kvGet('members', [])]; break;
        default: return ['error' => 'kind は kessan / journal / monthly / billing のいずれか'];
    }
    try {
        $tmp = opExportExcel($seg, $body, $qs);
    } catch (OpException $e) {
        return ['error' => 'Excel の生成に失敗しました: ' . $e->getMessage()];
    }
    $name = opExportName($seg, $body, $qs);
    if (!empty($in['month']) && $kind === 'monthly') $name = str_replace('.xlsx', '_' . (int)$in['month'] . '月.xlsx', $name);
    $f = aiFileRegister($tmp, $name, AI_FILE_XLSX, $user['conv_id'] ?? null, $user);
    return ['ok' => true, 'file_id' => $f['id'], 'name' => $f['name'], 'url' => $f['url'], 'size' => $f['size'],
            'note' => 'このファイルは、返答に Markdown のリンク [' . $f['name'] . '](' . $f['url'] . ') を貼るとユーザーがダウンロードできる'];
}

// ══════════════════════════════════════════════════════════════════════════════
// 実行
// ══════════════════════════════════════════════════════════════════════════════
/** @return ?array null なら知らないツール */
function aiAppExecTool(string $name, array $in, array $user): ?array {
    switch ($name) {
        // ── 読み取り ──
        case 'get_transaction': {
            $tx = getTransactionById((string)($in['id'] ?? ''));
            return $tx ? aiAppTxFull($tx) : ['error' => '取引が見つかりません'];
        }
        case 'get_ledger':    return aiAppGetLedger($in);
        case 'get_balances':  return aiAppGetBalances($in);
        case 'get_dashboard': return aiAppGetDashboard($in);
        case 'get_members':   return ['members' => kvGet('members', [])];
        case 'get_credit_rules': {
            $rules = kvGet('credit_rules', []);
            usort($rules, fn($a, $b) => ($b['priority'] ?? 0) <=> ($a['priority'] ?? 0));
            return ['rules' => array_map(fn($r) => array_intersect_key($r, array_flip(['name', 'pattern', 'debit_account', 'debit_sub', 'memo_template', 'priority'])), $rules)];
        }
        case 'list_invoices': {
            $limit = max(1, min(AI_TX_LIMIT, (int)($in['limit'] ?? 50)));
            $st = (string)($in['status'] ?? ''); $dt = (string)($in['doc_type'] ?? '');
            $list = array_values(array_filter(getAllInvoices(), fn($i) => ($st === '' || ($i['status'] ?? '') === $st)
                && ($dt === '' || ($i['doc_type'] ?? '請求書') === $dt)));
            return ['total' => count($list), 'invoices' => array_map('aiAppInvoiceBrief', array_slice($list, 0, $limit))];
        }
        case 'get_invoice': {
            $inv = getInvoice((string)($in['id'] ?? ''));
            return $inv ? $inv + aiAppInvoiceTotal($inv) : ['error' => '請求書が見つかりません'];
        }
        case 'list_billing_sheets': {
            $limit = max(1, min(AI_TX_LIMIT, (int)($in['limit'] ?? 30)));
            $out = [];
            foreach (array_slice(getAllSheets(), 0, $limit) as $s) {
                $ms = $s['members'] ?? [];
                $paid = array_filter($ms, fn($m) => !empty($m['paid']));
                $out[] = ['id' => $s['id'], 'type' => $s['type'] ?? '', 'title' => aiAppSheetTitle($s), 'period' => $s['period'] ?? '',
                    'start_date' => $s['start_date'] ?? '', 'due_date' => $s['due_date'] ?? '', 'created_at' => $s['created_at'] ?? '',
                    'checked_at' => $s['checked_at'] ?? '', 'member_count' => count($ms),
                    'total' => array_sum(array_map(fn($m) => (int)($m['fee'] ?? 0), $ms)),
                    'paid_count' => count($paid), 'paid_total' => array_sum(array_map(fn($m) => (int)($m['fee'] ?? 0), $paid)),
                    'unpaid_count' => count(array_filter($ms, fn($m) => empty($m['paid']) && (int)($m['fee'] ?? 0) > 0))];
            }
            return ['sheets' => $out];
        }
        case 'get_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            if (!$s) return ['error' => '請求シートが見つかりません'];
            $s['title_label'] = aiAppSheetTitle($s);
            return $s;
        }
        case 'get_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            if (!$c) return ['error' => '申請が見つかりません'];
            $c['has_receipt'] = !empty($c['receipt_file']);
            unset($c['receipt_file']);
            $c['status_label'] = AI_APP_CLAIM_STATUS[$c['status'] ?? ''] ?? '';
            return $c;
        }
        case 'get_import_history': {
            return [
                'bank_pdf_uploads'   => array_slice(array_reverse(kvGet('uploads_log', [])), 0, 30),
                'bank_pdf_imported_ranges' => aiAppDateRanges(kvGet('upload_dates', [])),
                'credit_csv_uploads' => array_slice(array_reverse(kvGet('credit_csv_log', [])), 0, 30),
                'reset_log'          => array_reverse(kvGet('reset_log', [])),
            ];
        }
        case 'get_edit_logs': {
            $limit = max(1, min(200, (int)($in['limit'] ?? 50)));
            $kw = mb_strtolower(trim((string)($in['keyword'] ?? ''))); $us = mb_strtolower(trim((string)($in['user'] ?? '')));
            $from = aiNormDate($in['date_from'] ?? ''); $to = aiNormDate($in['date_to'] ?? '');
            $rows = [];
            foreach (array_reverse(kvGet('edit_logs', [])) as $l) {
                $d = substr((string)($l['ts'] ?? ''), 0, 10);
                if ($from !== '' && $d < $from) continue;
                if ($to !== '' && $d > $to) continue;
                if ($kw !== '' && mb_stripos(($l['detail'] ?? '') . ' ' . ($l['target'] ?? '') . ' ' . ($l['action'] ?? ''), $kw) === false) continue;
                if ($us !== '' && mb_stripos(($l['user_name'] ?? '') . ' ' . ($l['user_email'] ?? ''), $us) === false) continue;
                $rows[] = array_intersect_key($l, array_flip(['ts', 'action', 'target', 'detail', 'user_name']));
                if (count($rows) >= $limit) break;
            }
            return ['logs' => $rows];
        }
        case 'get_settings': return aiAppGetSettings();
        case 'export_excel': return aiAppExportExcel($in, $user);

        // ── 仕訳帳 ──
        case 'add_transaction': {
            $date = aiNormDate($in['date'] ?? '');
            if ($date === '') return ['error' => '取引日が正しくありません（YYYY/MM/DD）'];
            $status = in_array($in['status'] ?? '', ['unregistered', 'provisional', 'registered'], true) ? $in['status'] : 'provisional';
            [$entries, $err] = aiAppParseEntries((array)($in['entries'] ?? []), $status === 'unregistered');
            if ($err) return ['error' => $err];
            $amount = array_sum(array_column($entries, 'amount'));
            $dir = $in['direction'] ?? '';
            if (!in_array($dir, ['in', 'out'], true)) {
                $dir = '';
                foreach ($entries as $e) {
                    if (getAccountType($e['credit_account']) === 'assets') { $dir = 'out'; break; }
                    if (getAccountType($e['debit_account']) === 'assets')  { $dir = 'in'; break; }
                }
            }
            $tx = [
                'id' => newUuid(), 'group_id' => newUuid(), 'date' => $date,
                'type' => in_array($in['type'] ?? '', ['振込', '振替', '現金', '手動'], true) ? $in['type'] : '手動',
                'party' => trim((string)($in['party'] ?? '')), 'amount' => $amount,
                'bank_debit' => $dir === 'out' ? $amount : 0, 'bank_credit' => $dir === 'in' ? $amount : 0,
                'memo' => trim((string)($in['memo'] ?? '')) !== '' ? trim((string)$in['memo']) : $entries[0]['memo'],
                'registered' => $status === 'registered', 'provisional' => $status === 'provisional',
                'auto_rule' => '', 'source_file' => '手動入力', 'entries' => $entries,
            ];
            upsertTransaction($tx);
            aiEditLog('作成', '/transactions', 'AIアシスタントが取引を追加: ' . aiAppTxBrief($tx), $user);
            return ['ok' => true, 'id' => $tx['id'], 'status' => $status, 'amount' => $amount];
        }
        case 'update_transaction': {
            $tx = getTransactionById((string)($in['id'] ?? ''));
            if (!$tx) return ['error' => '取引が見つかりません'];
            $before = $tx; $changed = [];
            $status = $in['status'] ?? aiTxStatus($tx);
            if (!in_array($status, ['unregistered', 'provisional', 'registered'], true)) return ['error' => 'status が正しくありません'];
            if (isset($in['date'])) {
                $d = aiNormDate((string)$in['date']); if ($d === '') return ['error' => '取引日が正しくありません'];
                if ($d !== $tx['date']) { $tx['date'] = $d; $changed[] = '日付'; }
            }
            foreach (['party' => '相手先', 'type' => '種別', 'memo' => '摘要'] as $k => $label) {
                if (isset($in[$k]) && (string)$in[$k] !== (string)($tx[$k] ?? '')) { $tx[$k] = (string)$in[$k]; $changed[] = $label; }
            }
            if (isset($in['entries'])) {
                [$entries, $err] = aiAppParseEntries((array)$in['entries'], $status === 'unregistered');
                if ($err) return ['error' => $err];
                $sum = array_sum(array_column($entries, 'amount'));
                $bank = max((int)($tx['bank_debit'] ?? 0), (int)($tx['bank_credit'] ?? 0));
                if ($bank && $sum !== $bank) return ['error' => '明細の金額の合計 ¥' . number_format($sum) . ' が取引額 ¥' . number_format($bank) . ' と一致しません'];
                rememberEntryOrigins($tx, $tx['entries'] ?? []);
                $tx['entries'] = $entries; $tx['amount'] = $sum; $changed[] = '仕訳明細';
                if (!isset($in['memo']) && $entries[0]['memo'] !== '') $tx['memo'] = $entries[0]['memo'];
            }
            if ($status === 'registered') {
                foreach ($tx['entries'] ?? [] as $e) {
                    if (($e['debit_account'] ?? '') === '' || ($e['credit_account'] ?? '') === '') return ['error' => '科目が空の明細があるので登録済みにできません'];
                }
            }
            if ($status !== aiTxStatus($before)) $changed[] = '状態';
            $tx['registered'] = $status === 'registered'; $tx['provisional'] = $status === 'provisional';
            if (!$changed) return ['ok' => true, 'changed' => [], 'note' => '変更はありませんでした'];
            upsertTransaction($tx);
            aiEditLog('更新', '/transactions', 'AIアシスタントが取引を編集: ' . aiAppTxBrief($before) . '（' . implode('・', $changed) . '）', $user);
            return ['ok' => true, 'changed' => $changed, 'status' => $status];
        }
        case 'delete_transaction': {
            $tx = getTransactionById((string)($in['id'] ?? ''));
            if (!$tx) return ['error' => '取引が見つかりません'];
            $unlinked = '';
            if (!empty($tx['claim_id']) && ($c = getClaim((string)$tx['claim_id']))) {
                upsertClaim(array_merge($c, ['journaled' => false, 'journal_tx_id' => '', 'pending_match' => ($c['status'] ?? '') === 'paid']));
                $unlinked = $c['id'];
            }
            deleteTransaction($tx['id']);
            aiEditLog('削除', '/transactions', 'AIアシスタントが取引を削除: ' . aiAppTxBrief($tx), $user);
            return ['ok' => true, 'deleted' => aiAppTxBrief($tx), 'unlinked_claim_id' => $unlinked];
        }
        case 'delete_receipt': {
            $tx = getTransactionById((string)($in['tx_id'] ?? ''));
            if (!$tx) return ['error' => '取引が見つかりません'];
            if (empty($tx['receipt_file'])) return ['error' => 'この取引に領収書はありません'];
            opReceiptDelete($tx['id']);
            aiEditLog('削除', '/transactions', 'AIアシスタントが領収書を外した: ' . aiAppTxBrief($tx), $user);
            return ['ok' => true];
        }

        // ── 勘定科目 ──
        case 'update_account': return aiAppUpdateAccount($in, $user);
        case 'delete_account': return aiAppDeleteAccount($in, $user);

        // ── クレカ仕訳ルール ──
        case 'save_credit_rule': {
            $name = trim((string)($in['name'] ?? '')); $pattern = trim((string)($in['pattern'] ?? ''));
            if ($name === '') return ['error' => 'ルール名が空です'];
            if ($pattern === '') return ['error' => 'pattern が空です（すべての明細に一致してしまいます）'];
            if (@preg_match('/' . aiNoSpace($pattern) . '/ui', '') === false) return ['error' => 'pattern が正規表現として正しくありません'];
            $err = aiCheckAccount(aiAccountIndex(), trim((string)($in['debit_account'] ?? '')), trim((string)($in['debit_sub'] ?? '')), '借方');
            if ($err) return ['error' => $err];
            $rule = ['name' => $name, 'pattern' => $pattern, 'debit_account' => trim((string)$in['debit_account']),
                     'debit_sub' => trim((string)($in['debit_sub'] ?? '')), 'memo_template' => trim((string)($in['memo_template'] ?? ''))];
            $rules = kvGet('credit_rules', []);
            usort($rules, fn($a, $b) => ($b['priority'] ?? 0) <=> ($a['priority'] ?? 0));
            $replaced = false;
            foreach ($rules as $i => $r) if (($r['name'] ?? '') === $name) { $rules[$i] = array_merge($r, $rule); $replaced = true; break; }
            if (!$replaced) { if (($in['position'] ?? 'top') === 'bottom') $rules[] = $rule; else array_unshift($rules, $rule); }
            $n = count($rules);
            foreach ($rules as $i => &$r) $r['priority'] = $n - $i;
            unset($r);
            kvSet('credit_rules', $rules);
            aiEditLog($replaced ? '更新' : '作成', '/credit-rules', "AIアシスタントがクレカ仕訳ルール「{$name}」を" . ($replaced ? '更新' : '追加'), $user);
            return ['ok' => true, 'replaced' => $replaced, 'rule' => $rule];
        }
        case 'delete_credit_rule': {
            $name = (string)($in['name'] ?? '');
            $rules = kvGet('credit_rules', []);
            $left = array_values(array_filter($rules, fn($r) => ($r['name'] ?? '') !== $name));
            if (count($left) === count($rules)) return ['error' => "ルール「{$name}」はありません"];
            kvSet('credit_rules', $left);
            aiEditLog('削除', '/credit-rules', "AIアシスタントがクレカ仕訳ルール「{$name}」を削除", $user);
            return ['ok' => true];
        }
        case 'apply_credit_rules': {
            $n = opApplyCreditRules();
            aiEditLog('更新', '/transactions', "AIアシスタントがクレカ仕訳ルールを適用（{$n} 件）", $user);
            return ['updated_transactions' => $n];
        }

        // ── 設定 ──
        case 'update_settings': {
            $s = kvGet('settings', []); $changed = []; $idx = aiAccountIndex();
            if (isset($in['club_name']))          { $s['club_name'] = (string)$in['club_name']; $changed[] = '団体名'; }
            if (isset($in['fiscal_year_start']) && (int)$in['fiscal_year_start'] >= 1 && (int)$in['fiscal_year_start'] <= 12) {
                $s['fiscal_year_start'] = (int)$in['fiscal_year_start']; $changed[] = '会計年度開始月';
            }
            if (isset($in['payment_grace_days'])) { $s['payment_grace_days'] = max(0, (int)$in['payment_grace_days']); $changed[] = '振込確認猶予日数'; }
            if (isset($in['refund_days']))        { $s['refund_days'] = max(0, (int)$in['refund_days']); $changed[] = '返金日数'; }
            foreach (['transport_debit' => '交通費の借方', 'advance_debit' => '立替の借方', 'refund_credit' => '返金の貸方'] as $k => $label) {
                if (!isset($in[$k]) && !isset($in[$k . '_sub'])) continue;
                $ac = trim((string)($in[$k] ?? $s[$k] ?? aiAppClaimSettings()[$k]));
                $sub = trim((string)($in[$k . '_sub'] ?? $s[$k . '_sub'] ?? ''));
                $err = aiCheckAccount($idx, $ac, $sub, $label); if ($err) return ['error' => $err];
                $s[$k] = $ac; $s[$k . '_sub'] = $sub; $changed[] = $label;
            }
            if (!$changed) return ['error' => '変更する項目がありません'];
            kvSet('settings', $s);
            aiEditLog('更新', '/settings', 'AIアシスタントが設定を変更（' . implode('・', $changed) . '）', $user);
            return ['ok' => true, 'changed' => $changed];
        }
        case 'set_opening_balance': {
            $year = (string)(int)($in['year'] ?? 0); $ac = trim((string)($in['account'] ?? '')); $sub = trim((string)($in['sub'] ?? ''));
            if ((int)$year < 1900) return ['error' => '年度が正しくありません'];
            $err = aiCheckAccount(aiAccountIndex(), $ac, $sub, '期首残高の'); if ($err) return ['error' => $err];
            $s = kvGet('settings', []);
            $ob = $s['opening_balances'] ?? [];
            $cur = $ob[$year] ?? [];
            if (!is_array($cur)) $cur = $cur ? ['普通預金' => (int)$cur] : [];
            // 既存の鍵は「科目 / 補助」でも「科目/補助」でもありうるので、同じ意味の鍵をそろえる
            $key = $sub !== '' ? "{$ac} / {$sub}" : $ac;
            foreach (array_keys($cur) as $k) if (preg_replace('/\s*\/\s*/u', '/', $k) === preg_replace('/\s*\/\s*/u', '/', $key)) { $key = $k; break; }
            if (!empty($in['remove'])) {
                if (!array_key_exists($key, $cur)) return ['error' => "{$year}年度に「{$key}」の期首残高はありません"];
                unset($cur[$key]);
            } else {
                if (!isset($in['amount'])) return ['error' => 'amount を指定してください'];
                $cur[$key] = (int)$in['amount'];
            }
            if ($cur) $ob[$year] = $cur; else unset($ob[$year]);
            $s['opening_balances'] = $ob;
            kvSet('settings', $s);
            aiEditLog('更新', '/settings', "AIアシスタントが{$year}年度の期首残高を変更（{$key}）", $user);
            return ['ok' => true, 'year' => (int)$year, 'opening_balances' => $cur];
        }
        case 'set_transport_deadline': {
            $month = str_replace('/', '-', trim((string)($in['month'] ?? '')));
            if (!preg_match('/^\d{4}-\d{2}$/', $month)) return ['error' => 'month は YYYY-MM'];
            $s = kvGet('settings', []);
            $dl = (array)($s['transport_deadlines'] ?? []);
            if (!empty($in['closed'])) $dl[$month] = true; else unset($dl[$month]);
            kvSet('settings', array_merge($s, ['transport_deadlines' => $dl]));
            aiEditLog('更新', '/transport-deadlines', "AIアシスタントが交通費の締め切りを変更（{$month}: " . (!empty($in['closed']) ? '締切' : '解除') . '）', $user);
            return ['ok' => true, 'closed_months' => array_keys(array_filter($dl))];
        }
        case 'set_published_months': {
            $year = (string)(int)($in['year'] ?? 0);
            $req = (array)($in['months'] ?? []);
            if (in_array('all', $req, true)) $req = fyMonths();
            $req = array_values(array_intersect(fyMonths(), array_map('strval', $req)));
            $mode = $in['mode'] ?? 'set';
            $cur = getPublishedMonths($year);
            $new = $mode === 'add' ? array_merge($cur, $req) : ($mode === 'remove' ? array_diff($cur, $req) : $req);
            $saved = setPublishedMonths($year, array_values(array_unique($new)));
            aiEditLog('更新', '/kessan/published', "AIアシスタントが{$year}年度の決算書の公開月を変更（" . ($saved ? implode('・', $saved) : 'なし') . '）', $user);
            return ['ok' => true, 'year' => (int)$year, 'published_months' => $saved];
        }
        case 'update_ai_settings': {
            $allowed = array_intersect_key($in, array_flip(['model', 'effort', 'instructions', 'viewer_daily_limit', 'admin_daily_limit', 'slack_channels']));
            if (isset($allowed['model']) && !isset(AI_MODELS[$allowed['model']])) return ['error' => 'model は ' . implode(' / ', array_keys(AI_MODELS))];
            if (isset($allowed['effort']) && !in_array($allowed['effort'], AI_EFFORTS, true)) return ['error' => 'effort が正しくありません'];
            if (!$allowed) return ['error' => '変更する項目がありません'];
            aiSaveSettings($allowed);
            aiEditLog('更新', '/ai/settings', 'AIアシスタントが自身の設定を変更（' . implode('・', array_keys($allowed)) . '）', $user);
            return ['ok' => true, 'changed' => array_keys($allowed)];
        }

        // ── メンバー名簿 ──
        case 'save_member': {
            $name = trim((string)($in['name'] ?? '')); if ($name === '') return ['error' => '氏名が空です'];
            $members = kvGet('members', []);
            $pos = array_search($name, array_map(fn($m) => (string)($m['name'] ?? ''), $members), true);
            $m = $pos === false ? ['name' => $name, 'kana' => '', 'type' => '', 'default_sub' => '', 'base_fee' => 0, 'default_tekiyo' => '会費'] : $members[$pos];
            if (isset($in['new_name']) && trim((string)$in['new_name']) !== '') $m['name'] = trim((string)$in['new_name']);
            if (isset($in['kana'])) $m['kana'] = trim((string)$in['kana']);
            if (isset($in['type'])) $m['type'] = mb_substr(trim((string)$in['type']), 0, 20);
            if (isset($in['base_fee'])) $m['base_fee'] = max(0, (int)$in['base_fee']);
            if (isset($in['default_tekiyo'])) $m['default_tekiyo'] = trim((string)$in['default_tekiyo']);
            if (isset($in['default_sub'])) {
                $sub = trim((string)$in['default_sub']);
                $allSubs = [];
                foreach (aiAccountIndex() as $subs) foreach ($subs as $x) $allSubs[] = $x;
                if ($sub !== '' && !in_array($sub, $allSubs, true)) return ['error' => "補助科目「{$sub}」はありません"];
                $m['default_sub'] = $sub;
            }
            if ($pos === false) $members[] = $m; else $members[$pos] = $m;
            kvSet('members', $members);
            aiEditLog($pos === false ? '作成' : '更新', '/members', 'AIアシスタントがメンバー「' . $m['name'] . '」を' . ($pos === false ? '追加' : '更新'), $user);
            return ['ok' => true, 'created' => $pos === false, 'member' => $m];
        }
        case 'delete_member': {
            $name = trim((string)($in['name'] ?? ''));
            $members = kvGet('members', []);
            $left = array_values(array_filter($members, fn($m) => (string)($m['name'] ?? '') !== $name));
            if (count($left) === count($members)) return ['error' => "メンバー「{$name}」は名簿にありません"];
            kvSet('members', $left);
            aiEditLog('削除', '/members', "AIアシスタントがメンバー「{$name}」を削除", $user);
            return ['ok' => true];
        }

        // ── 請求書 ──
        case 'save_invoice': {
            $id = (string)($in['id'] ?? '');
            $inv = $id !== '' ? getInvoice($id) : null;
            if ($id !== '' && !$inv) return ['error' => '請求書が見つかりません'];
            $new = $inv === null;
            $inv = $inv ?? ['id' => newUuid(), 'doc_type' => '請求書', 'status' => '未送付', 'created_at' => now('Y/m/d'), 'tax_rate' => 0, 'items' => []];
            foreach (['doc_type', 'invoice_no', 'client_name', 'subject', 'notes', 'from_name', 'from_zip', 'from_addr', 'from_tel', 'status'] as $k) {
                if (isset($in[$k])) $inv[$k] = trim((string)$in[$k]);
            }
            if (!in_array($inv['doc_type'] ?? '', ['請求書', '見積書'], true)) $inv['doc_type'] = '請求書';
            if (!in_array($inv['status'] ?? '', AI_APP_INVOICE_STATUS, true)) return ['error' => 'status は ' . implode(' / ', AI_APP_INVOICE_STATUS)];
            foreach (['issued_date', 'due_date'] as $k) {
                if (!isset($in[$k])) continue;
                $d = aiNormDate((string)$in[$k]); if ($d === '' && (string)$in[$k] !== '') return ['error' => "{$k} は YYYY/MM/DD"];
                $inv[$k] = $d;
            }
            if (isset($in['tax_rate'])) $inv['tax_rate'] = max(0, (int)$in['tax_rate']);
            if (isset($in['items'])) {
                $items = [];
                foreach ((array)$in['items'] as $it) {
                    $nm = trim((string)($it['name'] ?? '')); if ($nm === '') continue;
                    $items[] = ['name' => $nm, 'qty' => max(1, (int)($it['qty'] ?? 1)), 'unit_price' => (int)($it['unit_price'] ?? 0)];
                }
                $inv['items'] = $items;
            }
            if (trim((string)($inv['client_name'] ?? '')) === '') return ['error' => '宛先（client_name）が空です'];
            if ($new && empty($inv['invoice_no'])) $inv['invoice_no'] = str_pad((string)(countInvoices() + 1), 4, '0', STR_PAD_LEFT);
            if ($new && empty($inv['issued_date'])) $inv['issued_date'] = now('Y/m/d');
            upsertInvoice($inv);
            aiEditLog($new ? '作成' : '更新', '/invoices', 'AIアシスタントが' . $inv['doc_type'] . '「' . ($inv['invoice_no'] ?? '') . ' ' . ($inv['client_name'] ?? '') . '」を' . ($new ? '作成' : '更新'), $user);
            return ['ok' => true, 'created' => $new, 'invoice' => aiAppInvoiceBrief($inv)];
        }
        case 'delete_invoice': {
            $inv = getInvoice((string)($in['id'] ?? ''));
            if (!$inv) return ['error' => '請求書が見つかりません'];
            deleteInvoice($inv['id']);
            aiEditLog('削除', '/invoices', 'AIアシスタントが' . ($inv['doc_type'] ?? '請求書') . '「' . ($inv['invoice_no'] ?? '') . ' ' . ($inv['client_name'] ?? '') . '」を削除', $user);
            return ['ok' => true];
        }

        // ── 請求シート ──
        case 'create_billing_sheet': return aiAppCreateBillingSheet($in, $user);
        case 'update_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            if (!$s) return ['error' => '請求シートが見つかりません'];
            $changed = [];
            if (isset($in['due_date'])) { $d = aiNormDate((string)$in['due_date']); if ($d === '') return ['error' => 'due_date は YYYY/MM/DD']; $s['due_date'] = $d; $changed[] = '振込期限'; }
            if (isset($in['title']))    { $s['title'] = trim((string)$in['title']); $changed[] = 'タイトル'; }
            if (isset($in['period']))   { $s['period'] = str_replace('-', '/', trim((string)$in['period'])); $changed[] = '対象月'; }
            foreach ((array)($in['members'] ?? []) as $up) {
                $nm = trim((string)($up['name'] ?? ''));
                $i = array_search($nm, array_map(fn($m) => (string)($m['name'] ?? ''), $s['members'] ?? []), true);
                if ($i === false) return ['error' => "「{$nm}」はこのシートにいません"];
                if (isset($up['fee']))           $s['members'][$i]['fee'] = max(0, (int)$up['fee']);
                if (isset($up['tekiyo']))        { $s['members'][$i]['tekiyo'] = (string)$up['tekiyo']; if (($s['type'] ?? '') !== 'other') $s['members'][$i]['memo_template'] = '{$取引月}月分 ' . $up['tekiyo']; }
                if (isset($up['memo_template'])) $s['members'][$i]['memo_template'] = (string)$up['memo_template'];
                $changed[] = $nm;
            }
            if (!$changed) return ['error' => '変更する項目がありません'];
            upsertSheet($s);
            aiEditLog('更新', '/billing', 'AIアシスタントが請求シート「' . aiAppSheetTitle($s) . '」を編集（' . implode('・', array_unique($changed)) . '）', $user);
            return ['ok' => true, 'changed' => array_values(array_unique($changed))];
        }
        case 'delete_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            if (!$s) return ['error' => '請求シートが見つかりません'];
            deleteSheet($s['id']);
            aiEditLog('削除', '/billing', 'AIアシスタントが請求シート「' . aiAppSheetTitle($s) . '」を削除', $user);
            return ['ok' => true];
        }
        case 'check_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            if (!$s) return ['error' => '請求シートが見つかりません'];
            try { $r = opBillingCheck($s['id']); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('更新', '/billing', 'AIアシスタントが請求シート「' . aiAppSheetTitle($s) . '」の振込確認を実行（入金 ' . $r['matched'] . ' 名・新たに仕訳 ' . $r['journaled'] . ' 件）', $user);
            $after = getSheet($s['id']);
            $r['unpaid_members'] = array_values(array_map(fn($m) => ['name' => $m['name'] ?? '', 'fee' => (int)($m['fee'] ?? 0)],
                array_filter($after['members'] ?? [], fn($m) => empty($m['paid']) && (int)($m['fee'] ?? 0) > 0)));
            return $r;
        }

        case 'set_billing_member_paid': {
            $s = getSheet((string)($in['id'] ?? ''));
            if (!$s) return ['error' => '請求シートが見つかりません'];
            $nm = trim((string)($in['name'] ?? ''));
            $i = array_search($nm, array_map(fn($m) => (string)($m['name'] ?? ''), $s['members'] ?? []), true);
            if ($i === false) return ['error' => "「{$nm}」はこのシートにいません"];
            $paid = !empty($in['paid']);
            try { $m = opBillingSetManualPaid($s['id'], (int)$i, $paid, (string)($in['paid_date'] ?? '')); }
            catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('更新', '/billing', 'AIアシスタントが請求シート「' . aiAppSheetTitle($s) . '」で ' . $nm
                . ($paid ? ' を手動で振込済みに（入金日 ' . ($m['paid_date'] ?? '') . '）' : ' の手動の振込済みを取り消し'), $user);
            return ['ok' => true, 'name' => $nm, 'paid' => !empty($m['paid']), 'paid_date' => $m['paid_date'] ?? ''];
        }

        // ── 申請 ──
        case 'create_claim': {
            $data = array_intersect_key($in, array_flip(['type', 'applicant', 'amount', 'application_date', 'memo', 'work_date',
                'work_destination', 'from_station', 'to_station', 'usage', 'store']));
            $data['applicant'] = trim((string)($data['applicant'] ?? '')); if ($data['applicant'] === '') return ['error' => '申請者が空です'];
            if ((int)($data['amount'] ?? 0) <= 0) return ['error' => '金額が 0 以下です'];
            $data['application_date'] = aiNormDate($data['application_date'] ?? '') ?: now('Y/m/d');
            if (isset($data['work_date'])) $data['work_date'] = aiNormDate($data['work_date']);
            if (($data['type'] ?? '') === 'transport') {
                $data['description'] = trim(($data['work_destination'] ?? '') . ' ' . ($data['from_station'] ?? '') . '→' . ($data['to_station'] ?? ''), ' →');
            } else {
                $data['description'] = trim((string)($data['usage'] ?? '')) . (!empty($data['store']) ? ' (' . $data['store'] . ')' : '');
            }
            try { $c = opCreateClaim($data); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('作成', '/claims', 'AIアシスタントが申請を作成: ' . aiAppClaimLabel($c), $user);
            return ['ok' => true, 'id' => $c['id'], 'status' => 'pending'];
        }
        case 'update_claim': return aiAppUpdateClaim($in, $user);
        case 'journal_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            if (!$c) return ['error' => '申請が見つかりません'];
            if (!empty($c['journaled'])) return ['error' => 'この申請はすでに仕訳に紐付いています（取引ID ' . ($c['journal_tx_id'] ?? '') . '）'];
            if (!in_array($c['status'] ?? '', ['approved', 'paid'], true)) return ['error' => '承認済み（または返金済み）の申請だけ仕訳できます。先に update_claim で承認してください'];
            $paid = aiNormDate($in['paid_date'] ?? '') ?: (aiNormDate($c['paid_date'] ?? '') ?: now('Y/m/d'));
            $idx = aiAccountIndex();
            foreach (['debit' => '借方', 'credit' => '貸方'] as $side => $label) {
                if (!empty($in[$side . '_account'])) { $err = aiCheckAccount($idx, trim((string)$in[$side . '_account']), trim((string)($in[$side . '_sub'] ?? '')), $label); if ($err) return ['error' => $err]; }
            }
            upsertClaim(array_merge($c, ['status' => 'paid', 'paid_date' => $paid, 'pending_match' => false]));
            try { $tx = opJournalClaim($c['id'], $in); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('作成', '/transactions', 'AIアシスタントが申請の返金を仕訳: ' . aiAppClaimLabel($c), $user);
            return ['ok' => true, 'tx_id' => $tx['id'], 'date' => $tx['date'], 'entry' => aiAppEntryText($tx['entries'][0])];
        }
        case 'rematch_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            if (!$c) return ['error' => '申請が見つかりません'];
            if (($c['status'] ?? '') !== 'paid') return ['error' => '返金済みの申請だけ照合できます'];
            if (!empty($c['journaled'])) return ['error' => 'すでに取引 ' . ($c['journal_tx_id'] ?? '') . ' に紐付いています'];
            upsertClaim(array_merge($c, ['pending_match' => true]));
            matchPendingClaimsToTransactions();
            $after = getClaim($c['id']);
            $ok = !empty($after['journaled']);
            aiEditLog('更新', '/claims', 'AIアシスタントが申請を再照合: ' . aiAppClaimLabel($c) . ($ok ? '（紐付け）' : '（該当なし）'), $user);
            return ['ok' => true, 'matched' => $ok, 'journal_tx_id' => $after['journal_tx_id'] ?? '',
                    'note' => $ok ? '' : '一致する出金がありません。銀行明細を取り込むと自動で照合されます'];
        }
        case 'delete_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            if (!$c) return ['error' => '申請が見つかりません'];
            deleteClaim($c['id']);
            aiEditLog('削除', '/claims', 'AIアシスタントが申請を削除: ' . aiAppClaimLabel($c), $user);
            return ['ok' => true];
        }

        // ── 取り込み・リセット ──
        case 'import_bank_pdf': {
            $f = aiAppAttachedFile((string)($in['file_id'] ?? ''), ['pdf']);
            if (!$f) return ['error' => '添付の PDF が見つかりません'];
            $ps = aiNormDate($in['period_start'] ?? ''); $pe = aiNormDate($in['period_end'] ?? '');
            if ($ps === '' || $pe === '') return ['error' => '取引期間（period_start / period_end）を YYYY/MM/DD で指定してください'];
            if ($ps > $pe) return ['error' => '開始日が終了日より後です'];
            try { $r = opImportBankPdf($f['path'], (string)$f['name'], $ps, $pe); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('作成', '/upload', 'AIアシスタントが銀行明細 PDF「' . $f['name'] . '」を取り込み（' . $r['count'] . ' 件・' . $r['period'] . '）', $user);
            return $r;
        }
        case 'import_credit_csv': {
            $f = aiAppAttachedFile((string)($in['file_id'] ?? ''), ['text']);
            if (!$f) return ['error' => '添付の CSV が見つかりません'];
            try { $r = opImportCreditCsv($f['path'], (string)$f['name'], (string)($in['payment_month'] ?? '')); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('作成', '/upload-credit-csv', 'AIアシスタントがクレカ明細 CSV「' . $f['name'] . '」を取り込み（' . $r['count'] . ' 件）', $user);
            return $r;
        }
        case 'reset_period': {
            try { $r = opResetPeriod(aiAppResetBody($in)); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('削除', '/reset-period', 'AIアシスタントが期間リセット: ' . $r['start'] . '〜' . $r['end'] . '（仕訳 ' . $r['tx_count'] . ' 件・取込済み ' . $r['upload_dates'] . ' 日分・申請 ' . ($r['claims_reset'] ?? 0) . ' 件の紐付け解除）', $user);
            return $r;
        }
        case 'undo_reset': {
            try { $r = opResetUndo((string)($in['id'] ?? '')); } catch (OpException $e) { return ['error' => $e->getMessage()]; }
            aiEditLog('作成', '/reset-undo', 'AIアシスタントが期間リセットを取り消し（仕訳 ' . $r['tx_restored'] . ' 件・取込済み ' . $r['upload_dates_restored'] . ' 日分を復元）', $user);
            return $r;
        }
    }
    return null;
}
function aiAppResetBody(array $in): array {
    $b = ['start' => (string)($in['start'] ?? ''), 'end' => (string)($in['end'] ?? ''), 'sources' => is_array($in['sources'] ?? null) && $in['sources'] ? $in['sources'] : ['pdf']];
    if (array_key_exists('clear_upload_dates', $in)) $b['clear_upload_dates'] = !empty($in['clear_upload_dates']);
    return $b;
}

// ── 勘定科目の編集 ──
/** 科目名（または補助科目名）の変更を、仕訳・ルール・期首残高・請求シート・申請の既定科目に反映する */
function aiAppRenameAccountRefs(string $old, string $new, ?string $oldSub = null, ?string $newSub = null): array {
    $n = ['entries' => 0, 'rules' => 0, 'credit_rules' => 0, 'opening_balances' => 0, 'billing_sheets' => 0, 'settings' => 0];
    $fix = function(array &$row, string $acKey, string $subKey) use ($old, $new, $oldSub, $newSub, &$n): bool {
        if (($row[$acKey] ?? '') !== $old) return false;
        if ($oldSub !== null && ($row[$subKey] ?? '') !== $oldSub) return false;
        $row[$acKey] = $new;
        if ($oldSub !== null) $row[$subKey] = $newSub;
        return true;
    };
    $changed = [];
    foreach (getAllTransactions() as $tx) {
        $hit = false;
        if (!is_array($tx['entries'] ?? null)) continue;
        foreach ($tx['entries'] as &$e) {   // 「?? []」越しの参照ループは書き戻されないので、直接回す
            if ($fix($e, 'debit_account', 'debit_sub')) $hit = true;
            if ($fix($e, 'credit_account', 'credit_sub')) $hit = true;
        }
        unset($e);
        if ($hit) { $changed[] = $tx; $n['entries']++; }
    }
    if ($changed) upsertTransactionsBulk($changed);
    foreach (['rules', 'credit_rules'] as $key) {
        $rules = kvGet($key, []); $hit = false;
        foreach ($rules as &$r) {
            if ($fix($r, 'debit_account', 'debit_sub')) { $hit = true; $n[$key]++; }
            if ($fix($r, 'credit_account', 'credit_sub')) { $hit = true; $n[$key]++; }
            if (is_array($r['entries'] ?? null)) {
                foreach ($r['entries'] as &$e) { if ($fix($e, 'debit_account', 'debit_sub') | $fix($e, 'credit_account', 'credit_sub')) { $hit = true; $n[$key]++; } }
                unset($e);
            }
        }
        unset($r);
        if ($hit) kvSet($key, $rules);
    }
    $s = kvGet('settings', []); $sHit = false;
    foreach ((array)($s['opening_balances'] ?? []) as $y => $map) {
        if (!is_array($map)) continue;
        foreach ($map as $k => $v) {
            $parts = preg_split('/\s*\/\s*/u', (string)$k, 2);
            if ($parts[0] !== $old) continue;
            if ($oldSub !== null && ($parts[1] ?? '') !== $oldSub) continue;
            $sub = $oldSub !== null ? $newSub : ($parts[1] ?? '');
            $nk = $sub !== '' && $sub !== null ? "{$new} / {$sub}" : $new;
            unset($s['opening_balances'][$y][$k]); $s['opening_balances'][$y][$nk] = $v; $sHit = true; $n['opening_balances']++;
        }
    }
    foreach (['transport_debit', 'advance_debit', 'refund_credit'] as $k) {
        $row = [$k => $s[$k] ?? '', $k . '_sub' => $s[$k . '_sub'] ?? ''];
        if ($fix($row, $k, $k . '_sub')) { $s[$k] = $row[$k]; $s[$k . '_sub'] = $row[$k . '_sub']; $sHit = true; $n['settings']++; }
    }
    if ($sHit) kvSet('settings', $s);
    foreach (getAllSheets() as $sheet) {
        $hit = false;
        foreach ($sheet['members'] as &$m) {
            if ($fix($m, 'debit_account', 'debit_sub')) $hit = true;
            if ($fix($m, 'credit_account', 'credit_sub')) $hit = true;
        }
        unset($m);
        if ($hit) { upsertSheet($sheet); $n['billing_sheets']++; }
    }
    if ($oldSub !== null) {
        $members = kvGet('members', []); $hit = false;
        foreach ($members as &$m) if (($m['default_sub'] ?? '') === $oldSub) { $m['default_sub'] = $newSub; $hit = true; }
        unset($m);
        if ($hit) kvSet('members', $members);
    }
    return $n;
}
/** 科目（補助科目）を使っている仕訳・ルールの数 */
function aiAppAccountUsage(string $ac, ?string $sub = null): array {
    $hit = fn(array $row, string $k) => ($row[$k . '_account'] ?? '') === $ac && ($sub === null || ($row[$k . '_sub'] ?? '') === $sub);
    $entries = 0;
    foreach (getAllTransactions() as $tx) foreach ($tx['entries'] ?? [] as $e) if ($hit($e, 'debit') || $hit($e, 'credit')) $entries++;
    $rules = 0;
    foreach (kvGet('rules', []) as $r) { if ($hit($r, 'debit') || $hit($r, 'credit')) $rules++; foreach ($r['entries'] ?? [] as $e) if ($hit($e, 'debit') || $hit($e, 'credit')) $rules++; }
    $credit = 0;
    foreach (kvGet('credit_rules', []) as $r) if ($hit($r, 'debit') || $hit($r, 'credit')) $credit++;
    return ['entries' => $entries, 'rules' => $rules, 'credit_rules' => $credit];
}
function aiAppUpdateAccount(array $in, array $user): array {
    $type = (string)($in['type'] ?? ''); $name = trim((string)($in['name'] ?? ''));
    if (!isset(AI_APP_ACCOUNT_TYPES[$type]) || $name === '') return ['error' => '区分または科目名が正しくありません'];
    $accounts = kvGet('accounts', []);
    $list = $accounts[$type] ?? [];
    $pos = array_search($name, array_column($list, 'name'), true);
    if ($pos === false) return ['error' => "「{$name}」は" . AI_APP_ACCOUNT_TYPES[$type] . 'にありません'];
    $ac = $list[$pos]; $changed = []; $refs = [];
    $allNames = [];
    foreach ($accounts as $t => $l) foreach ((array)$l as $a) $allNames[] = $a['name'] ?? '';
    $cur = $name;
    if (isset($in['new_name']) && trim((string)$in['new_name']) !== '' && trim((string)$in['new_name']) !== $name) {
        $new = trim((string)$in['new_name']);
        if (in_array($new, $allNames, true)) return ['error' => "「{$new}」は既にあります"];
        $ac['name'] = $new; $changed[] = "科目名 {$name} → {$new}";
        $refs['rename'] = ['from' => $name, 'to' => $new];
        $cur = $new;
    }
    if (isset($in['code'])) { $ac['code'] = trim((string)$in['code']); $changed[] = 'コード'; }
    $subNames = fn() => array_map(fn($s) => (string)($s['name'] ?? ''), $ac['sub'] ?? []);
    foreach ((array)($in['rename_sub_accounts'] ?? []) as $rn) {
        $from = trim((string)($rn['from'] ?? '')); $to = trim((string)($rn['to'] ?? ''));
        $i = array_search($from, $subNames(), true);
        if ($i === false) return ['error' => "補助科目「{$from}」はありません"];
        if ($to === '' || in_array($to, $subNames(), true)) return ['error' => "補助科目「{$to}」は空か既にあります"];
        $ac['sub'][$i]['name'] = $to; $changed[] = "補助科目 {$from} → {$to}";
        $refs['sub'][] = ['from' => $from, 'to' => $to];
    }
    foreach ((array)($in['remove_sub_accounts'] ?? []) as $rm) {
        $rm = trim((string)$rm);
        $i = array_search($rm, $subNames(), true);
        if ($i === false) return ['error' => "補助科目「{$rm}」はありません"];
        $u = aiAppAccountUsage($name, $rm);
        if ($u['entries'] || $u['rules'] || $u['credit_rules']) return ['error' => "補助科目「{$rm}」は仕訳 {$u['entries']} 件・ルール " . ($u['rules'] + $u['credit_rules']) . ' 件で使われているので削除できません'];
        array_splice($ac['sub'], $i, 1); $changed[] = "補助科目 {$rm} を削除";
    }
    foreach ((array)($in['add_sub_accounts'] ?? []) as $add) {
        $add = trim((string)$add);
        if ($add === '' || in_array($add, $subNames(), true)) continue;
        $ac['sub'][] = ['code' => (string)($ac['code'] ?? '') . str_pad((string)(count($ac['sub'] ?? []) + 1), 2, '0', STR_PAD_LEFT), 'name' => $add];
        $changed[] = "補助科目 {$add} を追加";
    }
    if (!$changed) return ['error' => '変更する項目がありません'];
    $ac['sub'] = array_values($ac['sub'] ?? []);
    $list[$pos] = $ac; $accounts[$type] = $list;
    kvSet('accounts', $accounts);
    $updated = [];
    foreach ($refs['sub'] ?? [] as $rn) $updated[] = aiAppRenameAccountRefs($name, $name, $rn['from'], $rn['to']);
    if (isset($refs['rename'])) $updated[] = aiAppRenameAccountRefs($name, $refs['rename']['to']);
    $sum = [];
    foreach ($updated as $u) foreach ($u as $k => $v) $sum[$k] = ($sum[$k] ?? 0) + $v;
    aiEditLog('更新', '/accounts', "AIアシスタントが勘定科目「{$name}」を編集（" . implode('・', $changed) . '）', $user);
    return ['ok' => true, 'changed' => $changed, 'references_updated' => $sum ?: null];
}
function aiAppDeleteAccount(array $in, array $user): array {
    $type = (string)($in['type'] ?? ''); $name = trim((string)($in['name'] ?? '')); $sub = trim((string)($in['sub'] ?? ''));
    if (!isset(AI_APP_ACCOUNT_TYPES[$type]) || $name === '') return ['error' => '区分または科目名が正しくありません'];
    $accounts = kvGet('accounts', []);
    $list = $accounts[$type] ?? [];
    $pos = array_search($name, array_column($list, 'name'), true);
    if ($pos === false) return ['error' => "「{$name}」は" . AI_APP_ACCOUNT_TYPES[$type] . 'にありません'];
    $u = aiAppAccountUsage($name, $sub !== '' ? $sub : null);
    if ($u['entries'] || $u['rules'] || $u['credit_rules']) {
        return ['error' => '「' . $name . ($sub !== '' ? " / {$sub}" : '') . "」は仕訳 {$u['entries']} 件・自動仕訳ルール {$u['rules']} 件・クレカ仕訳ルール {$u['credit_rules']} 件で使われているので削除できません。先に付け替えてください"];
    }
    if ($sub !== '') {
        $i = array_search($sub, array_map(fn($s) => (string)($s['name'] ?? ''), $list[$pos]['sub'] ?? []), true);
        if ($i === false) return ['error' => "補助科目「{$sub}」はありません"];
        array_splice($list[$pos]['sub'], $i, 1);
        $list[$pos]['sub'] = array_values($list[$pos]['sub']);
    } else {
        array_splice($list, $pos, 1);
    }
    $accounts[$type] = array_values($list);
    kvSet('accounts', $accounts);
    aiEditLog('削除', '/accounts', 'AIアシスタントが' . ($sub !== '' ? "補助科目「{$name} / {$sub}」" : "勘定科目「{$name}」") . 'を削除', $user);
    return ['ok' => true];
}

// ── 請求シートの作成 ──
function aiAppCreateBillingSheet(array $in, array $user): array {
    $type = ($in['type'] ?? '') === 'other' ? 'other' : 'buhi';
    $due = aiNormDate($in['due_date'] ?? ''); if ($due === '') return ['error' => '振込期限（due_date）を YYYY/MM/DD で指定してください'];
    $idx = aiAccountIndex();
    $subsOf = fn(string $ac) => $idx[$ac] ?? [];
    $debit = trim((string)($in['debit_account'] ?? '')) ?: '普通預金';
    $dsub = trim((string)($in['debit_sub'] ?? ''));
    if ($dsub === '') foreach ($subsOf($debit) as $s) if (str_contains($s, '三井住友')) { $dsub = $s; break; }
    $credit = trim((string)($in['credit_account'] ?? '')) ?: ($type === 'buhi' ? '会費収入' : '');
    $csub = trim((string)($in['credit_sub'] ?? ''));
    if ($credit === '') return ['error' => '貸方科目（credit_account）を指定してください'];
    $err = aiCheckAccount($idx, $debit, $dsub, '借方') ?? aiCheckAccount($idx, $credit, $csub, '貸方');
    if ($err) return ['error' => $err];
    $roster = kvGet('members', []);
    $byName = []; foreach ($roster as $m) $byName[(string)($m['name'] ?? '')] = $m;
    $overrides = []; foreach ((array)($in['members'] ?? []) as $o) $overrides[trim((string)($o['name'] ?? ''))] = $o;
    $members = [];
    if ($type === 'buhi') {
        $period = str_replace('-', '/', trim((string)($in['period'] ?? '')));
        if (!preg_match('#^\d{4}/\d{2}$#', $period)) return ['error' => '対象月（period）を YYYY/MM で指定してください'];
        foreach ($overrides as $nm => $_) if (!isset($byName[$nm])) return ['error' => "「{$nm}」は名簿にいません"];
        $targets = $overrides ? array_values(array_intersect_key($byName, $overrides)) : $roster;
        if (!$targets) return ['error' => '名簿にメンバーがいません（先に save_member で登録）'];
        foreach ($targets as $m) {
            $o = $overrides[(string)$m['name']] ?? [];
            $fee = isset($o['fee']) ? max(0, (int)$o['fee']) : (int)($m['base_fee'] ?? 0);
            $tekiyo = trim((string)($o['tekiyo'] ?? '')) ?: ((string)($m['default_tekiyo'] ?? '') ?: '会費');
            $msub = trim((string)($o['credit_sub'] ?? '')) ?: ($csub ?: (string)($m['default_sub'] ?? ''));
            if ($msub !== '' && !in_array($msub, $subsOf($credit), true)) return ['error' => "貸方の補助科目「{$credit} / {$msub}」はありません（{$m['name']}）"];
            $members[] = ['name' => $m['name'], 'kana' => $m['kana'] ?? '', 'fee' => $fee,
                'debit_account' => $debit, 'debit_sub' => $dsub, 'credit_account' => $credit, 'credit_sub' => $msub,
                'memo_template' => '{$取引月}月分 ' . $tekiyo, 'tekiyo' => $tekiyo, 'auto_journal' => true];
        }
        $sheet = ['type' => 'buhi', 'period' => $period, 'due_date' => $due, 'debit_account' => $debit, 'debit_sub' => $dsub,
                  'credit_account' => $credit, 'memo_template' => '', 'members' => $members];
    } else {
        $title = trim((string)($in['title'] ?? '')); if ($title === '') return ['error' => 'タイトル（title）を指定してください'];
        $start = aiNormDate($in['start_date'] ?? ''); if ($start === '') return ['error' => '判定開始日（start_date）を YYYY/MM/DD で指定してください'];
        if (!$overrides) return ['error' => '対象者（members）と金額を指定してください'];
        foreach ($overrides as $nm => $o) {
            if (!isset($byName[$nm])) return ['error' => "「{$nm}」は名簿にいません"];
            $fee = max(0, (int)($o['fee'] ?? 0)); if ($fee <= 0) continue;
            $members[] = ['name' => $nm, 'kana' => $byName[$nm]['kana'] ?? '', 'fee' => $fee,
                'debit_account' => $debit, 'debit_sub' => $dsub, 'credit_account' => $credit, 'credit_sub' => trim((string)($o['credit_sub'] ?? '')) ?: $csub,
                'memo_template' => trim((string)($o['memo_template'] ?? '')), 'auto_journal' => true];
        }
        if (!$members) return ['error' => '金額が 0 より大きい対象者がいません'];
        $sheet = ['type' => 'other', 'title' => $title, 'start_date' => $start, 'due_date' => $due, 'debit_account' => $debit, 'debit_sub' => $dsub,
                  'credit_account' => $credit, 'credit_sub' => $csub, 'members' => $members];
    }
    $sheet['id'] = newUuid(); $sheet['created_at'] = now(); $sheet['checked_at'] = null; $sheet['matched_count'] = 0; $sheet['journaled_count'] = 0;
    foreach ($sheet['members'] as &$m) { $m['paid'] = false; unset($m['paid_tx_id'], $m['paid_date']); }
    unset($m);
    upsertSheet($sheet);
    $total = array_sum(array_column($members, 'fee'));
    aiEditLog('作成', '/billing', 'AIアシスタントが請求シート「' . aiAppSheetTitle($sheet) . '」を作成（対象 ' . count($members) . ' 名・合計 ¥' . number_format($total) . '）', $user);
    return ['ok' => true, 'id' => $sheet['id'], 'title' => aiAppSheetTitle($sheet), 'member_count' => count($members), 'total' => $total,
            'note' => 'PDF は画面の「会費請求」ページの履歴からダウンロードできる。入金の照合は check_billing_sheet'];
}

// ── 申請の更新 ──
function aiAppUpdateClaim(array $in, array $user): array {
    $c = getClaim((string)($in['id'] ?? ''));
    if (!$c) return ['error' => '申請が見つかりません'];
    $before = $c; $changed = []; $idx = aiAccountIndex();
    foreach (['amount' => '金額', 'memo' => 'メモ', 'description' => '内容', 'work_date' => '利用日', 'work_destination' => '行き先', 'person_kana' => 'カナ'] as $k => $label) {
        if (!isset($in[$k])) continue;
        $v = $k === 'amount' ? max(0, (int)$in[$k]) : ($k === 'work_date' ? aiNormDate((string)$in[$k]) : trim((string)$in[$k]));
        if ($v !== ($c[$k] ?? ($k === 'amount' ? 0 : ''))) { $c[$k] = $v; $changed[] = $label; }
    }
    foreach (['debit' => 'fallback_debit', 'credit' => 'fallback_credit'] as $side => $key) {
        if (!isset($in[$side . '_account']) && !isset($in[$side . '_sub'])) continue;
        $ac = trim((string)($in[$side . '_account'] ?? $c[$key] ?? '')); $sub = trim((string)($in[$side . '_sub'] ?? $c[$key . '_sub'] ?? ''));
        $err = aiCheckAccount($idx, $ac, $sub, $side === 'debit' ? '借方' : '貸方'); if ($err) return ['error' => $err];
        $c[$key] = $ac; $c[$key . '_sub'] = $sub; $changed[] = $side === 'debit' ? '借方科目' : '貸方科目';
    }
    if (isset($in['paid_date']) && !isset($in['status'])) {
        $d = aiNormDate((string)$in['paid_date']); if ($d === '') return ['error' => 'paid_date は YYYY/MM/DD'];
        if ($d !== ($c['paid_date'] ?? '')) { $c['paid_date'] = $d; $changed[] = '返金日'; }
    }
    $result = ['ok' => true];
    $st = $in['status'] ?? null;
    if ($st !== null) {
        if (!isset(AI_APP_CLAIM_STATUS[$st])) return ['error' => 'status が正しくありません'];
        $prev = $c['status'] ?? 'pending';
        if ($st === 'paid') {
            if (!empty($c['journaled'])) { $c['status'] = 'paid'; }
            else {
                $paid = aiNormDate($in['paid_date'] ?? '') ?: (aiNormDate($c['paid_date'] ?? '') ?: now('Y/m/d'));
                $kana = trim((string)($in['person_kana'] ?? '')) ?: ((string)($c['person_kana'] ?? '') ?: lookupMemberKana((string)($c['applicant'] ?? '')));
                $cs = aiAppClaimSettings(); $isTr = ($c['type'] ?? '') === 'transport';
                $c['fallback_debit']      = (string)($c['fallback_debit'] ?? '') ?: ($isTr ? $cs['transport_debit'] : $cs['advance_debit']);
                $c['fallback_debit_sub']  = (string)($c['fallback_debit_sub'] ?? '') ?: ($isTr ? $cs['transport_debit_sub'] : $cs['advance_debit_sub']);
                $c['fallback_credit']     = (string)($c['fallback_credit'] ?? '') ?: $cs['refund_credit'];
                $c['fallback_credit_sub'] = (string)($c['fallback_credit_sub'] ?? '') ?: $cs['refund_credit_sub'];
                $c['status'] = 'paid'; $c['paid_date'] = $paid; $c['person_kana'] = $kana; $c['pending_match'] = true; $c['journaled'] = false; $c['journal_tx_id'] = '';
                upsertClaim($c);
                matchPendingClaimsToTransactions();
                $c = getClaim($c['id']);
                $result['matched'] = !empty($c['journaled']);
                $result['journal_tx_id'] = $c['journal_tx_id'] ?? '';
                // 今後の取り込みで同じカナ×金額の出金を自動仕訳するルール（画面の「返金する」と同じ）
                if ($kana !== '') {
                    $rules = kvGet('rules', []);
                    $amount = (int)($c['amount'] ?? 0);
                    $exists = array_filter($rules, fn($r) => ($r['pattern'] ?? '') === $kana && (int)($r['exact_amount'] ?? 0) === $amount);
                    if (!$exists) {
                        $rules[] = ['name' => claimAutoRuleLabel($c), 'pattern' => $kana, 'exact_amount' => $amount,
                            'debit_account' => $c['fallback_debit'], 'debit_sub' => $c['fallback_debit_sub'],
                            'credit_account' => $c['fallback_credit'], 'credit_sub' => $c['fallback_credit_sub'],
                            'memo_template' => $isTr ? '{$利用日} {$行き先}' : (buildAdvanceMemo($c) ?: '{$苗字} {$取引月}月分立替'),
                            'claim_id' => $c['id']];
                        $n = count($rules);
                        foreach ($rules as $i => &$r) $r['priority'] = $n - $i;
                        unset($r);
                        kvSet('rules', $rules);
                        $result['rule_added'] = claimAutoRuleLabel($c);
                    }
                }
                if (empty($result['matched'])) $result['note'] = '一致する出金はまだありません。銀行明細を取り込むと自動で照合されます';
            }
        } elseif ($prev === 'paid' && $st !== 'paid') {
            // 返金の取り消し（紐付いた仕訳の登録自体は解除しない）
            $c['status'] = $st; $c['paid_date'] = ''; $c['journaled'] = false; $c['pending_match'] = false;
        } else {
            $c['status'] = $st;
        }
        if ($prev !== $st) $changed[] = '状態 ' . AI_APP_CLAIM_STATUS[$prev] . ' → ' . AI_APP_CLAIM_STATUS[$st];
    }
    if (!$changed) return ['ok' => true, 'changed' => [], 'note' => '変更はありませんでした'];
    upsertClaim($c);
    aiEditLog('更新', '/claims', 'AIアシスタントが申請を更新: ' . aiAppClaimLabel($before) . '（' . implode('・', $changed) . '）', $user);
    return $result + ['changed' => $changed, 'status' => $c['status']];
}

// ══════════════════════════════════════════════════════════════════════════════
// 承認画面に出す説明（形は ai_approval.php の先頭のコメント。変わる項目だけを「変更前 → 変更後」で出す）
// ══════════════════════════════════════════════════════════════════════════════
/** @return ?array null なら知らないツール */
function aiAppDescribeAction(string $name, array $in, string $state = 'waiting'): ?array {
    $why = $in['reason'] ?? null;
    switch ($name) {
        case 'add_transaction': {
            $st = $in['status'] ?? 'provisional';
            $ents = array_map(fn($e) => (array)$e, (array)($in['entries'] ?? []));
            $ch = [aiChg('日付', null, (string)($in['date'] ?? '')), aiChg('相手先', null, (string)($in['party'] ?? ''))];
            if (count($ents) === 1) {
                $e = $ents[0];
                $ch[] = aiChg('借方', null, aiAcText($e['debit_account'] ?? '', $e['debit_sub'] ?? ''));
                $ch[] = aiChg('貸方', null, aiAcText($e['credit_account'] ?? '', $e['credit_sub'] ?? ''));
                $ch[] = aiChg('金額', null, aiYen($e['amount'] ?? 0));
                $ch[] = aiChg('摘要', null, (string)($e['memo'] ?? ''));
            } else {
                $ch[] = aiChg('仕訳', null, array_map('aiEntryLine', $ents));
            }
            $ch[] = aiChg('状態', null, AI_STATUS_LABEL[$st] ?? $st);
            return ['summary' => '取引を手入力で追加', 'rows' => [aiRow('新しい取引', $ch, $why)]];
        }
        case 'update_transaction': {
            $tx = getTransactionById((string)($in['id'] ?? ''));
            $ch = [];
            foreach (['date' => '日付', 'party' => '相手先', 'type' => '種別', 'memo' => '摘要'] as $k => $label) {
                if (isset($in[$k])) $ch[] = aiChg($label, (string)($tx[$k] ?? ''), (string)$in[$k]);
            }
            if (isset($in['entries'])) $ch = array_merge($ch, aiEntryDiff($tx['entries'] ?? [], array_map(fn($e) => (array)$e, (array)$in['entries'])));
            if (isset($in['status']) && $tx) $ch[] = aiChg('状態', AI_STATUS_LABEL[aiTxStatus($tx)], AI_STATUS_LABEL[$in['status']] ?? $in['status']);
            $out = ['summary' => '取引を編集', 'rows' => [aiRow(aiTxTarget($tx), $ch, $why, aiTxTag($tx))]];
            if ($tx && !empty($tx['registered'])) $out['warn'] = '登録済みの取引を変えます。決算書の数字が変わることがあります。';
            return $out;
        }
        case 'delete_transaction': {
            $tx = getTransactionById((string)($in['id'] ?? ''));
            $ch = $tx ? [aiChg('仕訳', array_map('aiEntryLine', $tx['entries'] ?? []), '（削除）')] : [];
            if (!empty($tx['claim_id'])) $ch[] = aiChg('申請', '紐付けあり', '紐付けを外す');
            $out = ['summary' => '取引を削除（元に戻せない）', 'rows' => [aiRow(aiTxTarget($tx), $ch, $why, aiTxTag($tx))]];
            if ($tx && !empty($tx['registered'])) $out['warn'] = '登録済みの取引を削除します。決算書から消えます。';
            return $out;
        }
        case 'delete_receipt': {
            $tx = getTransactionById((string)($in['tx_id'] ?? ''));
            return ['summary' => '領収書を外す', 'rows' => [aiRow(aiTxTarget($tx), [aiChg('領収書', 'あり', '（削除）')], null, aiTxTag($tx))]];
        }
        case 'update_account': {
            $type = AI_APP_ACCOUNT_TYPES[$in['type'] ?? ''] ?? '';
            $ch = [];
            if (!empty($in['new_name'])) $ch[] = aiChg('科目名', (string)($in['name'] ?? ''), (string)$in['new_name']);
            if (isset($in['code'])) {
                $cur = '';
                foreach (kvGet('accounts', [])[$in['type'] ?? ''] ?? [] as $a) if (($a['name'] ?? '') === ($in['name'] ?? '')) $cur = (string)($a['code'] ?? '');
                $ch[] = aiChg('コード', $cur, (string)$in['code']);
            }
            foreach ((array)($in['rename_sub_accounts'] ?? []) as $r) $ch[] = aiChg('補助科目', (string)($r['from'] ?? ''), (string)($r['to'] ?? ''));
            if (!empty($in['remove_sub_accounts'])) $ch[] = aiChg('補助科目を削除', implode('・', (array)$in['remove_sub_accounts']), '（削除）');
            if (!empty($in['add_sub_accounts']))    $ch[] = aiChg('補助科目を追加', null, implode('・', (array)$in['add_sub_accounts']));
            $out = ['summary' => '勘定科目「' . ($in['name'] ?? '') . '」を編集（' . $type . '）', 'rows' => [aiRow('勘定科目「' . ($in['name'] ?? '') . '」', $ch)]];
            if (!empty($in['new_name']) || !empty($in['rename_sub_accounts'])) {
                $n = 0;
                if ($state === 'waiting') {
                    foreach (array_merge(!empty($in['new_name']) ? [null] : [], array_column((array)($in['rename_sub_accounts'] ?? []), 'from')) as $sub) {
                        $n += aiAppAccountUsage((string)($in['name'] ?? ''), $sub)['entries'];
                    }
                }
                $out['warn'] = ($n ? "仕訳 {$n} 行" : '仕訳') . 'の科目名も書き換わります（登録済みを含む。金額は変わりません）。';
            }
            return $out;
        }
        case 'delete_account':
            return ['summary' => (!empty($in['sub']) ? '補助科目「' . ($in['name'] ?? '') . ' / ' . $in['sub'] . '」' : '勘定科目「' . ($in['name'] ?? '') . '」') . 'を削除', 'rows' => []];
        case 'save_credit_rule': {
            $old = null;
            foreach (kvGet('credit_rules', []) as $r) if (($r['name'] ?? '') === ($in['name'] ?? '')) { $old = $r; break; }
            $f = fn($v) => $old === null ? null : $v;
            return ['summary' => 'クレカ仕訳ルール「' . ($in['name'] ?? '') . '」を' . ($old ? '変更' : '追加'), 'rows' => [aiRow($old ? '今のルール' : '新しいルール', [
                aiChg('加盟店', $f((string)($old['pattern'] ?? '')), (string)($in['pattern'] ?? '')),
                aiChg('借方', $f(aiAcText($old['debit_account'] ?? '', $old['debit_sub'] ?? '')), aiAcText($in['debit_account'] ?? '', $in['debit_sub'] ?? '')),
                aiChg('摘要', $f((string)($old['memo_template'] ?? '')), (string)($in['memo_template'] ?? '')),
            ])], 'lines' => ['貸方は普通預金（固定）']];
        }
        case 'delete_credit_rule':
            return ['summary' => 'クレカ仕訳ルール「' . ($in['name'] ?? '') . '」を削除', 'rows' => []];
        case 'apply_credit_rules':
            return ['summary' => 'クレカ仕訳ルールを未登録のカード明細に適用', 'rows' => [], 'lines' => ['全明細の科目がそろった取引は登録済みになる']];
        case 'update_settings': {
            $s = kvGet('settings', []); $cs = aiAppClaimSettings();
            $ch = [];
            if (isset($in['club_name']))          $ch[] = aiChg('団体名', (string)($s['club_name'] ?? ''), (string)$in['club_name']);
            if (isset($in['fiscal_year_start']))  $ch[] = aiChg('会計年度の開始', (int)($s['fiscal_year_start'] ?? 4) . '月', (int)$in['fiscal_year_start'] . '月');
            if (isset($in['payment_grace_days'])) $ch[] = aiChg('振込確認の猶予', (int)($s['payment_grace_days'] ?? 7) . '日', (int)$in['payment_grace_days'] . '日');
            if (isset($in['refund_days']))        $ch[] = aiChg('返金までの日数', (int)$cs['refund_days'] . '日', (int)$in['refund_days'] . '日');
            foreach (['transport_debit' => '交通費の借方', 'advance_debit' => '立替の借方', 'refund_credit' => '返金の貸方'] as $k => $label) {
                if (!isset($in[$k]) && !isset($in[$k . '_sub'])) continue;
                $ch[] = aiChg($label, aiAcText($cs[$k], $cs[$k . '_sub']), aiAcText($in[$k] ?? $cs[$k], $in[$k . '_sub'] ?? $cs[$k . '_sub']));
            }
            return ['summary' => '設定を変更', 'rows' => [aiRow('設定', $ch)]];
        }
        case 'set_opening_balance': {
            $key = ($in['account'] ?? '') . (!empty($in['sub']) ? ' / ' . $in['sub'] : '');
            $cur = aiAppOpeningMap((string)(int)($in['year'] ?? 0));
            $norm = preg_replace('/\s*\/\s*/u', '/', $key);
            $from = array_key_exists($norm, $cur) ? aiYen($cur[$norm]) : '（なし）';
            return ['summary' => ($in['year'] ?? '') . '年度の期首残高を' . (!empty($in['remove']) ? '削除' : '設定'),
                    'rows' => [aiRow($key, [aiChg('期首残高', $from, !empty($in['remove']) ? '（削除）' : aiYen($in['amount'] ?? 0))])]];
        }
        case 'set_transport_deadline':
            return ['summary' => '交通費申請の締め切り', 'rows' => [aiRow((string)($in['month'] ?? ''), [aiChg('受付', empty(kvGet('settings', [])['transport_deadlines'][str_replace('/', '-', (string)($in['month'] ?? ''))]) ? '受付中' : '締め切り済み', !empty($in['closed']) ? '締め切り済み' : '受付中')])]];
        case 'set_published_months': {
            $year = (string)(int)($in['year'] ?? 0);
            $cur = getPublishedMonths($year);
            $req = (array)($in['months'] ?? []);
            if (in_array('all', $req, true)) $req = fyMonths();
            $req = array_values(array_intersect(fyMonths(), array_map('strval', $req)));
            $mode = $in['mode'] ?? 'set';
            $new = $mode === 'add' ? array_unique(array_merge($cur, $req)) : ($mode === 'remove' ? array_diff($cur, $req) : $req);
            $new = array_values(array_intersect(fyMonths(), $new));
            return ['summary' => $year . '年度の決算書の公開月', 'rows' => [aiRow('閲覧専用に見せる月', [aiChg('公開', $cur ? implode('・', $cur) : '（なし）', $new ? implode('・', $new) : '（なし）')])]];
        }
        case 'update_ai_settings': {
            $ai = aiSettings();
            $labels = ['model' => 'モデル', 'effort' => '考える深さ', 'instructions' => '追加の指示', 'viewer_daily_limit' => '閲覧専用の回数上限', 'admin_daily_limit' => '管理者の回数上限', 'slack_channels' => 'Slack チャンネル'];
            $fmt = fn($k, $v) => $k === 'model' ? (AI_MODELS[$v] ?? (string)$v) : (string)$v;
            $ch = [];
            foreach ($labels as $k => $label) if (isset($in[$k])) $ch[] = aiChg($label, $fmt($k, $ai[$k] ?? ''), $fmt($k, $in[$k]));
            return ['summary' => 'AIアシスタントの設定を変更', 'rows' => [aiRow('AIアシスタント', $ch)]];
        }
        case 'save_member': {
            $old = null;
            foreach (kvGet('members', []) as $m) if ((string)($m['name'] ?? '') === (string)($in['name'] ?? '')) { $old = $m; break; }
            $f = fn($v) => $old === null ? null : $v;
            $ch = [];
            if ($old === null) $ch[] = aiChg('氏名', null, (string)($in['name'] ?? ''));
            if (!empty($in['new_name'])) $ch[] = aiChg('氏名', (string)$in['name'], (string)$in['new_name']);
            foreach (['kana' => 'カナ', 'type' => '種別', 'default_tekiyo' => '摘要', 'default_sub' => '補助科目'] as $k => $label) {
                if (isset($in[$k])) $ch[] = aiChg($label, $f((string)($old[$k] ?? '')), (string)$in[$k]);
            }
            if (isset($in['base_fee'])) $ch[] = aiChg('会費', $f(aiYen($old['base_fee'] ?? 0)), aiYen($in['base_fee']));
            return ['summary' => 'メンバー「' . ($in['name'] ?? '') . '」を' . ($old ? '変更' : '名簿に追加'), 'rows' => [aiRow($old ? 'メンバー「' . $in['name'] . '」' : '新しいメンバー', $ch)]];
        }
        case 'delete_member':
            return ['summary' => 'メンバー「' . ($in['name'] ?? '') . '」を名簿から削除', 'rows' => [], 'lines' => ['過去の請求シートは変わらない']];
        case 'save_invoice': {
            $inv = !empty($in['id']) ? getInvoice((string)$in['id']) : null;
            $doc = $in['doc_type'] ?? ($inv['doc_type'] ?? '請求書');
            $f = fn($v) => $inv === null ? null : $v;
            $ch = [];
            foreach (['doc_type' => '種類', 'invoice_no' => '番号', 'client_name' => '宛先', 'subject' => '件名', 'issued_date' => '発行日', 'due_date' => '期限', 'status' => '状態', 'notes' => '備考', 'from_name' => '差出人'] as $k => $label) {
                if (isset($in[$k])) $ch[] = aiChg($label, $f((string)($inv[$k] ?? '')), (string)$in[$k]);
            }
            if (isset($in['tax_rate'])) $ch[] = aiChg('税率', $f((int)($inv['tax_rate'] ?? 0) . '%'), (int)$in['tax_rate'] . '%');
            if (isset($in['items'])) {
                $line = fn($it) => ($it['name'] ?? '') . ' ×' . max(1, (int)($it['qty'] ?? 1)) . ' ' . aiYen($it['unit_price'] ?? 0);
                $ch[] = aiChg('品目', $f(array_map($line, (array)($inv['items'] ?? []))), array_map($line, (array)$in['items']));
                $ch[] = aiChg('合計', $f(aiYen(aiAppInvoiceTotal($inv ?? [])['total'])), aiYen(aiAppInvoiceTotal(['items' => $in['items'], 'tax_rate' => $in['tax_rate'] ?? ($inv['tax_rate'] ?? 0)])['total']));
            }
            return ['summary' => $doc . 'を' . ($inv ? '編集' : '作成'), 'rows' => [aiRow($inv ? trim(($inv['invoice_no'] ?? '') . ' ' . ($inv['client_name'] ?? '')) : '新しい' . $doc, $ch)]];
        }
        case 'delete_invoice': {
            $inv = getInvoice((string)($in['id'] ?? ''));
            return ['summary' => ($inv['doc_type'] ?? '請求書') . 'を削除', 'rows' => [aiRow($inv ? trim(($inv['invoice_no'] ?? '') . ' ' . ($inv['client_name'] ?? '') . ' ' . ($inv['subject'] ?? '')) : '（見つからない請求書）', [])]];
        }
        case 'create_billing_sheet': {
            $buhi = ($in['type'] ?? '') !== 'other';
            $ch = [
                $buhi ? aiChg('対象月', null, (string)($in['period'] ?? '')) : aiChg('タイトル', null, (string)($in['title'] ?? '')),
                $buhi ? null : aiChg('判定開始日', null, (string)($in['start_date'] ?? '')),
                aiChg('振込期限', null, (string)($in['due_date'] ?? '')),
                aiChg('入金の仕訳', null, aiAcText(($in['debit_account'] ?? '') ?: '普通預金', $in['debit_sub'] ?? '') . ' / ' . aiAcText(($in['credit_account'] ?? '') ?: ($buhi ? '会費収入' : ''), $in['credit_sub'] ?? '')),
            ];
            $ms = (array)($in['members'] ?? []);
            $ch[] = aiChg('対象', null, $ms ? array_map(fn($m) => ($m['name'] ?? '') . (isset($m['fee']) ? ' ' . aiYen($m['fee']) : ''), $ms) : '名簿の全員（会費の基本額）');
            return ['summary' => ($buhi ? '会費' : 'その他') . 'の請求シートを作成', 'rows' => [aiRow('新しい請求シート', $ch)]];
        }
        case 'update_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            $ch = [];
            if (isset($in['due_date'])) $ch[] = aiChg('振込期限', (string)($s['due_date'] ?? ''), (string)$in['due_date']);
            if (isset($in['title']))    $ch[] = aiChg('タイトル', (string)($s['title'] ?? ''), (string)$in['title']);
            if (isset($in['period']))   $ch[] = aiChg('対象月', (string)($s['period'] ?? ''), (string)$in['period']);
            foreach ((array)($in['members'] ?? []) as $m) {
                $cur = null;
                foreach ($s['members'] ?? [] as $x) if ((string)($x['name'] ?? '') === (string)($m['name'] ?? '')) { $cur = $x; break; }
                if (isset($m['fee']))           $ch[] = aiChg(($m['name'] ?? '') . ' 請求額', aiYen($cur['fee'] ?? 0), aiYen($m['fee']));
                if (isset($m['tekiyo']))        $ch[] = aiChg(($m['name'] ?? '') . ' 摘要', (string)($cur['tekiyo'] ?? ''), (string)$m['tekiyo']);
                if (isset($m['memo_template'])) $ch[] = aiChg(($m['name'] ?? '') . ' 摘要', (string)($cur['memo_template'] ?? ''), (string)$m['memo_template']);
            }
            return ['summary' => '請求シートを編集', 'rows' => [aiRow($s ? aiAppSheetTitle($s) : '（見つからないシート）', $ch)]];
        }
        case 'delete_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            return ['summary' => '請求シートを削除', 'rows' => [aiRow($s ? aiAppSheetTitle($s) . '（' . count($s['members'] ?? []) . ' 名）' : '（見つからないシート）', [])], 'lines' => ['照合済みの仕訳は残る']];
        }
        case 'check_billing_sheet': {
            $s = getSheet((string)($in['id'] ?? ''));
            return ['summary' => '振込確認チェックを実行', 'rows' => [aiRow($s ? aiAppSheetTitle($s) . '　期限 ' . ($s['due_date'] ?? '') : '（見つからないシート）', [])],
                    'lines' => ['金額とカナが一致した入金を入金済みにし、未仕訳なら登録済みの仕訳にする']];
        }
        case 'set_billing_member_paid': {
            $s = getSheet((string)($in['id'] ?? ''));
            $nm = (string)($in['name'] ?? '');
            $cur = null;
            foreach ($s['members'] ?? [] as $x) if ((string)($x['name'] ?? '') === $nm) { $cur = $x; break; }
            $state = fn($m) => empty($m['paid']) ? '未入金' : (!empty($m['manual_paid']) ? '振込済み（手動）' : '振込済み');
            if (!empty($in['paid'])) {
                $ch = [aiChg('振込確認', $state($cur), '振込済み（手動）'), aiChg('入金日', null, (string)(($in['paid_date'] ?? '') ?: date('Y/m/d')))];
                $lines = ['仕訳は作らない。振込確認チェックを再実行しても上書きされない'];
            } else {
                $ch = [aiChg('振込確認', $state($cur), '未入金')];
                $lines = [];
            }
            return ['summary' => $nm . ' を' . (!empty($in['paid']) ? '手動で振込済みに' : '未入金に戻す'),
                    'rows' => [aiRow($s ? aiAppSheetTitle($s) . '　' . $nm : '（見つからないシート）', $ch)], 'lines' => $lines];
        }
        case 'create_claim': {
            $tr = ($in['type'] ?? '') === 'transport';
            return ['summary' => ($tr ? '交通費' : '立替') . 'の申請を作成', 'rows' => [aiRow('新しい申請', [
                aiChg('申請者', null, (string)($in['applicant'] ?? '')),
                aiChg('金額', null, aiYen($in['amount'] ?? 0)),
                $tr ? aiChg('利用日・行き先', null, trim(($in['work_date'] ?? '') . ' ' . ($in['work_destination'] ?? ''))) : aiChg('用途', null, trim(($in['usage'] ?? '') . (!empty($in['store']) ? '（' . $in['store'] . '）' : ''))),
                $tr ? aiChg('経路', null, trim(($in['from_station'] ?? '') . (!empty($in['to_station']) ? ' → ' . $in['to_station'] : ''))) : null,
                aiChg('メモ', null, (string)($in['memo'] ?? '')),
            ])]];
        }
        case 'update_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            $ch = [];
            if (isset($in['status'])) $ch[] = aiChg('状態', AI_APP_CLAIM_STATUS[$c['status'] ?? 'pending'] ?? '', AI_APP_CLAIM_STATUS[$in['status']] ?? $in['status']);
            if (($in['status'] ?? '') === 'paid' && empty($c['journaled'])) $ch[] = aiChg('返金日', (string)($c['paid_date'] ?? ''), aiNormDate($in['paid_date'] ?? '') ?: '今日');
            elseif (isset($in['paid_date'])) $ch[] = aiChg('返金日', (string)($c['paid_date'] ?? ''), (string)$in['paid_date']);
            if (isset($in['amount'])) $ch[] = aiChg('金額', aiYen($c['amount'] ?? 0), aiYen($in['amount']));
            foreach (['memo' => 'メモ', 'description' => '内容', 'work_date' => '利用日', 'work_destination' => '行き先', 'person_kana' => 'カナ'] as $k => $label) {
                if (isset($in[$k])) $ch[] = aiChg($label, (string)($c[$k] ?? ''), (string)$in[$k]);
            }
            if (!empty($in['debit_account']))  $ch[] = aiChg('借方', aiAcText($c['fallback_debit'] ?? '', $c['fallback_debit_sub'] ?? ''), aiAcText($in['debit_account'], $in['debit_sub'] ?? ''));
            if (!empty($in['credit_account'])) $ch[] = aiChg('貸方', aiAcText($c['fallback_credit'] ?? '', $c['fallback_credit_sub'] ?? ''), aiAcText($in['credit_account'], $in['credit_sub'] ?? ''));
            $verb = ['approved' => (($c['status'] ?? '') === 'paid' ? '返金を取り消し' : '承認'), 'rejected' => '却下', 'paid' => '返金済みにする', 'pending' => '未承認に戻す'][$in['status'] ?? ''] ?? '変更';
            $out = ['summary' => '申請を' . $verb, 'rows' => [aiRow($c ? aiAppClaimLabel($c) : '（見つからない申請）', $ch, $why)]];
            if (($in['status'] ?? '') === 'paid' && empty($c['journaled'])) $out['lines'] = ['銀行明細の出金と照合し、同じカナ・金額の自動仕訳ルールも追加する'];
            return $out;
        }
        case 'journal_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            $cs = aiAppClaimSettings(); $isTr = ($c['type'] ?? '') === 'transport';
            return ['summary' => '申請の返金を仕訳帳に登録（登録済み）', 'rows' => [aiRow($c ? aiAppClaimLabel($c) : '（見つからない申請）', [
                aiChg('日付', null, aiNormDate($in['paid_date'] ?? '') ?: (($c['paid_date'] ?? '') ?: '今日')),
                aiChg('借方', null, aiAcText(($in['debit_account'] ?? '') ?: (($c['fallback_debit'] ?? '') ?: ($isTr ? $cs['transport_debit'] : $cs['advance_debit'])), $in['debit_sub'] ?? '')),
                aiChg('貸方', null, aiAcText(($in['credit_account'] ?? '') ?: (($c['fallback_credit'] ?? '') ?: $cs['refund_credit']), $in['credit_sub'] ?? '')),
                aiChg('金額', null, aiYen($c['amount'] ?? 0)),
                aiChg('摘要', null, (string)($in['memo'] ?? '')),
            ])]];
        }
        case 'rematch_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            return ['summary' => '申請を取り込み済みの銀行明細と照合', 'rows' => [aiRow($c ? aiAppClaimLabel($c) . '　返金日 ' . ($c['paid_date'] ?? '') : '（見つからない申請）', [])]];
        }
        case 'delete_claim': {
            $c = getClaim((string)($in['id'] ?? ''));
            return ['summary' => '申請を削除', 'rows' => [aiRow($c ? aiAppClaimLabel($c) : '（見つからない申請）', [], $why)], 'lines' => ['紐付いた仕訳は残る']];
        }
        case 'import_bank_pdf': {
            $f = aiFileRow((string)($in['file_id'] ?? ''));
            return ['summary' => '銀行明細 PDF を取り込む', 'rows' => [aiRow($f['name'] ?? '（不明なファイル）', [aiChg('取引期間', null, ($in['period_start'] ?? '') . '〜' . ($in['period_end'] ?? ''))])],
                    'lines' => ['取込済みの日付は飛ばし、自動仕訳ルールを適用して、返金済みの申請と照合する']];
        }
        case 'import_credit_csv': {
            $f = aiFileRow((string)($in['file_id'] ?? ''));
            return ['summary' => 'クレジットカード明細 CSV を取り込む', 'rows' => [aiRow($f['name'] ?? '（不明なファイル）', [aiChg('引き落とし月', null, (string)($in['payment_month'] ?? ''))])],
                    'lines' => ['クレカ仕訳ルールを適用する。同じ月の未登録のカード取引があれば置き換える']];
        }
        case 'reset_period': {
            $src = ['pdf' => '銀行PDF', 'credit_csv' => 'クレカCSV', 'manual' => '手入力'];
            $ch = [aiChg('取込元', null, implode('・', array_map(fn($x) => $src[$x] ?? $x, (array)($in['sources'] ?? ['pdf']))))];
            $out = ['summary' => '期間リセット（取引を削除して取り込み直せるようにする）', 'lines' => ['バックアップを取るので、あとで取り消せる']];
            if ($state === 'waiting') {
                try {
                    $d = opResetPeriod(aiAppResetBody($in) + ['dry_run' => true]);
                    $ch[] = aiChg('削除する取引', null, $d['tx_count'] . ' 件（' . aiYen($d['amount']) . '）');
                    if ($d['claim_count'])  $ch[] = aiChg('申請の紐付け', null, $d['claim_count'] . ' 件を外す');
                    if ($d['upload_dates']) $ch[] = aiChg('取込済みの日付', null, $d['upload_dates'] . ' 日分を未取込に戻す');
                    if ($d['registered']) $out['warn'] = "登録済みの取引 {$d['registered']} 件も削除されます。決算書の数字が変わります。";
                } catch (Throwable $e) { $out['lines'][] = '（件数の確認に失敗: ' . $e->getMessage() . '）'; }
            }
            $out['rows'] = [aiRow(($in['start'] ?? '') . '〜' . ($in['end'] ?? ''), $ch)];
            return $out;
        }
        case 'undo_reset': {
            $id = (string)($in['id'] ?? '');
            $row = null;
            foreach (array_reverse(kvGet('reset_log', [])) as $r) if (($id === '' && empty($r['undone'])) || ($r['id'] ?? '') === $id) { $row = $r; break; }
            return ['summary' => '期間リセットを取り消して復元', 'rows' => [aiRow($row ? ($row['start'] ?? '') . '〜' . ($row['end'] ?? '') . '（' . ($row['created_at'] ?? '') . ' のリセット）' : '（対象のリセットが見つからない）',
                    $row ? [aiChg('戻す取引', null, ($row['tx_count'] ?? 0) . ' 件'), aiChg('取込済みの日付', null, ($row['upload_dates'] ?? 0) . ' 日分')] : [])]];
        }
    }
    return null;
}
