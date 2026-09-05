# CLAUDE.md — open-reception

iPad 受付端末向け無人受付システム（Next.js 16 / React 19 / TypeScript、AWS サーバーレス
= OpenNext + DynamoDB）。アーキテクチャ詳細は `src/ARCHITECTURE.md`。

## 開発ループ（重要）

Issue を消化するループで開発する。**手順は `docs/loop-workflow.md`、依存 DAG と並列
トラックは `docs/loop-queue.md` に従う。** 観測→仮説→検証→展開→計測というループ全体の
位置づけ・暴走防止ガード・人間承認が必要な変更の一覧は **`docs/ai-development-loop.md`**
（#424 / #426。未構築の部分も明記してある）。
1 周 = ブランチ → 実装(TDD) → 品質ゲート（`--pr`/`--full` はクラウド）→ PR → セルフ/コードレビュー →
**ゲート green + レビュー blocking なしなら自動で squash + `--delete-branch`** → Issue
クローズ → 次へ。**重大変更時のみユーザー確認**（破壊的変更・スキーマ/公開API・本番デプロイ・
外部送信・依存/ライセンス追加(#105)・secret/PII 取り扱い変更）。詳細は `docs/loop-workflow.md` 手順 8。

**並列オーケストレーション**: 依存のない Issue は git worktree（または
`isolation: "worktree"` のサブエージェント）で並行実装（同時 2〜3 トラック上限、同一
ファイルを触らせない）。依存チェーンは直列、**マージは直列**（上記の自動マージ条件で 1 本ずつ）。
調査/レビューは読み取り専用エージェントを並行 fan-out してよい。

## 品質ゲート（GitHub Actions を使わない方針）

CI は使わない。ゲートは **`./scripts/quality-gate.sh`** の実行で担保する（GitHub Actions では
なく、開発者の手元またはクラウド環境で走らせる。**どこで回すかは後述**）。

- `--fast` … typecheck + lint + unit（各変更ごと）
- `--pr`   … fast + build（**PR 前必須**）
- `--full` … + secrets(gitleaks) / sast(semgrep) / audit / e2e / lighthouse（マージ前・定期）
- 個別: `--secrets --sast --audit --e2e --lighthouse`、未導入ツールは SKIP（`--strict` で FAIL）

対応する npm scripts: `verify`(typecheck+lint+test+build) / `test` / `test:e2e` /
`lighthouse` / `secrets:scan` / `sast` / `audit:deps`。閾値は `docs/quality-gate.md`。

**ゲートは機械的に強制される**。PreToolUse フック `scripts/hooks/pr-gate-guard.sh` が
`gh pr create`（要 `--pr` 以上）/ `gh pr merge`（要 `--full`）を、現在の作業ツリーに対する
green 記録が無ければブロックする。記録はゲートが実際に検査したツリーに紐づくので、
**ゲート後に編集したら走らせ直す**。詳細は `docs/quality-gate.md`。

### どこで回すか: `--pr` / `--full` は**クラウド既定**（2026-08-08 決定）

ローカル macOS は 16GB を他プロジェクトと共有しており、相手が重いテストを回すと
**メモリ枯渇 → swap thrash** でゲートが完走できない。同じツリーの実測:

| ステップ | クラウド | ローカル macOS（load 350〜480） |
| --- | --- | --- |
| lint | 32s | 212s |
| unit (5115 tests) | **43s 全 PASS** | **377s ＋ 偽の赤** |

- **ローカルで回すのは `--fast` まで。** 実装・TDD の内側ループはローカルで回してよい
- **`--pr` / `--full` はクラウド routine へ委譲する。** ブランチを push し、
  `Skill` で `schedule` を呼んで一度限りの routine を作る（環境 ID は
  `env_014bqpK5jWNvBq6oU2qLtybs`）。手順と既知の罠は `docs/cloud-dev-environment.md`。
  **人がやること（web セッションの回し方・AWS の窓の開閉・環境の健康診断）は同 §0**
  🔴 **環境 ID を名前で探さない。** 2026-09-05 まで `open-reception` という名前の環境が
  **2 つ**存在し（旧 `env_012h7PiJKNb4EYzKRSuBwpX3` / 現 `env_014bqpK5jWNvBq6oU2qLtybs`）、
  設定を片方へ入れて別の方でセッションが動く事故が起きた（旧環境はアーカイブ済み。
  経緯と実測は `docs/cloud-dev-environment.md` §0-A / §0-G）
- 🔴 **PR 作成とマージまでクラウド内で完結させる。** ゲートスタンプは `.git` 配下の
  **ローカル記録**なので、クラウドで green を取ってもローカルの `gh pr merge` は
  フックにブロックされる。マージまで向こうでやらせれば持ち運びを考えずに済む
- routine 作成直後は**接続済み MCP コネクタが全部自動アタッチされる**（`mcp_connections: []`
  を送っても効かない）。**毎回 `clear_mcp_connections` で外すこと**
- squash マージ後の**ブランチは残る。クラウド側が消すことを当てにしない** — 2026-08-08 に
  **3 本連続で残り**、うち 1 本は「マージ後に削除せよ」と明示指示しても消えなかった
  （PR #653 / #654 / #655）。**ローカルの後始末として扱う**:
  `git push origin --delete <branch>` ＋ `git branch -D <branch>`（`-d` は squash なので失敗する）
- 🔴 **routine が PR を作らずに終わることがある。** 2026-08-03 の週次ゲートは記録を push した
  のに PR が無く、**FAIL が 5 日間 main に載らなかった**（#656）。**ブランチが出来たこと＝
  PR が出来たことではない**ので、委譲したら PR とマージまで実際に到達したかを確かめる。
  取りこぼしは `npm run evaluate:gate-runs` が `orphan_branch`（PR が 1 つも無いリモート
  ブランチ）として拾う。**ただし routine 側が失敗に気づく仕組みは未実装**（#656 の AC1/AC2）

**ローカル macOS でしかできないこと（クラウドへ出さない）**:

1. **darwin の VRT ベースライン** … `{platform}` 込みのファイル名なので linux から取り直せない
2. **デプロイ窓を開けること** … 短命 STS の発行（`scripts/aws-issue-credentials.sh`）だけが
   ローカル。デプロイ自体はクラウドから wrapper（`scripts/aws-cloud-deploy.sh`）経由で行う
   （`docs/runbook-cloud-aws-deploy.md`）。**2 は機械強制されている**（#675）——
   `scripts/hooks/guard-destructive.sh` が darwin 以外でブロックする。規則の正本は
   `src/domain/governance/execution-lane.ts`、一覧は `docs/cloud-dev-environment.md` §3.5。
   1 は機械強制していない（linux 側のベースライン更新はクラウドが正しい経路なので、
   コマンドだけでは区別できない）

ゲートが赤いとき、**コードを疑う前に資源を見る**。見るのは 2 つ:

1. **メモリ** … macOS の load average は CPU ではなく**メモリ枯渇**を映していることがある
   （`top -l 1` の `PhysMem` の空きと swapins。20% idle なのに load 480 という実例がある）
2. **ディスク** … クラウドは書き込み枠が有限。埋まると **e2e が
   `page.screenshot: Target crashed` と SSL ハンドシェイク失敗で落ちる**。
   2026-08-19、`/tmp/cdk.out*` が 740 個・26GB まで積もって 100% になり、
   メモリも load も正常なまま赤くなった（#721）。`df -h` を見る

`Test timed out in Nms` や `Target crashed` のように**アサーションに到達する前**に
落ちたものは、まず偽の赤を疑う。ゲートは末尾に「一時領域」の 1 行を出すので、
**まずそこを読む**（`docs/quality-gate.md`）。

## 規約

- パッケージマネージャ: **npm**（Node >=22）。
- コミット: Conventional Commits（日本語可）、本文末尾に Issue 参照。PR タイトル =
  squash 後の main コミットになるため必ず Conventional Commits で書く。
- マージ: squash + `--delete-branch`。ブランチ名 `<type>/<topic>`。
- **コミット署名**: ローカルは ssh 署名（repo-local `gpg.ssh.program=ssh-keygen`）。
  署名に失敗しても `--no-verify` で回避しない（鍵/エージェント側を直す）。
  **クラウドセッション（Claude Code on the web）のコミットは署名されない** — 署名鍵は
  サンドボックスに入らない。squash マージでブランチのコミットは破棄され、`main` に残る
  squash コミットは GitHub が署名するので履歴は verified のまま。よって
  **feature ブランチに「署名済みコミット必須」の保護を掛けないこと**（掛けるとクラウドから
  push できなくなる）。詳細は `docs/cloud-dev-environment.md`。

## 調査の作法

**結論を出す前に、検索条件そのものを疑う。** 2026-08-03 の周回で、検索の不備による誤報を
2 度出した（「トークン API が無認証の可能性」「更新系 30 route が未監査」— どちらも実際は
問題なし）。「見つからなかった」は「無い」ではなく「その条件では見つからなかった」でしかない。

- `rg --glob "*name*"` は**パスではなく basename** に効く。ディレクトリ名で絞るなら
  `--glob "**/name/**"`
- 識別子を `name(` と括弧付きで探すと、`nameSomething(` や `name<T>(` を取りこぼす
- 「本番消費者がゼロ」を主張するなら、テスト・型のみ import・doc コメントを除いた上で数える
- **`rg -r` は `--replace`**（再帰ではない。再帰は既定）。`scripts/hooks/guard-destructive.sh`
  がブロックする

否定的な結論（無い・使われていない・満たしていない）ほど、条件を変えて 2 通り以上で確かめる。

## 検証の作法

**自分で導いた述語をそのままテストにすると、テストとコードが同じ誤りを共有する。**
2026-08-25〜26 の #367 永続層で、独立レビュー 7 周に **BLOCKER 3 / MAJOR 14** が出た。
BLOCKER 3 件はすべて**直前の自分の修正が作った**もので、いずれも「どの段が timezone に
依るか」を段ごとに手で導き、その導出をそのままテストに書いていたことが原因だった。
既存テストが全部「既定 TZ の世界」を正解として書かれていたため、**行単位の変異検証では
原理的に検出できない**（私の変異は毎回 4〜9 件生存し、レビュー側の測定で 15〜9 件生存へ訂正された）。

- 分岐ごとの期待値ではなく、**満たすべき不変条件**を書く。上の例では
  「確定と報告した ⟹ 拠点 TZ と共通営業時間が何であっても state が一致する」を
  総当たりで縛った 1 本が、それまで 5 周見逃していた欠陥を両方とも落とした
- **不変条件は片側しか主張しない。** 「確定なら一致する」は全部を判定不能にすれば
  空虚に満たせる。**下界**（必ず確定側に居るもの）を併せて縛る
- **近似の緊さは fixture でしか縛れない。** 境界値を使った近似（範囲の両端で評価する等）は、
  境界の**すぐ内側**を踏む入力が無いと、境界を狭める変異が全部素通りする
- 変異は「分岐の入替え」に偏りやすい。**早期 return が後段を飲み込む**型と、
  **数値パラメータを狭める**型を必ず入れる
- テストの主張が**落ちた先に飲み込まれていないか**を見る。判定対象の選び方（どのサービス・
  どの既定値）次第で、実装をどう変えても緑のままになることがある
- 🔴 **仕様を足したら、既存の回帰テストが空虚に通るようになっていないか測る。**
  2026-08-26 の #788 で、**テストを強くする目的のコミットが既存の回帰テストを 1 本
  無力化した**。復唱確認を挟んだことで「喋る」と「確定する」が分離し、確定回数を数える
  オラクルが「2 度喋っても確定しなければ増えない」＝空虚に通る形になった。同じコミットは
  **同型の 2 本には対策を入れており、3 本目にだけ入れ忘れていた**。
  対策は 1 つだけ:**修正の前後で同じ変異を当て、kill が減っていないことを確かめる**。
  この型は「変更後に全部 green」では絶対に見えない。
- **測る作業は `git worktree` で隔離する**（品質ゲートのスタンプはツリーに紐づくので、
  並走すると mtime でゲートが落ちる。詳細は `.claude/rules/opus5-autonomous-loop.md`）
- 🔴 **緑を読むときは `flaky` を数える。** playwright の集計は `N passed` の隣に
  `M flaky` を出し、**retry で通れば exit 0** になる。失敗した試行は**アサーションに一度も
  到達していない**ので、その試行の変異検出力はゼロ。2026-08-26 の #787 で「290 passed」と
  報告したが flaky を含んでおり、並列干渉で 2/4 の確率で落ちる spec を緑と誤読した。
  **緑は「通った」ではなく「再試行を含めて最終的に通った」**である。
- 🔴 **flaky は「観測の取りこぼし」と「DOM に一度も出なかった」を区別してから直す。**
  retry で緑になる spec は「待ち方が脆い」ように見えるので、待ち方だけ直して閉じたくなる。
  #826 はまさにその形（2026-08-31 に修正）（5 回中 1 回 flaky・瞬時値を `toHaveAttribute` で待つ書き方）
  だったが、**MutationObserver で遷移の全列を記録したら `preTimeoutNotice` が一度も描画されて
  いなかった**。実装側の欠陥である —— 予告の保持が「呼び出し開始からの経過」起点だったため、
  レンダラが数百 ms 詰まると段階更新と遷移の dispatch が **1 コミットへ畳まれ**、来訪者への
  予告が飛んでいた（#323 AC3 の保証違反。画面にも痕跡が残らない）。
  **落ちた瞬間の値ではなく遷移の全列を記録してから読む。** 待ち方を直すのはその後でよい。
- 🔴 **e2e のためにしきい値を圧縮すると、実装の保証そのものが壊れることがある。**
  #826 の e2e は予告の保持を 5s → 300ms へ縮めていた。本番の窓では 5 秒以上詰まらないと
  起きない欠陥が、圧縮した窓では**数百 ms の詰まりで再現する**。圧縮した値で落ちたときは
  「テスト専用の都合」と決めつけず、**同じ欠陥が本番の窓でも起こりうるか**を先に問う。
- 🔴 **主修正とフォールバックを同じコミットで入れない。** フォールバックは主修正が壊れたときの
  症状を**大声の失敗から沈黙の誤動作へ変換する**。2026-08-26 の #787 で、フォーカス移動の
  主修正と「移動先が無ければ戻る導線へ」のフォールバックを同時に入れた結果、主修正を元へ
  戻す変異が **unit 28 本・e2e 285 本の全部を素通り**した（`not.toBe('BODY')` が発火しない）。
  主修正を先に縛ってから入れる。
- 🔴 **固定日付の fixture を実時刻の配線に食わせると time bomb になる。** 2026-08-31、
  `src/lib/checkin/shared-backend.test.ts` の `expiresAt: '2026-08-29'` が発火し、**main ごと
  ゲートが赤**になった（#833。無関係の PR #831 も巻き添えで止まった）。怖いのは落ちたこと
  ではなく、**隣のテストが空虚に通るようになっていた**ことである —— 期限切れは**テナントに
  関係なく** `resolve` を失敗させるので、「他テナントからは引けない」は境界を外す変異を
  当てても**生存した**（実測。相対時刻へ直すと同じ変異が kill される）。clock を注入できない
  本番配線（singleton）を叩くテストでは、日付は**必ず `Date.now()` 相対**で作る。上の
  「下界を併せて縛る」が効くのはまさにこの型で、**「引けない」だけを主張する assertion は
  全部が壊れた世界でも通る**。

## ガード

- 品質ゲート red のまま PR / マージしない。保護ブランチへ force-push しない。
- フロント bundle に secret / private key を含めない。個人情報は最小限・保存期間明示・
  監査ログ最小化。
- 外部依存追加時は #105 のライセンス/プライバシーチェック（SPDX / LICENSE / 商用可否）。
- 外部認証情報・実機・アセット前提のタスクは interface + mock 先行で実装し、実物が要る
  検証は #65 にスタックする。

## Claude Code 設定（`.claude/`）

- `settings.json`（**追跡・チーム共通**）… このワークフローが前提とするプラグイン
  （`enabledPlugins`）と、**ループが機械的に必要とするコマンド**の共有許可リストを宣言。
  大半は読み取り専用だが、`git worktree add/remove` や `git push origin --delete`（マージ後の
  ブランチ削除）のように**規約が実行を要求する書き込み系も入る** —— ここに無いと
  クラウドセッションが後始末を完了できない。個人固有の許可・env は各自の
  `settings.local.json`（gitignore 済）へ。`/fewer-permission-prompts` で追記可。
  🔴 **クラウドの `settings.local.json` はコンテナと一緒に消える。** 毎セッション効かせたい
  許可は**追跡側に入れる**こと（`docs/cloud-dev-environment.md`「引き継がれるもの」）。
- `agents/loop-track.md` … 並行トラック実装用の subagent（ループ規約を内蔵。`Agent` の
  `subagent_type: "loop-track"` + `isolation: "worktree"` で使う）。
- `rules/` … パススコープ付き制約（admin/platform API 認可、PII/secret 最小化、TDD）。
- `skills/loop-round` … `/loop-round`。**1 周の入口**（AC マッピング → ブランチ → TDD →
  ゲート → PR → マージ → 後始末）。**routine / web セッション / ローカルのどこで走っていても
  同じ手順**で、場所で変わる部分（回せるゲートの範囲・ブランチ削除）だけを明示する。
  委譲プロンプト生成器と同じコマンドを名指ししていることは
  `tests/config/loop-round-skill.test.ts` が縛る（散文が実測から遅れる型を機械で止める）。
- `skills/quality-gate` … `/quality-gate` で `scripts/quality-gate.sh` を起動する project skill。
- `skills/loop-retro` … `/loop-retro`。**外側ループの入口**（内側ループの実績を観測し、
  一般化できる教訓だけを `.claude/rules/opus5-autonomous-loop.md` へ反映して PR を出す）。
  内側が成果物を出すのに対し、こちらは**内側の質そのもの**を上げる。2〜3 週ごと、または
  同じ失敗を 3 回踏んだときに回す。点検は `npm run loop:retro`、台帳は `docs/loop-retro.md`。
  🔴 **周回の最中に回さない** — 教訓を失敗したその場で書くと、規約とコードが同じ誤りを
  共有する（「検証の作法」冒頭と同型）。
- `skills/issue-ac-mapping` … `/issue-ac-mapping`。**各周回の冒頭で必ず通す**。issue の AC を
  実コードへマッピングし、未充足の AC だけを increment 化する。キューの分類は仮説であって
  事実ではない（stale 分類による作り直し・不要な「外部待ち」判定を防ぐ）。

### Superpowers スキル活用

`superpowers`（公式マーケットプレイス、SessionStart で自動ロード）を導入済み。ループ各段は
対応スキルに素直に対応する。**新規に手順を再発明せず、これらを使う**:

- 実装(TDD) → `test-driven-development`（red→green→refactor を厳守）
- 並行トラック/worktree → `using-git-worktrees` ＋ `subagent-driven-development` ＋
  `dispatching-parallel-agents`（本 CLAUDE.md の並列オーケストレーション規約が上位）
- 不具合調査 → `systematic-debugging`
- PR 前/マージ前 → `verification-before-completion`（`scripts/quality-gate.sh` と併用）
- レビュー → `requesting-code-review` / `receiving-code-review`（`/code-review` と併用）
- 設計着手 → `brainstorming` / `writing-plans`（重大変更の前段で仕様を固める）
- 運用メモ: worktree 掃除は `git worktree list` の **全エントリ**（`../` や `/tmp` の外部
  worktree 含む）を撤去する。依存追加 PR のマージ後の lockfile ドリフトは
  `quality-gate.sh` の bootstrap が `npm ci` で自動同期する。
