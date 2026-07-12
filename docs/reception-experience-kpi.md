# 受付体験 KPI 定義 (issue #319)

受付体験の改善は計測から始める。本書は「30 秒到達・完遂率・ステップ別ファネル」等の KPI の
**分子/分母**を一意に定義し、集計コードと表示が同じ定義を共有できるようにする。

関連: #86 / `docs/admin-frontend-design.md`（ダッシュボード）, #284 / `docs/platform-console-design.md`
（テナント横断集計）, #19 / `docs/audit-logging.md`・`.claude/rules/pii-secret-minimization.md`
（PII 最小化）。

## 1. 計測データ（`ReceptionLog.experience`）

体験メトリクスは `ReceptionLog.experience`（`src/domain/reception/log.ts`、**optional**）に載る。
**PII は一切含まない**（所要 ms・回数・列挙値のみ。氏名/会社名/メモ/連絡先は持たない）。

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `stepDurations` | `Partial<Record<ExperienceStep, number>>` | ステップ別滞在所要 (ms)。入ったステップのみキーを持つ。 |
| `timeToCallMs` | `number` | 受付開始（START）→ 呼び出し確定（`calling` 遷移）までの所要 (ms)。 |
| `backCount` | `number` | 「戻る」操作の回数（やり直し量）。0 は省略。 |
| `cancelCount` | `number` | 「キャンセル」操作の回数。0 は省略。 |
| `inputMethod` | `'touch' \| 'stt' \| 'chat' \| 'qr'` | 主入力手段。 |
| `abandonedAtStep` | `ExperienceStep` | 無操作リセット/キャンセルで離脱した際の到達最終ステップ。完遂時は未設定。 |

`ExperienceStep` = `selectingPurpose → selectingTarget → inputVisitorInfo → confirming → calling → connected`
（`EXPERIENCE_STEP_ORDER`, `src/domain/reception/experience-summary.ts`）。

### 計測点（KioskFlow, `src/components/kiosk/KioskFlow.tsx`）

- **ステップ所要**: 状態遷移で各ステップ入りの時刻を記録し、次ステップ入り/確定で差分を積算する。
- **timeToCallMs**: `calling` へ遷移した時点で `START` からの経過を記録する。
- **backCount**: `EXPERIENCE_STEP_ORDER` 上でステップが後退した遷移を「戻る」として数える。
- **cancelCount**: `cancelled` 状態への遷移を数える。
- **inputMethod**: タッチ既定。音声候補採用で `stt`、チャットドロワー操作で `chat`。
- **abandonedAtStep**: 到達していた最終ステップ（離脱時のみ）。
- 計測は**非破壊**（受付フローの見た目・挙動を一切変えない）。

> **到達ステップの捕捉（無操作リセット/キャンセル）**: トラッカは最後に入ったステップを保持する。
> リセット/キャンセルで待機へ戻る際、その保持値が `abandonedAtStep` になる（＝どこまで進んだか）。

## 2. KPI 定義（分子/分母）

集計は純関数 `summarizeExperience(logs)`（`src/domain/reception/experience-summary.ts`）に集約する。
期間は呼び出し側が絞り込む（ダッシュボードは **本日 = JST 暦日**、#254 の `jstDayKey` と境界を揃える）。

### 2.1 30 秒以内 呼び出し開始率 `callStartWithin30sRate`

- **分子**: `experience.timeToCallMs <= 30000` の受付数（境界 30,000ms を含む）。
- **分母**: `experience.timeToCallMs` が記録されている受付数（＝呼び出しへ到達した受付）。
- 分母が 0 のとき `null`（未計測）。閾値は `CALL_START_TARGET_MS = 30_000`。

### 2.2 完遂率 `completionRate`

- **分子**: `outcome === 'connected'` の受付数。
- **分母**: 対象期間の全受付数（`experience` の有無に依らず `outcome` は常に存在するため全ログ）。
- 分母が 0 のとき `null`。

### 2.3 所要時間の中央値 `medianDurationMs`

- 対象期間の全受付の `durationMs` の**中央値**（偶数個は中央 2 値の平均）。対象 0 件で `null`。

### 2.4 ステップ別ファネル `funnel`

- `EXPERIENCE_STEP_ORDER` 順に、各ステップの `reached`（到達数）と `abandoned`（離脱数）を返す。
- **到達数**: そのログが「到達した最大ステップ」以下の各ステップに +1（単調非増加）。到達は
  `stepDurations` のキーと `abandonedAtStep` の和集合から判定する。
- **離脱数**: `abandonedAtStep` がそのステップに一致する受付数。
- 対象は `experience` を持つ受付のみ（`measured`）。**離脱が多いステップの特定**に使う。

### 2.5 入力手段の利用数 `inputMethods`

- `touch/stt/chat/qr` それぞれの件数（`experience` を持つ受付のみ）。STT/チャット/QR 利用率の把握用。

## 3. テナント横断集計（プラットフォーム, #284 拡張）

`summarizeExperienceAcrossTenants(entries)`（`src/domain/platform/console-summary.ts`）が、各テナントの
受付ログ（期間フィルタ済み・テナント境界保証済みを想定）から:

- `overall`: 全テナント合算の `ExperienceKpi`。
- `perTenant`: テナント別行（`measured` 降順 → テナント名昇順）。`callStartWithin30sRate` /
  `completionRate` / `medianDurationMs` を並べる。

テナント名は運用メタで PII ではない。来訪者 PII は一切含めない。

## 4. 表示

- テナント管理ダッシュボード `/admin/dashboard`: 「受付体験 KPI（本日）」セクション
  （`src/components/admin/dashboard/ExperienceKpiSection.tsx`）で 30 秒 KPI・完遂率・中央値・
  ステップ別ファネル・入力手段を表示する。管理画面ラベルは日本語のまま（kiosk 向けではないため
  i18n 対象外）。
- **期間指定**: 同じ `summarizeExperience` を任意期間で絞ったログへ適用して実現する
  （ストアの `listReceptionLogsSince` で境界取得）。既定表示は本日。任意期間ピッカー UI は次増分。

## 5. スコープと次増分

- 本増分（#319）: `experience` スキーマ（optional・PII-free）、計測（KioskFlow）、KPI 純関数と
  ダッシュボード表示、テナント横断サマリ、本 KPI 定義。呼び出し到達時に `experience` を作成 API へ
  同送する（現サーバは未知フィールドとして無視。**非破壊・前方互換**）。
- **次増分**: サーバ側での `experience` 永続化（作成 API/セッション/`deriveReceptionLog` は
  optional 引数受け入れ済み）。呼び出しへ到達しない**離脱受付**（用件/担当選択・入力・確認での
  無操作リセット/キャンセル）は現状サーバレコードが無いため、専用の軽量テレメトリ経路
  （sendBeacon 等）で `abandonedAtStep` を含めて収集する。任意期間ピッカー UI。QR 受付
  （CheckinFlow）の `inputMethod='qr'` 計測。
