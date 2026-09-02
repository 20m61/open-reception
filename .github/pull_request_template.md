<!--
PR タイトルは squash 後の main コミットになります。Conventional Commits（日本語可）で。
  例: feat(reservation): 来訪予約ドメインと QR トークン発行 (#97)

ループ全体の位置づけ・停止境界は docs/ai-development-loop.md（#424）。
-->

## 概要

<!-- 何を・なぜ。1〜3 行。 -->

<!--
受入条件を**すべて**満たしたときだけ Closes。一部なら Refs にする
（満たしていない issue を自動クローズさせない）。
-->

Closes #<ISSUE>

## 仮説

<!--
1 PR = 1 検証可能な仮説。「何がどうなると期待するのか」を 1〜2 行。
リファクタ・文書のみで挙動不変なら「挙動不変（〜を〜へ寄せる）」と書く。
-->

## 変更点

-
-

## 受け入れ条件（Issue から転記）

- [ ]
- [ ]

## 計測 / 成功・停止条件

<!--
挙動を変える PR は必須。何で測るか（docs/reception-experience-kpi.md の指標名 /
監査ログ / コスト / ゲート結果）と、未達なら何をするか。
挙動不変なら「計測不要（挙動不変）」と明記する。
-->

- 測るもの:
- 成功条件:
- 停止条件 / 未達時の扱い:

## リスクと戻し方

<!--
rollback の単位は「移行フラグを戻す」「版を publish し直す」「この PR を revert する」等。
破壊的変更なら docs/product-integration-plan.md §9 Breaking-change register へ登録する。
-->

- 影響範囲（変えたもの / **変えていないもの**）:
- ロールバック手順:
- 1 周回の変更量が目安（`quality-gate.sh` の `loop halt / 変更量` が報告）を超えた場合、
  **分割しない理由**:

## 品質ゲート（GitHub Actions 不使用 / ローカル実行）

- [ ] `./scripts/quality-gate.sh --pr` が green（typecheck / lint / unit / build）
- [ ] マージ前に `--full` が green（`scripts/hooks/pr-gate-guard.sh` が機械的に要求する）
- [ ] 影響範囲に応じて追加ゲートを実行（該当のみチェック）
  - [ ] `--secrets`（秘密情報・gitleaks）
  - [ ] `--sast` / `--audit`（依存・SAST）
  - [ ] `--e2e` / `--lighthouse`（UI / a11y / パフォーマンス）
- [ ] VRT が差分を出した場合、**ベースラインを更新する前に差分画像と実物を見た**
      （閾値内でも実物を見る。`maxDiffPixelRatio` に本物の崩れが隠れた実例あり）
- [ ] セルフレビュー実施（必要に応じて code-reviewer / silent-failure-hunter）

## 基準文書 / ADR

- 参照した基準文書または ADR:
- [ ] 設計・契約・状態モデルを変えた場合、該当文書を**この PR で**更新した
      （`docs/adr/` / `docs/experience/README.md` / `docs/reception-ux-contract.md` /
      `docs/product-integration-plan.md` / `docs/loop-queue.md` の該当行）
- [ ] 覆すのに実装のやり直しが要る決定・コスト構造を変える決定は ADR を起こした
      （基準は `docs/adr/README.md`）

## セキュリティ / プライバシー / ライセンス

- [ ] フロント bundle に secret / private key を含めていない
- [ ] 個人情報は必要最小限・保存期間明示・監査ログ最小化
- [ ] 外部依存を追加した場合、#105 のライセンス/プライバシーチェックを通した
      （SPDX / LICENSE / 商用利用可否）

## 人間承認が必要な変更（該当すればマージ前に確認する）

<!-- docs/ai-development-loop.md §6 / .claude/rules/opus5-autonomous-loop.md の停止境界 -->

- [ ] 該当なし
- [ ] 本番デプロイ / 本番データ操作
- [ ] 認証・認可・PIN/IP 制御の境界変更
- [ ] 永続スキーマ・公開 API の非互換変更
- [ ] 新しい外部送信 / secret・PII・監査ログ方針の変更
- [ ] 継続的なコスト増 / 新規依存
- [ ] 主要 Journey・state・fallback の意味を変える仕様判断（状態を到達不能にする変更を含む）

## 補足 / スクショ / 残課題

<!-- 外部リソース待ちで未検証の点があれば #65 へのスタックを明記 -->
