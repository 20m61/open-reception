---
name: AI 提案 (AI Proposal)
about: AI が観測データから起こす改善提案。証拠と反証条件を必須にする。
title: '[AI Proposal] <何を実現するか>'
labels: ''
assignees: ''
---

<!--
docs/ai-development-loop.md の Diagnose / Propose フェーズ。

**証拠が無いものは Issue にしない。** 観測バックログに留める。Issue を増やすと
キューの分類が腐りやすくなり、次の周回が stale な分類を信じて作り直す。
-->

## Observation（観測した事実）

<!--
何を見てこの提案に至ったか。出どころを明記する:
KPI 指標名（docs/reception-experience-kpi.md）/ 監査ログ / 版の反映状況 /
コスト API / docs/gate-runs.md / 失敗した e2e・VRT / 該当コードのパスと行。
「〜だと思われる」ではなく、観測できた値・出力を書く。
-->

## Hypothesis（原因候補）

<!--
症状ではなく**原因候補**。複数あるなら並べて、それぞれに反証条件を付ける。
-->

## 反証条件（これが観測されたら仮説は誤り）

<!--
この欄が埋まらない提案は、検証ではなく思い込みになる。
-->

## 影響範囲

<!-- どの Actor / Journey / 画面 / API / テナントに及ぶか。及ばない範囲も書く。 -->

## Expected outcome / Metrics

- 期待する変化:
- 測るもの:
- 成功条件:
- 停止条件 / 未達時の扱い:

## Non-goals

## Architecture / security / privacy / cost impact

<!-- 契約・状態モデル・スキーマ・認可境界・secret/PII・継続費用。無ければ「なし」。 -->

## Rollback

## 提案する increment

<!--
1 Issue = 1 検証可能な仮説。大きいなら increment に割って、最初の 1 つを明示する。
既にあるものを作り直さないため、着手時に /issue-ac-mapping を通す前提で書く。
-->

## 受け入れ条件

- [ ]
- [ ]

## 人間承認が必要か（docs/ai-development-loop.md §6）

- [ ] 該当なし
- [ ] 本番デプロイ / 本番データ操作
- [ ] 認証・認可・PIN/IP 制御の境界変更
- [ ] 永続スキーマ・公開 API の非互換変更
- [ ] 新しい外部送信 / secret・PII・監査ログ方針の変更
- [ ] 継続的なコスト増 / 新規依存
- [ ] 主要 Journey・state・fallback の意味を変える仕様判断
