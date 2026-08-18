---
name: loop-round
description: Issue を 1 周する（AC マッピング → ブランチ → TDD → 品質ゲート → PR → マージ → 後始末）。routine セッション・claude.ai/code の web セッション・ローカル macOS のどこで走っていても同じ手順で、場所によって変わる部分だけを明示する。Use when starting a loop round on an issue, or when asked to implement/fix an issue end to end.
---

# loop-round

**1 Issue（または increment）= 1 周**。正本は `docs/loop-workflow.md` で、ここはそれを
**どこで走っていても同じ形で実行するための入口**。

## 0. まず、自分がどこに居るかを確かめる

```bash
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && echo "クラウド（web セッション or routine）" || echo "ローカル macOS"
```

判定は `scripts/install_pkgs.sh` と同じ signal を使う。**変わるのはここだけ**:

| | クラウド（web / routine） | ローカル macOS |
| --- | --- | --- |
| 回せるゲート | `--fast` / `--pr` / `--full` **全部** | **`--fast` まで**（メモリを他プロジェクトと共有しており、`--full` は完走しないことがある） |
| PR 作成 | `npx tsx scripts/create-pull-request.ts` | 同左（ローカルでは通常ここまで来ない） |
| マージ | `npx tsx scripts/merge-pull-request.ts --number <n>` | 同左 |
| ブランチ削除 | **できない**（proxy が write を拒否する） | **ここでやる** |
| `--pr` / `--full` が要るとき | その場で回す | **クラウドへ委譲する**（§5） |

🔴 **`gh pr create` / `gh pr merge` を使わない。** routine セッションでは GraphQL の
repo info preamble が 403 になる（#678 / #702 で実測）。web セッションでの挙動は未検証だが、
**REST 経路（上の 2 スクリプト）はどちらでも動く**ので迷わずそちらを使う。判別したい場合は
`docs/cloud-dev-environment.md` §0-E の 1 行。

## 1. AC を実コードへマッピングする（**省略しない**）

`issue-ac-mapping` スキルに従う。issue 本文と `docs/loop-queue.md` の分類は**仮説**であって
事実ではない。**6 回**、既に main に在るものを作り直しかけた。

## 2. ブランチを切る

`<type>/<topic>`（Conventional Commits の type）。`git switch -c feat/<topic>`

## 3. 実装（TDD）

`test-driven-development` に従う。red → green → refactor。

- 内側ループは `npx vitest run <path>`（0.3〜1s）。`npm test` の 95s を毎回払わない
- **書いたテストは必ず変異させる**（通って当然のテストを書いた前科がある）
- **`vitest` は型検査をしない。** ゲート前に `npm run --silent typecheck` を単体で通す
  （root と `infra/` は別々）

## 4. ゲート

```bash
./scripts/quality-gate.sh --fast   # 各変更ごと
./scripts/quality-gate.sh --pr     # PR 前（クラウド）
./scripts/quality-gate.sh --full   # マージ前（クラウド）
```

- **要約の緑だけを信じない。** log 本文で実際に走ったコマンド行を見る。infra の `Tests` 行が
  skip を含むなら偽の green
- 赤いとき、**コードを疑う前に負荷を見る**（`uptime` / `top -l 1` の `PhysMem`）。
  `Test timed out in Nms` は**アサーションに到達する前**に落ちたもので、まず偽の赤を疑う

## 5. ローカルに居て `--pr` / `--full` が要るとき（委譲）

```bash
npx tsx scripts/delegate-gate-prompt.ts <spec.json>   # 委譲プロンプトを生成（手書きしない）
```

`RemoteTrigger` で `run_once_at` を 2〜4 分後に置いた one-shot routine を作り、**直後に
`clear_mcp_connections`**（MCP コネクタが全部自動アタッチされる）。`run` は使わない（二重発火）。

**クラウドでしか確かめられない検証**は `extraVerification` に入れる。

## 6. PR とマージ

```bash
npx tsx scripts/create-pull-request.ts --head "$(git branch --show-current)" --base main \
  --title "<Conventional Commits>" --body "<本文>"
npx tsx scripts/merge-pull-request.ts --number <番号>
```

どちらも**作成／マージの直後に REST で引き直して確認する**。PR 本文には必ず:
ゲート結果（summary そのまま）/ 人間承認が必要な変更の有無 / `Refs #<N>`。

🔴 **「ブランチが出来た」は「PR が出来た」ではない。** #656 はこれで FAIL の記録を
5 日間失った。**`worker_status: idle` も「終わった」ではない** —— PR とマージの実物を見る。

## 7. 後始末とクローズ

```bash
git switch main && git pull --ff-only
git push origin --delete <branch> && git branch -D <branch>   # ローカル macOS で
```

Issue は**根拠つきで**クローズする（どの PR のどの実測で充足したか）。

## 止まるところ（人間承認）

本番デプロイ / 認可・PIN・IP 境界 / DynamoDB 非互換変更 / 外部送信の**本番配線** /
secret・PII・監査ログ方針 / 新規依存 / 継続的な AWS 費用増 / 主要 Journey の意味変更。
判断基準は `.claude/rules/opus5-autonomous-loop.md`。
