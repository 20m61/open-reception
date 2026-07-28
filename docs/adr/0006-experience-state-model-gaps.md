# ADR 0006: 体験設計の状態モデルに残った 2 つの未定義を決める

- ステータス: 採用（`docs/experience/README.md` を本 ADR に合わせて更新済み）
- 関連: issue #422（ExperienceShell）、#418（親 Epic）、#98（QR 受付）、#327（i18n）
- 関連ドキュメント: `docs/experience/README.md`（体験設計の正本）、
  `docs/experience/state-mapping.md` §6-5、`src/domain/experience/journey-map.ts`
- 現物: `src/domain/checkin/state.ts`、`src/components/kiosk/CheckinFlow.tsx`

## 背景

第 34〜37 wave で Journey / 状態モデルと実装の差分を洗い出した結果、**体験設計側に 2 つの
未定義**が残った（`state-mapping.md` §6-5）。どちらも「実装が足りない」のではなく
**正本の記述が実装の現実を写していない**種類の欠落で、放置すると次の周回が推測で埋めて
しまう（実際に第 37 wave は `privacy_blocked` の解釈を 2 通りの間で決めかねて保留した）。

1. `privacy_blocked` に定義文が無い（例外状態の列挙のみ）
2. 状態モデルの入力手段が `listening|touching` の 2 つしか無いが、実装には **QR スキャン**という
   第 3 の手段が在る（`CheckinState.scanning`）

## 決定 1: `privacy_blocked` は「プライバシー上の理由でその入力手段を続行できない状態」

### 却下した解釈

「PII の画面露出を抑制している状態」という読み方は**採らない**。

理由は、README 自身が「**各状態は次を持つ**」として全状態に `PII exposure rule` を要求して
いるため。露出抑制が全状態の属性なら、それをもう一度**独立した状態**として持つのは重複で、
状態モデルとして意味を成さない。実装側も `PrivacyNotice` を常時表示しており、
入る／出る条件を持たない（＝状態ではなく不変条件）。

### 採る定義

> **`privacy_blocked`**: 来訪者がプライバシーに関わる権限（カメラ・マイク）を許可しなかったため、
> **その入力手段では受付を続行できない**状態。受付そのものは失敗していない。必ず別の入力手段
> （タッチ）へ文脈を保ったまま復帰させる。

こう定義すると状態として成立する。

| 属性 | 内容 |
| --- | --- |
| entry | 権限要求に対する拒否（`CAMERA_DENIED`）、または権限が既に拒否されている端末での要求 |
| exit | 別手段（タッチ）へ切替、または待機へ戻る |
| fallback | **常に有り**。QR が使えなくても通常受付で完遂できる（行き止まりにしない） |
| PII | 拒否理由を来訪者の落ち度として表示しない。権限を再要求で追い詰めない |

### 実装との対応

現物は `CheckinState.cameraError`（`src/domain/checkin/state.ts`）。QR 読み取りのカメラ権限が
拒否された局面で、`RETRY` で `selectingMethod` へ、`CHOOSE_MANUAL` で `manualFallback` へ
戻れる（＝逃げ道が在る）。**マイク側は実 `getUserMedia` が未配線**のため、現時点で
`privacy_blocked` に到達するのはカメラ経路だけ。

`usePresenceCamera` の権限拒否は**該当しない**。来訪検知が働かなくなるだけで、来訪者は
画面をタップして受付を開始できる（続行不能ではない）。

## 決定 2: 入力手段は 3 つ。ただし等価性の要件は音声とタッチの 2 つに限る

状態モデルを実装の現実へ合わせる。

```text
idle -> visitor_detected -> greeting -> choosing_method
     -> listening | touching | scanning
     -> recognizing -> confirming -> contacting -> connected -> completed
```

### なぜ「等価性の要件は 2 つのまま」か

README の原則 2 は「音声とタッチで**同じ目的を達成できる**」を要求している。QR スキャンは
この意味での等価な手段では**ない**し、そうすべきでもない。

- QR は**予約済みの来訪者だけ**が持つ。全来訪者が使える手段ではない
- QR が無くても通常受付で完遂できる（補助チャットの FAQ も「QRコードが無くても受付できます」と
  案内している）
- QR を等価要件に含めると、「QR でしかできないこと」を作ってよいと読めてしまう

したがって `scanning` は**加速手段**として位置づける。**QR 経路で失敗したら必ずタッチ経路へ
戻せること**が要件で、逆（タッチ経路に QR 相当の近道を用意すること）は要件ではない。

### 実装との対応

`CheckinState.scanning`。`journey-map.ts` の `CHECKIN_STATE_TO_EXPERIENCE` はこれまで
「写す先が体験設計側に無い」として `null` にしていたが、本 ADR で写す先ができた。

## 影響

- `docs/experience/README.md`: 状態モデルに `scanning` を追加し、例外状態に定義表を追加
- `src/domain/experience/journey-map.ts`: `scanning` → `'scanning'`、`cameraError` →
  `'privacy_blocked'`。`UNIMPLEMENTED_EXPERIENCE_STATES` から `privacy_blocked` が外れる
- `docs/experience/state-mapping.md`: §2 と §6-5 を決着済みへ

**来訪者から見た挙動は変わらない。** 本 ADR は既に在る振る舞いに名前と境界を与えるもので、
遷移も画面も追加しない。

## 却下した代替案

**「未定義のまま保留し、実装するときに決める」**: 第 37 wave がこれを選んだが、`state-mapping.md`
に「要ユーザー確認」として積み残るだけで、次の周回が同じ調査を繰り返す。正本の欠落は
**実装より先に**埋めるのが安い（実装後に決めると、既に書いたコードに引きずられる）。

**「`privacy_blocked` を削除する」**: 権限拒否は実際に起きる局面で、しかも来訪者を行き止まりに
しやすい（第 39 wave のカスタムフローと同じ形）。名前を消すと、逃げ道の有無を検証する足場も
消える。
