---
name: quality-gate
description: Run the open-reception local quality gate (scripts/quality-gate.sh). Use before a PR (--pr), before a merge (--full), or for a fast check during work (--fast). This project uses NO GitHub Actions CI — this local gate is the sole gate.
---

# quality-gate

このプロジェクトは CI（GitHub Actions）を使わない。品質は
`./scripts/quality-gate.sh` のローカル実行で担保する。閾値は `docs/quality-gate.md`。

## 使い方

引数（`$ARGUMENTS`）でモードを選ぶ。指定が無ければ用途を確認して選ぶ。

- `--fast` … typecheck + lint + unit（各変更ごとの素早い確認）
- `--pr` … fast + build（**PR 前必須**）
- `--full` … + secrets(gitleaks) / sast(semgrep) / audit / e2e / lighthouse（**マージ前・定期**）
- 個別: `--secrets` `--sast` `--audit` `--e2e` `--lighthouse`（未導入ツールは SKIP、`--strict` で FAIL）

## 手順

1. 目的に応じてモードを決める（作業中=`--fast` / PR 前=`--pr` / マージ前=`--full`）。
2. リポジトリルートで実行する:
   ```bash
   ./scripts/quality-gate.sh <mode>
   ```
3. **red のまま PR/マージしない**。失敗は出力そのまま報告し、原因を潰してから再実行する。
4. マージ前は `--full`（`feedback: merge-gate`）。e2e は本番ビルド再利用のため、
   コード変更後は再ビルドしてから走らせる（stale を踏まない）。

## 注意

- fresh worktree は `node_modules` が無いが、スクリプト冒頭の bootstrap が `npm ci` で自己修復する。
- 本開発機（macOS 13 Intel Tier3）は Playwright WebKit 非対応。iPad/WebKit e2e は #65 にスタック。
- lighthouse のローカル計測が NO_NAVSTART で不能な場合、perf 検証は live URL に委譲する。
- superpowers の `verification-before-completion` と併用し、「done」と言う前に本ゲートを通す。
