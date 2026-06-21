# AI 案内 → 担当者/有人切替 設計 (issue #104)

AI 案内を「自由会話の主導線」ではなく、来訪者が迷ったときの **補助導線** として安全に扱い、
AI で解決できない/高リスクな場合に **担当者・部署・代表窓口・Vonage 通話などの既存導線へ確実に
引き継ぐ** ための設計。本書は increment 1 の設計と、後続増分（実 LLM 連携）への方針を記す。

商用 SaaS / OSS の UI・文言・画面構成・プロンプト・コードは流用せず、機能思想のみを参考にした
自前実装である（Epic #96 / #105 のライセンス・権利・個人情報方針に準拠）。

## 安全方針（不変条件）

1. **AI は補助。最終判断・実行は必ず有人/担当者を経由する。** AI は受付操作（呼び出し・通話
   発信・取り次ぎ）を **即時実行しない**。エスカレーションは必ず「引き継ぎ要求
   （`handoff_requested`）」状態を経由する。状態機械上、`guiding` から `handed_off`（実行完了）へ
   直接遷移するイベントは存在しない。
2. **引き継ぎの成否は人間導線（HandoffChannel）が決める。** AI は決めない。
3. **誤案内フォールバック。** 低信頼・スコープ外・NG ワードのときは AI 回答をそのまま見せず、
   担当者へ取り次ぐ。引き継ぎに失敗したら既存受付フロー/代替導線へ戻す。
4. **会話内容・PII を保持/送信/監査に残さない。** ドメインモデルは判断に必要な最小の計量値
   （確信度・連続失敗回数・最終やり取り時刻・エスカレーション理由種別）のみを持つ。LLM へ渡す
   入力は最小化し、来訪者メモ・担当者情報・氏名等を送らない（#105）。
5. **LLM は差し替え可能 adapter の背後に隔離する。** increment 1 は実 LLM を呼ばず mock のみ。

## 回答してよい範囲 / 禁止範囲

- 答えてよい: FAQ、施設案内、受付端末の操作案内（許可トピック `allowedTopics` のホワイトリスト）。
- 答えてはいけない: 許可トピック外（`outOfScope`）、本人確認、個人情報を要する判断、要注意/禁止語
  （NG ワード: 緊急・苦情・トラブル等）を含む相談。これらは全て有人へ切り替える。

## 状態機械

状態（`src/domain/ai-guidance/state.ts`）:

| 状態 | 意味 |
| --- | --- |
| `guiding` | AI が補助案内中（FAQ・受付操作案内）。 |
| `handoff_requested` | 引き継ぎ要求済み。担当者/有人の応答待ち（確認・取り次ぎ中）。 |
| `handed_off` | 担当者/有人へ確実に引き継がれた（終端）。 |
| `failed` | 引き継ぎ不能。代替導線へフォールバックさせる前段。 |

遷移:

```text
guiding
  ├─ REQUEST_HUMAN / LOW_CONFIDENCE / TIMEOUT / NG_WORD / REPEATED_FAILURE ─→ handoff_requested
handoff_requested
  ├─ HANDOFF_CONFIRMED ─→ handed_off (終端)
  └─ HANDOFF_FAILED   ─→ failed
failed
  └─ FALLBACK ─→ handed_off (既存受付フロー/代替導線へ戻して終端)
(全状態) RESET ─→ guiding (端末リセット)
```

エスカレーション系イベントはすべて `handoff_requested` に倒れる。`guiding` から実行完了へ飛ぶ
遷移が存在しないことで「AI 即時呼び出し禁止」を型と遷移表で保証する。

## エスカレーション条件

`src/domain/ai-guidance/session.ts` の `evaluateEscalation`（純関数）が判定。優先順位は安全側に倒す:

1. **ユーザー要求**（`user_request`）— 来訪者が明示的に担当者/有人を要求。最優先。
2. **NG ワード**（`ng_word`）— 要注意/禁止語を検知（検知語そのものは保持しない、真偽のみ）。
3. **低信頼**（`low_confidence`）— 確信度 < `policy.minConfidence`（既定 0.5）。
4. **連続失敗**（`repeated_failure`）— 未解決が `policy.maxRepeatedFailures`（既定 2）回連続。
5. **タイムアウト**（`timeout`）— 無応答が `policy.idleTimeoutMs`（既定 30s）超過（`isIdleTimeout`）。

`EscalationPolicy` はテナント別に上書きする前提の既定値を持つ。

## レイヤ構成

- `src/domain/ai-guidance/**`（純関数・副作用なし・LLM 非依存）
  - `state.ts`: 状態・イベント・遷移表・エスカレーション理由写像。
  - `session.ts`: セッションモデル、`EscalationPolicy`、`evaluateEscalation` / `applyTurn` /
    `isIdleTimeout` / `dispatch`。PII・会話を保持しない。
- `src/lib/ai-guidance/**`（オーケストレーション・差し替え可能 adapter）
  - `types.ts`: `GuidanceProvider`（LLM 差し替え interface）・`HandoffChannel`（有人導線
    interface）・最小入力 `GuidanceRequest`（PII 非含有）。
  - `mock.ts`: `MockGuidanceProvider` / `MockHandoffChannel`（決定的・実 LLM 非呼び出し）。
  - `orchestrator.ts`: `runGuidanceTurn`（provider 出力の計量値のみでエスカレーション判定、
    エスカレーション時は回答を破棄）・`performHandoff`・`finalizeFallback`。
- `src/components/kiosk/ai-guidance/AiGuidancePanel.tsx`（**スタンドアロン UI。KioskFlow へ未組込**）。

## 監査（PII・会話を残さない）

`src/domain/reception/log.ts` に追加（本トラックが log.ts 単独編集者）:

| AuditAction | 意味 | metadata |
| --- | --- | --- |
| `ai_guidance.escalated` | 引き継ぎ要求が出た | `reason`（エスカレーション理由種別のみ） |
| `ai_guidance.handoff` | 担当者/有人へ確実に引き継がれた | — |
| `ai_guidance.fallback` | 引き継ぎ失敗→代替導線へ戻した | — |

会話本文・確信度の生値・来訪者発話は監査に残さない。理由は種別 enum のみ。
監査画面（`src/app/admin/audit/page.tsx`）にラベルを追加。

## 管理画面での有効/無効（設計）

`EscalationPolicy` と AI 案内の有効/無効はテナント別設定として持つ前提。inc1 では既定値のみ
（永続化・設定 UI は後続増分）。AI 案内を無効化した場合は `guiding` に入らず従来のタッチ受付のみ
となる。

## ライセンス / 権利（#105）

- 実 LLM / TTS / STT / ナレッジベース採用時は利用規約・商用利用可否・データ取扱（学習利用可否）を
  確認し SPDX/利用条件を記録する。inc1 は外部依存を追加しない（mock のみ）。
- AI 生成文を固定文言として保存する場合の権利・責任範囲を確認する。
- 競合サービスの AI 受付シナリオ/プロンプト/文言を流用しない。

## increment 1 のスコープ / 後続増分

- inc1（本 PR）: 設計ドキュメント + 安全切替の中核モデル/状態機械（純関数）+ オーケストレーション
  interface + mock + スタンドアロン UI + 監査アクション + テスト。**実 LLM は呼ばない。**
- 後続: 実 LLM provider 実装（利用規約確認・入力最小化・PII マスク）、実 HandoffChannel（#88 通知
  ルート/担当者通知/Vonage/代表窓口接続）、KioskFlow への統合配線、テナント別ポリシー永続化と
  管理画面の有効/無効・閾値設定 UI、多言語案内（#103）との連携。

## 想定 nav 配線（本 PR 外）

- Kiosk: 既存タッチ受付を主導線に保ちつつ、「迷ったとき」の補助として `AiGuidancePanel` を提示。
  エスカレーション時は既存の担当者呼び出し/代替導線（fallback 状態）へ戻す。KioskFlow への実配線は
  後続増分。
- Admin: AI 案内の有効/無効・エスカレーション閾値設定ページ（後続増分）。監査ログに引き継ぎ証跡。
