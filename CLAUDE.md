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
  `env_012h7PiJKNb4EYzKRSuBwpX3`）。手順と既知の罠は `docs/cloud-dev-environment.md`
- 🔴 **PR 作成とマージまでクラウド内で完結させる。** ゲートスタンプは `.git` 配下の
  **ローカル記録**なので、クラウドで green を取ってもローカルの `gh pr merge` は
  フックにブロックされる。マージまで向こうでやらせれば持ち運びを考えずに済む
- routine 作成直後は**接続済み MCP コネクタが全部自動アタッチされる**（`mcp_connections: []`
  を送っても効かない）。**毎回 `clear_mcp_connections` で外すこと**
- squash マージ後の**ブランチは自動削除されない**。ローカルで
  `git push origin --delete <branch>` ＋ `git branch -D <branch>`（`-d` は squash なので失敗する）

**ローカル macOS でしかできないこと（クラウドへ出さない）**:

1. **darwin の VRT ベースライン** … `{platform}` 込みのファイル名なので linux から取り直せない
2. **AWS デプロイ** … 対話型 SSO がクラウドで通らない。元々**停止境界**でユーザー確認が要るため
   ループの自動化範囲は狭まらない

ゲートが赤いとき、**コードを疑う前に負荷を見る**。macOS の load average は CPU ではなく
**メモリ枯渇**を映していることがある（`top -l 1` の `PhysMem` の空きと swapins を見る。
20% idle なのに load 480 という実例がある）。`Test timed out in Nms` のように
**アサーションに到達する前**に落ちたものは、まず偽の赤を疑う。

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

## ガード

- 品質ゲート red のまま PR / マージしない。保護ブランチへ force-push しない。
- フロント bundle に secret / private key を含めない。個人情報は最小限・保存期間明示・
  監査ログ最小化。
- 外部依存追加時は #105 のライセンス/プライバシーチェック（SPDX / LICENSE / 商用可否）。
- 外部認証情報・実機・アセット前提のタスクは interface + mock 先行で実装し、実物が要る
  検証は #65 にスタックする。

## Claude Code 設定（`.claude/`）

- `settings.json`（**追跡・チーム共通**）… このワークフローが前提とするプラグイン
  （`enabledPlugins`）と、読み取り専用コマンドの共有許可リストを宣言。個人固有の許可・
  env は各自の `settings.local.json`（gitignore 済）へ。`/fewer-permission-prompts` で追記可。
- `agents/loop-track.md` … 並行トラック実装用の subagent（ループ規約を内蔵。`Agent` の
  `subagent_type: "loop-track"` + `isolation: "worktree"` で使う）。
- `rules/` … パススコープ付き制約（admin/platform API 認可、PII/secret 最小化、TDD）。
- `skills/quality-gate` … `/quality-gate` で `scripts/quality-gate.sh` を起動する project skill。
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
