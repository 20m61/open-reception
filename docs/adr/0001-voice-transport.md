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
- Realtime gateway は PCM16 mono 16kHz の 20〜40ms に対応する **640〜1280 byte** の binary frame
  のみを音声として受ける。1 byte `[0]` は heartbeat、text frame と oversized frame は拒否する。

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

### 5. セキュリティ: 短命接続トークン + Realtime gateway の 4 段ゲート

EC2 上の Node gateway は `src/server/realtime/voice-gateway.ts` の
`acceptVoiceTransportGatewayConnection` を HTTP upgrade 前の唯一の accept path とする。
内部では `authorizeVoiceTransportConnection` を呼び、順序を固定する:

1. 署名・role・exp（`readVoiceTransportToken`） — 改ざん・期限切れを拒否。
2. tenant/site/kiosk/reception への境界一致（`checkTokenBinding`） — 他テナント・
   他端末・他受付セッションの token を拒否。
3. 同時接続上限（`streamLimiter`） — kiosk あたりの同時ストリーム数を制限。
4. 単回性・リプレイ拒否（`replayGuard`） — 同じ token での 2 回目の接続を拒否。

3→4 の順序は意図的（コメント参照）。逆にすると、同時接続上限で弾かれるはずの正規リトライが
token を無駄に consume してしまう。

接続契約は次で固定する。

- path: `/v1/voice?kioskId=<id>&receptionSessionId=<id>`
- `tenantId/siteId`: **runtime/deployment binding 由来**。URL/query から受け取らない。
- WebSocket subprotocol: `open-reception.voice.v1, auth.<short-lived-token>`
- server が handshake で選択して返すのは `open-reception.voice.v1` のみ。auth token は echo しない。
- token は URL/query に載せない。Caddy/access log が URL を記録しても credential が残らない既定にする。
- #366 の `not_ready/draining` は token consume より前に拒否し、ready 復帰後の安全な再試行を妨げない。

トークンの claims (`tenantId/siteId/kioskId/receptionSessionId/jti`) はすべて
**サーバ権威**で決める。発行 API (`POST /api/kiosk/voice-transport/token`) は
kiosk セッション cookie から kioskId を、device レジストリから tenantId/siteId を、
対象 reception の所有権チェック（`reception.kioskId === session.kioskId`）で
receptionSessionId を確定する。リクエスト body の同名フィールドはクライアント詐称防止の
ため無視する。

`kioskId/receptionSessionId` の query は routing/binding consistency の入力であり、それ自体を
認証情報とはみなさない。Bearer token の署名・短命性・単回性が接続資格を担い、tenant/site は
Site 1:1 runtime の deployment binding と独立照合する。

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

server側では認可済み socket 1本を `VoiceTransportGatewaySession` とし、socket close時に
`streamLimiter.release(kioskId, jti)` を冪等に呼ぶ。close hook が走らない異常時の安全弁として
既存TTLも維持する。

### 7. 音声はデフォルト保存しない

Transport 層は音声チャンクをメモリ上のキュー（送信待ちの間だけ）以外に永続化しない。
評価ハーネス（#365）のイベントにも生音声 URI を含められない
（`evaluation-events.ts` の `FORBIDDEN_EVENT_FIELDS` が構造的に弾く）。

## この increment（#369）でやったこと / やっていないこと

**やったこと（mock / pure boundary）**:
- Transport 内部ロジック一式（`src/domain/voice-transport/`）: 型・token 境界検証・
  有界キュー・レート制限・lifecycle 状態機械・#365 イベント橋渡し・フォールバック導出。
- I/O 層（`src/lib/voice-transport/`）: 接続トークンの署名発行/検証、リプレイガード、
  同時接続上限、kiosk→tenant/site 解決、接続許可の検証経路
  （`authorizeVoiceTransportConnection`）、`VoiceTransportClient`。
- token 発行 API（`POST /api/kiosk/voice-transport/token`）。
- server accept/session 境界（`src/server/realtime/voice-gateway.ts`）: path/subprotocol契約、
  runtime tenant/site binding、ready/drain gate、認可呼出、close時slot解放、frame上限・heartbeat分類。

**まだやっていないこと**:
- **RFC6455/WSS listener adapter**。`voice-gateway.ts` を実ソケットへ結ぶ thin adapter は、WebSocket
  library を production dependency として追加する必要があるため、依存追加の Human Gate 後に行う。
  Caddy/TLS・systemd・S3 artifact 配布と AWS dev deploy は #366/#65 の責務。
- **AudioWorklet 実装**（実マイク入力・AEC/NS/AGC 設定）。ブラウザ実機が必要なため #65。
- **Kiosk UI 配線**。フォールバックイベントは `fallback.ts` の中立な形で用意済み。
- STT/TTS の実 session close（`registerCloseHook` の interface は用意済み。実 STT/TTS
  session を渡す配線は #370/#371 側で行う）。

## 実測後の見直し

chunk size（20〜40ms 帯）・reconnect backoff・heartbeat 間隔・idle timeout・同時接続上限・
送信レート上限の具体値は暫定値であり、#65 の実機 UAT（実 iPad Safari / 実回線 / 実 STT・TTS
provider）で計測してから確定する。見直し時は本 ADR と `evaluation-thresholds.ts`
（該当する場合）を合わせて更新する。