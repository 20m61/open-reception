---
name: 改善 / 機能 (Improvement)
about: 観測または要求から起こす改善・機能追加。証拠と成功条件を必須にする。
title: '[<領域>] <何を実現するか>'
labels: ''
assignees: ''
---

<!--
ループ全体の位置づけは docs/ai-development-loop.md（#424）。
着手時は /issue-ac-mapping で受入条件を実コードへ突き合わせること
（本文の「未実装」は仮説であって事実ではない。過去 5 回 stale だった）。
-->

## Problem statement

<!-- 誰が何に困っているか。解決策ではなく問題を書く。 -->

## Evidence

<!--
証拠。KPI 指標名（docs/reception-experience-kpi.md）/ 監査ログ / ゲート結果 /
再現手順 / 該当コードのパスと行。**証拠が無いものは Issue 化しない**（観測バックログへ）。
-->

## Affected users

<!-- Actor（来訪者 / 受付運用者 / テナント管理者 / platform developer）。 -->

## Expected outcome

<!-- 何がどうなれば解決か。観測可能な形で。 -->

## Non-goals

<!-- やらないこと。スコープが広がるのを防ぐ。 -->

## Architecture impact

<!--
契約・状態モデル・永続スキーマ・公開 API に触れるか。
覆すのに実装のやり直しが要る決定・コスト構造を変える決定は ADR を起こす
（基準は docs/adr/README.md）。
-->

## Security / privacy / cost impact

<!--
secret・PII・監査ログ・認可境界・継続費用への影響。
無ければ「なし」と書く（空欄にしない）。
-->

## Rollback

<!-- 撤回の単位（移行フラグ / 版の再 publish / revert）と撤回条件。 -->

## Metrics（成功条件・停止条件）

- 測るもの:
- 成功条件:
- 停止条件 / 未達時の扱い:

## 体験設計（来訪者・運用者向けの変更のみ）

<!--
docs/experience/README.md が正本。.claude/rules/opus5-autonomous-loop.md の Experience loop。
該当しない場合はこの節を削除する。
-->

- Actor / user outcome:
- 関連 Journey ID と step:
- entry / exit / exception state:
- 音声とタッチの等価性:
- 表示される応答と読み上げられる応答:
- timeout / cancel / fallback:
- PII / 監査への影響:
- 評価層と対象デバイス・ブラウザ:

## 受け入れ条件

<!-- チェック可能な粒度で。実装タスクではなく「何が満たされれば完了か」。 -->

- [ ]
- [ ]

## 人間承認が必要か（docs/ai-development-loop.md §6）

- [ ] 該当なし
- [ ] 本番デプロイ / 本番データ操作
- [ ] 認証・認可・PIN/IP 制御の境界変更
- [ ] 永続スキーマ・公開 API の非互換変更
- [ ] 新しい外部送信 / secret・PII・監査ログ方針の変更
- [ ] 継続的なコスト増 / 新規依存（#105 のライセンス・プライバシーチェック）
- [ ] 主要 Journey・state・fallback の意味を変える仕様判断
