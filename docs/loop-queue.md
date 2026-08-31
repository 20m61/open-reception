# ループ着手キュー & 残作業マップ

> 🔴 **キューより先に「人にしか出来ない残件」を見る。** 下の 3 件は Issue の周回ではないので
> **`/loop-round` からは拾われない**（あれは Issue の 1 周を回すスキルで、起点は Issue と本書である）。
> ここに置くのは、キューを見る導線（`/loop-round` / `/issue-ac-mapping`）が必ず本書を通るため。
>
> | 残件 | なぜ人・ローカル macOS でしか出来ないか | 追跡 |
> | --- | --- | --- |
> | `kiosk-landscape-target-chromium-ipad-darwin.png` の取り直し（**この 1 枚だけ**） | ベースライン名に `{platform}` が入る。**linux の描画を darwin の名前で置くと永久に一致せず、本物の退行を隠す**。手順は #789 のコメント | #789 |
> | AWS の窓を開ける（`./scripts/aws-issue-credentials.sh`） | 短命 STS の発行は darwin 限定で、`scripts/hooks/guard-destructive.sh` が機械強制（#675）。**窓さえ開けばデプロイ本体はクラウドから wrapper 経由で流せる** | #675 / `docs/runbook-cloud-aws-deploy.md` |
> | 実機 iPad UAT | 横向きで部署カードが何枚見えるか / 部署を開いて戻れるか / 騒音下で不在告知が聞き取れるか | #807 / #65 |
>
> 2026-08-26 の引き継ぎ（`docs/handoff-2026-08-26.md`）の §0 は **2026-08-27 に消化済み**
> （PR #819 / #820 マージ、Cursor 手順書の環境変数方針）。同書は経緯の記録として残すが、
> **着手待ちとして追いかける必要はない**。

> **直近の引き継ぎは `docs/handoff-2026-08-31.md`。** その前は `docs/handoff-2026-08-28.md`。 2026-08-26 の分（`docs/handoff-2026-08-26.md`）は
> §0 を 2026-08-27 に消化済みで、経緯の記録として残すだけでよい。

## 🔁 次に着手する候補（2026-08-28 更新・上から順）

**`/loop` で自走させるならこの順で拾う。** 分類は `/issue-ac-mapping` で必ず検算すること
（本書の分類は仮説であって事実ではない ―― 2026-08-28 だけで #798 の AC を 2 つ「起票時から充足」と
判明させている）。

| 順 | Issue | なぜこの順か | 着手可否 |
| --- | --- | --- | --- |
| 1 | **#813** | lint の warning が `--max-warnings` 不在でゲートを素通りする。2026-08-28 の実測で **86 warnings**。#826 と同じ「ゲートが見た目より弱い」族 | ローカル可 |
| 2 | **#818** | 全 spec がちょうど 1 つの project に載ることの機械化。#787 で「project を分けても隔離にならない」を踏んだ再発防止 | ローカル可 |
| 3 | **#817** → **#816** → **#815** | #787 の周回で実測から分離したもの。#817 は**営業時間外に全群がその形になる**ので 3 つの中では先 | ローカル可 |

> **#826 は 2026-08-31 に消化した**（PR は本書の履歴を参照）。**flaky の正体は観測ではなく実装**
> だった: 予告(preTimeoutNotice)の保持が「呼び出し開始からの経過」起点だったため、レンダラが
> 数百 ms 詰まると段階の setState と CALL_TIMEOUT の dispatch が 1 コミットへ畳まれ、
> **予告が一度も描画されないまま結果画面へ飛ぶ**（#323 AC3 の保証違反）。e2e は保持を
> 300ms へ圧縮しているのでこれを踏みやすかった。保持の起点を「commit した時刻」へ変えた。
>
> 🔴 **ただし直ったのは `/call` が同期で `timeout` を返す経路だけ。** 実運用で来訪者が踏む
> **実 PSTN（`/status` ポーリング）と Vonage ビデオの 2 経路は、今も予告を経ずに遷移する**
> （main も同じ既存欠陥。独立レビューで判明）。#323 AC3 は**まだ全経路では満たされていない**
> ので「解消」と読まないこと。2 経路への適用は別 Issue。

### ⛔ 着手できないもの（待ちの理由つき）

| Issue | 待っているもの |
| --- | --- |
| **#798 AC1-2** | Reconciler の DynamoDB 配線。**Reconciler はまだ `resolveServiceStates` を呼んでいない**ので、集約ログは配線と同じ increment で入れる |
| **#800 AC4** | 本番 DynamoDB の棚卸し（AWS の窓が要る）。`TIMEZONE_BOUNDS` は**それまで狭めてはいけない** |
| **#789 / #807** | 上の「人にしか出来ない残件」表のとおり |

> **#798 AC2 は 2026-08-31 に消化した**（ユーザー承認は同日、issue のコメントに記録）。
> 解析不能な `expiresAt` を持つ一時 override は、**`force_running` は従来どおり自動解除、
> `force_stopped` / `draining` は維持**へ変えた（「起動しっぱなし」より「止まりっぱなし」が
> 安全側）。併せて、どう倒したかを `RuntimeStateResolution.anomalies` として返し、
> `resolveRuntimeStatesFor` が監視へ 1 行上げる（**同一原因の集約は AC1-2 と同じ increment**）。
>
> **#798 と #800 は閉じないこと。** どちらも AC の一部だけが残っている（issue 本文に
> マッピング結果を反映済み）。#798 に残っているのは **AC1-2 だけ**。

`docs/loop-workflow.md` の運用対象キュー。**独立トラックは並行、統合点は直列、
マージは直列**（理由は workflow の「並列オーケストレーション」節）。

> **本書の分類は仮説であって事実ではない。** 各周回の冒頭で必ず `/issue-ac-mapping`
> （project skill）を通し、AC を実コードへマッピングしてから着手する。過去 **4 回**、
> 本書の「未実装」「外部待ち」分類が stale で、既に main に在るものを作り直しかけた。
> 分類が実態と違ったら、その周回で本書を直す。
>
> **4 回目（第 41 wave）**: #367 / #369〜#372 / #374 / #375 の 4 行が「未着手」のまま
> だったが、いずれも PR #401〜#404 / #407 / #414 で実装済みだった。加えて #327 は
> クローズ済みなのに「次に着手」の第一候補として残っていた。
> **stale の直接原因は、分類を書いた周回と実装した周回が別で、実装側が表を直さないこと。**
> 消化したら必ずその周回で該当行を直す（下の「消化した wave」表に足すだけでは不十分）。

## 現在地（2026-08-21 深夜 更新・DEADLINE MODE 2 巡目）

> **2 巡目のテーマは「失敗したことが誰にも伝わらない」だった。** 1 巡目が直した「果たせない
> ことを言う嘘」の裏側で、**失敗が来訪者にも運用者にも届かない**経路が 4 つ残っていた。
>
> | 届かなかったもの | 直した PR |
> | --- | --- |
> | 未捕捉例外 → iPad に Next 既定の英語 "Application error: a client-side exception has occurred"（`src/app` にエラー境界が **0 件**だった） | #759 |
> | 全断（origin 到達不能）→ CloudFront 既定の英語の技術文（`rg errorResponse infra/` が **0 件**） | #760 |
> | QR 受付の入口ルートに**テストが 1 本も無い**（どのテナントの予約を引けるかを決めている場所） | #761 |
> | **実発信のつもりで撃てなかったとき「担当者が応答しました」** | #765 |
> | 追い返した来訪者が履歴にもメトリクスにもアラームにも残らない | #766 |
>
> 🔴 **#629 の停止境界は解けた。** 「custom error response はディストリビューション単位で
> cache behavior に絞れないので 403/503 を割り当てると API の応答まで HTML に潰れる」という
> 記録は正しく、だから **403/503/500 は割り当てない**。残る **502 / 504 は CloudFront が
> origin へ到達できなかったときだけ**返るもので、そのとき**既に HTML を返している** ──
> 差し替えるのは本文だけで fallback の意味は変わらない。よって仕様判断は要らなかった（#760）。
> 停止画面は S3 origin の behavior（`/assets/*`）から配る（Lambda が落ちているまさにその
> ときに Lambda から取れない。AWS: custom error page は**パスに一致する cache behavior の
> origin** から取得される）。
>
> 🔴 **`/call` の嘘は 3 通りあり、1 つだけ塞いで満足しかけた**（独立レビューで判明・#765）。
> `MockCallAdapter` は**部署呼び出しを無条件で `connected`** にするので、
> (A) 資格情報不備 / (B) **ルート未作成** / (C) ストア読み取りの throw のどれでも
> 「担当者が応答しました」に到達する。B は「資格情報は入れたがルートをまだ作っていない」
> という 8/30 で最も起きやすい形。**ガードを、そのガードの失敗が握り潰される場所
> （`.catch`）の内側に置いていた**のが C。
>
> **判定の軸を取り違えると、正常なテナントを全断させる。** 「vonage + enabled」を実発信の
> 意図とみなすと、**Video 受付だけで運用しているテナント**（`VonageCallAdapter` は
> `fromNumber` を要らない）まで巻き込む。`fromNumber` を条件に含めて避けた。
>
> **テストの穴を 3 つ計測した**（いずれも変異が生き残ることを実測してから直した）:
>
> - route.test.ts が sentinel をリテラルで**二重定義**していた → 実定数が `null` になる変異が
>   **全テスト green のまま通る**（fail-open のテナント全部が 503 になる重大回帰）
> - `options.x ?? realX` の**既定側が一度も走っていない** → 右辺を潰す変異が 1 件も落ちない
> - `OPEN_NEXT_READY` で gate された suite だけ更新し忘れる → `.open-next` が新しいときに
>   **だけ**落ちる（#628 の形。実際に踏みかけた）
>
> **停止境界・外部待ち**: #743 の通話切断 / #744 の実測（#65）/ #762（設定ストアが in-memory
> ＝**実 PSTN の前提が揃っていない**）/ #763（「有効」の定義の食い違い）/ #638 / #625。
>
> **新規に登録した発見**: #762 / #763 / #764（#764 はアラーム部分を #766 で実施し close）。

## 現在地（2026-08-21 更新・DEADLINE MODE 初日）

> **今夜のテーマは「システムが果たせないことを来訪者に言うのをやめる」だった。** 同型の嘘が
> 4 箇所に在り、いずれも #738（実発信停止時に「担当者が応答しました」と出す）で 1 度直した
> のと同じクラスだった:
>
> | 嘘 | 直した PR |
> | --- | --- |
> | 営業時間外に「呼び出しに失敗しました」＋果たせない代替導線 CTA | #747 |
> | 代替導線が「お繋ぎします・お待ちください」と言うが通知経路ゼロ | #747 |
> | **QR 受付が `/call` を一度も呼ばずに「受付が完了しました」** | #748 |
> | 予約 QR の URL が 404（生の技術的エラー） | #753 |
>
> 🔴 **QR 受付は本番形態でまったく機能していなかった**（#752）。予約が in-memory・発行側と
> 照合側で別インスタンス・受付端末の scope が `dev-tenant` 固定、の 3 つが重なり、
> **発行した QR は必ず「不明な QR」になる**状態だった。
>
> **テストの甘さを 5 回計測した。** いずれも「変異を当てたら赤くならない」を実測してから
> 直した。とくに繰り返し出たのが **配線が縛られていない**型:
>
> - `KioskFlow` の失敗理由の写像 … 元の形へ戻しても **6143 テスト全部が green**
> - 発行と照合が同じバックエンドを見ること … **本番のバグそのものなのに誰も縛っていない**
> - `CheckinFlow` が実際に `/call` を呼ぶこと … node 環境では React の効果を回せず、
>   QR の注入口は本番ビルドで無効なので**振る舞いで縛れない**（構造で固定し、限界を明記）
>
> **偽の赤で 2 度遠回りした。** `vrm-check.sh` の `lsof` ベースの後始末がこの環境では
> 空振りし、孤児 `next-server` が残って**古い build manifest を配り続けていた**。
> main との比較実験まで汚染して「自分の変更が VRM を壊した」と誤断した（実際は無関係）。
> #748 で恒久対策（PPID を辿って子孫ごと落とす／実応答で検知）を入れた。
>
> **#743 / #744 は Human Gate 1 件を残して完了。** 「受付が終わったら取次も止まる」を
> `src/domain/routing/stop.ts` の契約にし、終端の書き込みを条件付き部分更新へ、端末の諦めを
> サーバへ届ける `/give-up` を追加、取次の総所要時間と端末上限の関係を保存時に検証。
> 残るのは**鳴っている通話を切るか**（外部副作用＝停止境界）だけで、内部の停止は全部入っている。
>
> **停止境界・外部待ち**: #743 の通話切断 / #744 の実測（#65）/ #638（origin-verify の
> ローテーション）/ #625（実機 UAT）/ #424 の残 2 項目。
>
> **DEFER した発見**: #749（状態語彙の取りこぼし検出が `*_REASONS` を素通り。11 件）。

## 現在地（2026-08-08 更新・第 131〜137 wave 消化後）

> **この日の周回は「観測を直す」に尽きた。** #656（週次ゲート routine が FAIL を記録しても
> PR を作らない）の外側の網を作る過程で、**クラウドで検査が到達しない原因を 3 周にわたって
> 当て推量で差し替えた**（`gh repo view` → `git symbolic-ref` → `git ls-remote --symref`）。
> 毎回クラウドで実走させて事実は持ち帰ったのに、そこに書かれていたのは常に
> `Command failed: <コマンド>` だけだった — `execFileSync` の例外は `message` が
> そこまでで、**理由は `stderr` にある**。拾っていなかった。
>
> stderr を 1 行載せた途端（PR #665）、原因も対処法もエラー本文が教えてくれた:
> 「クラウドのサンドボックスは GitHub GraphQL を絞っており、`gh pr list` は 403。
> REST via `gh api repos/{owner}/{repo}/...` を使え」。
> **直すべきは 4 つ目のコマンドではなく観測だった。同じ対象で 2 回外したら、3 つ目の候補を
> 試す前に「診断が原因を含んでいるか」を見る。**
>
> **分類 stale の 6 回目**: #578 の増分 2・3 は既に main に在り、しかも**増分 2 は issue の
> 提案とは違う形で解決済み**だった（版差は `createVRMAnimationClip` が補正するので、
> issue が提案した `resolveMotionApplicability` を足すと**二重補正**になると実コードが記録
> していた）。残っていたのは増分 1 の後半（カメラの観測可能化）だけ。
>
> **自分が入れた検出器で狼少年を作りかけた。** `orphan_branch`（PR にならなかった push）は
> **push 済み・PR 作成前**という正常な窓を error にしていた（自分の作業ブランチ 2 本を実際に
> 誤検出）。FAIL / SKIP で 2 度踏んだ型の 3 回目。猶予 24 時間で分けたが、**日時が分からない
> ときは指摘する側に倒す** — ローカルに無いオブジェクト＝一度も fetch していないブランチで、
> まさに #656 が起きた形だから。
>
> **非停止境界で残っているもの**:
> - **#656 の AC1 本体 / AC2** … routine 自身が PR 作成失敗に気づいて失敗終了すること。
>   **週次 routine の指示文が読めずブロック中** — `RemoteTrigger` の `list` は新しい 20 件しか
>   返さず cursor を受け付けない。routine ID を控えるか https://claude.ai/code/routines を開く
> - **`BranchPullRequest.state` の simplify** … 運んでいるだけで判定に読まれていない
>   （消費者ゼロのフィールド）。「open/merged/closed はいずれも指摘しない」という 3 本の
>   テストは、状態を検証しているように見えて素通りしている
>
> **停止境界・外部待ち**: #629（下記）/ #646（2 手目以降の実発信）/ #638（origin-verify の
> ローテーション手段・**今やると全断する**）/ #625（実機 UAT）/ #424 の残 2 項目。
>
> 🔴 **#629 は「やること節どおりに実装すると壊れる」ことが判明した**（実装せず issue に記録）。
> CloudFront の custom error response は**ディストリビューション単位で cache behavior に
> 絞れない**ので、403/503 を割り当てると **API の 403/503 応答を全部 HTML に差し替える**。
> 本番 31 ファイルが 403 を返し、`PROVIDER_WEBHOOKS_DISABLED` の 503 + `Retry-After` は
> Vonage の再送に効いている運用スイッチ。解決策は 3 通りあって fallback の意味が変わるため
> **停止境界（Journey / fallback の仕様判断）**。
>
> **#612 は受入条件 1（Secrets Manager 供給）と 3（漏洩確認）が充足済みで、残るのは
> 2（ローテーション手順）= #638 だけ。** それが解けるまでクローズできない。

## 旧・現在地（2026-07-30 更新・第 77 wave 消化後）

> **#361 をクローズした**（第 76〜77 wave / PR #505・#506）。受入条件 7 件すべて充足。
> 着手時の `/issue-ac-mapping` で **7 AC のうち 6 件が既に充足**と判明し、本書の「`ConversationTurnView`
> 不在」が stale だった（**分類 stale の 5 回目**）。実際に足りなかったのは QR 受付側だけで、
> (a) アバター字幕が locale を無視して ja 固定、(b) 逃げ道が各ターン手書きで契約の
> `checkinEscapeHatchesFor` が消費者ゼロ、の 2 点。
>
> **「消費者ゼロ導出はもう無い」は受付側だけの話だった。** 第 71 wave でそう記録したが、同じ
> `ui-contract.ts` の QR 受付側（`CheckinTurnView`）は一巡していなかった。**「一巡した」と書くときは
> 契約ファイル全体で数える。** QR 側で今も未消費なのは `checkinInputModesFor` /
> `checkinRequiresExplicitConfirmation`（値は正しく、テストで縛られている）。
>
> 次に着手する候補はユーザー判断（下記「次に着手する候補」節・#419 グローバルストアのテナント対応 /
> #421 admin IA 再編 / #423 横断 E2E / AI Evolution #382〜#392）。

## 旧・現在地（2026-07-29 更新・第 62 wave 消化後）

> **新規セッションはまず [`docs/handoff-2026-07-29.md`](handoff-2026-07-29.md) を読むこと。**
> 次に何をするか・再調査不要な確定事実・ユーザー判断待ちの一覧がそこにある。
>
> **判断待ちは 0 件になった**（第 55〜57 wave でユーザー承認取得）。
> **#366 / #405 の月 $14.2 費用は承認済み**、**#363 は実施承認済み**、**#422 inc5 は着手可**。
> 差分 C' は (a) 実施済み・**(b) 音声入力の実装のみ要確認**。
>
> **`--full` はこのリポジトリで初めて全ステップ green になり、マージ時の迂回は不要**
> （PR ゲートは `scripts/hooks/pr-gate-guard.sh` が機械的に強制する）。
> 残件は **#480**（linux の VRT ベースライン。**Linux セッションでしか対応できない**）。
>
> **#422 inc5 は 3 段に引き直した**（ユーザー承認済み）: inc5-a（契約を真にする・**完了**）→
> inc5-b（画面を `ConversationTurnView` へ配線）→ inc5-c（ステッパー廃止等・**inc5 から除外**）。
> **inc5-b の地ならし（残る 3 導出の突き合わせ）は完了**（第 63 wave / PR #489）。
> `gazeTarget` に乖離 2 件（`fallback` が存在しない回答領域を指す / 通信断の `failed` が
> 出ないはずの代替 CTA を指す）。`deriveAvatarEmotion` と
> `requiresExplicitConfirmationFor` は**値が正しく**、縛るテストだけ足した。
> **inc5-b 本体は増分に割って進める。増分 1（主指示の配線）は完了**（第 64 wave / PR #490。
> `conversation-turn.ts` が契約 `MessageKey` → i18n キーの解決を持つ）。
> **増分 2（単一 CTA 3 画面 = 確認 / 失敗・未応答 / 通話中）も完了**（第 65 wave / PR #492）。
> `turnAnswersFor` 経由になり、**代替導線を出すかの判断が画面から消えた**
> （`reception-screens.tsx` の `shouldOfferAlternativeContact` import ごと削除）。
> **増分 3a（用件カード）も完了**（第 66 wave / PR #493）。ラベルの二重管理
> （契約の生リテラル vs 辞書）を解消し、画面から `RECEPTION_PURPOSES` が消えた。
> **増分 3b（待機の入口）も完了**（第 67 wave / PR #494）。QR 受付は「回答」ではなく
> **引き渡し（`handoffs`）**として型で分け、`quick-actions.ts` から入口の定義が消えた。
> **inc5-b の配線は一巡した。** inc5-c はユーザーと仕様を詰めて 3 増分に分割済み
> （設計は `docs/superpowers/specs/2026-07-29-issue-422-inc5c-design.md`）。
> **増分 1（ステッパー廃止 + 字幕の位置づけ化）は完了**（第 69 wave / PR #496）。
> **増分 2（常設要素の領域帰属）も完了**（第 70 wave / PR #497）。契約が 3 領域の語彙と
> ターン要素の帰属を、component の登録簿が実 DOM 要素の帰属を持つ。`data-testid` と
> `data-persistent-region` を登録簿から同時に供給するので**描画側が登録簿を迂回できない**。
> **増分 3（`gazeTarget` の VRM 適用）も完了**（第 71 wave / PR #498）。
> **#422 は第 72 wave でクローズした**（受入条件 7 件すべて充足）。受入条件に対応しない
> 実装範囲 2 項目は #500（段階表示ルール）/ #501（kiosk 専用トークン分離）へ切り出した。
> 残る検証は実機（#65）と linux VRT ベースライン（#480）。
> 視線の実描画確認は headless では不可（WebGL fallback へ落ちる）ため #65 へスタック。
> 前セッション分は [`handoff-2026-07-27.md`](handoff-2026-07-27.md)。

**統合再設計プログラム #418 の進捗**: Wave 0（#425 台帳・クローズ済）→ Wave 1（#419 契約 +
`/api/configuration/effective` 実配線）→ Wave 2（#420 = 版ライフサイクル・永続化・スナップショット公開・管理 API・反映状況）
→ Wave 4 の increment 1〜2（#422 = 端末の構成取得を実効構成の 1 回取得へ一本化 → 構成取得 /
環境監視 / メトリクスのフック分離）→ #420 の端末側の版報告と定期再取得（公開 → 端末取得 → 反映 ACK が一周した）まで消化。
→ #422 increment 3〜4（`renderScreen` の props オブジェクト化 → **受付ジャーニー画面と状態機械の
ファイル分割**）まで消化。`KioskFlow.tsx` は 3196 → **1608 行**。
→ #419 の `kiosk-dev` 除去（**端末 ID はセッションが権威**）まで消化。詳細は第 16〜30 wave の各節。
→ #420 の実検証チェッカ（asset / motion / language）まで消化。
**#427 はユーザー承認を得てマージ済**（`docs/experience/README.md` が体験設計の正本、
`.claude/rules/opus5-autonomous-loop.md` が運用規約）。次の #422 increment 5（新旧 ExperienceShell）は
**その規約の停止境界「主要 Journey / state / fallback の意味を変える仕様判断」に該当する**ため、
着手前にユーザー確認が要る。#363 デモ公開モデルの統合は **ADR 0005 で方針を確定したが、実施は要ユーザー承認**（台帳 §9 B-07）。
第 34 wave で **Journey / 状態モデルと実装の差分を洗い出し**（`docs/experience/state-mapping.md`）、
対応表を機械検証（`src/domain/experience/journey-map.ts`）にした。
**差分 B は第 35〜37 wave で決着**（体験状態は 1 つも増やさずに済んだ）。
**差分 C の「2 つの確認を統合する」提案は ADR 0007 で却下**（前提が誤りだった）。ただし
**差分 C'（音声だけでは受付を完遂できない。`SCREEN_TO_INPUT_MODES` の宣言と実装が
3 分の 2 で食い違う）は実在し、要ユーザー確認**（音声入力を増やすのは Journey の意味に触れる）。
差分 D も要ユーザー確認のまま。**#422 increment 5 の範囲引き直しも仕様判断なので未確定。**
**ブラウザ e2e はこのコンテナで動き、フルスイート 172/172 が安定して green**
（第 22 wave で実行環境を是正・第 23 wave で干渉を解消）。UI に触る変更は `--e2e` を通すこと。
移行状態の追跡は **`docs/product-integration-plan.md` が正**（本書は着手順・依存 DAG を持ち、
移行台帳は持たない）。

## 旧・現在地（2026-07-27 起票登録時）

**2026-07-23〜26 に統合再設計プログラム #418〜#426（9 件）が起票された**（本書に未登録
だったため 2026-07-27 に登録。下記「統合再設計プログラム」節）。#418 の issue コメントで
**推奨開始順が明示**されている: ①#425 Wave 0（baseline 固定・移行台帳）→ ②#419
（ProductContext 型・resolver 契約・越境防止契約テストの小 PR）→ ③#420 → ④#421 →
⑤#422 → ⑥#423 → ⑦#424。AC マッピング済み（2026-07-27、結果は同節の表）。

**ユーザーの draft PR が 2 件 open**（#427 = Opus 5 自律ループ guardrails +
`docs/experience/README.md`、#428 = Opus 5 operating profile）。いずれもユーザー起票の
ドキュメント PR で、#418 配下の issue は #427 の Experience Engineering 規約
（Journey ID・状態遷移・音声タッチ等価性等）を必須入力とする旨が #418 コメントに在る。
**マージ判断はユーザー**（本ループでは触らない）。

**エピック群の優先順位（#418 統合再設計 / #382〜#392 AI Evolution / #360・#364・#368 残差）
はユーザー判断**。ただし #418 は最新の起票でかつ #424 が AI Evolution 系の関心を包含する
形になっており、着手順が issue 側で確定しているため、**次周回は #425 Wave 0 + #419 を
既定候補とする**（両方ローカル可・破壊なし。異議があればユーザーが interrupt）。

起点確認 2026-07-27: main = `31718c7` で `quality-gate.sh --fast` green
（typecheck / lint / unit 3734 件 PASS）。

## 旧・現在地（2026-07-21 時点）

**2026-07-19 に AI Evolution epic 群（#382〜#392 の 12 件）が追加起票された**（本書に未登録
だったため 2026-07-21 に登録。下記「AI Evolution epic 群」節）。全件 greenfield
（`src/` に Evolution/Opportunity/Signal 系の実装は無関係モジュールのヒットのみ）。
土台として再利用する既存資産は #83 コンソール・#89 使用量/監査・feature-flags・#319 KPI・
#320 満足度・#365 評価ハーネス・#379 コスト画面。

**前フェーズ（2026-07-11 起票の三層棚卸し #313〜#331）は完了・クローズ済み**
（PR #333〜#359、詳細は `docs/handoff-2026-07-12.md`）。

**現在の LOOP は「2026-07-19 に起票された次世代 epic 群（#360 / #364 / #368）を
消化する」フェーズ。** 起票時に 18 件（#360〜#377）が追加され、全件を実コードへ
マッピング済み（結果は下表）。マッピングで判明した重要事項:

- **#374（ルーティング）を「未着手」扱いしない。** `domain/notification/call-route.ts` に
  `CallRoute > CallTargetGroup > CallTarget(channel/priority)` + 管理 UI + API が既に在り、
  AC「Vonage 以外の Provider 追加時に受付ドメインを変更しない」は設計上ほぼ達成済み。
  残差分は `RoutingStep.nextOn` の結果別遷移と Orchestrator に絞れる。
- **#375（QR 招待）も部分充足。** 期限/使用済み/取消の区別（`CheckinFailureReason`）と
  「QR に PII を含めない」は既に充足。~~残るのは token の hash 化と 3-ref 分離のみ~~
  → **hash 化は第 13 wave で完了。残るのは 3-ref 分離だけ**（第 41 wave 確認）。
- **#362 は AC 違反が現物として存在する。** `KioskFlow.tsx:1055` で
  `usePresenceCamera(presenceActive, startReception)` が検知→`dispatch({type:'START'})` に
  直結している。バグ相当なので配線分離 + 回帰テストで消化できる。
- ~~**#369〜#372 は完全 greenfield。**~~ → **第 41 wave に撤回**（PR #401〜#404 で実装済み。
  本物のパイプラインは `src/domain/voice-*` と `src/lib/voice-*` に在る）。
- **#367 の「#366 依存」は過剰記述。** Increment 1（ServiceOperatingPolicy）と
  Increment 4（営業時間外 Kiosk UX）は EC2 非依存でローカル完結可能。#366 が要るのは
  EC2 start/stop adapter のみ。→ **その通りで、実際に PR #407/#414 で消化済み**（第 41 wave 確認）。

## オープン issue（46 件・2026-08-08 時点）

> **第 41 wave の棚卸し**: 本表の分類を実コードへ突き合わせ直したところ、**4 行が実装済みを
> 「未着手」と書いていた**（#367 / #369〜#372 / #374 / #375）。件数も 43 → 42（#327 クローズ）。
> 本書冒頭が自ら警告している「分類は仮説であって事実ではない」の 4 回目の再発。
> **着手前に `/issue-ac-mapping` を通すこと**（表を信じて作り直すのが最大の損失）。

### 新 epic 群（2026-07-19 起票）

| # | 種別 | 充足状況（根拠） | 分類 |
| --- | --- | --- | --- |
| **#360** | epic | Character-led 受付・会話・低コスト基盤の統合 epic（トラッキング） | — |
| ~~#361~~ | ux/kiosk | **クローズ済**（第 76〜77 wave。受入条件 7 件すべて充足）。着手時の再マッピングで旧「`ConversationTurnView` 不在」が **stale** と判明（契約は `ui-contract.ts` に在り #422 inc5-b で配線済み）。第 76 wave で QR 字幕の locale 固定を是正（PR #505）、第 77 wave で QR の逃げ道を `EscapeBar` 共有の常設バーへ統一（PR #506）。確認画面の `checkin-cancel`（「やめる」）は `cancelled` の到達性を保つためユーザー確認のうえ残した | 完了 2026-07-30 |
| ~~#362~~ | ux/kiosk | **クローズ済**（第 2 wave: KioskMode/attract-detector 分離・検知→START 直結廃止） | 完了 2026-07-22 |
| **#363** | admin/demo | **Inc1〜3 実装済**（シナリオ・編集/保存・下書き/テスト/本番公開・共有トークン・未認証閲覧）。第 33 wave で **#420 版モデルとの統合方針を ADR 0005 で確定**。**残**: 統合の実施（§9 B-07。永続スキーマとスコープ語彙を動かすため**要ユーザー承認**） | 要ユーザー確認 |
| **#364** | epic | 日本語リアルタイム会話基盤 epic（トラッキング） | — |
| ~~#365~~ | quality/voice | **クローズ済**（PR #393）。`src/domain/voice/evaluation-*` + `tests/voice-evaluation/`。**#369〜#372 の共通イベント形式が確定** — 正解は刺激側（`nearEndStimuli[]` の `atMs ± toleranceMs`）に固定し観測とマッチング、計測不能は `null`、`strict` で欠落自体を違反に。詳細は `docs/voice-evaluation-harness.md` | 完了 2026-07-22 |
| **#366** | infra/cdk | **未着手**: `infra/lib/stacks/` に realtime 系なし。`docs/adr/` 自体が不在 | **要ユーザー判断（固定費増）**。Phase 0 ADR のみローカル可 |
| **#367** | admin/ops | **大部分実装済**（第 41 wave に訂正。旧「未着手・0 ヒット」は誤り）: `domain/operating-policy/{schedule,tz,text-format,types}.ts` + `lib/operating-policy/{call-guard,kiosk-gate,request,store}.ts` + `app/api/admin/operating-policy/` + `app/admin/operating-hours/` + `components/kiosk/OutOfHoursView.tsx`（PR #407/#414）。**残**: EC2 の start/stop/drain adapter | ローカル可（残りは #366 待ち＝費用増） |
| **#368** | epic | 組織・接続先・ルーティング・QR 招待の再構築 epic（トラッキング） | — |
| **#369** | voice | **実装済（純ロジック + 配線）**（第 41 wave に訂正。旧「未着手」は誤り）: `domain/voice-transport/`（token/lifecycle/queue/rate-limit/fallback/eval-bridge、7 module × 7 test）。`lib/voice-session/orchestrator.ts` から配線済 | ローカル可（実機計測は #65） |
| **#370** | voice/stt | **実装済**（同上）: `domain/voice-stt/`（stabilizer/entity-resolver/fallback）+ **`lib/voice-stt/transcribe-adapter.ts`（`TranscribeStreamingSttProvider`）** + mock provider。旧「Transcribe 参照 0」は誤り | ローカル可 / 実 AWS 疎通は外部待ち |
| **#371** | voice/tts | **実装済**（同上）: `domain/voice-tts/`（cache/queue/lifecycle/viseme/suppression/dynamic-utterances、9 module × 9 test）。Polly は `server/notification/polly-adapter.ts` に在る | ローカル可 / 実 AWS 疎通は外部待ち |
| **#372** | voice/turn | **実装済**（同上）: `domain/voice-turn/`（vad/turn-detector/near-end-classifier/barge-in-controller/history-truncation/stt-integration）。旧「VAD/turn detector なし」は誤り | ローカル可 |
| **#373** | domain/org | **increment 1〜7 完了。読み→書き→画面の一巡が閉じた。** inc1 型・階層検証／inc2 永続化／inc3 合成ビュー／inc4 来訪者ディレクトリ導出＋同姓同名ラベル（PR #588/#590/#592）／inc5 編集 API（#596）／inc6 管理画面 `/admin/organizations`（#598）／inc7 階層編集（#603）。**規則 A（2026-08-02 ユーザー判断）: 組織の有効/無効は担当者の呼び出し可否へ波及させない。ただし所属単位の `callable`/`publicInDirectory` は効く。** 残: **代理担当を来訪者面に出すか（仕様判断・要ユーザー確認）**のみ。**site scope 化は実装不能と判明**（`Department`/`Staff` に `siteId` が無く、互換ユニットは要求スコープの siteId を継承するので no-op。前提はスキーマ変更＝停止境界。実測の根拠は #373 コメント） | 残りは要ユーザー確認 |
| **#374** | domain/routing | **実装済**（第 41 wave に訂正。旧「未達」列は stale）: `domain/routing/`（endpoint/policy/orchestrator/ledger/describe/compat/seed/provider/mock-provider、9 module × 7 test）。循環検出は `policy.ts`。**残**: 旧 `call-route` との重複解消（台帳 §5 の重複概念＝概念一本化は仕様判断） | 残りは要ユーザー確認 |
| **#375** | domain/invitation | **部分**: token hash 化は第 13 wave 完了。**3-ref 分離は第 42 wave で型と写しを実装し、第 53 wave で `issuedBy` の永続化まで到達**（任意フィールドで加算的・サーバの認可済みコンテキストから導出＝公開 API は非破壊）。**残**: `receptionTarget` / `connectionTarget` の載せ替え。MVP 制約下では `targetType`/`targetId` から導出でき**情報が増えない**ため、公開 API を動かす価値が薄い（要ユーザー確認のまま）・QR 確認画面への発行者表示・監査記録・**本人接続でない招待をどの exception state へ落とすかの体験設計**（`person_unavailable` か新規か。J-OR-03 / J-OR-05 に直結） | 残りは**要ユーザー確認**（公開 API + Journey の意味） |
| **#376** | spike/vonage | **部分**: `vonage-adapter.ts`・`vonage-jwt.ts`・`docs/vonage-call-design.md` 在り。実測部未着手 | ADR はローカル可 / 実測は**外部待ち**→ #65 |
| **#399** | avatar | **本書に未登録だった**（第 41 wave に追加）。`public/avatar/` は README + provenance のみで実 VRM 資産なし。実機 UAT とライセンス条件の判定を含む | **外部待ち**→ #65 |
| **#405** | platform | **本書のオープン表に行が無く、完了アーカイブ行にだけ現れていた**（第 41 wave に追加）。Inc1 実装済: `domain/provider-config/`（config/secret/types/secrets-manager-store + server-only 静的検証）+ `lib/platform/tenant-secret-store.ts`。**残**: Inc2 の保存先判断（Secrets Manager / KMS+DynamoDB）＝ secret 方針 + コスト | **要ユーザー確認**（issue 本文も明記） |
| ~~#377~~ | platform | **クローズ済**（PR #378: developer 専用 `GET /api/platform/costs`・タグ絞り込み・実績/予測・追加依存なしの SigV4 自作署名。レビューで署名を独立実装と照合し一致確認）。follow-up は **#379** | 完了 2026-07-19 |
| ~~#379~~ | platform | **クローズ済**（第 2 wave: 予測失敗理由の伝播・TTL キャッシュ・回帰テスト） | 完了 2026-07-22 |
| ~~#396~~ | domain/org | **クローズ済**（第 2 wave: 防御的回収の削除・scope/publicIds 必須化・`validateOrganizationMembership` 新設） | 完了 2026-07-22 |

> **#369〜#372 は PR #401〜#404（第 3〜6 wave）で実装済み**だった。「`src/lib/voice/` を音声
> パイプラインと誤認しない」という旧・落とし穴は、**本物のパイプラインが `src/domain/voice-*` と
> `src/lib/voice-*` に在る**現在では逆向きの誤誘導になるので撤去した。

### 統合再設計プログラム（2026-07-23〜26 起票 / 2026-07-27 登録・AC マッピング済）

キオスク・管理画面・プラットフォームを 1 つの循環（提供→構成→プレビュー→公開→実行→
計測→評価）へ統合する親 Epic #418 と実行 issue 群。着手順は #418 コメントで確定
（#425 Wave 0 → #419 → #420 → #421 → #422 → #423 → #424）。

| # | 種別 | 充足状況（2026-07-27 マッピング根拠） | 分類 |
| --- | --- | --- | --- |
| **#418** | program | 親 Epic（トラッキング）。子 = #419〜#425、Related #426 | — |
| **#419** | architecture | **increment 4 完了**（第 16 wave = 契約 52 テスト / 第 18 wave = `src/lib/product-context/` + `GET /api/configuration/effective` 33 テスト / 第 24 wave = `/kiosk` クライアントの新経路切替を移行フラグ配下で実施 19 + e2e 5 / 第 30 wave = `kiosk-dev` 除去・端末 ID をセッション権威に 9 + e2e 1）。**残**: 移行フラグ既定の切替（観測後）・グローバルストア（branding/directory/voice/motions/avatar/languages）のテナント対応・旧個別 API の撤去（台帳 §9 B-03） | ローカル可（継続） |
| **#420** | lifecycle | **increment 7 完了**（第 17 = 純ロジック 34 / 第 19 = 永続化・スナップショット公開・管理 API 45 / 第 20 = heartbeat 受け口 + 反映状況 API 20 / 第 21 = 管理画面 18 / 第 26 = 端末側の報告送信 11 / 第 27 = **端末側の定期再取得 + 受付中は適用保留** 10 + e2e 2 / 第 31 = 実検証チェッカ（asset / motion_mapping / language_fallback）18。計 156 テスト）。**ライフサイクル（公開 → キオスク取得 → 反映 ACK）が一周した。** / 第 32 = 取次到達性の検証 13。計 169 テスト）。**残**: デモ公開モデル（#363）の統合・ナビ配線（#421） | ローカル可（継続） |
| **#421** | admin ux | **部分**（業務構造への再編は未着手）。第 45 wave で AC「既存管理機能を失わない」に反していた `/admin/experience-versions` の**ナビ未登録**を是正し、同種の取りこぼしを検出するメタテストを追加。**残**: 重複ナビの統合（`受付端末`/`受付端末（拠点別）`・`呼び出しルート`/`取次ルート`）は**概念一本化＝仕様判断**、業務構造への再編本体は #419/#420 の後 | 重複統合は要ユーザー確認 / 再編本体はローカル可 |
| **#422** | kiosk ux | **increment 4 完了**（第 24 wave: `useEffectiveConfiguration` で構成取得 7 経路 → `/api/configuration/effective` 1 回取得へ一本化。移行フラグ `effectiveConfiguration`・新経路失敗時は旧経路へ自動フォールバック。19 unit + 5 e2e / 第 25 wave: `useKioskConfiguration`・`useKioskDeviceStatus`・`useExperienceMetrics` へ分離 / 第 28 wave: `renderScreen` の props オブジェクト化 / 第 29 wave: `reception-screens.tsx`・`flow-state.ts` へ分割し **3196 → 1608 行**）。会話中心化の部品は #361/#364 で先行。**残**: 新旧 ExperienceShell の切替・ステッパー最小化・常設要素の 3 領域整理・ConversationTurn への接続 | #419 の後（#420/#421 と並行可だが推奨 Wave は #421 の後） |
| **#423** | nav/e2e | **部分**: e2e 資産は厚い（`tests/e2e/` 40+ spec）。第 46 wave = 管理 API 認可網羅の静的検証 / 第 74 wave = 対象テナント context の安全側フォールバックを e2e 固定 / **第 83 wave = 別実装 TenantSwitcher の表示統合**（意味は統合しない。母集合・未選択の有無・永続化と監査・反映方法が別。重複していたのは表示だけで、`AdminShell` の固定表示と admin 側の単一所属表示が逐語的に同一かつ排他レンダリング＝片方直しても気づけない形だった。両方が同じ `data-testid="tenant-switcher"` だった点も解消）。**第 84 wave = context 優先順位の契約**（`src/domain/tenant/context-scope.ts`。`route > sticky > none`、ただし**どちらも server resolved の許可集合で濾す**＝#419「クライアントが送る識別子は権威にしない」の形。`differsFromSticky` で食い違いを UI へ伝え、route が sticky を書き換えない＝「暗黙の切り替わり」を作らない）。**第 85 wave = 配線**（`resolveViewingContext` が契約の消費者。`/platform/tenants/[tenantId]` でヘッダに「表示中: <名前>」を出し、sticky と別なら「（選択中と別）」を併記。**select は sticky を示し続ける**＝プルダウンの意味を嘘にしない、**route は sticky を書き換えない**）。**第 88 wave = エリア切替導線**（developer のみ admin → platform。戻りは無条件）。**第 107 wave = 共通コンテキストバーの Site 次元**（ヘッダに「対象拠点」を常設。第 88 wave が「route 層も sticky 層も無い」として却下した前提は #421 で `/admin/sites/[siteId]` と `?siteId=` ができて**成立しなくなった**＝分類 stale の 7 例目）。**残**: `Kiosk > Version` 次元（route/sticky 層が無い。#420 の版選択 UI が先）/ platform→admin→preview→kiosk の 10 ステップ横断シナリオ / 越境・失効 **テナント** context のエラー UX（テナント作成 API の壁の向こう）/ **AC「視覚回帰は desktop admin も対象」= 未充足**（admin の VRT baseline が 1 枚も無い。**darwin と linux の両方が要るので linux セッションと組で行う**）。**意味の一本化（admin にも全テナント横断を出すか等）は仕様判断＝要ユーザー確認** | ローカル可（継続。意味統合は要確認） |
| **#424** | ai loop | **増分 1〜3 完了**（第 78〜80 wave）: `docs/ai-development-loop.md` / Issue・PR テンプレート / **change-risk classifier**（`src/domain/governance/change-risk.ts` = 停止境界 8 種を変更パスから判定する純関数。`scripts/change-risk.ts` が git から集めて `quality-gate.sh` が毎回**報告のみ**で呼ぶ）。**残**: schema diff チェック / 追跡 ID / kill switch・変更量上限 / 定期評価レポート / プロンプト・ツール実行の監査ログ / **元 issue への計測書き戻し**（KPI 実データが要るので稼働環境待ち）。受入条件は 6 件中 0 件が充足 | ローカル可（継続。計測系は稼働環境待ち） |
| **#425** | delivery | **Wave 0 完了**（第 16 wave: `docs/product-integration-plan.md` = Wave 開始/終了条件・占有ファイル・route/API 移行マトリクス・重複概念・暫定 ID・feature flag registry・breaking-change register・rollback playbook・KPI baseline、`docs/adr/README.md` = ADR index）。**残**: Wave 1 以降の各 PR で状態列を更新していく運用（台帳自体の追加作業なし） | 完了 2026-07-27 |
| ~~#426~~ | docs | **クローズ済**（第 78〜79 wave）。作成対象 3 件すべて存在: `docs/product-integration-plan.md`（第 16 wave）/ `docs/adr/README.md`（同）/ `docs/ai-development-loop.md`（第 78 wave）。受入条件「各 PR が基準文書または ADR を参照する」「設計変更時に文書更新を要求する PR チェック項目がある」は PR テンプレートの該当節で充足 | 完了 2026-07-30 |

### AI Evolution epic 群（2026-07-19 起票 / 2026-07-21 登録）

自律型プロダクト進化基盤の epic。**全件 greenfield**。既存の #360/#364/#368 wave とは
ファイル領域がほぼ独立（`/platform/evolution` 系）なので独立トラックにできるが、
**既存 epic 群との優先順位はユーザー判断**（本書は依存順のみ定義する）。

| # | 種別 | 充足状況（根拠） | 分類 |
| --- | --- | --- | --- |
| **#382** | epic | 自律進化基盤の統合 epic（トラッキング）。自律レベル L0〜L5・停止条件を定義 | — |
| **#392** | adr/spike | **未着手**: `docs/adr/` 自体が不在。Claude Managed Agents / Agent SDK / AWS 実行基盤の責務境界検証 | ローカル可（ADR 起草）。**実コスト発生する検証は要ユーザー判断** |
| **#383** | governance | **未着手**: 憲章・変更分類・Policy as Code・Kill Switch。`PROJECT_CHARTER.md` は在る | ローカル可。**Increment 0 = 最初に着手**（L0 固定・deny fixture 先行） |
| **#384** | intelligence | **未着手**: 外部シグナル収集は interface + mock 先行、実クロールは外部待ち | ローカル可（mock 先行） |
| **#385** | diagnostics | **未着手**: Scorecard。#319 KPI・#320 満足度・#89 使用量を再利用（重複計測しない） | ローカル可 |
| **#386** | opportunity | **未着手**: Opportunity Registry。#383/#384/#385 の後 | 依存待ち |
| **#387** | experiment | **未着手**: 土台に `domain/platform/feature-flags.ts` 在り。Shadow/Canary/Guardrail | #383 の後 |
| **#388** | development | **未着手**: 隔離環境の自律開発 → Draft PR。main push/merge 権限なしが前提 | #386 の後（外部実行基盤は #392 ADR で裁定） |
| **#389** | evaluation | **未着手**: 独立評価器・Evidence Package・Release Governor | #387/#388 の後 |
| **#390** | memory | **未着手**: Evolution Ledger。Run/Evidence 最小モデルは Increment 1 で先行可 | #383 の後 |
| **#391** | console | **未着手**: `/platform/evolution`。read-only shell は早期実装可、write は各 Policy/API 完成後 | read-only は #383 後に前倒し可 |

**推奨着手順（epic 記載の Increment 準拠）**: #392 ADR + #383 → (#384 ∥ #385 ∥ #390 最小 ∥
#391 read-only) → #386 → #388 → #389 → #387 → 段階昇格。
**ガード**: 本 epic 群は権限・IAM・Secret・監査・課金・PII に触れる設計判断を多く含む。
各 issue の「重大変更時ユーザー確認」条件（CLAUDE.md）への該当が既定で高いことを前提に進める。

### 継続オープン

| # | 種別 | 状態 | 分類 |
| --- | --- | --- | --- |
| **#290** | platform ops | ローカル可能分は消化完了（item1-4）。残: 実 deploy 実行本体 | #195 外部待ち |
| **#196** | perf | バンドル -19%・a11y 1.0/BP 0.96 live 確定・TTFB 50-90ms。残: PSI で perf 値取得 | PSI クォータ待ち |
| **#195** | infra | dev 分完了（Notification/Monitoring 稼働・authorizer 検証済）。残: prod deploy | prod 見送り中 |
| **#4** | feature | Vonage 実通話（基盤・interface 済） | #65 スタック |
| **#31** | feature | VRM 状態別モーション（実描画済・残 idle `.vrma`） | #65 スタック |
| **#65** | 集約 | 実機 UAT / 実認証 / WebKit E2E のスタック先 | 外部リソース待ち |

## 依存 DAG

```
#365 評価基盤 ──┐(先行・並行)
                ├→ #369 Transport ─┬→ #370 STT ─┐
                │                   └→ #371 TTS ─┴→ #372 Turn/Barge-in
#366 Phase0 ADR ─→ #366 Stack ─→ #367（EC2 adapter 部のみ）
                                  #367 Inc1/Inc4 は #366 非依存 ★
#373 Organization ─→ #374 Routing ─→ #4 Vonage Provider
#375 Invitation ───→ #374（RoutingPolicy 解決で合流）
#362 状態分離 ─→ #361 Character-led UI ─→ #363 Demo Harness
                                  #363 は #374 の Mock contract も要求
#376 Spike ─→ #4 MVP2
すべて ─→ #65 実機 UAT

[統合再設計プログラム #418（着手順は issue コメントで確定）]
#425 Wave0(baseline+台帳) ─→ #419 ──┬─→ #420 ──┬─→ #421 ─→ #423
                                    │           └（#423 は #419/#420/#421 に依存）
                                    └─→ #422（#419 のみ依存・推奨は #421 の後）
#424 は各 wave の Issue/PR へ順次適用（初回適用対象 = #419）
#426 は #424/#425 と並行可（Related 扱い・順序指定なし）

[AI Evolution（独立トラック・優先順位はユーザー判断）]
#392 ADR ─┐
#383 Governance ─┬→ #384 Intelligence ─┐
                 ├→ #385 Diagnostics ──┼→ #386 Opportunity ─┬→ #388 Development ─→ #389 Governor
                 ├→ #390 Ledger        │                    └→ #387 Experiment ──→ #389
                 └→ #391 Console(read-only 先行、write は各 Policy/API 後)
```

★ issue 本文の「#367 依存: #366」は過剰記述（上記「現在地」参照）。

**issue 本文に無い実装上の依存**: **#362 → #361**。両者とも `KioskFlow.tsx`（2880 行）を
触るため、先に #362 の presence 配線分離を入れてから #361 の大規模再構成に入る。

## ウェーブ計画

**過去 wave の詳細は各ハンドオフに委譲する**（本書に残すと陳腐化して誤誘導するため。§完了アーカイブ）。

| wave | 時期 | 概要 | 記録 |
| --- | --- | --- | --- |
| 1〜15 | 2026-07-19〜23 | 次世代 epic 群（#360/#364/#368）の消化。音声基盤・組織/ルーティング・デモハーネス・営業時間・テナント別 secret・VRT/axe 導入 | `docs/handoff-2026-07-22.md` ほか |
| 16〜23 | 2026-07-27 | 統合再設計 #418 の Wave 0〜2（#425 台帳 / #419 契約と実配線 / #420 版管理・スナップショット公開・反映状況・運用画面）+ **e2e 実行環境の是正と安定化** | **`docs/handoff-2026-07-27.md`** |
| 24 | 2026-07-27 | #422 increment 1: 端末の構成取得を `EffectiveKioskConfiguration` の 1 回取得へ一本化（移行フラグ配下・自動フォールバック付き）+ ADR 0004 | 本書 + `docs/product-integration-plan.md` §4.1 / §7 / `docs/adr/0004-kiosk-experience-migration-flag.md` |
| 25 | 2026-07-27 | #422 increment 2: 構成取得 / 環境監視 / 体験メトリクスを `KioskFlow` からフックへ分離（挙動不変・e2e 177/177 で固定） | 本書 |
| 26 | 2026-07-27 | #420 increment 5: 端末が読み込んだ版を heartbeat で報告（反映状況画面が全台 `pending` だった片肺を解消） | 本書 |
| 27 | 2026-07-27 | #420 increment 6: 端末が構成を定期再取得し、**受付進行中は適用を保留**して次セッションから新版を使う | 本書 |
| 28 | 2026-07-27 | #422 increment 3: `renderScreen` の 29 位置引数を props オブジェクト化 | 本書 |
| 29 | 2026-07-27 | #422 increment 4: `reception-screens.tsx`（画面 1487 行）と `flow-state.ts`（状態機械 88 行）へ分割。`KioskFlow.tsx` 3196 → 1608 行 | 本書 |
| 30 | 2026-07-27 | #419: `kiosk-dev` 固定値をクライアントから除去。**死活記録・版報告・失効検知が実端末で初めて機能するようになった**（従来は全て seed 端末の設定を見ていた） | 本書 |
| 31 | 2026-07-27 | #427 マージ（体験設計の正本）+ #420 実検証チェッカ（asset / motion_mapping / language_fallback） | 本書 |
| 32 | 2026-07-27 | #420 取次到達性の公開前検証（**実行時が使う `RoutingPolicy` 側**を検査。port 注入で domain は純関数のまま） | 本書 |
| 33 | 2026-07-27 | #363 統合方針を ADR 0005 で確定 + 台帳 §5/§6/§9 B-07 へ登録（**実施は要ユーザー承認**） | `docs/adr/0005-...md` |
| 34 | 2026-07-27 | #422 の前提整備: Journey / 状態モデルと実装の差分洗い出し + 対応表の機械検証 | `docs/experience/state-mapping.md` |
| 35 | 2026-07-27 | #322 の残り: 担当者検索の 0 件計測を端末 → サーバ → KPI 集計 → 管理画面まで繋ぐ | 本書 |
| 36 | 2026-07-27 | 通信断とサーバ失敗を同じ「呼び出しに失敗しました」で伝えていた件を是正（`failureReason`。状態は増やさない） | `docs/experience/state-mapping.md` |
| 37 | 2026-07-27 | **差分 B を決着**（状態を 1 つも増やさず）。第 34 wave の誤判定を訂正: `visitor_detected` / `recognizing` / `choosing_method` は**3 つとも元から実装済み**だった。未登録語彙を検出するメタテストを追加 | `docs/experience/state-mapping.md` |
| 38 | 2026-07-27 | #327 follow-up: **常設の逃げ道バーが全画面で日本語固定**だった件を是正（English を選んだ来訪者が受付中ずっと「戻る/最初に戻る」を見ていた）。allowlist のドリフト 2 件も解消 | `scripts/check-cjk-literals.ts` |
| 39 | 2026-07-28 | **カスタム受付フローで逃げ道が消え、行き止まりになっていた**件を是正（#455 レビューが発見）。逃げ道バーを画面分岐の外へ出し、入れ忘れの余地を構造から無くした | `docs/loop-queue.md` |
| 40 | 2026-07-28 | #327 follow-up: **通信断バナー**（失敗時フォールバックの入口）と端末利用不可・カスタムフロー主 CTA を多言語化。`?heartbeatMs=` で通信断表示を E2E から検証できるようにした | `docs/loop-queue.md` |
| 41 | 2026-07-28 | **キューの棚卸し**（文書のみ）。実装済みを「未着手」と書いていた 4 行（#367 / #369〜#372 / #374 / #375）を実コードで訂正。未登録だった #399 / #405 を追加。件数 43 → 42 | `docs/loop-queue.md` |
| 42 | 2026-07-28 | #375 inc1: 招待モデル（発行主体 / 受付対象 / 接続先）の分離を**型と写しだけ先行**（呼び出し元はまだ無い）。1 参照が 3 つの問いに同時に答えている構造を解いた。接続先の語彙は #374 に合わせた | `src/domain/reservation/invitation.ts` |
| 43 | 2026-07-28 | #327 follow-up: **通話中の状態表示**（locale を受け取っていたのにここだけ日本語固定）と**カスタム受付フローの 2 画面**（locale 未受領）を多言語化。allowlist を 3 件縮小 | `scripts/check-cjk-literals.ts` |
| 44 | 2026-07-28 | #327 follow-up: **補助チャットドロワー**を多言語化（担当者検索 0 件時に開く＝来訪者が困っている時に出る画面）。モック LLM の既定応答も対象。allowlist を 3 件縮小し、**来訪者向けの実際の翻訳漏れは解消** | `scripts/check-cjk-literals.ts` |
| 45 | 2026-07-28 | #421 の一部: **第 21 wave で作った `/admin/experience-versions` がどこからも辿れなかった**件を是正。ナビ未登録のルートを検出するメタテストを追加（作る周回と IA を触る周回が別なので規律では抜ける） | `src/components/admin/navigation.ts` |
| 46 | 2026-07-28 | #423 の一部: **管理 API の認可ガード網羅を静的検証**。既存テストはルートを手で列挙しており、新しい admin/platform ルートを足しても気づかない構造だった（認可境界なので影響が重い） | `src/app/api/admin/authz-coverage.test.ts` |
| 47 | 2026-07-28 | **`--full` ゲートを実際に通した**（10 周回 `--pr` だけで回していた手順違反の解消）。postcss の脆弱性（高・既存 override が修正版を塞いでいた）と lighthouse の Chrome 未検出を是正 | `scripts/quality-gate.sh` |
| 48 | 2026-07-28 | dev 依存の脆弱性 3 件を semver 互換で解消（js-yaml / body-parser / brace-expansion の一部）。**brace-expansion の残りは修正版が存在せず、5.x へ寄せると eslint が壊れることを実測**して断念・記録 | `package-lock.json` |
| 49 | 2026-07-28 | セッション・ハンドオフを作成（第 37〜48 wave）。**境界内の作業がほぼ尽きたこと**と、判断待ち 7 件が #418 Wave 4 を塞いでいることを明示 | `docs/handoff-2026-07-28.md` |
| 50 | 2026-07-28 | **ADR 0006**: 体験設計の未定義 2 件を決定（`privacy_blocked` の定義 / QR スキャン＝第 3 の入力手段）。正本・対応表・実装へ反映。挙動は不変 | `docs/adr/0006-experience-state-model-gaps.md` |
| 51 | 2026-07-28 | **ADR 0007**: 差分 C の「確認の統合」を却下（前提が誤り）。ただし**等価性ギャップは別の理由で実在**（差分 C'）。音声の露出面を固定する回帰テストを追加 | `docs/adr/0007-voice-touch-confirmation-boundary.md` |
| 52 | 2026-07-28 | **ADR 0008**: 差分 D は「今は統合しない」。並存コストを実測したら**修正の伝播漏れ**で、実害 1 件（QR 受付が 403/400/その他を「通信に失敗しました」と表示）を是正 | `src/domain/checkin/failure.ts` |
| 53 | 2026-07-28 | #375 inc2: **QR を誰が発行したかがどこにも記録されていなかった**件を是正（レコードにも監査にも無く、`appendAdminAudit` は actor を固定値で書いていた）。加算的・サーバ導出で公開 API は非破壊 | `src/lib/reservation/service.ts` |
| 54 | 2026-07-28 | ハンドオフを第 53 wave まで更新。**判断待ち 7 → 3 件**（4 件を ADR で決着）。新たに**差分 C'（音声だけでは受付を完遂できない）**が要ユーザー確認として浮上 | `docs/handoff-2026-07-28.md` |
| 55 | 2026-07-28 | **Claude Code 環境の整理**（無関係プラグイン 6 件削除 / 本プロジェクト向け 3 件追加）+ **PR ゲートのフック強制**（`gh pr create`=`--pr` / `gh pr merge`=`--full` を green 記録なしでブロック）+ `visual-checks` skill | PR #473 |
| 56 | 2026-07-28 | **`--full` をこのリポジトリで初めて全ステップ green にした**。gitleaks 誤検知 2 件（履歴走査なので `.gitleaksignore` に指紋で受容）/ semgrep 3 件 / VRT ベースライン 7 枚。加えて**無操作オーバーレイ由来の e2e フレークを根治**（`?inactivityMs.<state>=`）。#477 #478 は**実装不要**と判明 | PR #479 |
| 57 | 2026-07-28 | 差分 C' の (a): `inputModes` の宣言を実装されている手段だけに限る（`voice` だけでなく `text` も過剰宣言だった）。(b) 音声入力の実装は要ユーザー確認のまま | PR #481 |
| 58 | 2026-07-29 | #366: リアルタイム基盤の可用性から音声受付の提示可否を決める純ロジック（ADR-005 の判定を実行可能な仕様として先に固定）。**今 deploy しても EC2 は何も起動しない**ことを確認 | PR #483 |
| 59 | 2026-07-29 | #369: マイク入力 → 送出チャンクの変換（Float32→PCM16 / ダウンサンプル / 20ms チャンク化）。ADR・token API・4段検証・backpressure は**既に充足済み**だった | PR #484 |
| 60 | 2026-07-29 | #363: デモ用途の版を**指定端末にだけ**配る（ADR 0005 手順 1 = additive）。デモ版を publish すると本番端末の配信先が消えるため draft のまま配る | PR #485 |
| 61 | 2026-07-29 | #422 地ならし: 逃げ道アクションの判断を契約へ一本化（二重実装 + `confirming` の食い違いを解消） | PR #486 |
| 62 | 2026-07-29 | #422 inc5-a: 既定 answers / message を画面の実挙動に一致させる。**未消費 6 導出のうち調べた 4 つすべてで乖離**（うち 1 件は存在しない CTA を返す構造的乖離） | PR #487 |
| 63 | 2026-07-29 | #422 inc5-b 地ならし: 残る 3 導出を実挙動へ突き合わせ。`gazeTarget` の乖離 2 件と `answers` の取りこぼし 1 件（**通信断で果たせない約束の CTA**）を修正。`deriveAvatarEmotion` / `requiresExplicitConfirmationFor` は値が正しく、縛るテストのみ追加 | PR #489 |
| 64 | 2026-07-29 | #422 inc5-b 増分 1: 5 画面の主指示（`screen__title`）を契約経由へ配線。契約 `MessageKey` → i18n キーの対応が**テストの中にしか無かった**のを本番経路へ出した（`conversation-turn.ts`）。文言は不変 | PR #490 |
| 65 | 2026-07-29 | #422 inc5-b 増分 2: 単一 CTA 3 画面（確認 / 失敗・未応答 / 通話中）を `turnAnswersFor` 経由へ。**「通信断では代替導線を出さない」判断の二重実装を解消**（画面から `shouldOfferAlternativeContact` が消えた）。ラベル・testId は不変 | PR #492 |
| 66 | 2026-07-29 | #422 inc5-b 増分 3a: 用件カードを契約経由へ。**ラベルの二重管理**（契約の生日本語リテラル vs i18n 辞書。ja では一致していたが辞書だけ直すとズレる）を解消し、画面から `RECEPTION_PURPOSES` が消えた | PR #493 |
| 67 | 2026-07-29 | #422 inc5-b 増分 3b: 待機の 5 入口を契約へ統合。**QR 受付は状態機械を進めないので「回答」ではなく「引き渡し」として型で分けた**（嘘の intent で安全不変条件を無意味にしない）。用件の先取りは `presetPurpose`。`quick-actions.ts` から入口の定義が消え、逃げ道だけが残った | PR #494 |
| 68 | 2026-07-29 | #422 inc5-c の設計を固める。**AC 4 つのうち 1 つ（landscape 基準化）は #361 で既に充足**、VRM も表情は適用済みで残るのは `gazeTarget` だけと判明しスコープが絞れた | PR #495 |
| 69 | 2026-07-29 | #422 inc5-c 増分 1: ステッパー廃止 + 字幕へ位置づけを織り込み（3 状態 × 5 locale）。**VRT が退行を検出** — ステッパーは右上の常設ボタンと本文の緩衝帯も兼ねており、撤去で見出しが潜った。`.screen-anim > .screen__title` に余白を確保 | PR #496 |
| 70 | 2026-07-29 | #422 inc5-c 増分 2: 常設要素 7 件の領域帰属を登録簿化（案内 2 / ヘルプ 5）。`persistentRegionProps` が testId と領域を同時に供給し、描画側が手書きで迂回できない形にした。e2e で実 DOM と突き合わせ（登録簿だけあってズレていれば無意味なので消費者を置く）。見た目は不変 | PR #497 |
| 71 | 2026-07-29 | #422 inc5-c 増分 3: `gazeTarget` を VRM 頭部オフセットへ適用。**レイアウトで向く方向が変わる**（横向きは右レール、縦向きは真下）ので `gazeOffsetFor(target, layout)` が両方を取る。既存ポーズへ加算するので呼吸・頷きは失われない。**契約の消費者ゼロ導出が無くなった** | PR #498 |
| 72 | 2026-07-29 | #422 AC「VRT で主要状態を固定」のギャップを埋める: 結果系 4 状態（通話中・未応答・失敗・代替案内）を追加し 5 → 9 状態へ。**通話中はパネルごと mask して VRT を無意味にしかけた** — PII は本文の担当者名だけなので `.result-panel__message` へ絞った。**#422 の受入条件 7 件がすべて充足** | PR #499 |
| 73 | 2026-07-29 | #500: 常設要素の「いつ出すか」を `isPersistentVisible(key, state)` へ一本化。逃げ道・チャットは既存導出へ委譲し二重定義を作らない。**実際に移せた分岐は `CheckoutLink` の 1 箇所だけ**だったが、これまで構造に埋もれていた「言語切替・退館は待機のみ」が明示され、契約の主張を実 DOM と突き合わせる e2e が付いた | PR #502 |
| 75 | 2026-07-30 | #501: 管理画面が受付端末向けサイズ（`--font-body` 20px 等）を継承する #330 item4 の根治。**色ではなくサイズが問題**（色は意図的に共通で、分離すると二重管理になるだけ）。`:root` は受付端末向けに据え置き、`[data-area='admin'\|platform']` が下げる**方向が重要** — 逆にすると mobile の text autosizing で `rem` 基準（html の font-size）自体が動き kiosk の実寸が変わる（実測 16px→20px。VRT が 3 度検出） | PR #504 |
| 125 | 2026-08-07 | **#4 Inc D-1: 実 PSTN 発信の境界を作った（mock 先行）。** 着手時の AC マッピングで **`ConnectionProvider` が実 PSTN を実装できない**ことが判明 — `connect()` は 1 手の最終結果を**同期で返す**契約だが、実 PSTN の `POST /v1/calls` は call UUID を返すだけで応答・DTMF は後から webhook で届く。同じ契約に押し込むと `connect()` の中で数十秒待つことになり HTTP リクエスト内で完結しない（#632 で「取次が同期実行だった」として顕在化した問題の再演）。**ユーザー判断で契約を分離**し、`VoiceCallInitiator`（発信を開始するだけ・結果は返さない）を新設。mock 経路は `ConnectionProvider` のまま温存する（`orchestrator.ts` は同期前提なので実 PSTN を混ぜると壊れる）。相関の順序問題（相関キーは発信後にしか分からないのに answer webhook はそれを要求する）は「発信後に書いて answer 側で短時間リトライ」で行く方針を決定、実装は D-2。入れたもの: 発信リクエストの純関数化（**来訪者情報を引数に取れない**型・`answer_method`/`event_method` を POST 明示・E.164 検証・uuid 欠落を成功にしない）＋ 依存注入の Vonage adapter。🔴 **変異テストが自分のテストの弱さを捕まえた** — 「2xx 以外は失敗」テストの応答本文に uuid が無かったため、status チェックを外しても後段の uuid 欠落で落ちてしまい**「何かが throw する」ことしか固定できていなかった**。400 でも uuid を返す応答に変え、status 経路でしか落ちない形にして kill を確認。24 テスト・変異 8 件すべて kill。**本番の呼び出し元はまだゼロ**（D-2 で `executeRoutedCall` へ配線） | PR #639 |
| 126 | 2026-08-07 | **#4 Inc D-2a: webhook で取次が実際に進むよう配線した。** 着手時の AC マッピングで **キューの項目 8 の記述が不正確**と判明 — 「`/api/providers/**` が `authz-coverage.test.ts` の走査対象外」と あったが、同テストは `src/app/api/admin/` 配下の admin 専用で、providers は**意図的に未認証**（署名検証）なので authz 走査の対象にするのは筋が違う。真の穴は `webhook-routes.test.ts` の `const ROUTES = [...]` が**列挙型**で、新しい provider ルートを足すと黙って検査を逃れること（#628 と同じ型）。🔴 `/events` は保存済み状態を読まず毎回 `applyVoiceEvent('queued', …)` から畳み直し `void result` で捨てていた。`applyVoiceEvent` は terminal を short-circuit することで巻き戻しを防いでいるので、`'queued'` からの畳み直しはその保護を丸ごと消す — **担当者が DTMF 応答して `answered`（terminal）になった後 `completed` が届くと `no_answer` になり、応答済みなのに次の人へ発信する**。入れたもの: 純関数 `advanceFromWebhook`（保存状態から畳む・確定済みは無視・冪等キーに webhook の `jti`）＋ `StoredCallCorrelation.voiceState`（任意・後方互換）＋ `/events` の配線。**発信（dial）は行わない** — provider 選択＝実送信の停止境界（項目 2）。撃てない以上**位置を進めず**通話状態だけ記録し、保留を構造化ログで可観測にする（進めると「撃ったことになっている手が鳴っていない」不整合になる）。変異 5 件すべて kill。残: 項目 2（mock/vonage 分岐＝実送信）・6（`/dtmf` の PII 供給）・7（未認証 4 本のレート制限）・8（列挙→走査） | PR #643 |
| 127 | 2026-08-07 | **#4 Inc D-2b: 実送信の手前を固めた（項目 7・8）。** **項目 7 停止スイッチ**: `PROVIDER_WEBHOOKS_DISABLED` で provider webhook 4 本を全断できる。**403 ではなく 503 ＋ Retry-After** — Vonage は 4xx を恒久的失敗として再送を諦めるが、停止は一時的な運用操作なので復旧後にイベントを取り戻せる 5xx でなければならない。判定は署名検証より前。**env に置く理由**は、DynamoDB 由来にすると止めたい状況（データ層異常・高負荷）でこそ読めないから。**項目 7 レート制限**: `ledger` は 1 通話あたり無制限に伸び、相関ごと DynamoDB へ書かれるので**item 上限 400KB へ向かって育つ**。1 通話 100 イベントで打ち切り、超過分は**書き込まない**（書き込み自体が資源消費なので弾くなら書く前に弾く）。**項目 8**: `webhook-routes.test.ts` の `ROUTES` を列挙からディレクトリ走査へ。🔴 走査は**空でも it.each が静かに 0 回走って緑になる**ので、走査結果自体を固定するテストを置いた。**1 ルートだけ停止スイッチを外す変異で 2 件落ちる**ことを確認（列挙のままなら素通りしていた）。変異 6 件すべて kill。残: 項目 2（mock/vonage 分岐＝実送信）・6（`/dtmf` の PII 供給） | PR #644 |
| 128 | 2026-08-07 | **#4 Inc D-2 項目 2: 実 PSTN 発信を本番経路へ配線した（停止境界・ユーザー承認済み）。** `executeRoutedCall` が mock / 実発信を選ぶ。**2 つの経路は形が違う** — mock は 1 リクエストで取次を最後まで回して確定するが、実 PSTN は **1 手撃って `'calling'` を返し、結果は webhook で後から届く**（`runVoiceRoutedCall`）。`RoutedCallResult.status` から `'calling'` を除外していた型を外し、`outcome` は mock 経路のみの任意項目にした。**実発信は 5 条件がすべて揃ったときだけ**（有効ルート / webhook 基底 URL / テナントが vonage+enabled+secret / applicationId・fromNumber・privateKey / 1 手目の接続先が pstn かつ enabled）。1 つでも欠ければ mock へ倒れる。🔴 **失敗を例外にしない** — call route は `executeRoutedCall` の例外を捕まえて単発 mock へ fail-open するので、投げると**鳴っていないのに「繋がった」と来訪者へ表示しうる**。実発信経路の失敗は `failed` ＋ 固定コード（`dial_failed` 等。provider のエラー文言は 番号・URL が混ざるので載せない）で返す。相関を書けなかったときも `'calling'` にせず `failed` — 相関が無いと webhook が全部 403 になり **来訪者が無限に待つ**ので、有人支援へ倒す。🔴 **停止スイッチの穴を塞いだ** — `PROVIDER_WEBHOOKS_DISABLED` は webhook（発信後の進行）しか止めず、**新規発信は止まらない**。配線前は何も鳴らないので十分だったが、いまは違う。`VOICE_DIALING_DISABLED` を新設し、発信の入口 1 箇所（`resolveVoiceInitiator`）で**資格情報の解決より前**に倒す。あわせて **#645 を修正** — dial 分岐が `advance.next.position` を丸ごと捨てており `jti` 冪等の ledger まで捨てていた（同一 jti の再配信が `duplicate` にならない）。位置は据え置いたまま ledger だけ保存する。配線テストは**引数そのもの**を固定した（`webhookBaseUrl` を渡し忘れても全テストが緑のまま通り、症状は「実発信が永久に起きない」沈黙だけになる）。変異で 3 件 kill 確認。🔴 **配線して初めて見えた欠陥を 1 件自分で捕まえた** — `'calling'` はもともと **Vonage Video 専用の意味**（セッション確立済み・担当者の参加待ち）で、端末は `calling` を見るとビデオビューを開く。PSTN 経路にはセッションが無いので、**存在しないトークンを取りに行って失敗する**。媒体の判定を純関数 `shouldOpenVideoView` へ出した（空文字を「セッションあり」に化けさせない）。**残: 2 手目以降の発信は未配線（#646）／端末が PSTN の結果を確定できない（#647・Journey 仕様判断＝停止境界）**・項目 6（`/dtmf` の PII 供給）は停止境界のまま | PR #648 |
| 129 | 2026-08-08 | **#647: 実 PSTN 通話の結果を端末が確定できるようにした。** 実発信 (#4 Inc D-2 項目 2) の受付は `'calling'` で止まり、webhook は相関を進めるが**受付状態を動かす者が居なかった**＝来訪者が呼び出し中画面で待ち続ける。**ユーザー判断で 4 点を確定**（issue #647 のコメントが正本）: 方式は `/status` ポーリング（push/SSE は Lambda で長時間接続が未検証・費用リスク）／**タイムアウトの権威はサーバ**／**未着の確定は読み時の遅延評価**（EventBridge sweeper は**継続的 AWS 費用**になるので採らない。実績は月 $0.0005 なのでコスト構造を変えない）／1 本の PR。🔴 **着手時の調査で自分の前提が 1 つ誤りと判明** — 「UI とサーバでタイムアウトが二重」と書いていたが、`KioskFlow` は**サーバが返した timeout の表示を #323 で遅らせているだけ**で権威はサーバ側にあった。端末が発明するタイムアウトは `KioskCallView` の 30 秒だけで、これは**ビデオ媒体**＝ PSTN は通らない。よって「権威をサーバへ寄せる」ために外す配線は無く、サーバが結果を**産む**ようにするだけでよかった。入れたもの: 純関数 `resolveCallResolution`（通話状態→結果の写像 ＋ 呼出予算超過の遅延タイムアウト。**通話状態が先・予算は後** — 逆にすると応答済みなのに時間切れで代替導線を出す）／相関の `dialExpiresAt`（任意・互換）／受付の `providerCallId`（任意・互換。相関は provider 通話 ID をキーに保存されるので受付側が鍵を持たないと引けない）／`markCallFailed`／`/status` の遅延確定（**認可の後**に行う＝越境要求で他人の通話を進めない。**例外を投げない**＝相関が読めなくても状態取得を巻き添えにしない）／純関数 `decidePollAction`（**サーバの結果を経過時間で上書きしない**・上限到達は「判定できなかった」の表明で未応答とは別物として `contact_failed` へ）／端末のポーリング effect。体験モデル（`docs/experience/README.md`）との対応も確認 — 未応答/話中/辞退→`person_unavailable`、発信失敗→`contact_failed`。変異 5 件すべて kill。**残: #646（2 手目以降の発信）**。🔴 **調査中に既存欠陥を 1 件発見 → #649**: #99 の担当者応答ポーリングが **`calling` 中に 1 度も走っていない**（`sessionId` を立てるのは `CALL_CONNECTED`/`TIMEOUT`/`FAILED` の 3 つだけで `CONFIRM → calling` では立たず、`useStaffResponse` の第 1 引数が `null` になる）。`handleStaffResponseFallback` の calling 分岐も到達不能。🔴 **自分の実装の実バグも 1 件**: ポーリングの `fetch` に `cache: 'no-store'` が無く、同一 URL の GET なのでブラウザ HTTP キャッシュに当たると状態が変わっても古い応答を読み続ける（テスト環境にキャッシュが無いので**ゲートも全テストも緑のまま通る**）。あわせて新規 advisory **GHSA-2v37-7h3g-55p8 (nanoid, high)** が `main` でもゲートを塞いでいたため lockfile の patch 更新 6 件で解消（`package.json` 無変更） | PR #650 |
| 130 | 2026-08-08 | **#649: 呼び出し中に担当者応答が画面へ出るようにした。** #99 の `useStaffResponse` は「呼び出し中・応答後にポーリングする」意図だったが、受付 ID を立てるのが `CALL_CONNECTED`/`CALL_TIMEOUT`/`CALL_FAILED` の 3 つだけで `CONFIRM → calling` では立たないため、**`calling` の間は 1 度も走っていなかった**（第 1 引数が null）。実際に走り始めるのは `connected` になった後＝すでに応答が確定した後だけ。表示側（`StaffResponseBanner` を calling で描画する配線・testid）は最初から在り、**壊れていたのは受付 ID の供給だけ**だった。issue の選択肢 1（ID を先に立てる）を採用し、**状態を動かさない** action `SESSION_CREATED` を追加（遷移表を引く**前**に処理するので `domain/reception/state.ts` は不変・`ReceptionEvent` を増やしていない）。`calling` 以外で届いた ID は無視する（キャンセル後に届いた作成応答で立て直さない＝「不正遷移は現状維持」と同じ考え方）。🔴 **自分の変更が作りかけた regression を 1 件、実装中に自分で捕まえた** — ID を先に立てた結果、`/call` が例外で落ちたときの `CALL_FAILED`（ID を持たない）が `sessionId: action.sessionId` で既存 ID を undefined に上書きし、終端画面からの `/fallback`・`/feedback` の宛先が消える形になっていた。「action が ID を持たない」と「受付が存在しない」は**別物**（[[lesson-empty-vs-missing-fallback]] と同型）。検証: e2e 2 件を**実装前に本番ビルドで red 実測**（バナーが calling 中に一度も出ない）→ 実装 → 再ビルドで 23 passed。guard は**変異させて kill を確認**。`--full` は 13 ステップ全 PASS・SKIP ゼロ（infra `138 passed (138)` ＝ #642 の偽 green 形ではない）。🔴 **セルフレビューで範囲外の既存欠陥を 1 件発見 → #652**: `pstnCallId` を null に戻すのが calling の effect 先頭だけなので、**`calling` を抜けても #647 の結果ポーリングが最大 5 分止まらない**（逃げ道バーの「最初に戻る」= RESET・CANCEL で **#649 以前から到達可能**）。状態機械が不正遷移として無視するので**画面は壊れずテストもゲートも緑のまま通る**種類。あわせて `/status` を 2 経路（`useStaffResponse` 3s ＋ #647 3s）で叩く形の 1 本化も #652 に含めた。本番稼働直後の #647 の結果確定ロジックを同じ増分で触らない判断 | PR #651 |
| 131 | 2026-08-08 | **#656: 記録の穴（AC3）と、PR にならなかった push を検出。** `stale` は**直近 1 件の経過日数しか見ない**ので、週次の途中で 1 回分が main に載らなくても次の回が載った時点で永久に見えなくなる（2026-08-03 がこの形）。隣接する `full` 記録の間隔で `record_gap` を検出し、解決手段は「抜けた回の行を追記する」（並びは日時で決まるので後から挿せる＝永久に消えない指摘にしない）。あわせて**リモートに在るのに PR が 1 つも無いブランチ**を `orphan_branch` で検出。**squash マージなので ancestry では判定できず**、材料は「そのブランチ名を head に持つ PR が在るか」だけ | PR #660 / #661 |
| 132 | 2026-08-08 | **#578 増分 1 の残り: 実効画角を観測可能にした。** 版（`data-vrm-version`）とモーション（`data-motion-state`）は観測できるのに**カメラだけが出ておらず**、実機で「顔が切れる/真っ黒」を見ても帰属先を絞れなかった。`resolveCameraFraming` は頭の高さを**黙って既定へ倒し、黙って妥当域へ寄せる**ので、その事実を `headHeightSource`（measured/fallback/clamped）として返し `data-camera-framing` に載せる。**値は丸めて出す** — `ResizeObserver` は 1px 未満でも発火し、生の浮動小数だと属性が毎フレーム変わって増分 3 で踏んだ発散の入口になる。**AC マッピングで増分 2・3 が既に main に在ると判明**（stale 6 回目） | PR #662 |
| 133 | 2026-08-08 | **#656: 既定ブランチ名を gh に頼らず解決（2 度目の当て推量・仮説は外れた）。** `git symbolic-ref --short refs/remotes/origin/HEAD` へ移したが、**クラウドの clone には remote 追跡 HEAD が無く**失敗。gh fallback も従来どおり落ち、`branch_check_unverified` は消えなかった。routine が緑に見せず事実を持ち帰ったのは設計どおり | PR #663 |
| 134 | 2026-08-08 | **#656: リモートの ref を `ls-remote --symref` 1 回から取る（3 度目の当て推量）。** `symbolic-ref` が効かなかったので、**リモートに HEAD を尋ねる** `ls-remote --symref` へ。リポジトリ外から明示 URL で叩いて ref が返ることを実測してから採用した（前回欠けていた検証）。既定ブランチとブランチ一覧が 1 回で揃い往復も減る。**この経路自体はクラウドで成功したが、失敗が `gh pr list` へ移っただけだった** | PR #664 |
| 135 | 2026-08-08 | 🔴 **#656: 外部コマンド失敗の理由（stderr）を診断に載せた。この日いちばん効いた増分。** `execFileSync` の例外は `message` が `Command failed: <cmd>` までで、**理由は `stderr`**。拾っていなかったため、クラウドで検査が到達しない原因を**一度も見ないまま 3 周**（wave 132〜134）当て推量を重ねた。1 行載せた途端、原因（GraphQL 403）も対処法（REST を使え）もエラー本文が教えてくれた。**あわせて URL 埋め込みの資格情報を伏字化** — クラウドの remote は `https://x-access-token:<token>@…` の形で、git の stderr はその URL を echo し、この説明文は PR 本文へ運ばれる | PR #665 |
| 136 | 2026-08-08 | **#612: origin-verify の秘密漏洩テストの隙間を埋めた。** 🔴 **当初「テストが 1 本も無い」と判断しかけたが誤り** — `rg` を `secret` で絞ったが実際のテスト名は「シークレット」で、既存 2 本を見落としていた（変異を当てたら既存テストが落ちて発覚）。本物の隙間は 3 つ: (a) **`disabled` 経路** — `logOriginVerifyTransition` が `secret` を実際に受け取って読むのはこの分岐だけなのに未被覆、(b) `console.log`/`info`/`debug`（既存 spy は error/warn だけ）、(c) **`missing-secret` の 503 経路** — 未解決でも env には未置換の `{{resolve:secretsmanager:<名前>:...}}` が入っており**保管場所の名前**を含む。実装は元から正しく、3 つの漏らし方を埋め込んで対応テストが死ぬことを確認した | PR #666 |
| 137 | 2026-08-08 | **#656: orphan 検査を REST 経路にし、PR 作成前の窓を殺さない。** `gh pr list` は GraphQL を叩き、クラウドのサンドボックスがそれを絞っているため 403（PR #665 の stderr で判明）。`gh api repos/<owner>/<repo>/pulls?state=all&head=<owner>:<branch>` へ移し、owner/repo は remote URL からローカルに取る（**読めない形は推測で組み立てない** — 誤った owner/repo だと 404 が「PR が無い」と誤読される）。あわせて**猶予 24 時間**を入れ、push 済み・PR 作成前を error にしないようにした。**日時が分からなければ指摘する側に倒す**（ローカルに無いオブジェクト＝一度も fetch していないブランチ＝ #656 が起きた形）。REST が実際に PR #428 を見つけること、かつそのブランチの先端が猶予外であることを実測して「除外理由が猶予ではなく PR」だと確認 | 本書 |
| 124 | 2026-08-07 | **#630: middleware の 403/503 による全断をアラームに載せた。** middleware の応答は **Lambda としては成功した呼び出し**なので `Errors`/`Throttles`/`Duration` のどれにも出ず、origin-verify の fail-closed 全断が**誰にも通知されなかった**。🔴 **着手時の調査で issue の前提が2 つ崩れた**: (a) `missing-secret` は **503＝5xx** なので CloudFront `5xxErrorRate` アラーム(#303)に**既に部分的に乗っていた**（「一切引っかからない」は半分だけ正しい）、(b) issue の第 1 案「4xx アラームを足す」は`CloudFrontMonitoringStack` の**明示的な設計判断に反する**（ボットのパス探索で恒常的に発生し、「直叩き」と「配備破損」を分離できない）。よって 4xx 率ではなく**アプリの拒否ログをメトリクス化**し、`missing-secret`（1 件で即・配備側の自損）と `mismatch`（10 件×3 期間・単発は正常動作）を**別メトリクスに分けた**。🔴 **この機能の急所はアラームではなく文言のドリフト** — ログを書き換えるとフィルタが黙って外れる。`ORIGIN_VERIFY_LOG_MARKERS` を `origin-verify.ts` に置き **アプリと CDK が同じ定数を使う**形にし、両側から変異させて kill を確認した（当初は CDK だけが定数を使い proxy.ts は直書きのままで、「共有している」というコメントが**嘘だった**のを自分で見つけて直した）。**デプロイはしていない** — アラーム 2 本の課金は `OpenReception-WebMonitoring-<env>` の適用時に発生する | PR #636 |
| 123 | 2026-08-06 | **#634: audit ステップが `infra/` を監査していなかったのを塞ぎ、依存を更新した。** #633 のマージ後、`git push` が返した Dependabot「6 high」とゲートの `PASS audit` が食い違っていたことから調査。**どちらも正しく、見ている manifest が違った** — `audit:deps` は root の `npm audit` だけで、**`infra/` は 1 度も監査されていなかった**（#628 と同じ構造の穴で、対象がテストか監査かの違いしかない）。6 件はすべて `aws-cdk-lib` の推移依存（`ajv → fast-uri` / `brace-expansion`）。🔴 **`overrides` と `npm audit fix` は原理的に効かない** — `table`/`minimatch` が `aws-cdk-lib` の **`bundleDependencies`** で tarball 内に同梱されているため。実際 `npm audit fix` は「fix available」と言いながら lockfile を 1 バイトも変えなかった（＝**効いていないのに効いたように見える**）。唯一の手段である `aws-cdk-lib` 2.260.0 → 2.263.0 で **6 → 1** へ。残る 1 件は上流の再バンドル待ちなので、**advisory 単位・理由付き・期限付きの allowlist**（`audit-allowlist.json`）で受容する（`--audit-level` で緩めると severity 全体が盲点になる。期限切れは自動でFAIL へ戻り、上流が直せば unused として警告される）。CDK 更新の安全性は**実測**: dev WebStack の合成テンプレートが更新前後で **42,809 バイト完全一致**、infra 133 テスト green。新規 10 テスト、変異 5 件すべて kill、失敗経路 3 通り（未登録・期限切れ・未使用）も実際に走らせて exit 1 を確認 | PR #635 |
| 122 | 2026-08-06 | **#628: `infra/test/**` がゲートで 1 度も実行されていなかったのを配線した。** root の `npm test` は root vitest の include しか走らせず、CDK テンプレートのアサーション 9 ファイルが**誰にも見られていなかった**（`tsc --noEmit` は型しか見ない）。着手時の AC マッピングで **AC3（`describe` 直下の `new WebStack`）は #627 で既に充足**と判明し、実装対象は 2 つに絞れた。🔴 **実測して初めて分かった重要な事実**: 当時の main で `npm --prefix infra test` を回すと **17 failed**。`.open-next` の状態は「有る/無い」の 2 値ではなく **absent / stale / fresh の 3 値**で、#632 のマージで `src` の mtime が進んだ結果 stale になり凍結ガードが発火していた。つまり **AC2 を「無言スキップ」だけの問題として実装すると外す**。判定を `infra/lib/build-artifacts.ts` へ一本化し（synth ガードとテストが同じ関数を使う。二重実装は #557 で食い違った実績がある）、stale は**赤ではなく理由付き SKIP**へ（`src` を触れば毎回 stale になるので、赤にすると常時赤＝赤を無視する習慣がつく。#424 増分 3 と同じ理屈）。ゲートは `--pr` 以上で `infra (cdk vitest)` を独立ステップとして持ち、fresh でなければ `SKIP  infra WebStack synth  (理由)` を summary へ出す（`--strict` で FAIL）。**「黙って 0 件にしない」の実体は「独立ステップが summary に自分の行を持つこと」**。あわせて `QUALITY_GATE_DRY_RUN=1` を足し、tier → ステップの解決を**実際にスクリプトを起動して**固定するテストを置いた（字面の grep はリファクタで簡単に嘘になる）。新規 17 テスト、変異 8 件すべて kill | PR #633 |
| 121 | 2026-08-06 | **#4 MVP1（担当者への外線取次 Voice/PSTN）の中核を mock 先行で実装（PR #632）。** 着手前の調査で 2 つの誤解を潰した: (a) 既存 `VonageCallAdapter` は **Vonage Video API**（遠隔顔合わせ）で #4 の Voice/PSTN とは**別製品・別トラック**、(b) 取次が**同期実行**（`connect()` がその場で最終結果を返す mock 前提）で実 PSTN では成立しない → **ユーザー判断で「取次状態を永続化して再開可能に」を採用**し `domain/routing/resumable.ts` を新設。逆に当初「足りない」と挙げた冪等台帳（`ledger.ts`）と営業時間外ゲート（`call-guard.ts` #367）は**実装済み**だった（確認せず書いた。訂正）。設計の軸は「**署名済み本文だけを権威にする**」（URL クエリは POST では `payload_hash` の対象外で付け替えられる）。🔴 **レビュー 5 本が実バグ 3 件を発見**: DTMF の段を区別できず**第 2 段の「1」で来訪者情報を無限に読み上げ、2/3/4 は無音で切断**（→ `/choice` へ分離）／`eventUrl` が `request.url` 由来で Lambda では CloudFront を迂回 → origin-verify で 403（→ base-url の解決順へ）／**「診断はサーバログで」と一様 403 の対価に書きながらログ 0 行**（→ `logOnly` で構造化ログへ）。🔴 **変異 12 件が生き残り**、うち `/dtmf` のテストが未定義入力のみで**定義済みだが accept でない 2/3/4 が 1 件も無かった**（＝第三者が 3 を押すと来訪者情報が流れる、#4 の最重要要件そのもの）。総括は「**形（arity・本文・status）を固定するテストが意味（値・経路・ヘッダ・時間）を固定していない**」で、私が誇っていた arity テストも 3 通りで回避可能と実証された → 許可リストへ。**この PR は本番では機能しない**（相関を書く本番コードが無く 4 ルートとも 100% 403。Inc D 待ち）ことを PR 本文と docs に明記 | PR #632 |
| 120 | 2026-08-06 | **#612 増分 1 の設計をレビュー結果で作り直した。** 6 本の独立レビューのうち 2 本が独立に同じ CRITICAL に到達し、片方は**実際に OpenNext バンドルを走らせて再現**した: middleware は OpenNext の routing 層から `instrumentation.register()` より **先** に呼ばれるので、ARN を渡す runtime 解決では**コールドスタート初回が 403**。しかも middleware が拒否応答を返すと Next サーバへ到達せず `register()` が永久に走らないため、**そのインスタンスは寿命まで全拒否**（回復経路は matcher 除外の favicon が偶然同じインスタンスに当たったときだけ）。加えて一過性の SM エラー 1 回で `prepare()` の rejected promise が固定され、再試行もプロセス終了もしない。→ **ユーザー判断で「env に CFN 動的参照」へ変更**。CFN テンプレートの平文は消え、値はプロセス開始時から env に在るので 403 が起きない。代償は Lambda 環境変数に解決済みの値が残ること（#612 の目標の半分に縮小、docs に明記）。他に直したもの: `JSON.parse` の cause が**シークレット先頭 10 文字**を CloudWatch へ出す（実測）／検証の ON/OFF を `ORIGIN_VERIFY_REQUIRED` 一本に（secret が env に在るだけで有効化されると、docs 推奨の同居 + context 忘れで全 403）／`=== 'prod'` を `!== 'dev'` へ（**staging が素通り**）／空文字・非文字列 context を synth で拒否／`missing-secret` は 503 + プロセス 1 回ログ（直叩きの 403 と区別できないと障害切り分けが不能）／引数検証を成果物チェックより前に移動（ガードのテストが `.open-next` 無しで走る）。🔴 **自分が書いたテスト 2 件が無効だった**: 漏洩テストは cause チェーンを見ておらず素通り、ドリフト検査は `not.toContain('..._ARN')` と書いたが実コードはテンプレートリテラルで**ARN 版が残ったまま緑**。どちらも変異させて発覚。ドリフト検査は `src/` 側へ移して**実際にゲートで走る**ようにし、両側を突き合わせる形にした。切り出し: #629 来訪者向けフォールバック / #630 403・503 がアラームに出ない / #631 image Lambda が無検証で公開 | PR #627 |
| 119 | 2026-08-05 | 🔴 **この wave の設計（ARN + instrumentation の runtime 解決）は第 120 wave で撤回した。** 以下は経緯として残す。 **#612 増分 1: origin-verify シークレットを prod で Secrets Manager から供給する。** 生値は CFN テンプレートと Lambda 環境変数の**両方に平文で載る**ので 2 経路とも塞いだ: CloudFront の origin custom header は **CFN 動的参照**（AWS ドキュメントで「全リソースプロパティで使える」ことを確認済み。テンプレートに平文が残らない）、Lambda へは ARN だけ渡し `src/instrumentation.ts` が起動時に解決（#194 の経路を一般化）。🔴 **調査中に本命の欠陥が出た** — `proxy.ts` は「`ORIGIN_VERIFY_SECRET` 未設定なら検証しない」という後方互換の分岐を持っており、これは **Secrets Manager の解決に失敗したときにも成立する**。つまり runtime 取得へ移した瞬間、取得失敗が **CloudFront 迂回の全ルート素通り**に化ける。非機密フラグ `ORIGIN_VERIFY_REQUIRED` を配備側が立て、「未設定」と「解決失敗」を区別して **fail-closed** にした（instrumentation 側もキー欠落で起動を止める）。prod で生値を渡すと `cdk synth` が止まる。**発見: `infra/test/**` はゲートの unit ステップ（root vitest の include 外）で 1 度も走っていない**。今回は `.open-next` をビルドして手で実行し、生値方式の既存 suite が prod 前提だったことと、新規 3 アサーションが実際に効くことを変異で確認した | 本書 |
| 118 | 2026-08-01 | **#557 の修正が実際の環境で空振りしていたのを直す（レビュー 2 本目の指摘）。** `git fetch origin main` は **PR ブランチだけを `--single-branch` で clone した環境（＝クラウドの実際の形）では refspec に main が無く `refs/remotes/origin/main` を作らない**。実測で確認: 旧形式は空振りしたうえ `--deepen` に落ちて無駄に全履歴を取得、新形式（`+refs/heads/main:refs/remotes/origin/main`）は解決できて **shallow のまま**。🔴 **前回の検証はフル shallow clone で行っており、想定したシナリオを検証して実際に起きるシナリオを検証していなかった**。あわせて (a) 起点を実行内で 1 度だけ確定し `GATE_BASE_SHA` で全消費者へ配る（共有実装にしただけでは「たまたま同時刻に同じ」という時間依存が残り #557 の構図は閉じない）、(b) `change-scope.ts` の 3 つ目の写しを解消 — **唯一ステップを省略できる消費者**なので起点がずれると docs 判定で build/e2e/sast/lighthouse が飛ぶ最も危険な位置だった、(c) **起点不明時に「停止境界に触れていません」と断定しない**（測れていないのに認証境界・PII・本番デプロイの検出器が安全宣言をしていた。過小報告は過大報告より危険）、(d) 資格情報待ち・低速接続でハングしない指定（kill switch より前を通るため） | PR #570 |
| 117 | 2026-08-01 | **レビュー P2 群: 取得できない状態からの復帰と断定。** (a) **拠点 0 件で永久 loading**（第 111〜114 wave で入れた回帰）— `resolveSiteScopeState` は 0 件で `ready:false` を返すので、素朴に扱うと**拠点をまだ登録していないテナント**という正常な運用状態が終わらないスピナーに化ける。理由の種別に `no-site` を足した。(b) **JSON パース失敗で永久 loading**（締切で塞いだ穴の別入口。認証切れの HTML が 200 で返る構成で実際に起こる）。(c) 「拠点を確認できないため変更できません」と表示しながら保存ボタンが有効だった。**拠点一覧は書き込み先そのものを決める読みなので、確認できないなら書かせない** — #552 の「読みの失敗で書きを殺すな」の例外にあたるので理由を明記した。(d) 3 画面に自画面用の再試行が無く、ブラウザリロードしか復帰手段が無かった（`SiteScopeSelect` の再試行は**拠点一覧**の失敗にしか出ない）。(e) 集計は「取得できませんでした」なのに件数だけ「0 件中 0 件」と出ていた。**構造テストを 3 件追加**し、共有の門を使う画面が `canRefresh` と失敗理由を消費していることを機械で強制（今回まさに 4 画面中 3 画面が捨てていた） | PR #569 |
| 116 | 2026-08-01 | **🔴 レビュー P1: 門を「入口」にしか置いていなかった。** 第 110〜114 wave では「ハンドラとボタンが同じ 1 つの値を見る」に注意を集中していたが、それは**押した瞬間しか守らない**。保存が飛行中に拠点を切り替えると、遅れて届いた A の応答が B の画面へ載り、`<data>ScopeKey` は B のままなので保存ボタンが再び有効になる → **A の内容が B として保存される**。サイネージは受付端末の待機画面なので**来訪者に他拠点の案内が出る**。担当者応答では無効化したはずの応答が有効に戻る。**読み（`load`）には最初から書いていた `isCurrentScope` を、書きに写していなかった** — 引き継ぎメモに自分で書いた「対策を写す範囲が思っているより広い」型の再演。修正は応答適用側の門 ＋ **変更飛行中は拠点セレクタ自体を無効化**（入口を閉じる。片方だけでは裏返しが残る）。あわせて予約の QR に発行スコープを持たせ（1 回しか出ないので誤配布すると来訪者が受付を完遂できない）、拠点切替でフォーム（来訪者 PII）を破棄し、`showQr` の門の写し漏れを直し、**既存欠陥だった `OperatingHoursManager` にも横展開**した | PR #568 |
| 115 | 2026-08-01 | **#557: 浅い clone で変更量チェックだけ古い base を使う問題を修正（クローズ）。** 根因は**時刻のずれ** — ゲートの 1 番目（変更量）と末尾（停止境界）は同じ `origin/main` を起点に測るのに、浅い clone では `origin/main` がステールで `--unshallow` は secrets ステップまで走らない。よって**同一実行の中で 47 ファイル / 2365 行 と 7 件が併記**された。`quality-gate.sh` の**測る前に**起点を確定させる（fetch は浅いときだけ。ローカル実行にネットワーク往復を足さない。共通祖先へ届かなければ deepen し、駄目なら明示して続行＝オフラインで落とさない）。**より本質的なのは重複の解消** — `change-budget.ts` と `change-risk.ts` が**同じ問いに 2 つの実装**を持っていたことが食い違いを見えにくくしていたので `src/domain/governance/git-base.ts` へ共有化した。抽出中に潜在バグも 1 件見つけて修正: 旧実装は ref が**在る**かだけを見て**共通祖先へ到達できる**かを見ておらず、浅い clone ではこの 2 つが食い違う（諦めずに次候補へ進む形にした。ここで諦めると今度は**過小**に報告する）。**検証は仮定せず再現させた**: 浅い clone を作り `origin/main` を 4 コミット巻き戻すと、真の差分 0 に対し修正前 9 ファイル → 修正後 0。クラウド以外でこのバグを観測できたのは初めて | PR #566 |
| 114 | 2026-08-01 | **#554 の 5 画面目: 担当者応答アクションを拠点スコープへ。あわせて `/admin/demo` を調査。** staff-response は既定値 `'default-site'` 自体は正しかったが**固定で切り替え手段が無く**、複数拠点テナントでは 2 つ目以降の拠点の応答設定に到達できなかった（#421 が営業時間・取次ルートで直したのと同じ形）。ついでに **`load` が `if (res.ok)` だけで失敗を握り潰していた**のを直した — 応答種別は未設定でも既定にフォールバックして並ぶ画面なので、**空表示が「設定が無い」と読め、取得失敗に気づけない**。**`/admin/demo` の調査結果: 移行対象ではない。** `siteId={String(tenantId)}` は**意図的な単一テナント MVP**（ページの doc コメントが #363 Inc3 として明記）で、デモ API は全て `defaultAdminTenantId()` で認可し、`selectableTargets` は**端末の実拠点を無視して**渡された siteId で publish target を組む。内部的には整合しているので今は壊れない。拠点スコープへ移すには「**拠点にスコープされたデモ公開とは何か**」を決める必要があり（#419 / #420 と絡む）、機械的な移行ではなく**仕様判断＝要ユーザー確認**。#554 の残りはこれのみ | PR #564 |
| 113 | 2026-08-01 | **#554 の 4 画面目: 来訪予約を拠点スコープへ。** 同じく既定が `'default'` で実在しない拠点の予約を読み書きしていた。**作成と既存行操作の両方を持つ最初の移行対象**だったので、`resolveScopeGate` に **`canCreate` を追加して `canMutate` と分離**した: 作成は「どの拠点に作るか」さえ決まっていれば実行でき、**一覧の取得状態を混ぜてはいけない**（混ぜると GET 1 回の失敗で登録が永久に無効化される＝ #552 の P1 そのもの）。既存行への取消・失効・再発行は `dataLoaded` を要求する。**`reissue` は `act` を通らない独自 fetch だったので、そこにも同じ門を写した** — 呼び出し元を数えて見つけた（写し忘れれば再発行だけが拠点切替中に通る）。拠点切替時は行だけでなく**発行済み QR も捨てる**（別拠点の招待を提示しない） | PR #562 |
| 112 | 2026-08-01 | **#554 の 3 画面目: 待機中サイネージを拠点スコープへ。あわせて判定を共有部品化。** ここが**最も実害が大きかった** — 管理画面はローカル定数の `'default'` に保存し、受付端末の `SignageDisplay` は共有の `DEFAULT_SITE_ID`（`'default-site'`）を読む。つまり**運用者が設定した待機画面は端末に一切反映されない**。両側とも単体では「動いて」いるので気づけない形だった。3 画面目で同じ判定を書こうとしたので `resolveScopeGate` へ集約（`docs/loop-queue.md` が記録してきた「共有フックへ寄せた分は横展開できたが、**どのスコープのデータが載っているかを各画面の state で持っていた部分**が毎回穴になった」への直接の対処）。潰しているのは実際に P1 になった 3 形: ハンドラを止めてボタンに写さない／読みの失敗で書きを殺す／取得できていないのに 0 件と断定する。**在館状況も同じ部品へ載せ替え、stay 側のテストが意図を変えずに通ることを抽出の検証にした**。また**拠点が変わったらフォームの内容ごと捨てる** — 残すと「B を選んでいるのに A の内容を編集している」状態になり保存で越境する（#541 と同型） | PR #561 |
| 111 | 2026-08-01 | **#554 の 2 画面目: 在館状況を拠点スコープへ。ヘッダが黙る話ではなく実バグだった。** 3 画面（stay/signage/reservations）が**それぞれ自前のローカル定数**で `DEFAULT_SITE_ID = 'default'` を持っていたが、**実在する既定拠点は `'default-site'`**。共有の `default-scope` から分岐した影の定数が原因で、**画面を開いただけで実在しない拠点を読んでいた**。在館者は端末の実拠点で記録されるので一覧は空になり、**在館状況の空表示は「誰も建物に居ない」と読める**（避難確認のような場面で嘘をつく）。よって「まだ分かっていない」と「0 人だと分かっている」を必ず区別し、拠点切替中・取得失敗中は集計を出さず理由を述べる形にした。**失敗の理由は拠点一覧の失敗を優先**して伝える（拠点が確認できないのに「滞在を取得できませんでした」と出すと原因を取り違える）。実装中に自分で 2 件見つけて直した: 取得失敗時に**永久に「読み込み中…」**を出す（失敗系に食い違いが残る形）／`error` が取得失敗と操作失敗を兼ねていて理由がすり替わる | PR #560 |
| 110 | 2026-08-01 | **#554 の共有基盤（M3/N8）: 拠点一覧の取得失敗・無応答から復帰できるようにする。** AC マッピングで issue の記述が**一部 stale** と判明（`useSiteScope` の `listStatus` は既に main に在った）ので、欠けていた復帰経路だけを増分にした。**最も重いのは締切が無いこと** — 応答が返らないと `error` にすら遷移せず `status` は `loading` のまま固着し、`scopeReady` が立たないのでその画面は**取得も保存もできず、画面リロード以外に脱出手段が無い**。10s の `AbortController` を **body を読み切るまで**効かせる（ヘッダ到着で解除すると `await res.json()` で同じ固着に戻る）。**ヘッダのチップと本文は別インスタンス**なので、本文で再試行が成功してもヘッダは「確認できません」のまま残った → `subscribeSiteList` / `invalidateSiteList` で取り直しを全インスタンスへ配る（「兄弟へ写していない」型を購読で構造的に潰す）。`SitesManager` が `status` を捨てており 401/403/5xx が「拠点が 1 つも無い」と同じ見た目 ＝ **#536 で `SiteDetail` に対して直した問題が別画面に生き残っていた**。`SiteScopeSelect` の `onRetry` を**必須 prop** にして 6 マネージャ全部を型で強制した（省略可能にすると新しい拠点別画面で渡し忘れ、その画面だけ復帰不能のまま通る）。自己レビューで**古い応答が新しい一覧を上書きする窓**を見つけ取得の世代番号で封じた（#535 / #541 と同型）。**意図的にやらなかったこと: 拠点の「追加」を一覧の取得状態に依存させない**（読みの失敗で書きを殺す＝#552 の P1）。なお 6 マネージャの書き込みが一覧失敗時に止まるのは**正しい**（拠点が不明なら安全な書き込み先が無い。#552 の罠は**無関係な**読みを書きのゲートに混ぜたこと）。構造テストは**検出器自身が常に緑にならないこと**も固定した（#552 レビュー P2 で同じ失敗をしたため）。**残: 5 画面（signage / stay / reservations / staff-response / demo）の `useSiteScope` 移行** | PR #558 |
| 109 | 2026-08-01 | **#554 の 1 画面目: `/admin/experience-versions` を拠点スコープへ。** テナントも既定固定だったので、テナントを切り替えた developer が**別テナントの版を公開・巻き戻せる**状態だった。レビュー P1: 拠点切替直後、版一覧が届くまで前拠点の版が残る窓で、**`revision` は experience ごとの連番なので拠点間で衝突**し、B の同番の版を公開/巻き戻せる（監査ログには正規の操作として残るので事後に判別できない）。可否判定を純関数 `resolveVersionActions` へ集約し、**ハンドラとボタンが同じ 1 つの値を見る**形にした（分岐しようがなくする）。**`save-draft` だけ版の取得状態に依存させない**（一覧 GET 1 回の失敗で復旧経路が永久停止する罠）。**クラウド併用の型を確立**: ローカル `--pr` / 独立レビュー / クラウド Routine `--full --strict` の 3 系統並行。**成果物を必ず repo 側に残させること**（`gh pr comment` を成果物に指定する。1 回目は指定し忘れて結果を読めないジョブを 1 本無駄にした）。**クラウドだけが #557 を発見**（浅い clone でゲートの base 誤解決）| PR #556 |
| 108 | 2026-08-01 | **VRT の hover 焼き付きを根治し、admin desktop の VRT を新設**（#553 / #423 AC5）。`kiosk-landscape-purpose` の flaky は**ベースライン画像に `:hover` が焼き付いていた**のが正体 — クリック後もカーソルが座標に残り、次画面のカードが同じ位置に来るため `:hover`（`.card:hover` = 枠 + `translateY(-3px)` + グロー）の再評価タイミングが非決定的だった。`stabilize()` に `page.mouse.move(0, 0)` を足して**撮る前に状態を 1 つに決める次元をもう 1 つ塞ぎ**、焼き付いていた 2 枚（purpose / qr-intro）を取り直した。あわせて **admin の VRT ベースラインが 1 枚も無い**（#423 AC5 未充足）を解消し、拠点別 2 画面 + 非拠点 1 画面の desktop VRT を新設（ヘッダの対象テナント/対象拠点が写る）。**時間で動く画面（稼働状況・利用量）は入れない**（サイネージを VRT 対象外にしたのと同じ判断）。**darwin と linux の分担**: baseline 名は `{platform}` を含むので片方だけ更新すると他方の環境で決定的に落ちる（週次 Routine は linux）。darwin をローカルで、**linux を claude.ai の Routine（Linux コンテナ）で生成**して同一ブランチへ集約した。**`Agent` の `isolation: "remote"` はローカル worktree に落ちるので linux 作業には使えない** — クラウドは Routine 経由が正 | PR #555 |
| 107 | 2026-08-01 | #423「共通コンテキストバー」の **Site 次元**。対象テナントはヘッダに常設なのに、**対象拠点は各画面の本文にしか無く**、拠点詳細 `/admin/sites/[siteId]` に至っては本文にも表示が無い（URL を読むしか判別手段が無かった）。**ヘッダが本文と別の拠点を指す事故を構造で防ぐ** — 既定拠点への倒し方を独自に書かず、本文が使う `resolveSiteScopeState` へ**委譲**し、両者の一致をテストで固定した（第 84 wave に platform で実在した「ヘッダは Cookie・本文は URL」と同型を作らない）。**route（拠点詳細）だけは黙って倒さない**（`unknown` 表示）。解決はクライアント側（`usePathname`/`useSearchParams`）— 共有 layout の props はクライアント遷移で更新されない（第 87 wave）。あわせて `GET /api/admin/sites` の**4 つ目の写し**を作る代わりに `useSiteList` へ集約（取得失敗を空一覧に潰す実装が混在しており「拠点が無い」と区別できなかった）。**登録漏れ検出の構造テスト**で `/admin/call-routes` が拾えた — 拠点詳細のカードには意図的に載せない画面なので、登録簿の派生だけにすると**この画面だけヘッダが黙る**（「ある次元で解いた対策を別の画面へ写していない」形）。**独立レビューが P1 を 2 件返した**: (a) 解決方式を `resolveSelectedSiteId`（一覧未着なら `''`）から `resolveSiteScopeState`（未着なら既定拠点）へ変えたことで、**一覧到着前に「追加」が押せて既定拠点に端末が作られる**回帰が入った（読みには `scopeReady` を写したのに書きには写していない＝**この PR 自身が同じ型の欠陥を作った**）。(b) 拠点切替中に前拠点の行が残り、**受付URL発行で別拠点の稼働中 iPad を受付不能にできる**（既存欠陥。`ReceptionFlowsManager` の `flowsLoaded` と同型の `devicesLoaded` で解消）。ほか **P2**: 2 画面（`call-routes`/`reception-flows`）が component のハードコード既定を使っておりヘッダ（`resolveDefaultScope`）と出所が違った／`/admin/sites` だけテナントが `internal` 固定／検出器が「URL から読むか」で見ていたため**既に登録済みの 5 画面としか一致せず新しい漏れを拾えない**（`siteId` を扱うかで見る形へ変え、未対応 7 画面を allowlist 化して #554 へ）。**`--full` の flaky 2 件も根因まで追った**: VRT は**ベースラインに `:hover` が焼き付いている**（クリック後もマウスが残る／darwin・linux 両方に焼き付き＝#553）、フロー並び替えは `fullyParallel` で**同一ファイル内の兄弟テスト**が A と B の間にフローを差し込む（`mode: 'serial'` で解消。project 分離をファイル内次元へ写していなかった）。**2 巡目のレビューが修正自体の P1 を 2 件返した**: (a) 行操作ハンドラに `!sitePending` を入れたのにボタンへ反映せず、**拠点切替中は「無効化」も「受付URL発行」もサイレント no-op**（この repo の既知 P1 パターンの逆向き＝ハンドラを ボタンより強くした）。行は deviceId で一意なので `sitePending` は作成専用にし、`canCreate` / `canMutateRows` へ分割。(b) 作成ゲートに `devicesLoaded` を含めたため、**一覧 GET が 1 回失敗しただけで登録が永久に無効化**され、端末交換の復旧経路が止まる（**読み取りの失敗で書き込みを殺さない**）。あわせて取得失敗を状態として持ち「0 件です」と断定しない・再試行導線を出す形に。P2 では `void p.finally()` の unhandled rejection、保存失敗でも編集モードを閉じる、件数表示だけゲート外、**取得失敗時にセレクタが実在するかのような拠点 ID を出す**（ヘッダは「確認できません」＝失敗系に食い違いが残っていた）、検出器が推移的 import で `/admin/sites` を誤検出、を修正。**教訓: 「読みに写した対策を書きに写す」だけでは足りず、「ハンドラとボタンを同時に見る」「読みの失敗で書きを殺さない」まで含めて初めて一巡する。** | `src/components/admin/site-context.ts` / PR #552 |
| 106 | 2026-08-01 | **週次 Routine を稼働させ、#424 の定期評価レポートを実装。** #318 の Routine（毎週月曜 09:00 JST）を作成し初回を即実行 → **設計どおり FAIL 時ハンドリングが働いた**（PR ではなく issue #545 を起票し、記録行はブランチに push）。原因は環境ダイアログの setup script が `scripts/cloud-setup.sh` の semgrep 修正（`--ignore-installed PyJWT`）に追随していない**設定ドリフト**で、正本を repo に置いた狙いどおり検出できた。修正後の再実行で PASS し、FAIL と PASS の両方を append-only で記録した PR が自動作成された（`docs/gate-runs.md` は EXAMPLE 行だけの状態を脱し、**FAIL → 起票 → 修正 → PASS の顛末がそのまま証跡になった**）。続けて #424「定期評価レポート生成コマンド」を実装（`npm run evaluate:gate-runs`）。**KPI 評価は含めない** — 実データが無く消費者ゼロになるため。**実データが設計を 2 度直した**: (a) 初版は FAIL 行の備考だけを見ていたが、`record-gate-run.sh` は issue 起票の**前**に行を書くうえ append-only なので**永久に消えない指摘＝狼少年**になるところだった。(b) レビュー指摘で、その修正を **SKIP に横展開していなかった**ことが判明（同じ罠が同じ PR の中に残っていた）。ほか tier 未検証で `fast`/`pr` の記録が stale を解除する穴、別件の issue 参照が古い FAIL をまとめて解決扱いにする穴も是正。**`quality-gate.sh` には組み込まない** — コード品質の門と運用の点検を混ぜると、Routine 停止中ずっとローカルが赤くなり override が習慣化する（増分 4 と同じ判断） | PR #548 / #550 |
| 105 | 2026-08-01 | **取次モデル一本化の増分 1（入口を閉じる）＋ e2e の並行実行バグを構造で解消。** 受付フローの「通知ルート割当」セレクタを撤去した。ここで割り当てる `CallRoute`(#88) は**実際の発信が参照しない**ので、設定しても実通話に効かないのに「呼び出し先を決めた」と読める入口だった。方針 A（撤去）の footprint は **5 層**（UI / API / 永続化・検証 / ドメイン / 公開前検査）に及ぶため 3 増分へ割り、本 wave は**スキーマに触らない UI 撤去のみ**。副次的に、選択肢取得の二重ローダーごと不要になり**第 102・104 wave のレビュー指摘 3 件を生んだ結合が消えた**。**`--full` の e2e が 3 回連続で落ちた**件は、毎回違う test が落ちるので追ったところ根は 1 つ — **`flow-mutation` project 内は `fullyParallel` で並行実行される**ため `admin-reception-flows` と `kiosk-flow-integration` が同時に既定スコープのフローを作り合っていた（kiosk の画面に他 spec の `並び替えA-*` が出た／一覧の順序検証中に対象が消えて `indexOf` が -1）。**project を分けたのは他 project との分離であって project 内の分離ではなかった**。既存の `pristine-state → chromium-ipad → flow-mutation` と同じく `dependencies` で連鎖させ `flow-mutation-kiosk` を切り出して直列化。テスト側も「自分が作ったデータを名前で選ぶ」へ堅牢化した | PR #546 |
| 104 | 2026-07-31 | **自己監査で 1 件（レビュー指摘ではなく自分で洗って発見）。** #421 の 7 増分でレビューが P1 を 15 件見つけた領域なので、idle time に同じ型が残っていないか機械的に洗った。`ReceptionFlowsManager` の `loaded` は flows と routes の**両方**が揃うまで偽だが、**flows だけ先に届くと行は描画される** — その窓で行の操作を押すとハンドラが早期 return して無反応（第 103 wave で直したサイレント no-op と同じ型が別の場所に残っていた。あちらは「ボタンの disabled に反映していない」、こちらは「`loaded` の粒度が粗すぎる」）。`routes` は割当セレクタしか使わないので `flowsLoaded` / `routesLoaded` へ分割し、**行が描かれている＝操作できる**を一致させた。`RoutingPolicyManager` の `save` がボタンより弱いガードだった逆向きの不一致も是正（**ハンドラをボタンより弱くしない**）。レビューで派生の P2: 分割により取次先未着でもフロー作成が可能になり、直後に選択肢を見る e2e が空の option を見うる → **実装が公開している signal（セレクタが有効になる）を待つ**形へ（sleep や再試行ではなく）。`--repeat-each=3` で 223 passed / flaky 0。**この領域は 8 本中 8 本のレビューが実のある指摘を返した** | PR #543 |
| 103 | 2026-07-31 | **#421 増分 7: 拠点別画面のテナント解決。#536 のレビューは氷山の一角だった** — あのとき拠点詳細だけ是正したが、実際は**拠点別 5 画面すべて**がテナントを決め打っていた（2 つは `resolveDefaultScope()`、3 つは component 既定の `'internal'`）。拠点 ID はテナント内スコープなので、テナントを切り替えると**別テナントの設定を表示・操作させうる**。`resolveAdminTenantId` へ寄せ、拠点詳細の inline 実装も 1 本化。**この PR の主眼は再発防止**で、実ファイルを走査する構造テスト（`tests/config/admin-tenant-scope.test.ts`）で機械的に落とす。走査 0 件で落ちるトリップワイヤ付き。レビューでさらに P1 2 件——どちらも**拠点で解いた問題がテナント次元で同じ形で空いていた**: (a) 既定拠点は env 由来のグローバル既定で選択中テナントに在るとは限らず、URL 未指定時に即確定すると `<選択中テナント>/default-site` を読み書きし**実在しない拠点の下にデータを作れた** → 一覧到着まで確定せず、在れば保ち無ければ先頭へ。(b) スコープ識別が拠点だけで、同じ拠点 ID を持つ別テナントへ移ると A の遅い応答が B として採用され**保存で A の内容を tenantId=B へ書き込んだ** → 識別子を `scopeKey`（テナント + 拠点）へ。**共有フック側で直したので 5 画面に同時に効く**。さらに `--full` の e2e が落ちて本 PR の退行を発見: 変更系ハンドラを `loaded` で止めたのに**ボタンの `disabled` に反映しておらず、押せるのに何もしないサイレント no-op** になっていた（`--repeat-each=3` で flaky 2→0）。**retry で流していたら実装欠陥を見逃していた**（第 102 wave に続き 2 度目） | PR #541 |
| 102 | 2026-07-31 | **#421 増分 6: 受付フローの拠点対応。これで拠点別 5 画面すべてが拠点を運ぶ。** あわせて **e2e の flaky が実バグだった**件を潰した — 「旧画面への導線は拠点を落とさない」が不安定で、原因は競合ではなく実装。拠点一覧が届く前は `resolveSiteScopeState` が `ready=false` で既定拠点を返すため、**リンクの href が一瞬 `?siteId=default-site` になる**（実測 13 回連続）。押すと別拠点の旧ルートを編集する。確定するまでリンクにしない形で塞ぎ `--repeat-each=3` で 51/51。**retry で流していたら気づかない類**だった。レビューでさらに P1: `isCurrentSite` は「古い応答を反映しない」だけで**既に描かれた前拠点の行は残る**。PATCH/DELETE は tenant と ID でしか対象を決めないので、B を表示しながら A のフローを削除できた → `flowsSiteId`/`routesSiteId` で載っている拠点を持ち、切替時に行を捨て変更系を止める | PR #539 |
| 101 | 2026-07-31 | **#421 増分 5: 重複ナビ 2 組の一本化（ユーザー承認のうえ調査して実施）。調べたら 2 組は同種の問題ではなかった。** `kiosks`/`devices` は `docs/site-device-management-design.md` に**確定方針**（Device が正・`/admin/devices` が主管理画面）があり**新しい仕様判断は不要**、ナビが方針に追いついていないだけだった。`call-routes`/`call-routing` は重複より重く、**`CallRoute` は実際の発信が参照しない**（発信は `executeRoutedCall` → RoutingPolicy/ContactEndpoint、`routing/compat.ts` は消費者ゼロ、`lib/experience-version/store.ts` も明記）＝**設定しても実通話に効かない画面**だった。対応は AC の「legacy 表示を経て段階廃止」に沿う非破壊形: ナビは 1 本ずつへ統合し、旧 2 画面は理由付きで `UNLISTED_ADMIN_ROUTES` へ。**消さずに到達可能なまま残す**（受付フローの `callRouteId` が旧 CallRoute を参照し kiosks も token フローが生きているため、消すと編集手段が絶たれる）。レビューで P1: 旧画面への導線が `siteId` を落とし、`?siteId=branch-site` から辿ったのに default を編集させていた（**既存 e2e は既定拠点しか通っておらず素通し**）。ほか拠点詳細に旧 call-routes が残存・非掲載化でタブタイトルが失われる（表示可否とメタ情報を結合していた）を是正 | PR #538 |
| 100 | 2026-07-31 | **#421 増分 4: 拠点詳細ハブ**（`/admin/sites/[siteId]`）。#421 の情報構造の結節点が存在せず `/admin/sites` は一覧だけだった。**リンクを「拠点を運べる／運べない」で分ける**のが要点で、`site-destinations.ts` を登録簿にし `siteScoped` が真の 4 つにだけ `?siteId=` を付ける。付けても無視される先に付けると**リンクが拠点を運んでいるように見えて捨てられる**（消費者ゼロの契約）。運べない 3 つは画面に「※ この設定は拠点別ではありません」と明示。テストで「siteScoped が真なのは実際に URL を読む 4 画面だけ」を固定（登録簿だけ先に増やすとリンクが嘘になる）。拠点一覧の名称からリンクし、URL 直打ちでしか開けない画面を作らない（第 21 wave の前例）。**レビューで 2 件**: (a) テナントを `resolveDefaultScope()` 固定にしていたため、テナントを切り替えた developer に**別テナントの設定を表示・リンクしうる**（拠点 ID はテナント内スコープ）→ `resolveActiveTenant` へ是正。(b) 401/403/5xx で早期 return し「それらしい詳細画面」が描かれ設定リンクが全部出たままだった → loading/ok/missing/error を明示 | PR #536 |
| 99 | 2026-07-31 | **#421 増分 3: 呼び出しルート・取次ルートの拠点固定を解く。** 増分 2 の共有部品（`useSiteScope` / `SiteScopeSelect`）をそのまま使い、配線だけで済んだ。**レビューで P1 4 件**——根はどれも同じで、`scopeReady` で「確定前に投げない」は塞いだのに**取得中に拠点を切り替えた場合**を塞いでいなかった。A の要求が飛行中に B へ切り替えると、遅れて届いた A の応答が B を上書きし、見出しとセレクタは B なのに中身は A になる（その状態で編集・削除すると別拠点の資源を壊す）。判定を共有フックへ（`isCurrentSite`）置いたので、**指摘外だった `operating-policy` にも同じ経路があった**のを見つけて同時に直せた。最も危険だったのは取次ルートで、拠点 A の下書きを持ったまま B へ切り替えると**`A のポリシー ID + siteId=B` で PATCH** し、routing サービスは siteId 変更を受け付けるのでポリシーが別拠点へ移動する → セクションを `siteId` で key して下書きを捨てる | PR #535 |
| 98 | 2026-07-31 | **#421 増分 2: 営業時間の拠点固定を解く。** `/admin/operating-hours` は `resolveDefaultScope()` 固定で、UI から別拠点へ到達する手段が無かった（env でしか変えられない）＝ IA 以前の機能欠落。`useSiteScope` + `SiteScopeSelect` を共有部品として作り、3 画面で重複させない形にした。**レビューで P1 2 件**: (a) 拠点切替直後、新拠点の取得が飛行中で `loaded` が真のままの窓があり、そこで保存すると**新拠点の設定を前拠点の値で上書き**する → `loaded` を真偽値から「どの拠点の内容が載っているか」へ変更。(b) 一覧未取得時に既定拠点を返す設計が、deep link のたびに **default → branch の 2 本の要求**を生んでいた → 純関数を `resolveSiteScopeState` にして `ready` を返し、確定するまで取得しない。**「空 id で fetch しないための fallback」という当初の判断が、より悪い競合を作っていた** | PR #534 |
| 97 | 2026-07-31 | **#421 増分 1 + 検証の土台。** AC を実コードへマッピングした結果、**キューの「重複ナビの統合以外は着手可」は依存を過小評価**していた — 拠点詳細ハブを足すだけでは受入条件を満たせず、対象 6 画面が**どれも拠点をクエリから読まない**ため、ハブから `?siteId=` を張っても捨てられる。よって拠点スコープの配線が keystone と判断し順序を入れ替えた。増分 1 で `DevicesManager` の `siteId` を `useState` から URL へ（検索・フィルタ・ページは URL 同期済みなのに**画面のスコープそのものだけが component state** だった）。**ただし追加した e2e 2 本は変更前から pass しており検証になっていなかった** — seed の拠点が 1 件だと URL を見ない実装でも同じ結果になる。seed に `branch-site` を追加して初めて実証可能にした（追加前は red、追加後 green）。レビュー指摘で、`kiosk-fixtures` 由来の `test` が毎回端末を作るため**自分で汚した一覧を assert していた**ことも判明 | PR #532 / #533 |
| 96 | 2026-07-31 | **`kiosk-vrt-a11y` の許容値を締め、隠れていた 3 例目を掘り当てた（#529）。macOS ↔ クラウドを 1 ブランチで往復した初の周回。** 0.02 は下げると毎日落ちる（9 枚中 1 枚 `out-of-hours` が 1813px 差分・中身は「次回の受付開始」の日時だけ）ので、閾値ではなく **`mask`** で潰す。**日時の値のノード（`kiosk-out-of-hours-reopen-time`）だけ**を対象にし、枠ごとは隠さない（第 72 wave の反省）。ラベル・緊急連絡枠・言語切替は比較対象のまま残る。`SHOT_BASE` を **0.002** へ。**手順**: mask は描画を変え darwin と linux のベースラインが同時に無効になるため、macOS で mask + darwin 再生成 → **同じブランチ**をクラウドセッションで linux 再生成、と往復した。macOS 側では **darwin 1 枚だけ再生成し残り 8 枚は再生成せず 0.002 で PASS**（ノイズ実測 0 の裏付け）。**クラウド側で想定外が 1 枚出た** — `qr-intro` の linux ベースラインも書き換わった＝**0.02 が隠していた 3 例目**。「1 枚だけのはず、それ以上なら止めて差分を見よ」という停止条件を事前に書いておいたので、黙って通さず記録して処理できた。linux 側は `maxDiffPixelRatio: 0` で **10 件とも完全一致**（日時を mask した分 macOS の 8/9 より強い）。`--full --strict` 全 10 ステップ PASS。**これで 0.02 が隠していた退行は計 3 件**（`kiosk-idle` のカード並び / `out-of-hours` の日時 / `qr-intro`）。ベースラインは darwin 12 / linux 12 で均衡 | PR #530 |
| 95 | 2026-07-31 | **VRT が退行を隠していた（第 77 wave に続き 2 度目）。** 第 94 wave §6.5 の残課題「darwin の `kiosk-idle` ベースラインが #422 inc5-b 以前のカード並びのまま」に対応。**診断は正しかったが「macOS で回すと 2 件落ちる見込み」という予測は外れ、実際は 3 件とも PASS していた** — カードの**位置は同じで中身の文字とアイコンだけが入れ替わる**ため、差分は 4900/4900/12319px（実比 **~0.006**）にしかならず `maxDiffPixelRatio: 0.02` の内側だった。ベースライン再生成（実描画が linux 版と一致することを目視確認＝linux が正・darwin が stale）に加え、**許容値を 0.002 へ**。根拠は実測で、同一プラットフォームの再撮影は**ノイズ 0**（`maxDiffPixelRatio: 0` で 12 連続 pass）。ベースラインは `{platform}` 込みで OS ごとに分かれており、フォント差の吸収に緩い許容値はもう要らない。**`kiosk-vrt-a11y` は同じ手が使えない** — 唯一の差分が「次回の受付開始」の日時で毎日動く。筋の良い直し方は `mask` だが描画が変わり両プラットフォームのベースラインが同時に無効になるので、1 ブランチで往復する必要がある（候補 0 へ） | PR #527 |
| 94 | 2026-07-31 | **クラウド移行の受入確認を通し、#480 を解消**（クラウドセッションが実施）。`--full --strict` 全 10 ステップ PASS（e2e 219 passed / 191s）、linux VRT ベースライン 9 枚を生成・更新（新規 4 = 結果系、更新 5 = `kiosk-idle` 3 + purpose/target/confirm）。**環境側の実バグ 2 件を発見・修正**: (a) **semgrep が黙って入らない** — debian 由来 PyJWT が uninstall できず pip install が中断していた（`--strict` を付けていなければ SKIP のまま気づかず、マージゲートが弱いまま運用されていた）。(b) **shallow clone が `.gitleaksignore` の指紋を無効化する** — 指紋は `<commit>:<file>:<rule>:<line>` で commit SHA を含むが、depth 50 clone では切り詰めた根より古い履歴が無く別 SHA で報告され、受容済みフィクスチャが**実 secret と見分けの付かない red** になる。gate 側で unshallow してから走らせる（走査対象が増える方向なので検出は弱まらない）。**取り直し範囲は §4 の記述より広く**、既存 linux ベースライン 3 枚も落ちた | PR #526 |
| 93 | 2026-07-31 | **Claude Code on the web への開発移行をリポジトリ側で成立させた**（ユーザーが「可能な限り全面移行」を決定し、claude.ai/code の環境ダイアログ側＝Network access / Setup script は実施済み）。正本は `docs/cloud-dev-environment.md`。**(a) VRT の欠落ベースラインを自動生成しない** (`updateSnapshots: 'none'`) — 既定 `'missing'` は欠落分をその場の描画で生成し、**`retries: 1` と組み合わさると「1 回目が baseline を書いて落ち、retry が通る」**ため、誰もレビューしていない描画が「正」として焼き付いたまま green になる。linux は結果系 4 状態（connected/failed/fallback/timeout）が欠けており Linux へ移した瞬間に踏む。**(b) `guard-destructive.sh` をリポジトリへ移設** — ユーザ階層 `~/.claude/` の設定は**クラウドへ引き継がれない**ので、自律ループをクラウドで回すとガードだけが消える。移植で**元実装の穴が判明**: macOS の `/Users/<user>` しか見ておらず **Linux の `/home/<user>` と `/root` を素通し**していた（実測で確認。クラウドのホームがちょうど無防備）。**(c)** SessionStart で cloud のみ `npm ci` / `.nvmrc` で Node 22 固定 / CLAUDE.md の署名規約を実態へ更新。**署名は問題にならない**ことを実測で確定 — 全て squash マージなのでブランチのコミットは破棄され、`main` の squash は GitHub が署名する（`555f64a`/`dd0df39` が `verified: true`）。⚠️ feature ブランチに署名必須の保護を掛けないこと | PR #524 |
| 92 | 2026-07-31 | **#361 の根因を確定し、`scanning` を決定的にした。あわせて第 91 wave で自分が main へ入れた誤記 4 箇所を訂正。** 根因: headless に実カメラが無く `getUserMedia` は**約 2 秒後に**拒否される。`checkin-scanning` は**その窓の間だけ存在する過渡状態**で、負荷が高いと（`--full`）assert が窓を跨ぎ、以後ずっと `element(s) not found`。第 91 wave がこの仮説を「実測で棄却」したのは **1 点サンプリングによる誤り**（camera-grant の 1.5s 後だけを 5 回見て `scanning=1`＝ちょうど境界の内側を踏んでいた）。今回は時間軸で 35 点取り直し、素の headless で `0s,1s=scanning / 2s..34s=cameraError`、フェイクカメラ有りで `0s..30s=scanning / 31s=scanError`（31s は scan timeout）と**両条件を実測**。対策は `playwright.config.ts` へ `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`（`executablePath` の解決と**マージ**すること — 置き換えると Claude Code on the web のプリインストール Chromium 解決が壊れる）。実 `CameraQrScanner` の経路はそのまま踏むので検証内容は落ちない。**教訓: 過渡状態の有無を 1 点で判定しない。時間軸で複数点を取る** | PR #523 |
| 91 | 2026-07-31 | `kiosk-checkin-subtitle-i18n:47` の flaky を `systematic-debugging` で追った。**根因は未特定のまま、次に起きたら診断できる状態にして止めた**（当て推量の修正をしない）。棄却した仮説: 「headless にカメラが無く `CameraQrScanner.start` が `camera_denied` で即座に `scanning` から抜ける」→ **実測で棄却**（camera-grant の 1.5s 後に 5 回とも `scanning=1 / cameraError=0`。headless Chromium でも getUserMedia は成功し `scanning` は安定状態）。**⚠️ この棄却は第 92 wave で誤りと判明した（1 点サンプリング）。仮説の方が正しい — 下記第 92 wave の行を参照。**ローカル 12 連射でも 0/12 で再現せず（唯一の失敗は fixture の `/api/admin/login` ECONNRESET＝既知の別件）。調査を止めていたのは**失敗メッセージが `element(s) not found` だけで、実際どの状態に居たか分からない**こと。`checkin-shell` の `data-checkin-state`（実装済み・テストが見ていなかった）を先に表明させ、失敗時に `Expected: "scanning" / Received: "..."` が出るようにした。あわせて `kiosk-checkin.spec.ts` の「mock scanner 起動中」という**事実に反する注記 2 箇所**を訂正（e2e は scanner を注入しておらず実 CameraQrScanner が動く） | PR #522 |
| 90 | 2026-07-30 | #424「API schema の diff チェック」。`change-risk` は「公開 API のパスを触った」ことは見るが**何が消えたか**は見ない。実際に壊れるのは削除・改名で、しかも**壊れる相手はリポジトリの外**（配布済みの受付端末が `/api/kiosk/*` を叩き続ける。同一リポジトリ内の呼び出し元は typecheck が捕まえるが端末は捕まえない）。170 経路のスナップショット（`docs/api-surface.txt`）と突き合わせ、**削除・改名で落ちる**。追加と削除を分けて報告するのが要点で、「スナップショットが違う」とだけ言うと更新が全部同じ重みになり破壊的変更がレビューで埋もれる。**走査が空を返したら落ちるトリップワイヤ付き**（0 本なら常に「差分なし」で通る検査になる）。動的セグメントは `[]` へ正規化（変数名の変更は URL 形状を変えないので差分にしない）。**config の schema diff は見送り** — 単一の宣言的定義が無く、作るなら定義の一元化が先 | PR #520 |
| 89 | 2026-07-30 | #424 増分 4: **kill switch と 1 周回の変更量**。**止める資格が違うので扱いを分けた** — kill switch（`.loop-halt` / env）は人間の明示操作で偽陽性が原理的に無いので**その場で abort**（実測 4.9s。`step` でサマリに FAIL を積むだけだと残りを走り切ってしまい「10 分使う前に止める」目的を果たさない。abort なので green 記録にも到達せず PR / マージも通らない）。**変更量は報告のみ** — 大きい変更が自動的に悪いわけではなく、FAIL にすると override が習慣化して増分 3 で避けた「赤を無視する習慣」を作る。目安 40 ファイル / 1500 行は**通常の周回では鳴らない水準**（暴走の検出であって大きさの禁止ではない）。超過時は PR 本文に分割しない理由を書く欄を用意。`.loop-halt` は gitignore（コミットすると全員のゲートが止まる）。**コスト上限は積み残し** — 1 周回のコストを観測する経路が無い（§8 の計測書き戻しと同根） | PR #519 |
| 88 | 2026-07-30 | #423「developer ロール時のみ platform への切替導線を表示」。**admin ⇄ platform を行き来する UI がどこにも無く**、developer は URL 直打ちしか手段が無かった（ヘッダは `テナント管理` / `プラットフォーム運用` と**現在地を書くだけ**）。`resolveAreaSwitch` は方向で条件を変える — admin → platform は developer のみ、**platform → admin は無条件**（platform に居る時点で developer が保証され、developer は admin にも入れる。戻り導線に条件を付けると判定ミスが**戻れない画面**を生む）。**導線は認可ではない**ので、非表示が保護でないことを e2e で明示（非 developer が URL 直打ち → `/admin` へ戻される）。肯定/否定を**別サーバで両側固定**した — 片側だけだと「常に出る」実装でも「常に出ない」実装でも通る | PR #518 |
| 87 | 2026-07-30 | **platform e2e を実効させた**（候補 1・A 案採用）。`platform-developer` project + 2 本目の Next サーバ（`PORT+1` / `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer`）で developer をそのプロセスに閉じる。**実測 299s → 310s（+10s / +3.5%）** — 懸念していた「起動 ~60s」ではなく、project 間に依存を張らないので並行で吸収される。**走らせた瞬間に第 85 wave の配線の欠陥が出た**: 一覧 → 詳細は `next/link` のクライアント遷移で、**App Router は共有 layout を再レンダリングしない**ため server layout から prop で渡していた pathname が stale になり、「表示中」はハードロード時しか出ていなかった（純関数は正しく、unit では検出不能）。`usePathname` へ移し静的メタテストで固定。あわせて「platform 主要画面」のスクショを分離し、**撮る前に居場所を表明**させた（それまで admin を `platform-*.png` として撮り続けていた） | PR #517 |
| 86 | 2026-07-30 | 候補 1 の AC マッピング（文書のみ）。**第 85 wave の自分の引き継ぎに誤り 2 件**を発見して訂正: (a) developer セッションは **helper では張れない**（`passwordRole` はプロセス env・email allowlist は password セッションに適用不可）→ サーバを分けるしかない。(b) 走り出すのは **4 本ではなく 3 本**（2 件目のテナントを作る API が無い＝第 74 wave の制約が有効）。実現手段（project + webServer 分離）と、A（既定 config・腐らないが重い）/ B（専用 config・軽いが腐る）の選択、および**まず `--full` の伸びを実測する**ことをキューへ記録 | `docs/loop-queue.md` |
| 85 | 2026-07-30 | #423 の配線: platform ヘッダに「表示中テナント」を出し、契約の消費者ゼロを解消（`resolveViewingContext`）。**sticky 未選択でも URL がテナントを名指ししていれば出す** — ここを `differsFromSticky` だけで判断すると「全テナント横断」と表示しながら 1 テナントの詳細を見ている状態が残る。**e2e で既存の blind spot を発見**: platform は developer 専用で `loginAsAdmin` は developer にならないため `/platform/*` は `/admin` へリダイレクトされる。`capture-screens.spec.ts` の「platform 主要画面」は撮るだけで検証しないので**ずっと admin を撮っていた**。新規 e2e は到達不能時に理由付き skip（消して腐らせない） | `src/lib/platform/selected-tenant.ts` |
| 84 | 2026-07-30 | #423 の一部: **context 優先順位の契約**を固めた。着手時に**実害を特定** — platform のヘッダは Cookie の選択を出すが `/platform/tenants/[tenantId]` の本文は URL のテナントを出すので、**ヘッダが本文と別のテナント（または「全テナント横断」）を示し得る**。`resolveContextScope` は `route > sticky > none` で解決し、**両方を server resolved の許可集合で濾す**（#419 の教訓）。`differsFromSticky` を返して UI が食い違いを明示できるようにし、route は sticky を書き換えない（#423 AC「画面移動で対象が暗黙に切り替わらない」）。**意図的に未配線** — 配線＝食い違い時に何を表示するかは UX 判断なので要ユーザー確認 | `src/domain/tenant/context-scope.ts` |
| 83 | 2026-07-30 | #423 の一部: **別実装 TenantSwitcher の表示を統合**。admin と platform は母集合（actor の accessibleTenants vs developer 専用 API）・未選択の有無（admin は常に 1 つ / platform は「全テナント横断」）・永続化（server action vs **監査に残す API**）・反映（`router.refresh()` vs フルリロード）がすべて違い、**素朴に一本化すると壊れる**（第 33 wave の「別語彙で完結した並行実装 ≠ 壊れた実装」）。実際の重複は表示だけで、`AdminShell` の固定表示と admin の単一所属表示が testid・inline style・文言まで逐語的に同一、しかも**排他レンダリングなので片方を直しても気づけない**形だった。あわせて**両方が同じ `tenant-switcher` testid** だったのを分離（意味の違う 2 つに同じ selector が当たると、片方向けの e2e がもう片方に当たって通る）。再発防止の静的メタテスト付き | `docs/loop-queue.md` |
| 82 | 2026-07-30 | 定期全体チェックの棚卸し。**「計画が未整備」は自分が同一セッションで作った stale だった** — #318 はクローズ済みで `docs/quality-gate.md` に方式・記録形式・FAIL 時の重大度・ツール追従・SKIP=FAIL まで文書化済み。実際に欠けているのは**実行**（`gate-runs.md` の実記録が 0 件。Routine 作成は文書が明記するとおりユーザー判断）。ループ側の実バグを 1 件修正: **定期実行が文書のみのブランチで走ると回すべきステップを省略していた** → `--strict` が scope 省略を無効化（`effectiveScope`。倒す方向は docs→code の一方通行） | `docs/quality-gate.md` |
| 81 | 2026-07-30 | **開発速度の施策**（ユーザー承認済み）。`--full` 実測 598s の内訳を取り、**文書のみの周回で build/e2e/lighthouse/sast を省略**（ソースを入力に取るので入力が変わらない）= **598s → 152s**。判定は純関数 `change-scope.ts`（allowlist の補集合で厳しい方へ倒す。未知のファイルは自動で全ステップ実行へ。変更ゼロも code）。**typecheck/lint/unit/secrets は docs でも回す**＝判定器のバグに対するトリップワイヤ。有効性の担保は指紋側なので省略はそのツリー限り。あわせて読み取り専用コマンドを共有 allowlist へ（安全判定モデル停止時に `rg` が無く 30 分止まった）、内側ループは `npx vitest run <path>`（0.3s / `npm test` は 95s）、署名は 1Password アンロック依頼より先に ssh-agent の生存確認、を明文化 | `docs/quality-gate.md` |
| 80 | 2026-07-30 | #424 増分 3: **停止境界の機械判定**。`CLAUDE.md` と rules が列挙する「人間承認が必要な変更」8 種を、これまで人間/AI が覚えて手で判定していた。変更パスから導出する純関数 + git 収集 CLI + ゲートへの報告ステップ。**偽陽性に倒す**（偽陽性は人が一目で流せるが偽陰性は境界を素通りさせる）。**ゲートを FAIL させない**のも意図的で、偽陽性で赤くすると赤を無視する習慣がつく。検証: #506（実際に承認を取った変更）で発火し、文書 PR では発火しない。**ドッグフーディングで偽陽性を 1 件つぶした** — npm script を足しただけで「新規依存」が出たので、依存木が動いたかは lockfile で判定するよう変更 | `docs/loop-queue.md` |
| 79 | 2026-07-30 | #424 増分 2 / #426 クローズ: Issue テンプレート 2 種と PR テンプレート拡充。AI 提案側は **observation（出どころ付き）/ hypothesis / 反証条件**を必須欄にした（反証条件が埋まらない提案は検証ではなく思い込みになる）。PR 側は仮説・計測・ロールバック・基準文書 ADR 参照・人間承認が必要な変更を追加し、**VRT は閾値内でも実物を見た**というチェック項目も入れた（第 77 wave で実際に隠れた）。#426 は受入条件 3 件を充足しクローズ | `docs/loop-queue.md` |
| 78 | 2026-07-30 | #424 増分 1 / #426: `docs/ai-development-loop.md` を新設。10 フェーズを**実在する仕組みへ写像**し、fitness functions（認可網羅・ナビ未登録検出・journey-map・server-only・CJK リテラル・契約と表示の一致・常設要素 3 領域・locale 網羅）を棚卸しした。**理想を現状として書かない**ため受入条件 6 件を「充足 0 件」として §9 に明記。検証中に自分の記述 2 件が誤りと判明（ZAP は `--full` に無く `url-quality-gate.sh` 側 / 台帳の節番号）。**文書も参照されなければ消費者ゼロと同じ**なので `CLAUDE.md` と `loop-workflow.md` から導線を張った | `docs/loop-queue.md` |
| 77 | 2026-07-30 | #361 AC2: **QR 受付の逃げ道を常設バーへ一本化**（ユーザー承認済み）。各ターンが `CANCEL`/`exit` を手書きし契約の `checkinEscapeHatchesFor` は消費者ゼロだった。契約を後退のみ（`RESET` 1 語）に絞り、`CHOOSE_MANUAL`/`USE_MANUAL` は「別レールへの前進」としてコンテンツ主 CTA へ残す（#325 が `useFallback` をバーから外したのと同じ判断）。バー実装は `EscapeBar` として受付と共有＝2 つ持たせない。**QR の idle でもバーを出す**（kiosk 待機から降りた 1 つ下なので戻る先が実在）。**VRT が本物の退行を捕まえた** — バーは `sticky bottom` 前提なので行 flex の子にすると右側の縦カラムになり「見やすさ設定」に重なる。しかも初回は `maxDiffPixelRatio: 0.02` に隠れて **pass していた**（閾値内でも実物を見ること） | `docs/loop-queue.md` |
| 76 | 2026-07-30 | #361 AC2: **QR 受付のアバター字幕だけが日本語固定**だった件を是正。`CheckinShell` は見出し・リードを `makeT(locale)` で訳していたのに、字幕は契約の ja 既定文言をそのまま渡していた（English を選んだ来訪者は英語の見出しの隣で日本語の字幕を読む）。`checkinSubtitleFor` を component 層に置き 16 ターン × 4 言語を解決。**override は speech/subtitle/fallbackText を同時に置き換える**ので読み上げも直る。あわせて #361 の AC を再マッピングし、キューの「`ConversationTurnView` 不在」が stale だったのを訂正 | `docs/loop-queue.md` |
| 74 | 2026-07-29 | #423 の一部: 対象テナント context の安全側フォールバック（存在しない id / 壊れた値 / 画面移動）を e2e で固定。純関数 `resolveActiveTenantId` は unit 済みだが**cookie → server 解決 → 画面表示の経路が未検証**だった。テナント作成 API が無いため実テナント間の越境 e2e は不可 | PR #503 |


**#578 VRM の観測性とカメラ（完了・実機 UAT 待ち）**

> 「モーションが変」というユーザー報告に対し、**まず観測可能にしてから直す**方針で 3 増分。
> PR #579（`data-vrm-version`）/ #580（`data-motion-state`）/ #581（カメラ画角）。
>
> **🔴 ユーザー提案の「0.0/1.0 を判定してモーション適用」は入れなかった。**
> `@pixiv/three-vrm-animation` が既に `vrm.meta.metaVersion` を見て `.vrma` のトラック値を
> 0.x 用に反転している（`createVRMAnimationHumanoidTracks(.., metaVersion)`）。
> **独自の版判定を足すと二重補正になって逆に壊す。** 提案を受けたら実装前にライブラリ側の
> 責務を確認すること。
>
> **単独で成立していたバグ 2 件を修正**: (a) `aspect` が読込時 1 回きりで
> `updateProjectionMatrix()` も未呼び出し → **横向き iPad を回転させると歪む**。
> (b) `position.set(0, 1.3, 2.2)` の決め打ちで VRM の身長差（子供/成人で頭の高さが 50cm 以上
> 違う）に非対応 → モデル差し替えで顔が切れる。
>
> **モーション読込は失敗しても完全に黙っていた**（`if (!vrmAnimation || !vrm) return;` /
> `catch {}`）。`data-motion-url` は要求 URL を出すだけなので、**「再生されていない」ことすら
> 分からなかった**。実機での切り分けは `data-motion-state`（`failed:load-error` /
> `failed:no-animation` / `failed:no-vrm`）→ `data-vrm-version`（`unknown` なら補正が空振り）の順。
>
> **残**: 視覚的な妥当性（距離比 1.6・注視点の下げ幅 0.08 等の係数）は実機 UAT #65。

**次に着手する候補（更新・#419 グローバルストアのテナント対応 3/5 完了時点）**

> ### #419 残増分「グローバルストアのテナント対応」— 残り 2 ストア（調査済み・着手可能）
>
> 済: `branding`（PR #572）/ `voice`・`motionMapping`（PR #573）。
> `section-loaders` の `assertGlobalStoreScope` は **`directory` / `avatar` の 2 セクションのみ**が
> 使用中。**両方対応したら guard 自体を撤去する**（`section-loaders.test.ts` に明記済み）。
>
> 共通の型（branding で確立、そのまま写す）:
> 1. `tenantScopedStoreKey('<name>', tenantId, defaultTenantIdFrom())` でキーを分ける。
>    **既定テナントは従来キー据え置き**＝移行不要・永続スキーマの非互換にならない
> 2. 対応する admin ルートを `resolveAdminTenantId()`（選択中テナント）へ。
>    **ストアだけ直しても多テナントにならない**（3 ストアとも `defaultAdminTenantId()` 固定だった）
> 3. 旧・個別 kiosk API は**既定固定のまま据え置く**。端末セッション不要の公開経路に
>    テナントを受け取らせると**無認証で任意テナントの設定を引ける**入口になる。撤去が正しい
> 4. `section-loaders` の該当セクションから guard を外し、**代わりに「別テナントへ既定
>    テナントの値を配らない」を直接固定**する（guard を消すだけだと退行に気づけない）
> 5. **モックが引数を捨てていないか確認する**。`getX: () => getX()` の形だと `tenantId` の
>    渡し忘れで緑になる。`toHaveBeenCalledWith('tenant-other')` で固定する
> 6. **`legacy-routes-guard.test.ts` の対象に入っているか確認する**。branding は入っておらず、
>    認可の出所を変えたのに検査ゼロでマージしていた（第 2 増分で追加）
>
> #### 次: `assets`（機械的に同型・小）
> `collection('asset')` + `singleton('activeAssets')` の 2 キー。**`collection(name)` も
> `singleton(name)` と同じ名前キー**なので branding と同じ扱いで済む。
> エクスポート 8 / 呼び出し元 6 ファイル。
>
> #### 最後: `directory`（最大・設計判断あり）
> `DataBackedDirectoryRepository` が `collection('department')` + `collection('staff')` を持ち、
> **`directory-store.ts` が repository をプロセス単位で memo 化している**（`let repository`）。
> ここだけ形が違うので先に方式を決めること:
> - (a) `getDirectoryRepository(tenantId)` を**テナント単位で memo 化**（`Map<tenantId, repo>`）
> - (b) 各メソッドが tenantId を取り、呼び出しごとに collection を解決する
>
> どちらでも**エクスポート 16 / 呼び出し元 10 ファイル**に tenantId を通す必要がある。
> (a) の方が変更が局所的。CSV インポート・kiosk directory も呼び出し元に含まれる。

**次に着手する候補（2026-08-01 更新・第 118 wave 消化後）**

> **#554 / #557 とも完了。** `/admin/demo` は**意図的な単一拠点**と判明したので allowlist の
> 理由を `n/a` にした（拠点スコープの意味は #419 / #420 が決めるべきもの。今移すと
> 消費者ゼロの契約を新設することになる）。
>
> 🔴 **第 110〜115 wave をまとめて独立レビューに掛けた結果、P1 1 件 + P2 12 件が出た**
> （第 116〜118 wave で全て対応済み）。**自己レビューだけでは足りない**ことの実証で、
> とくに P1（応答適用側に門が無い）と「#557 の修正が実際の clone 形式で空振り」は
> 自分では見つけられていなかった。**今後もマージ前に独立レビューを挟むこと。**
>
> 次の周回は**着手前に優先順位の確認が要る**（残る epic は #418 / #360 / #382 系で、
> どれも仕様判断を含む）。

> **#554 の機械的な移行は完了した**（6 画面）。残る `/admin/demo` は**移行対象ではなく
> 仕様判断＝要ユーザー確認**（第 114 wave の調査結果。デモ公開を拠点にスコープする意味を
> 決める必要があり、#419 / #420 と絡む）。**ユーザーの判断が出るまで #554 は着手しない。**
>
> よって次は **#557**（浅い clone でゲートの変更量チェックだけ古い base で測り、過大な
> 数値を報告する。実害は無いが狼少年になる）。
>
> 拠点別画面を新たに足すときの型（第 110〜114 wave で確立、そのまま写してよい）:
> ページで `resolveAdminTenantId()` と `resolveDefaultScope()` をサーバ解決 → `useSiteScope` →
> `SiteScopeSelect`（`onRetry` は必須 prop なので配線忘れは型が落とす）→ `<data>ScopeKey` で
> 載っているスコープを保持 → 門は `resolveScopeGate` の **`canCreate`（一覧に依存しない
> 書き込み）と `canMutate`（載っている行への操作）を分ける**。**独自 fetch を持つハンドラを
> 数えて全部に門を写すこと**（#562 の `reissue` が実例）。

> **#421 の「拠点スコープ」と重複ナビは一巡した**（第 97〜102 wave）。拠点別 **5 画面**が
> URL の `siteId` を読み、拠点詳細ハブから辿れ、重複ナビ 2 組も 1 本ずつへ統合済み
> （旧画面は legacy 表示で到達可能なまま）。残りは下記のとおり。
>
> **⚠️ この 6 増分でレビューが P1 を 13 件見つけた。型はほぼ 1 つ**: ある画面で見つけた
> 対策を次の画面へ写していない。共有フック（`useSiteScope`）へ寄せた分（`scopeReady` /
> `isCurrentSite`）は横展開できたが、**コンポーネント側の状態（「どの拠点のデータが
> 載っているか」）は各画面に散ったまま**で、そこが毎回穴になった。
> 拠点別画面を新たに足すときは、**取得ガード・応答の取りこぼし判定・載っている拠点の
> 保持・変更系の停止の 4 点セット**を必ず揃えること（`ReceptionFlowsManager` が全部入り）。
>
> 0. **#421 の残り（軽い順）**
>    - **取次モデルの一本化（残り増分 2・3）** … 移行台帳 §5「取次モデル」。方針は
>      **A（撤去）でユーザー承認済み**。第 105 wave で増分 1（UI の入口を閉じる）まで完了。
>      残るのは **(2) PATCH での書き込み停止 / (3) レスポンス・型・`call-route-checks`
>      からの撤去**。**⚠️ (3) は保存済みフロー設定のスキーマを変えるので着手前に要確認**
>      （CLAUDE.md の停止境界。増分 1 の PR でも「増分 3 は改めて確認する」と明言している）。
>    - **受付体験エディター統合 / 共通ヘッダー / 変更影響範囲** … #419・#420 依存が濃い。
> 1. **#424 の残り**（config・API schema の diff / 追跡 ID / 定期評価レポート / 監査ログ /
>    1 周回のコスト上限）。棚卸しは `docs/ai-development-loop.md` §9 にあるので**再調査不要**。
> 2. **#423 の残チェックリスト**（下記「旧・候補」の 3 番を参照）。
>
> **VRT を触る周回だけ手順が違う**（恒久的な制約）: ベースラインは**両方向にプラットフォーム
> 束縛**で、darwin は macOS でしか、linux は Linux でしか作れない。描画が変わる変更は
> **1 本のブランチで macOS ↔ クラウドを往復**させること。`docs/cloud-dev-environment.md` §6.6。

**✅ 完了した候補 0（第 95 wave 時点・`kiosk-vrt-a11y` の日時マスク）**

> 第 96 wave (PR #530) で完了。macOS 側で mask + darwin 再生成、クラウドセッションで
> linux 再生成という往復を実施。**副産物として閾値が隠していた 3 例目（`qr-intro` の linux）
> を発見**。以下は当時の記述（履歴として残す）。

> 0. **`kiosk-vrt-a11y` の日時マスク（macOS ↔ クラウドを 1 ブランチで往復する必要あり）。**
>    第 95 wave で `kiosk-screenshot` の許容値は 0.002 まで締めたが、`kiosk-vrt-a11y` の
>    `maxDiffPixelRatio: 0.02` は**下げると毎日落ちる** — 実測で 9 件中 1 件
>    （`kiosk-landscape-out-of-hours`）が 1813px 差分になり、**中身は「次回の受付開始」の
>    日時テキストだけ**だった。筋の良い直し方は閾値ではなく**その要素の `mask`**
>    （第 72 wave の手法。ただし必要最小限へ絞ること）。
>
>    **手順が特殊**: mask は描画を変えるので **darwin と linux の両ベースラインが同時に
>    無効になる**。片側だけで直すともう片側が壊れるため、**1 本のブランチで**
>    「macOS で mask 適用 + darwin 再生成 → 同じブランチをクラウドセッションで linux 再生成
>    → `--full --strict` → マージ」と往復する。詳細は `docs/cloud-dev-environment.md` §6.6。
>
> 1. 以降は下記「旧・候補」の #421 admin IA 再編 / #424 の残り / #423 の残チェックリストへ戻る。

**✅ 完了した候補 0（第 93 wave 時点・クラウド受入確認）**

> 第 94 wave で完了。`--full --strict` 全 10 ステップ PASS、linux VRT ベースライン 9 枚を
> 生成・更新し **#480 を解消**。副産物として環境側の実バグ 2 件（semgrep が黙って入らない /
> shallow clone が `.gitleaksignore` の指紋を無効化する）を発見・修正した。
> 記録は `docs/cloud-dev-environment.md` §6。以下は当時の手順（履歴として残す）。

> 0. **クラウドセッションでの受入確認（ローカルからは実施不可）。** 第 93 wave で移行の
>    リポジトリ側は揃った。残るはクラウドセッション内での確認だが、**順序が重要**。
>
>    **(1) 先に linux VRT ベースラインを作る。** 結果系 4 状態（connected/failed/fallback/
>    timeout）が欠落、かつ #480 の `kiosk-idle` は #324 以前のまま。**ベースラインは実行
>    プラットフォームでしか作れず、#480 は macOS からは原理的に閉じられない＝クラウドが
>    唯一の手段**。`--update-snapshots` で生成し、**差分を見てから**コミットする。
>
>    **(2) その後で `./scripts/quality-gate.sh --full --strict`。** これが移行の受入条件。
>    ⚠️ **順序を逆にすると受入確認は成立しない** — `updateSnapshots: 'none'` は欠落
>    ベースラインを**意図的に落とす**ので、(1) の前に `--full` を回すと `kiosk-vrt-a11y` が
>    必ず赤くなる（これは移行の失敗ではなく手順の誤り）。`--strict` を付けるのは、任意ツール
>    （gitleaks / semgrep / lhci）が未導入だと **SKIP は FAIL にならず、マージゲートが黙って
>    弱くなる**ため。目視確認に頼らず `--strict` で機械的に落とす。
>
>    動かないものがあれば**再現コマンドと実際の失敗メッセージ**を
>    `docs/cloud-dev-environment.md` へ追記する（「動かない」だけだと stale な制約として
>    引き継がれる。第 15 wave の前例）。

**旧・次に着手する候補（2026-07-30 更新・第 87 wave 消化後）**

> **候補 1「platform e2e を実効させる」は第 87 wave で完了。** A 案（既定 config に project +
> 2 本目の webServer）を採用。決め手は実測で、**+10s / +3.5% しか伸びない**（依存を張らないので
> 2 本目の起動は並行で吸収される）。方式は `docs/quality-gate.md`「`platform-developer` が
> 別サーバな理由」を正本とする。
>
> 残っている制約: **`platform-viewing-context.spec.ts` の 4 本目（sticky と別テナント）はまだ
> skip**。2 件目のテナントを作る API が無い（`src/app/api/platform/tenants/` に POST 無し・
> `createTenant` は repository 層のみ、seed は `internal` の 1 件）。第 74 wave の
> 「テナント作成 API が無いため実テナント間の越境 e2e は不可」が引き続き有効で、
> **#423 の「越境 context のエラー UX」も同じ壁の向こう**にある。テナント作成 API は
> platform の write ＝ JIT 昇格・監査を伴う設計判断なので、着手するなら要ユーザー確認。

> **❌「`Site > Kiosk > Version` を context 契約へ揃える」は前提が成立しない**（第 88 wave の
> AC マッピングで判明。**この行は分類 stale の 6 例目**）。`resolveContextScope` と同じ形
> （route > sticky、権威で濾す）を site/kiosk へ広げようとしたが、**route 層も sticky 層も
> 存在しない**:
> - `/admin` 配下に**動的セグメントが 1 つも無い**（`/admin/sites/[siteId]`・
>   `/admin/devices/[deviceId]` などは無く、全ページが平坦な一覧/管理画面）。
> - site/kiosk の sticky Cookie も無い。`DevicesManager` の `siteId` は**ローカル React state**
>   で、画面を跨ぐと消える（一覧フィルタを URL へ載せる `use-query-params`(#94) も使っていない）。
>
> いま契約だけ作れば**消費者ゼロの契約**になる（本書が繰り返し警告してきた形）。先に要るのは
> 「site/kiosk を画面を跨いで保持する対象にするのか」という IA 判断で、それは **#421 の
> テナント→拠点→端末→受付体験の再編そのもの**。順序は #421 → context 契約。

1. **#421 admin IA 再編**（重複ナビの統合＝概念一本化は要ユーザー確認なので除く）。
   ここで site/kiosk が「画面を跨ぐ対象」になって初めて context 契約に意味が出る。
   **第 87 wave の教訓を必ず持ち込む**: 共有 layout の props はクライアント遷移で更新されない。
   context の解決はクライアント側（`usePathname`）か、遷移ごとに再評価される経路で行う。
2. **#424 の残り**（増分 4 = kill switch / 変更量は第 89 wave で完了）。残るチェックリストは
   config・API schema の diff チェック / 追跡 ID / 定期評価レポート生成 / プロンプト・ツール実行の
   監査ログ / **1 周回のコスト上限**（コストを観測する経路が無く、§8 の計測書き戻しと同根）。
   棚卸しは `docs/ai-development-loop.md` §9 にあるので**再調査不要**。
3. **#423 の残チェックリスト**（依存が軽い順）:
   - platform のテナント詳細 → そのテナントの admin へ遷移。**admin の選択中テナントを書き換える
     かが論点**（#423 AC「画面移動で対象が暗黙に切り替わらない」と正面から当たる）。要設計。
   - admin の拠点・端末詳細 → draft/published プレビュー、および preview からの復路（#420 依存）。
   - AC「視覚回帰は iPad landscape と **desktop admin** を対象にする」… **未充足**。現状 VRT は
     kiosk のみ（`kiosk-vrt-a11y` / `kiosk-screenshot`）で admin の baseline は 1 枚も無い。

**✅ 週次 Routine は第 106 wave で稼働開始**（毎週月曜 09:00 JST）。`docs/gate-runs.md` に実記録が入り始め、`npm run evaluate:gate-runs` で「回っているか / 黙って弱くなっていないか」を点検できる。**環境ダイアログの setup script は `scripts/cloud-setup.sh` の写しなので、片方だけ直すとドリフトする**（実際に初回でこれを踏んだ）。

**旧・次に着手する候補（2026-07-27 更新・第 37 wave 消化後）**: **差分 B は決着済み**
（`docs/experience/state-mapping.md` §5 B の表）。第 35〜37 wave で 6 項目すべてを処理し、
**体験状態は 1 つも増やさずに済んだ**（3 つは元から実装済み、2 つは計測配線と文言分岐で解決、
1 つは README の定義待ち）。残る未対応は `no_match`（計測は通っているので状態化不要）と
`privacy_blocked`（**README に定義文が無く判断できない = 要ユーザー確認**）の 2 つ。
残る差分は **C（音声とタッチの確認を 1 状態機械へ）と D（QR 受付の統合）だけで、
どちらも仕様判断＝要ユーザー確認**。よって体験設計まわりで境界内に残る作業は無い。

> **#327 はクローズ済み**（2026-07-12・`state_reason: completed`）。第 38 wave の
> `/issue-ac-mapping` で判明。本書と handoff が「次は #327 の i18n 移行」を第一候補に
> していたのは stale な分類だった。ただし**受入条件は満たしきれていなかった**ので、
> follow-up として第 38 wave で常設逃げ道バーの i18n 化を実施した（下記）。

**旧・次に着手する候補（第 29 wave 時点）**: **#422 increment 5 = 新旧
ExperienceShell の切替**（移行フラグは ADR 0004 のとおり構成取得とは**別キー**にする）、または
**#419 の `kiosk-dev` 除去**。台帳 §9 B-03〜B-05 は移行フラグの既定を新経路へ倒して
観測してから。#420 の残り（実検証チェッカ・デモ公開モデルの統合）はいつでも着手可。
代替候補: #421 admin IA 再編（`/admin/experience-versions` のナビ配線を含む）／
**グローバルストアのテナント対応**（永続キー変更 = スキーマ破壊なので **要ユーザー確認**）／
#423 横断 E2E ／ AI Evolution epic 群(#382〜#392)。
エピック群の優先順位はユーザー判断（現在地の注記参照）。

## 落とし穴（着手前に必読）

- **#366 は本プロジェクト初の実質的な固定費**。EC2 t4g + Route 53 + EBS + CloudWatch を
  8:00–23:00 常時稼働させる。現状 open-reception の AWS 実績は**月 $0.0005**（2026-07 実測、
  dev のみ・ほぼ無料枠内）なので、コスト構造が質的に変わる。CLAUDE.md の重大変更条件に
  該当 → **Phase 0 ADR で Budget 見積を出して承認を取ってから CDK を書く**。
- ~~#361 は既存の意図的設計の反転~~ → **決着済み**（#361 クローズ・2026-07-30）。選択/入力画面でもアバターを出す判断は `deriveAvatarPresence` の `companion` として契約に入り、`avatar-companion.test.ts` もその前提で書き換わっている。
- ~~#375 の token hash 化~~ → **第 13 wave で消化済み**（SHA-256 + timingSafeEqual）。
  残るのは DynamoDB 永続化（#97 inc3）時の一括移行と pepper 確定。
- **VRT を別 project へ移すと baseline が孤立する**（第 23 wave で実際に踏んだ）。スナップショット名は
  既定で project 名を含むため、その場の描画が新 baseline として自動生成され、退行がそのまま
  「正」として焼き付く。`snapshotPathTemplate` で解決先を固定すること。
- **e2e はこのコンテナで動く**（第 22 wave で是正）。「実行不可」という過去の記録は誤りだった。
  UI/a11y に触る変更は `--pr --e2e` を通す。
- **`KioskFlow` の副作用はフックへ出した**（第 25 wave）。設定取得は `useKioskConfiguration`、
  heartbeat は `useKioskDeviceStatus`、体験メトリクスは `useExperienceMetrics` が所有する。
  **これらの state を `KioskFlow` に再び置かない**（分割が巻き戻る）。
- **kiosk 配下の新規ファイルに生 CJK リテラルを置かない**（#327 の機械検証が落ちる）。
  `KioskFlow.tsx` は allowlist 済みなので、未移行の既定文言をフックへ移すと違反になる。
  第 25 wave では待機リードの ja 既定文言を `KioskFlow` 側に残して回避した（移行本体は #327）。
- **区別は「状態を増やす」以外の方法でも付けられる**（第 36 wave）。通信断とサーバ失敗を
  分けるのに `failed` を割らず、`failureReason` を添えて文言だけ変えた。遷移表を増やすと
  逃げ道・timeout・戻るの組み合わせが倍になり、増えた状態ごとに同じ検証が要る。
  **状態を増やす前に「同じ状態の中の説明」で足りないかを見る。**
- **「状態が無い」と「計測できない」は別**（第 35 wave）。差分 B を「Outcome metrics が測れない」と
  一括りにしたが、0 件率は端末側で既に数えており（`searchZeroHitCount`）、欠けていたのは
  サーバへの配線と集計だった。**状態を増やす前に、その指標が本当に状態を要求するのか確かめる。**
- **並行実装は「壊れている」とは限らない**（第 33 wave）。デモ公開は旧 kiosk レジストリと
  旧スコープ語彙（`siteId` にテナント ID）で**一貫して閉じており**、UI の端末候補も同じ母集合なので
  現時点の実害は無い。統合予定の subsystem に互換対応だけを積むと債務が深まるため、
  **その場しのぎの修正はせず方針（ADR 0005）を固定した**。「別語彙で完結した並行実装」と
  「壊れた実装」を区別すること。
- **取次モデルは 2 つ並存している**（第 32 wave に確認）。実際の呼び出しが使うのは
  `RoutingPolicy`/`ContactEndpoint`（#374）で、受付フローの `callRouteId` が指す `CallRoute`（#88）は
  **admin の編集と永続化のみ**（`executeRoutedCall` は参照しない）。「取次が設定できている」ことの
  検査は前者で行う。台帳 §5 に重複概念として登録した。
- **検証の severity は「実行時に本当に壊れるか」で決める**（第 31 wave）。`language_fallback` は
  当初 error にしたが、`sanitizeLanguageSettings` が実行時に必ず補正するため端末は壊れない。
  壊れないもので公開を止めると運用が理由なく止まる → 全て warning へ直した。逆に http: アセットは
  混在コンテンツでブラウザにブロックされ**黙って表示されない**ので error のまま。
  **常に鳴る警告も作らない**（アバター未使用の拠点で毎回モーション警告が出る形だったので、
  アバター設定済みの拠点だけに絞った）。
- **`kiosk-dev` 固定値は「動いているように見えて実は無効」の典型だった**（第 30 wave）。
  クライアントが `?kioskId=kiosk-dev` を送り、実エンロール端末（ランダム UUID）のセッションと
  食い違うため、**死活記録も版報告も丸ごとスキップ**され、有効性は全端末が seed 端末の設定を
  読んでいた（個別の失効が効かず、seed を無効化すると全端末が止まる）。
  **クライアントが送る識別子は権威にしない**（サーバがセッションから解決する）。
- **kiosk コンポーネントを切り出すときは生 CJK リテラルの有無を先に測る**（#327 の検証は
  `KioskFlow.tsx` を allowlist する一方、**新規ファイルは例外なく検査する**）。残る生 CJK は
  13 箇所 / 5 コンポーネント（`KioskAuthorizeView` 4 / `KioskUnenrolledView` 3 /
  `KioskCheckingView` 1 / `EscapeHatchBar` 1 / `CustomVisitorInfoView` 1 / `KioskFlow` 本体 2）で、
  **これらは端末ゲート系＝ KioskFlow に残す側**。受付ジャーニー画面は全て i18n 済みで、
  第 29 wave でそのまま切り出せた。allowlist を広げて回避しないこと。
  > 第 28 wave は「`renderScreen` が `CustomVisitorInfoView` を参照するので分割は #327 待ち」と
  > 記録したが**誤り**だった（参照関係を確認せず仮定した）。実際には `renderScreen` の参照先は
  > 全て i18n 済みで、依存は無かった。**「依存がある」と書くときは参照を実際に引くこと。**
- **`--full` を実際に通す**（第 47 wave）。CLAUDE.md は「マージ前は `--full`」を要求しているが、
  第 37〜46 wave は `--pr` だけで 10 本マージしていた。通してみたら **2 件 FAIL** した:
  postcss の高危険度脆弱性（**既存の override `>=8.5.10` が修正版 8.5.18+ の解決を塞いでいた**）と、
  lighthouse の Chrome 未検出。**重いゲートは「重いから後で」で飛ばすと、飛ばしている間に
  実際に赤くなる。**
- **`brace-expansion` の残存脆弱性は現状「直せない」**（第 48 wave に実測）。advisory の対象は
  `<=5.0.7` で、**2.x 系には修正版が存在しない**（最新 2.1.2 も対象内）。唯一の修正版 5.0.8 へ
  override で寄せると、**エクスポート形が変わっていて `minimatch`（CJS）が
  `TypeError: expand is not a function` で落ち、eslint が起動しなくなる**。
  経路は `@opennextjs/aws` → `@node-minify/core` → `glob@9` → `minimatch@8` と
  `typescript-eslint` で、いずれも **dev 依存**（ゲートの `npm audit --omit=dev` は 0 件）。
  上流が 2.x 系へ patch を出すか、`minimatch` が 5.x 対応するまで待つ。**再挑戦するなら
  まず `npx eslint .` を回すこと**（install だけでは壊れていることに気づけない）。
- **バージョン固定の override は、あとで脆弱性修正を塞ぐ**（第 47 wave）。`overrides` は
  脆弱性対応で足すことが多いが、レンジの下限を固定したまま放置すると**次の脆弱性修正が
  入らない**。`npm audit` が override 済みパッケージを指したら、まず override 自体を疑う。
- **「網羅」を手で列挙したリストで担保しない**（第 44〜46 wave で 3 回踏んだ）。CJK allowlist・
  admin ナビ・認可ガードのいずれも、対象を手で並べたリストで管理しており、**新しいものを
  足しても誰も気づかない**構造だった。共通の対処は同じで、**実体（ファイル・ルート・語彙）を
  走査して、登録済みか理由付きの除外かのどちらかを強制する**メタテストを置くこと。
  除外理由の長さも検査する（空文字や「同上」で誤魔化せなくする）。
- **生 CJK の件数を「翻訳漏れ」の指標にしない**（第 42 wave）。訳し終えた module にも ja の
  訳文は残るので、件数は減らない。`avatar/guidance.ts` の 36 箇所は **5 ロケール × 全 9
  AvatarState を完備した上での ja + やさしい日本語の原稿**で、漏れではなかった
  （第 40 wave は件数だけを見て「来訪者向けの最大の翻訳漏れ」と書いた＝誤り）。
  **判定は「その module が `locale` を受け取っているか」で行う**。受け取っていなければ
  選んだ言語に関わらず日本語が出る＝実際の漏れ。`grep -c 'locale\|makeT\|Locale' <file>` が
  0 のものを探すこと。
- **「実装に無い」と書く前に、その語を実際に grep する**（第 37 wave。第 28 wave と同種の誤り）。
  第 34 wave の差分表は実装の状態語彙を `ReceptionState` / `KioskMode` / `VoiceKioskMode` の
  3 系統と仮定したため、`visitor_detected` / `recognizing` / `choosing_method` を「状態語彙に
  無い」と誤判定した。実際には `PresenceState`（独立した状態機械）・`voiceListeningStage()`・
  **`CheckinState.selectingMethod`**（`ui-contract.ts` に `chooseMethod` の文言まである）に在った。
  **前提として立てた「語彙の数」自体を疑うこと**（前提が誤ると派生した判定はまとめて誤る）。
  > **規律では守れなかった**: 第 37 wave はこの落とし穴を書いた当のコミットで、残り 1 件
  > （`choosing_method`）に対して同じ誤りを犯し、独立レビュー（`change-reviewer-opus5`）に
  > 指摘されて発覚した。**「気をつける」で止めず、仕組みで止める**こと。
  対策として `journey-map.test.ts` が `src/domain/**` の状態語彙を**全件走査**し、採録も除外も
  されていない語彙があれば落ちるようにした（表の内側の網羅テストでは「表に載せなかった語彙」を
  検出できない、という第 34 wave の失敗の形をそのまま塞ぐ）。
- **「常設される」前提の UI は、画面分岐の外に置く**（第 39 wave）。逃げ道バーは
  「待機以外の全画面に常設」される前提で設計され、その前提のもとで各画面のコンテンツ側から
  後退ボタンを撤去してある（`VisitorInfoForm` へ `onBack` を渡さない等）。ところが実際には
  既定受付の枝の**中**に置かれていたため、カスタム受付フロー (#100) の 2 画面では逃げ道が
  1 つも出ず、来訪者は 60 秒の無操作リセットを待つしかない**行き止まり**になっていた。
  **コメントが「常設」と書いていても、構造がそれを保証していなければ嘘になる。**
  分岐を増やす人が入れ忘れられない位置（分岐の外側）へ出すこと。
- **独立レビューは「自分が今書いた結論」にこそ効く**（第 37 wave）。自己レビューは自分の前提を
  共有しているため、前提そのものの誤りを見つけられない。**分析の結論を含む変更**は
  `change-reviewer-opus5`（読み取り専用）へ回し、「その語を実際に grep して確かめよ」と
  明示的に指示すると、憶測ではなく事実で返ってくる。
- **構成の「取得」と「適用」を分けて考える**（第 27 wave）。取得は 60 秒ごと（`?configSyncMs=` で
  短縮可）に回るが、**適用は待機（idle）に戻ってから**。受付進行中に差し替えると来訪者の画面が
  操作の途中で入れ替わる。判定は `src/domain/kiosk/configuration-sync.ts`。
  heartbeat で報告するのは**適用済み**の版であって、取得だけして保留中の版ではない。
- **端末の版報告は「内容の指紋を持つ版」だけ送る**（第 26 wave）。版管理未導入の拠点は
  `LIVE_VERSION`（revision 0・指紋なし）で配信されるため、これを報告すると管理側の突き合わせが
  常に不一致になり、正常な端末が「旧版で稼働」として並ぶ。判定は
  `src/domain/kiosk/configuration-report.ts`。
- **構成取得の移行フラグは既定 OFF**（第 24 wave）。`/kiosk?effectiveConfig=1` で新経路、`=0` で
  旧経路。**フラグの既定を倒す前に「新経路で全端末が構成を取れる」ことを観測する**（未エンロール
  端末は新経路が 403 になり、旧経路へ自動フォールバックして初めて構成が揃う）。
- **#369〜#372 は greenfield**。既存 `src/lib/voice/` を音声パイプラインと誤認しない。

### 音声スタック（#369〜#372）は「ドメイン完成・実音声未接続」（2026-08-03 実測）

キューは #369〜#372 を「ローカル可」に置いていたが、実態は違う。**ドメインと seam は
完成していて、ローカルで積める差分がほぼ無い。**

本番呼び出し元がゼロのもの（＝作ってあるが誰も起動しない）:

| 対象 | 本番消費者 |
| --- | --- |
| `reportNearEndOnset` / `reportNearEndUpdate`（barge-in の入口） | **0** |
| `createOrchestratorVoiceSession`（実 orchestrator を束ねる seam） | **0** |
| `domain/voice-turn/vad.ts` | 0 |
| `domain/voice-turn/stt-integration.ts` | 0 |
| `domain/voice-turn/history-truncation.ts` | 0 |

一方 `turn-detector` / `near-end-classifier` / `barge-in-controller` / `eval-bridge` は
orchestrator まで配線済み。**つまり barge-in の機構は在るが、信号を供給する側が無いので
本番では一度も起動しない。**

kiosk の音声入力は `MockSttAdapter` 直結（`components/kiosk/stt-adapter.ts`）。

#### 何がブロッカーか

- **実音声の入力経路**（ブラウザのマイク → transport → STT provider）。#369 / #370 の本体で、
  実 AWS・実機が要る（#65）
- `history-truncation` は別の前提でブロック ── **本番に会話履歴そのものが存在しない**。
  履歴を持つ設計は「来訪者の発話＝PII をどこにどれだけ保持するか」の判断を伴う

#### 実施済み: 実 orchestrator のローカル起動（PR #607）

`?voiceOrchestrator=1` で mock provider 駆動の実 `VoiceSessionOrchestrator` が起動する
（`lib/voice-session/local-mode.ts`）。**既定はオフ**で、既存の受付挙動は変わらない。

実装中に判明した設計上の欠落: orchestrator は `pushMicChunk` / `reportSpeechStarted` /
`reportSilenceTick` を**外部から駆動される**設計で、seam はそれを露出しない。実機ではマイクと
VAD が駆動するが、ローカルには無いので**素直に繋いでも「起動はするが何も起きない」**。
合成音声で駆動する層を足して解決した。

**⚠ これは実音声の代替ではない。** 以下は依然として未検証:

- 実マイク入力での VAD の妥当性
- **自己音声エコーの誤検出**（`echoLikelihood` を**計測する実装がまだ無い**。
  `classifyNearEnd` は入力として受け取るだけ）
- 実 STT の partial/final タイミングに対するターン検出の挙動
- 騒音下・距離のある発話

#### 残りのローカル候補（要判断）

`createOrchestratorVoiceSession` を Mock STT 駆動で KioskFlow へ配線し、実 orchestrator を
ローカルで起動できるようにする。turn detection と barge-in が実 UI で動き、e2e で検証できる
ようになる。ただし**受付端末の音声挙動を変える**のでフラグ運用と体験設計の判断が要る。

### テストが在ることは安全の証明にならない（2026-08-02〜03 実例）

セキュリティ 4 件（#589 / #595 / #597 / #601）を潰したが、**いずれも「テストもゲートも
green だが安全ではない」**形だった。通常のテスト実行では見つからず、**変異させて初めて**分かった。

- **#589** … セッションガードが取り残されていたが、e2e には「kiosk API は認証なしで利用できる
  （公開）」という**意図を明示したテスト**が在った。履歴を辿ると #24（admin 認証境界）当時の
  「admin 認証の背後に置かない」という別の意図で、**タイトルが陳腐化**していた
- **#595** … 認可カバレッジ検査が、**doc コメントに `requireActor` と書いてあるだけ**で通った。
  ガードの説明が丁寧な route ほど素通りする逆向きの穴。`@/lib/admin/guard` から
  `toGuardResponse` を import するだけでも通った（連結先に定義が在るため）
- **#597** … 縮退経路が組織モデルの編集を無視し、**隠したはずの組織が縮退中だけ露出**していた
- **#601** … `it('クエリ指定時はその tenantId / siteId で取得する')` が、**脆弱な挙動を
  そのまま仕様として固定**していた

**教訓**: 書いたテストは必ず変異させて落ちることを確かめる。既存テストのタイトルは意図の
スナップショットで陳腐化する。**「拒否側テストが通っている」は、正しい理由で通っているとは限らない**
（#603 では `parentId` が編集不可キーとして弾かれていたため、循環検証が無くても通っていた）。

### 調査の粗さによる誤報を 2 度出した（2026-08-03）

- 「トークン API 2 本が無認証の可能性」→ **誤り**。`readKioskSession` ＋所有権チェック済み。
  最初の調査が `denyWithoutKioskSession|requireKioskSession` だけを検索していた
- 「更新系 30 route が未監査」→ **誤り**。全 67 route を精査して穴はゼロ。マーカを `marker(` と
  括弧付きで探して `authorizePlatformWithIdentity` を取りこぼし、`--glob` がディレクトリ名に
  効かず委譲先の判定も誤った

**教訓**: 結論を出す前に**検索条件そのものを疑う**。`rg --glob "*name*"` はパスではなく
basename に効く。`rg -r` は `--replace`（recursive ではない。**この周回でも 1 度踏んだ**）。

### ゲートの FAIL がコードの退行とは限らない（2026-08-02 実例）

`--full` の vrm が FAIL したが、原因は**検査自身がリークした `next-server`** がポート 3102 を
握っていたことだった。`npm run start` は `next start` を子プロセスとして起動するので、
`cleanup` が npm を殺しても next-server は孤児として生き残る。次回の実行は**古いサーバ**に
繋がり、再ビルド後は chunk が食い違って `ChunkLoadError` を出す。

この症状は**コードの退行と見分けがつかない**。実際「自分の変更が VRM を壊した」と誤認し、
main との比較・クリーンビルドで数回のビルドを浪費した。逆に古い build が健全なら**偽 PASS**
にもなる。`scripts/vrm-check.sh` に (1) 起動前のポート検査 (2) ポート保持者を名指しで殺す
cleanup を入れて塞いだ。

**教訓**: 検査が FAIL したら、まず「検査対象は本当に今のコードか」を確かめる。
切り分けの初手は `lsof -i tcp:<port>`。**背景実行に `tail -N` を噛ませない**（失敗理由を
捨てる。今回も一度失った）。ログはファイルへ落として全文を残す。

### mask されている領域は VRT で守られていない

VRT の `mask` は要素の**矩形**を覆う。よって (1) 要素が高くなれば mask 矩形も変わり
**baseline は影響を受ける**（「mask してあるから影響なし」は誤り）、(2) mask 下の**中身は
何も検証されない**。PII のため mask している領域に機能を足したら、テキスト検査を別に足すこと。
`confirm-target` の所属表示（#591）がこれに該当する。

## モデル割り当て指針（オーケストレータ向け）

オーケストレータ（マージ判断・レビュー・競合解決・スコープ裁定）は上位モデルで実行し、
実装トラックは `Agent` の `model` でタスク特性に合わせる:

| 割り当て | 対象 | 例 |
| --- | --- | --- |
| **上位（opus 等）** | 設計判断を伴う UX/情報設計、横断リファクタ、スキーマ設計 | #361（画面再設計・既存設計の反転）/ #373（組織モデル）/ #374（ルーティング抽象）/ #375（招待モデル） |
| **標準（sonnet 等）** | AC が具体的で対象ファイルが特定済みの実装 | #362（配線分離）/ #365（ハーネス）/ #367 Inc1 / #369〜#372（仕様が明確な greenfield）/ #377 |
| **標準（sonnet 等）** | ドキュメント整備・ADR 草案 | #366 Phase 0 / #376 ADR |

- レビュー/検証エージェント（読み取り専用 fan-out）は標準モデルで並行可。
- トラック内で設計疑義が出たら実装を止めてオーケストレータへ報告（トラック側で判断しない）。

## 進め方メモ

- 各トラックは独立 worktree（または `isolation: "worktree"` のサブエージェント）で実装。
- fresh worktree は `node_modules` が無いが `quality-gate.sh` の bootstrap が自己修復する。
  worktree 内でゲートを起動するときは **その worktree 自身の `scripts/quality-gate.sh`** を叩く。
  スクリプトは `cd "$(dirname "$0")/.."` で repo root を解決するため、**main の絶対パスを渡すと
  main のツリーが検証され worktree の変更は一切見られない**（2026-07-19 に実際に 2 トラック空振り
  させた）。「絶対パスで」だけでは不十分。`$(git rev-parse --show-toplevel)/scripts/quality-gate.sh`
  の形で渡すか、出力の `repo:` 行でどのツリーで走ったかを必ず確認する。
- コミット署名は 1Password `op-ssh-sign`（ロック中は失敗 → アンロックして再実行）。
- マージは 1 本ずつ。ゲート green + レビュー blocking なしなら自動マージ（重大変更時のみ確認）。
  後続トラックはマージ後 main を `git pull --ff-only` で取り込んでから整合確認。
- 状態は本ファイルの表で更新していく。**分類が実態と違ったらその周回で直す。**

## 完了アーカイブ

過去フェーズの詳細は各ハンドオフに委譲する（本書には残さない — 陳腐化して誤誘導するため）。

| フェーズ | 範囲 | 記録 |
| --- | --- | --- |
| 初期 DAG / QR チェーン / 管理画面クラスタ / 受付拡張・UX | epic #82 / #96 / #119 とその子 issue | 全クローズ |
| platform console | epic #83（運用 ops は #290 へ切り出し） | `docs/platform-console-design.md` |
| 2026-07-02〜03 自律ループ | #264/#275/#273/#261/#289/#274/#299/#300/#303/#308/#284/#200 | クローズ済 |
| 2026-07-11 三層棚卸し → 07-12/13 消化 | #313〜#331・#342・#348 | `docs/handoff-2026-07-12.md` |
| 2026-07-19〜23 次世代 epic（第 1〜15 wave） | #360〜#377・#396・#405 ほか | `docs/handoff-2026-07-22.md` |
| 2026-07-27 統合再設計 #418 Wave 0〜2 + 検証基盤是正（第 16〜23 wave） | #425 クローズ / #419・#420 継続 / e2e 172-172 化 | **`docs/handoff-2026-07-27.md`** |
