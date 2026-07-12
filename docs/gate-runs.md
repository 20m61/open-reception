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
