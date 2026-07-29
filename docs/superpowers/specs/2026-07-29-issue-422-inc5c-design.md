# #422 inc5-c 設計: ステッパー廃止・領域整理・VRM 主体化

2026-07-29 策定。ユーザー承認済み。#422 の受入条件のうち inc5-b（配線）で残った 4 項目を扱う。

前提は [`docs/handoff-2026-07-29.md`](../../handoff-2026-07-29.md)、体験設計の正本は
[`docs/experience/README.md`](../../experience/README.md)。

## 1. 着手前の AC マッピング

4 つの AC のうち 1 つは既に充足していた。

| AC | 実態 | 根拠 |
| --- | --- | --- |
| iPad landscape を基準 viewport とし portrait / large display を派生プロファイル化 | **充足** | #361 で横向きは 35%/65% レールで全受付ステップにアバターを継続表示し、縦向きが `PORTRAIT_COMPANION_STATES` に限定される派生側になっている（`KioskFlow.tsx` の `showAvatarCompanion`） |
| VRM を pointer-events:none の装飾ではなく対話状態の主要表現として統合 | **部分** | 表情は既に VRM へ適用済み（`avatar/vrm-expression.ts` → `AvatarGuide` → viewer）。**未適用は `gazeTarget` だけ** |
| 常設要素を原則「案内・回答対象・ヘルプ」の 3 領域以内へ整理 | **部分** | 領域数は満たすが、ヘルプ相当に 4 要素（逃げ道バー・チャット・言語切替・退館リンク）が同居。ただし言語切替と退館リンクは待機画面のみ |
| ステッパーを廃止または最小化 | **未着手** | `FlowStepper` が入力系 4 状態で表示中 |

## 2. スコープ

| やる | やらない | 理由 |
| --- | --- | --- |
| ステッパー廃止 | レイアウト（35%/65% レール）の変更 | 既に landscape 基準。触ると VRT を全面的に取り直すことになる |
| 字幕に位置づけの文脈を持たせる（5 locale） | アバターの `aria-hidden` 解除 | 読み上げは字幕要素が担う。二重読み上げを作らない |
| `gazeTarget` を VRM へ実適用 | VRT ベースラインの全面取り直し | 変わる画面だけ更新する |
| 常設要素の領域帰属を宣言し、領域外を増やせなくする | ヘルプ要素の物理的統合 | 逃げ道の**常時可視**は #325 の設計意図。メニューへ畳むと後退導線が 1 タップ遠のく |

## 3. 増分 1: ステッパー廃止 + 字幕の文脈化

### 変更

- `FlowStepper.tsx` と `FlowStepper.test.ts` を削除し、`KioskFlow.tsx` の描画を外す。
  関連 i18n キー（`reception.step.*`）も辞書から落とす。
- `avatar/guidance.ts` の短文に位置づけを織り込む。ja は全状態必須、en / ko / zh / ja-simple は
  既存の部分辞書に追随（欠落は ja へフォールバックする既存の仕組みをそのまま使う）。

### 制約: `guiding` には位置づけを入れられない

`guidance.ts` は **avatarState キー**で、`guiding` が `selectingTarget`（相手選択＝ 2 番目）と
`fallback`（代替案内＝受付失敗後）の**両方**を覆う。ここに「つぎに」を入れると代替案内画面へ
漏れる。#489 で `gazeTarget` と `cue` について見つけたのと同じ粗さの問題。

よって位置づけを入れるのは screenState と 1 対 1 の 3 状態に限る。

| avatarState | screenState | 入れる位置づけ |
| --- | --- | --- |
| `greeting` | `selectingPurpose` | 最初 |
| `guiding` | `selectingTarget` **+ `fallback`** | **入れない**（粗すぎる） |
| `listening` | `inputVisitorInfo` | もう少し |
| `confirming` | `confirming` | 最後 |

`selectingTarget` に位置づけが要ると判明したら、字幕の真実源を screenState キーへ移す別増分に
する（`AvatarGuide` は既に `screenState` を受け取っているので土台はある）。

### 意図

進捗を「あと何ステップ」という UI 都合ではなく、「次は何をするか」という会話で伝える。
#121 がステッパーで満たしていた「今どこか」の把握は、主指示（`screen__title`）と字幕の
位置づけ表現が担う。

**失うもの**: 全体量の見通し（初見の来訪者への安心材料）。受付は最大 4 画面と短く、各画面の
主指示が明確なため許容する。効果は実機検証（#65）で確認する。

### 実装中に VRT が見つけた退行（設計時に想定していなかった）

**ステッパーは進捗表示だけでなく、右上に固定される「見やすさ設定」ボタン
（`.a11y-menu__button`、`position: fixed`）と本文の緩衝帯としても機能していた。**
撤去すると見出しが上段へ上がり、ja の長い見出し（「内容をご確認ください」）がボタンの下へ
潜った。

対処: `.screen-anim > .screen__title` にボタン 1 つ分の上余白を確保する。待機画面の見出しは
`.kiosk-idle__head` の中にありヒーロー独自のレイアウトを持つため、直下セレクタで自然に外れる。

**教訓**: VRT のベースラインを差分を見ずに更新していたら、この崩れをそのまま焼き込んでいた。
差分画像と実際のスクリーンショットを必ず目で確認してから更新する。

### 検証

- unit: 字幕に位置づけ表現が入っていること、全 locale で位置づけが ja へ落ちていないこと
- VRT: 入力系 3 画面（用件選択・相手選択・確認）の darwin ベースライン更新。
  待機・QR 導入・営業時間外は変化なし。
  **linux ベースラインは #480 と同じ制約で macOS から取り直せない**ため、この 3 画面も
  linux 側が stale になる（Linux セッションでの対応が要る）
- e2e: ステッパーの testid 参照が残っていないこと

## 4. 増分 2: 常設要素の領域帰属

### 二層構成

`domain` はチャットドロワーや言語切替の存在を知らない（知らせると domain が component へ
依存する）。よって二層に分ける。

| 層 | 持つもの |
| --- | --- |
| 契約（`domain/reception/ui-contract.ts`） | 領域語彙（`guidance` / `answers` / `help`）と、**契約自身が持つ部分**の帰属（アバター＝guidance、answers＝answers、escapeHatches・chat＝help） |
| component（`components/kiosk/conversation-turn.ts`） | 実 DOM 要素（スロット/testid）→ 領域の登録簿 |

### 不変条件

**未登録の常設要素があればテストが落ちる。** 見た目は変えない。この増分の価値は
「領域外の常設要素を後から足せなくする」ことにある。ステッパー廃止で領域外要素は 0 になる。

### 検証

unit のみ（描画不変）。`--full` は通すが VRT の更新は発生しない見込み。

## 5. 増分 3: `gazeTarget` の VRM 適用

### 変更

- 純関数 `gazeOffsetFor(gazeTarget, layout)` … 視線先 → 頭部/視線のオフセット（yaw / pitch）。
  **`layout` を引数に取る**。横向きは回答が右レール、縦向きは下部にあり、向く方向が違う。
- viewer での適用（VRM の lookAt / 頭部ボーン）。

### 意図

`gazeTarget` は #489 で実挙動と突き合わせて真にしたが、**まだ消費者がゼロ**。このセッションが
繰り返し確認したとおり、消費者ゼロの契約は腐る。ここで消費者を作る。

### 検証（実装後に確定した内容）

- unit: 全 `GazeTarget` × 全 `KioskLayout` で有限値・`'none'` は中立・入力欄/CTA は回答一覧より
  深く見下ろす・首の可動域（横 ±0.5rad / 縦 ±0.35rad）を超えない
- **VRT のベースライン更新は発生しない。** VRM は WebGL canvas で、VRT は非決定性のため
  canvas とアバター領域を mask している（`kiosk-vrt-a11y.spec.ts` の `avatarMasks`）。
  視線は mask の内側でしか動かない。
- **実描画の確認は #65（実機 UAT）へスタックする。** `VrmAvatarViewer` は headless では
  WebGL 不可で fallback 経路に落ちるため、視線が実際にどう見えるかはこの環境で検証できない。
  純ロジックと配線までがローカルで担保できる範囲。

## 6. ロールバック

各増分は独立した PR。増分 1 は `FlowStepper` の復帰と辞書の復元、増分 2 は登録簿の削除、
増分 3 は viewer での適用箇所の削除で戻せる。状態機械・遷移契約は一切変更しない。

## 7. 体験受入条件（`.claude/rules/opus5-autonomous-loop.md`）

- Actor: 来訪者
- Journey / step: 受付開始 → 用件選択 → 相手選択 → 情報入力 → 確認
- entry / exit / exception state: 変更なし（状態機械は不変）
- 音声とタッチの等価性: 変更なし（ステッパーは表示専用で入力手段ではない）
- 表示・読上げ: 字幕は `aria-live` で読み上げ済み。ステッパーの `aria-label`（`n / 4`）は
  失われるため、位置づけを字幕本文へ移す
- timeout / cancel / fallback: 変更なし
- PII / 監査: 影響なし
- 評価水準: static → state/model → browser/E2E → screenshot（変わる画面のみ）→ 実機は #65
