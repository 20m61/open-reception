---
name: visual-checks
description: Run the repo's real-browser verification scripts (scripts/*-check.mjs) for kiosk / VRM / signage / demo-studio / QR routing UI. Use when a UI change needs confirmation in an actual browser beyond unit tests and Playwright E2E, when reviewing kiosk visuals, or when recording a ui-review-*.md. These scripts are NOT wired into package.json or quality-gate.sh, so they are invisible unless this skill points at them.
---

# visual-checks

`scripts/*-check.mjs` は各 wave の UI を**実ブラウザ**（Playwright chromium を直接
起動）で検証する使い捨てスクリプト群。`npm run` にも `quality-gate.sh` にも紐づいて
いないため、存在自体が忘れられやすい。UI 変更の目視確認・`docs/ui-review-*.md` の
記録を作るときはここから選ぶ。

## 前提

いずれも **稼働中の本番ビルド** に対して実行する（E2E と同じ流儀。コード変更後は
再ビルドしないと stale を踏む）。

```bash
npm run build
PORT=3100 RECEPTION_DISABLE_DEV_SEED=1 npm run start   # 別シェルで起動したまま
```

スクリプト側の既定 baseURL は `http://127.0.0.1:3100`、出力先は各スクリプトの既定
ディレクトリ。**両方とも引数で明示するのが安全**:

```bash
node scripts/<name>.mjs http://127.0.0.1:3100 /tmp/<name>-shots
```

各スクリプトは `PASS` / `FAIL` を 1 行ずつ標準出力に出す。**FAIL 行はそのまま報告する**
（要約しない）。スクリーンショットは出力ディレクトリに残るので、Read で実際に見る。

## スクリプト一覧

| スクリプト | 対象 | 関連 issue |
| --- | --- | --- |
| `kiosk-visual-check.mjs` | ATTRACT 遷移 / presence 検知 / サイネージ投入（iPad viewport・fake camera） | #362 |
| `vrm-visual-check.mjs` | VRM 実描画・状態別表示・`.vrma` 再生 | #31 / #65 |
| `kiosk-landscape-check.mjs` | Character-led レイアウト（横向き iPad 1080x810） | #361 |
| `demo-studio-check.mjs` | Demo Harness（スタジオ表示・9 シナリオ・iframe 内 Kiosk） | #363 |
| `qr-routing-check.mjs` | QR シェル / ルートビルダー | #361 / #374 |

## 注意

- `kiosk-visual-check.mjs` は `--use-fake-device-for-media-stream` /
  `--use-fake-ui-for-media-stream` を付けた chromium が要る（スクリプト内で指定済み）。
  fake camera の映像は動き続けるため、「無操作でタイムアウトする」系の検証は
  スクリプトのコメントに従うこと。
- `vrm-visual-check.mjs` は `--enable-unsafe-swiftshader`（本開発機に GPU が無いため）と
  `sharp` に依存する。
- 本開発機（macOS 13 / Intel Tier3）は **Playwright WebKit 非対応**。実機 iPad / WebKit の
  確認は #65 にスタックする。
- 検証結果を残すときは `docs/ui-review-<日付>.md` に PASS/FAIL 内訳付きで追記する
  （前例: `docs/ui-review-2026-07-22.md`）。
- これらは恒久 E2E の代替ではない。繰り返し必要になった検証は
  `tests/e2e/` の Playwright テストに昇格させ、`quality-gate.sh --full` に載せる。
