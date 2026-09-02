# Agent Operating Profile — Claude Opus 5

既存の Issue ループ、品質ゲート、重大変更の人間確認を維持しつつ、Opus 5 で過剰になりやすい並列委譲と重複レビューを抑える。

> 🔴 **重なる項目の正本はここではない。** 本書は 2026-07-27 に書かれ、
> `.claude/rules/opus5-autonomous-loop.md`（版管理あり・`/loop-retro` が実データから更新する）
> より前に成立している。**モデル役割・レビューの停止条件・停止境界・完了証拠は同規約が正本**で、
> 食い違ったら規約が勝つ。
>
> 本書が固有に持つのは **completion contract の記法**（`objective` / `acceptance_criteria` /
> `owned_files` / `execution_profile` / `human_gate` / `delegation_budget` / `stop_conditions`）と、
> **プロファイル別の委譲予算**である。規約側にこの語彙は無い（実測）。
>
> 「指示が 2 箇所にあると古い方が残って発火する」は本リポジトリが繰り返し踏んでいる型なので、
> この注記を外さないこと。

## Completion contract

各トラック開始時に一度だけ確定する。

```yaml
objective:
acceptance_criteria: []
non_goals: []
invariants: []
owned_files: []
required_gates: []
execution_profile: medium
human_gate: none
delegation_budget: 0
stop_conditions: []
```

## Execution routing

- `low`: 文言、設定、局所修正。サブエージェント 0。
- `medium`: 通常 Issue。メインエージェントが調査、計画、実装、レビューを完結。原則 0。
- `high`: 複数領域または非自明な設計。独立調査または専門レビューを最大 1。
- `xhigh`: 大規模再設計。書き込みトラックは、所有ファイルが完全分離できる場合のみ最大 2。

## Delegation rules

- Issue 着手時の Explore + Plan の常時 fan-out は行わない。
- code-reviewer + silent-failure-hunter の常時並列実行は行わない。
- 数回のツール操作で完了する作業、自己検証だけの委譲は禁止。
- 複数 Issue を並列化する場合は依存なし、共有ファイルなし、マージ直列を満たすこと。
- 機微パス、外部依存、ライセンス、PII、認証・認可のみ専門レビューを追加する。

## Review profile

通常レビューは Opus 5 本体が二段階で行う。

1. 問題候補を広く抽出する。
2. 影響度、再現性、確信度で blocking / warning / suggestion に分類する。

blocking を修正後、変更に対応する `scripts/quality-gate.sh` を再実行する。モデルへの念押しは品質ゲートの代替にしない。

## Required gates

- 通常 PR: `./scripts/quality-gate.sh --pr`
- UI / a11y: `--e2e --lighthouse`
- 依存・セキュリティ: `--secrets --sast --audit`
- マージ前または定期: `--full`

ゲートを弱める、skip を隠す、別 worktree を誤って検証することは禁止。

## Human gates

既存 `docs/loop-workflow.md` の重大変更条件を維持する。破壊的 schema / public API / migration、本番 deploy、外部送信、依存・ライセンス追加、secret / PII、認証・認可境界は人間確認前にマージしない。

## PR evidence

PR 本文へ次を記録する。

```text
Execution profile: medium
Delegated agents: 0
Review profile: standard
Human gate: none
Quality gates: ./scripts/quality-gate.sh --pr
```
