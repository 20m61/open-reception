# ADR 0001: iPad 音声ストリーム Transport（WSS + AudioWorklet, PCM 16kHz/16bit, 20ms チャンク）

- ステータス: 承認（MVP）。実測により見直す前提（下記「実測後の見直し」参照）。
- 関連: issue #369（本 ADR の対象）、#370 (STT)、#371 (TTS)、#372 (Turn)、#365（評価ハーネス）、#65（実機 UAT）
- 関連ドキュメント: `docs/voice-evaluation-harness.md`

## 背景

iPad Safari / PWA の受付キオスクからリアルタイム会話ランタイム（STT/TTS/ターン判定）へ
音声を低遅延・安全に送受信する経路が必要。STT/TTS/ターン制御とは分離し、Transport の実装
（WSS/WebRTC 等）を後から交換可能にしておきたい（#360 統合 Epic の方針）。

## 決定

### 1. Transport は WSS（WebSocket over TLS）を MVP の第一候補とする

- 理由: 受付ブースは 1 kiosk = 1 参加者の単方向〜双方向ストリームで、複数参加者・映像・
  P2P 低遅延が要らない。WebRTC/LiveKit は SFU 運用コストと複雑さに見合わない。
- WSS はブラウザ標準 API（`WebSocket`）のみで完結し、AudioWorklet からのチャンクを
  `ArrayBuffer` としてそのまま送出できる。
- 将来、遠隔受付・映像・複数参加者が要件化した場合は WebRTC/LiveKit へ置換する
  （「境界」節を参照）。

### 2. 音声形式は mono PCM 16kHz / 16bit（`pcm16`）

- STT プロバイダの標準的な入力仕様に合わせる（多くの ASR API が 16kHz/16bit mono を
  第一級でサポートし、余計なリサンプルをサーバ側に持ち込まない）。
- TTS 再生側は必要に応じて 48kHz へ変換する（Transport の対象外、#371 側の責務）。
- codec は将来 Opus 等の圧縮へ拡張可能な余地を型に残す
  （`VoiceTransportEncoding` を union にしてある。現状は `'pcm16'` のみ）。

### 3. チャンクサイズは初期値 20ms（20〜40ms を許容範囲とする）

- 20〜40ms は音声ストリーミングで一般的な帯域/遅延のトレードオフ帯。
- 実機（iPad Safari の AudioWorklet 実測レイテンシ・実回線）での確定は #65 で行う。
  `isValidVoiceTransportAudioConfig` がこの範囲を機械的に強制し、実装がドリフトしても
  気づけるようにしてある。

### 4. WebRTC/LiveKit へ置換可能な境界

```
AudioWorklet(ブラウザ)
        │  PCM チャンク (ArrayBuffer)
        ▼
VoiceTransportClient（本 issue, src/lib/voice-transport/client.ts）
        │  VoiceTransportSocket interface（send/close/onopen/onclose/onerror/onmessage）
        ▼
[WSS 実装]  ← ここだけ差し替えれば WebRTC/LiveKit 等へ移行できる
        │
        ▼
会話ランタイム（STT/TTS/ターン判定, #370-#372）
```

`VoiceTransportSocket`（`src/lib/voice-transport/socket.ts`）が唯一の交換点。
`VoiceTransportClient` は lifecycle・backpressure・reconnect・rate limit をこの interface
の上でのみ組み立てており、ブラウザの `WebSocket` を実装として満たせば動く。WebRTC の
DataChannel も同じ interface で包めるため、置換時に `VoiceTransportClient` 側の変更は
不要という設計にした（`client.test.ts` の `MockVoiceTransportSocket` が実際にこの境界の
テスト容易性を証明している）。

### 5. セキュリティ: 短命接続トークン + サーバ側検証の 4 段ゲート

`src/lib/voice-transport/connection-authorizer.ts` の `authorizeVoiceTransportConnection`
が実 WSS サーバ（AWS では API Gateway WebSocket API の `$connect` 相当）から呼ばれる想定の
唯一の検証入口。順序は固定:

1. 署名・role・exp（`readVoiceTransportToken`） — 改ざん・期限切れを拒否。
2. tenant/site/kiosk/reception への境界一致（`checkTokenBinding`） — 他テナント・
   他端末・他受付セッションの token を拒否。
3. 同時接続上限（`streamLimiter`） — kiosk あたりの同時ストリーム数を制限。
4. 単回性・リプレイ拒否（`replayGuard`） — 同じ token での 2 回目の接続を拒否。

3→4 の順序は意図的（コメント参照）。逆にすると、同時接続上限で弾かれるはずの正規リトライが
token を無駄に consume してしまう。

トークンの claims (`tenantId/siteId/kioskId/receptionSessionId/jti`) はすべて
**サーバ権威**で決める。発行 API (`POST /api/kiosk/voice-transport/token`) は
kiosk セッション cookie から kioskId を、device レジストリから tenantId/siteId を、
対象 reception の所有権チェック（`reception.kioskId === session.kioskId`）で
receptionSessionId を確定する。リクエスト body の同名フィールドはクライアント詐称防止の
ため無視する。

### 6. lifecycle: reconnect / heartbeat / idle timeout / backpressure / degraded fallback

`src/domain/voice-transport/lifecycle.ts` の状態機械（`idle → connecting → connected
→ reconnecting → degraded → closed`）が唯一の真実源。`degraded`（再接続試行を使い果たした）
に達すると `src/domain/voice-transport/fallback.ts` がフォールバックイベントを導出し、
Kiosk 側がタッチ受付へ切り替える判断材料にする（イベント形は
`src/domain/reception/ui-contract.ts` に依存しない中立形 — 同モジュールは他トラック占有
のため、配線は次 increment）。

backpressure は `src/domain/voice-transport/queue.ts` の有界キュー（`maxChunks` /
`maxBytes` / drop policy）で吸収する。どのポリシーでも「無制限にメモリ・キューが増えない」
ことを関数の事後条件として保証する。

### 7. 音声はデフォルト保存しない

Transport 層は音声チャンクをメモリ上のキュー（送信待ちの間だけ）以外に永続化しない。
評価ハーネス（#365）のイベントにも生音声 URI を含められない
（`evaluation-events.ts` の `FORBIDDEN_EVENT_FIELDS` が構造的に弾く）。

## この increment（#369）でやったこと / やっていないこと

**やったこと（ローカルで mock 検証済み）**:
- Transport 内部ロジック一式（`src/domain/voice-transport/`）: 型・token 境界検証・
  有界キュー・レート制限・lifecycle 状態機械・#365 イベント橋渡し・フォールバック導出。
- I/O 層（`src/lib/voice-transport/`）: 接続トークンの署名発行/検証、リプレイガード、
  同時接続上限、kiosk→tenant/site 解決、接続許可の唯一の検証経路
  （`authorizeVoiceTransportConnection`）、`VoiceTransportClient`（lifecycle を実際に
  駆動するクライアント側実装、mock socket で継続送信・再接続・backpressure・
  degraded/fallback・二重 close 安全性を検証）。
- token 発行 API（`POST /api/kiosk/voice-transport/token`）。

**やっていないこと（次 increment / #65 スコープ）**:
- **実 WSS サーバ**（AWS 上の実配線）。`authorizeVoiceTransportConnection` は実 WS
  accept ハンドラ（API Gateway WebSocket API の Lambda 等、infra/lib 側の追加が必要）
  から呼ばれる想定で書いてあるが、そのハンドラ自体・CDK スタックはこの increment の
  スコープ外（触ってよいディレクトリの制約、かつ実配備は #65／将来のインフラ増分）。
- **AudioWorklet 実装**（実マイク入力・AEC/NS/AGC 設定）。ブラウザ実機が必要なため #65。
- **Kiosk UI 配線**（`src/components/kiosk/` は他トラック占有のためこの increment では
  触らない）。フォールバックイベントは `fallback.ts` の中立な形で用意済みで、Kiosk 側は
  これを `useFallback` アクション（`ui-contract.ts`）へ変換するだけで配線できる。
- STT/TTS の実 session close（`registerCloseHook` の interface は用意済み。実 STT/TTS
  session を渡す配線は #370/#371 側で行う）。

## 実測後の見直し

chunk size（20〜40ms 帯）・reconnect backoff・heartbeat 間隔・idle timeout・同時接続上限・
送信レート上限の具体値は暫定値であり、#65 の実機 UAT（実 iPad Safari / 実回線 / 実 STT・TTS
provider）で計測してから確定する。見直し時は本 ADR と `evaluation-thresholds.ts`
（該当する場合）を合わせて更新する。
