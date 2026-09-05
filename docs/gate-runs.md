# 品質ゲート `--full` 実行記録 (#318)

`./scripts/quality-gate.sh --full --strict` の**定期実行**結果を記録するファイル。
方式・記録フォーマット・FAIL 時ハンドリングの詳細は `docs/quality-gate.md` の
「定期運用（`--full`、#318）」節を参照。

- 追記は **append-only**（既存行の書き換え・削除はしない。履歴として残す）。
- `scripts/record-gate-run.sh`（任意）を使うと実行〜追記までを自動化できる。手動追記の
  場合も下記と同じ列で 1 行追加する。

## 記録フォーマット

| 列 | 内容 |
| --- | --- |
| 日時 (UTC) | 実行開始時刻。`date -u +"%Y-%m-%dT%H:%MZ"` |
| コミット SHA | 実行時の `git rev-parse --short HEAD` |
| tier | 通常は `full`（定期実行は `--strict` 併用が必須） |
| 結果 | `PASS` / `FAIL` |
| SKIP 項目 | 未導入ツール等で SKIP になった項目。`--strict` 下では SKIP=FAIL 扱いのため通常発生しない |
| 起票 Issue / 備考 | FAIL 時の issue 番号、ツール追従作業のメモ等 |

## 実行記録

| 日時 (UTC) | コミット SHA | tier | 結果 | SKIP 項目 | 起票 Issue / 備考 |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05T09:00Z | `abcdef1` | full | PASS | なし | **EXAMPLE 行**（実データではない。実運用の最初の行はこの下に追記する） |
| 2026-07-31T19:22Z | `ba60889` | full | FAIL | なし | 要 issue 起票（docs/quality-gate.md の FAIL 時ハンドリング参照） |
| 2026-07-31T22:58Z | `3bc6f50` | full | PASS | なし | semgrep 導入済みで再実行し green を確認（#545 クローズ） |
| 2026-08-03T00:01Z | `8fe2756` | full | FAIL | なし | 🔴 **原因未記録**。週次 routine はこの行を `chore/gate-run-20260803` に commit したが **PR を作らなかった**ため、記録が 5 日間 main に載らなかった（2026-08-08 のブランチ棚卸しで発見し、本 PR で回収）。失敗内容は routine のセッションログにしか残っておらず復元できない。追跡: #656 |
| 2026-08-10T00:04Z | `b5c4529` | full | FAIL | infra WebStack synth  (.open-next/ が未ビルド（不足: open-next.output.json, assets, server-functions/default/index.mjs, image-optimization-function/index.mjs）— `npm run build:open-next` で作成) | ビルド前提の欠落であって退行ではない。**#677 で解消**（ゲート自身が `.open-next/` をビルドして復旧するようにした / PR #701）。この実行では `--publish` の `gh pr create` も GraphQL 403 で落ちており、記録は push 済みなのに PR が無い状態になった → **#678 で解消**（PR 作成を REST 化 / PR #701）。本 PR はそのとき手動で作成したもの |
| 2026-08-27T23:50Z | `0425a658` | full | PASS | なし | 自動記録（record-gate-run.sh） |
| 2026-09-05T07:26Z | `b28c425` | full | PASS | なし | 自動記録（record-gate-run.sh） |
