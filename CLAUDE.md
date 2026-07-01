# CLAUDE.md — open-reception

iPad 受付端末向け無人受付システム（Next.js 16 / React 19 / TypeScript、AWS サーバーレス
= OpenNext + DynamoDB）。アーキテクチャ詳細は `src/ARCHITECTURE.md`。

## 開発ループ（重要）

Issue を消化するループで開発する。**手順は `docs/loop-workflow.md`、依存 DAG と並列
トラックは `docs/loop-queue.md` に従う。**
1 周 = ブランチ → 実装(TDD) → ローカル品質ゲート → PR → セルフ/コードレビュー →
**ゲート green + レビュー blocking なしなら自動で squash + `--delete-branch`** → Issue
クローズ → 次へ。**重大変更時のみユーザー確認**（破壊的変更・スキーマ/公開API・本番デプロイ・
外部送信・依存/ライセンス追加(#105)・secret/PII 取り扱い変更）。詳細は `docs/loop-workflow.md` 手順 8。

**並列オーケストレーション**: 依存のない Issue は git worktree（または
`isolation: "worktree"` のサブエージェント）で並行実装（同時 2〜3 トラック上限、同一
ファイルを触らせない）。依存チェーンは直列、**マージは直列**（上記の自動マージ条件で 1 本ずつ）。
調査/レビューは読み取り専用エージェントを並行 fan-out してよい。

## 品質ゲート（GitHub Actions を使わない方針）

CI は使わない。ゲートは **`./scripts/quality-gate.sh`** をローカル実行して担保する。

- `--fast` … typecheck + lint + unit（各変更ごと）
- `--pr`   … fast + build（**PR 前必須**）
- `--full` … + secrets(gitleaks) / sast(semgrep) / audit / e2e / lighthouse（マージ前・定期）
- 個別: `--secrets --sast --audit --e2e --lighthouse`、未導入ツールは SKIP（`--strict` で FAIL）

対応する npm scripts: `verify`(typecheck+lint+test+build) / `test` / `test:e2e` /
`lighthouse` / `secrets:scan` / `sast` / `audit:deps`。閾値は `docs/quality-gate.md`。

## 規約

- パッケージマネージャ: **npm**（Node >=22）。
- コミット: Conventional Commits（日本語可）、本文末尾に Issue 参照。PR タイトル =
  squash 後の main コミットになるため必ず Conventional Commits で書く。
- マージ: squash + `--delete-branch`。ブランチ名 `<type>/<topic>`。
- **コミット署名**: 1Password `op-ssh-sign`。ロック中は commit が署名失敗で止まる →
  アンロックして再実行（`--no-verify` で回避しない）。

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
