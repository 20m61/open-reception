# Vonage 通話・遠隔応対 設計（実装は後続） (issue #4)

実通話の実装は本番認証情報が前提のため、本書では **server-side トークン発行 / セッション /
通話 UI / 状態遷移 / secret 管理 / fallback** の設計とインターフェースを先行整備する。
実装は認証情報が用意でき次第、`CallAdapter`（#20）の本番実装と通知サブシステム（DESIGN #34）で行う。

## 1. 方針

- 受付セッション（#16）ごとに通話用 Vonage セッションを作成する。
- **Vonage token はサーバ側で短命発行**し、クライアントには短命トークンのみ渡す。
- **secret / private key はクライアントに置かない**（server-only env / Secrets Manager、#6）。
- 担当者への**通知**と**通話開始**を分離する。
- 応答 / 拒否 / 未応答 / 切断 / 失敗 / タイムアウトを状態として扱う（既存の状態遷移 #10 と整合）。
- 通話不可時は通知 / 電話 / メッセージへ fallback する（受付フローを止めない）。

## 2. コンポーネントと責務

| 要素 | 責務 |
| --- | --- |
| `CallAdapter`（#20） | 呼び出しの抽象境界。Mock / Vonage を差し替え（基盤実装済み #4） |
| `VonageCallAdapter`（scaffold 済み） | Vonage 経由の呼び出し。session 作成・token 発行をサーバで行う |
| Token 発行 API（server-only） | 受付セッションに紐づく Vonage session と短命 token を発行 |
| 担当者応答 UI / URL | 通知から通話へ入る担当者側エントリ |
| iPad 通話 UI | 受付端末側の通話画面（接続中 / 通話中 / 終了 / 再呼び出し） |
| 監査ログ（#19） | 通話イベント（開始 / 応答 / 失敗 / 切断）を記録（PII 非保持） |

## 3. シーケンス（設計）

```
iPad(受付) --confirm--> /api/kiosk/receptions/:id/call (server)
  server: CallAdapter=Vonage の場合
    1) Vonage session 作成（sessionId）
    2) 受付セッションに sessionId を紐づけ
    3) 担当者へ通知（通知サブシステム / 通知先 #26）
    4) iPad へ短命 publisher token を返す（secret は返さない）
  iPad: token で接続 → 状態 calling
担当者: 通知 → 応答 URL → 短命 subscriber token 取得 → 接続
  応答     → connected（通話中）
  未応答    → timeout → fallback
  拒否/失敗  → failed  → fallback
  切断     → completed / 再呼び出し
```

## 4. インターフェース（先行整備）

`src/adapters/call/vonage-session.ts` に型 / インターフェースを定義する（実装は後続）。

- `VonageSessionRef = { sessionId: string }`
- `ShortLivedToken = { token: string; role: 'publisher' | 'subscriber'; expiresAt: string }`
- `interface VonageSessionService`
  - `createSession(receptionId): Promise<VonageSessionRef>`
  - `issueToken(session, role): Promise<ShortLivedToken>`（短命・サーバ発行）

`CallResult`（#20）の `connected / timeout / failed` を受付状態（#10）へマッピングする既存ロジックを再利用する。

## 5. secret 管理（#6 と整合）

- `VONAGE_APPLICATION_ID / API_KEY / API_SECRET / PRIVATE_KEY` は **server-only**（`NEXT_PUBLIC_` 不使用）。
- 本番は AWS Secrets Manager（DESIGN #34）。
- クライアントへは**短命 token のみ**。secret / private key を bundle に含めない（secret scan #6）。

## 6. 状態遷移（既存 #10 を利用）

`calling → connected | timeout | failed | cancelled`、`connected → completed`、
`timeout/failed → fallback → idle`。Vonage の実イベントをこの遷移へ写像する。

## 7. fallback

通話不可 / 失敗 / 未応答時は、代替担当者（#26）・代表窓口・通知（メール/Slack/電話）へ誘導する。
受付端末は通話 UI が使えなくてもタッチ操作で受付を完了できる。

## 8. テスト方針

- 状態分岐（connected/timeout/failed/cancelled）は **MockCallAdapter**（#20）で e2e 済み。
- 本番 Vonage は adapter 差し替えで接続し、token がクライアント bundle に含まれないことを検査（#6）。
- 通話イベントの監査記録（#19）を確認する。

## 9. 実装時タスク（認証情報が用意でき次第）

- [x] `VonageSessionService` の実装（session 作成・短命 token 発行）→ increment 1
- [x] `VonageCallAdapter.call` の実装（scaffold を置換）→ increment 1（session 確立まで）
- [x] 非同期通話ライフサイクル（サーバ）: calling 保持・sessionId 永続化・/connected・/timeout → increment 2a
- [x] 受付端末トークン配布 API（publisher）→ increment 2a
- [x] トークン発行の認可（kiosk セッション束縛 + 端末一致）→ increment 2b
- [x] クライアント通話ライフサイクル制御（fetch→接続→connected/timeout→fallback）→ increment 2b
- [x] 実 Vonage client SDK アダプタ（CallClient 実装・CDN 動的ロード + fallback）→ 2c（要ライブ検証）
- [x] 受付端末ビデオ UI への組込み（KioskFlow calling 状態・fallback-first）→ 2c（要ライブ検証）
- [x] 担当者応答エンドポイント + 応答トークン + subscriber トークン配布 → 2c
- [x] 担当者応答ページ UI（subscriber ビデオ表示）→ 2c-残（要ライブ検証）
- [x] 通話イベントの監査ログ拡充（reception.answered）→ 2c-残
- [x] secret がフロント bundle に含まれないことの検査（#6）: `'use client'` から server-only secret 環境変数（`VONAGE_*` / `ADMIN_*` / `KIOSK_SESSION_SECRET` / `KIOSK_PIN`）の参照を禁止する静的ガードテスト（`src/lib/security/client-secret-guard.test.ts`）。Vonage 実装時もこのガードで回帰を防ぐ。

## 10. 実装方針確定（increment 分割）

実通話は「クライアント動画 UI + 担当者応答の非同期検知」が必須で規模が大きく、かつ実認証情報が
ないとライブ検証できない。そこで **セキュリティ中核（サーバ側 session/token）を先に確定・実装** し、
クライアント UI と非同期状態遷移を後続イテレーションに分離する。

### Vonage 製品 / 認証方式

- **Vonage Video API（Unified）** を採用（受付の遠隔“顔合わせ”= ビデオ）。
- 認証は **Application ID + Private Key による RS256 JWT**（`VONAGE_APPLICATION_ID` /
  `VONAGE_PRIVATE_KEY`）。`VONAGE_API_KEY` / `VONAGE_API_SECRET` はアカウント系 API 用に保持。
- すべて server-only。クライアントへ渡すのは短命 client token のみ。

### increment 1（本イテレーション・このPR）— サーバ中核 + 単体テスト

- `src/lib/call/vonage-jwt.ts`: `node:crypto` で RS256 JWT を生成（外部依存なし）。
  - アプリ認証 JWT（REST 呼び出し用）と client 接続トークン（`scope: "session.connect"`）。
  - claims / 有効期限 / 署名検証（公開鍵）を単体テスト。
- `src/adapters/call/vonage-session.ts`: `VonageSessionService` を実装。
  - `createSession(receptionId)`: Vonage Video REST `POST /session/create`（form-urlencoded、
    `archiveMode=manual` / `p2p.preference=disabled`、`Accept: application/json`）を
    **注入された transport（fetch 互換）** で呼ぶ（テスト時は mock）。
    ※ 当初は `POST /v2/project/{appId}/session` + JSON `{ mediaMode }` と書いていたが、
    その経路は存在しない。§11（2026-09-02 仕様照合）で修正。
  - `issueToken(session, role)`: ローカルで RS256 JWT を発行（ネットワーク不要）。
- `VonageCallAdapter.call`: session 作成 + publisher token 発行までを行い結果を返す。
  - フラグ `VONAGE_ENABLED` 既定 off。**Mock の挙動・既存 e2e は不変。**
  - 本 increment の `connected` は「通話セッション確立」を意味する暫定セマンティクス
    （担当者の実応答検知は increment 2）。
- **ライブ検証の注意**: REST エンドポイント/レスポンス形は実認証情報での結合確認が必要
  （単体テストは request 整形・JWT 正当性まで）。

### increment 2a（実装済み）— サーバ側 非同期通話ライフサイクル

- `CallResult` に `calling`（応答待ち）+ `sessionId` を追加。Vonage adapter は session 作成後
  `calling` を返し、受付状態は `calling` のまま `vonageSessionId` を紐づける（即 connected にしない）。
  Mock は従来どおり connected/timeout/failed を同期返却（挙動不変）。
- 状態確定エンドポイント（受付端末/クライアントの接続検知から呼ぶ）:
  - `POST /api/kiosk/receptions/:id/connected` → calling→connected（`markConnected`）
  - `POST /api/kiosk/receptions/:id/timeout`   → calling→timeout（`markTimeout`、履歴記録）
- トークン配布 API（受付端末 publisher）:
  - `GET /api/kiosk/receptions/:id/token` → `{ applicationId, sessionId, token, role, expiresAt }`
    を返す（secret は返さない。未確立/無効時は 409）。
- すべて単体テスト済み（adapter 注入で calling/connected/timeout 経路を検証）。

### increment 2b（実装済み）— 認可 + クライアント通話制御の中核

- **トークン発行の認可**: `GET /token` を kiosk セッション必須 + `reception.kioskId` 一致に限定
  （第三者が reception id を知っても発行不可）。`src/app/api/kiosk/receptions/[id]/token/route.ts`。
- **クライアント通話ライフサイクル制御**: `src/lib/call/call-controller.ts`（フレームワーク非依存）。
  - token API 取得 → `CallClient` で接続 → 応答で `/connected`、未応答で `/timeout` を報告 → 失敗は
    fallback へ降格（受付フローを止めない）。
  - 実 SDK 接続は `CallClient` interface に隔離（2c で具体実装）。fetch/タイマー/状態遷移を単体テスト。

### increment 2c（コード実装済み・要ライブ検証）

- **`CallClient` 実装** `src/adapters/call/vonage-client.ts`: OpenTok 互換 SDK を CDN スクリプトで
  動的ロード（`NEXT_PUBLIC_VONAGE_SDK_URL` で上書き可）。接続/publish/streamCreated→onConnected を
  実装。loadSdk 注入で制御ロジックを単体テスト（SDK の DOM ロードは browser-only・要ライブ検証）。
- **受付端末ビデオ UI** `src/components/kiosk/KioskCallView.tsx` を KioskFlow の calling 状態へ組込み。
  Vonage（`calling` 返却）時のみビデオビューを描画し、Mock 同期通話の挙動・既存 e2e は不変（fallback-first）。
- **担当者応答（サーバ）**: `POST /api/staff/calls/:id/answer`。署名付き応答トークン
  （`src/lib/call/answer-token.ts`）で認可し、subscriber トークンを発行 + calling→connected を確定。
  secret は返さない。401/403/404/409/200 を単体テスト。

### increment 2c-残（コード実装済み・要ライブ検証）

- **担当者応答ページ UI**: `/staff/calls/[id]?token=<answerToken>`（`src/app/staff/calls/[id]/page.tsx`
  + `src/components/staff/StaffCallView.tsx`）。応答エンドポイントを呼んで subscriber トークンを取得し
  通話に参加（fallback-first）。proxy 認可の対象外（公開・トークン認可）。
- **通話イベント監査拡充**: 応答の瞬間に `reception.answered` を監査ログへ記録（markConnected）。
  connected/completed の監査とは別イベント。管理画面の監査一覧にラベル追加。
- **要ライブ検証**: ビデオ参加（StaffCallView の実 SDK 接続）は実 Vonage 認証情報・実機が前提。

### MVP1 Voice/PSTN（#4）— **Video とは別トラック**

> **§10 までは Vonage *Video* API（遠隔「顔合わせ」）の設計。** #4 が求める
> 「担当者の携帯・部門代表電話への外線取次」は **Voice API / PSTN** で、別製品・別実装。
> 既存の `VonageCallAdapter` は Video 側で、#4 の実装ではない。

increment（PR #632 で A〜C・G を実装。**実発信は #65**）:

- **A** 二段階 NCCO（`domain/call/voice-announcement.ts`）。第 1 段は「受付からの電話」＋DTMF のみで
  **来訪者情報を引数に取れない**。第 2 段で初めて案内する（留守電・第三者への読み上げ防止）
- **B** 通話状態機械（`domain/call/voice-call-state.ts`）。順不同・terminal 巻き戻り拒否
- **C** signed webhook 検証（`lib/security/vonage-webhook.ts`）＋ 4 ルート
  （`/answer` `/dtmf` `/choice` `/events`）。**段はエンドポイントで持つ**（同じ URL に戻すと
  第 2 段の「1」が本人確認として再解釈され、来訪者情報を無限に読み上げる）
- **G** provider 通話 ID → 受付 の相関（`lib/routing/call-correlation.ts`）
- 再開可能な取次（`domain/routing/resumable.ts`）。実 PSTN は 1 手 20〜30 秒で結果は webhook
  なので、同期実行の `orchestrator.ts` では成立しない

確定した設計判断:

- **署名済み本文だけを権威にする。** URL のクエリで通話 ID や段階を渡さない（POST では
  `payload_hash` の対象外で付け替えられる）
- **拒否は一様**（403・固定文言・ヘッダも同一）。理由で分けると通話 ID の総当たりで
  「その通話は存在する」が漏れる。**理由は構造化ログにのみ出す**
- **代理先は Provider が選ばない。** `declined`/`delegate` はどちらも取次語彙の `declined` で、
  次に誰へ行くかは RoutingPolicy / Orchestrator が決める

**Vonage 側の必須設定（#65 のチェックリスト）**:

1. アカウントで **signed webhooks を有効化**する
2. Application の **`answer_method` / `event_method` を `POST`** にする
   （既定は GET。GET だと本文が無く通話 ID を取れないので、この実装は成立しない）
3. 資格情報 bundle に **`signatureSecret`** を入れる（`apiSecret` とは別物）
4. webhook URL は **CloudFront のドメイン**を登録する（Function URL を直接登録すると
   `x-origin-verify` で 403 になる。#612）

**未了（Inc D）**: 相関を書く本番コードがまだ無いため、**現状 4 ルートは常に 403 を返す**。
発信（`VonageVoiceProvider`）と相関の書き込みが入って初めて機能する。
あわせて `jti` によるリプレイ防止と、`correlation.status === 'settled'` での打ち切りも Inc D。

### 全体の残（ライブ検証フェーズ）

- 実 Vonage 認証情報・実機で REST/JWT/client SDK（グローバル名・URL・API 差異）を結合検証。
- 受付端末↔担当者の双方向ビデオ疎通、応答/未応答/再呼び出しの実イベント確認。

## 11. 仕様照合（2026-09-02）

`developer.vonage.com` はこの環境の egress から読めなかったため、**公式 SDK のソース**（Node
`@vonage/video` / `@vonage/voice` / `@vonage/jwt` 3.x、Python `vonage-video` / `vonage-voice` /
`vonage-jwt`、Java `vonage-java-sdk` / `vonage-jwt-jdk`）と公式サンプル
（`opentok/opentok-web-samples`）、npm レジストリ（`@vonage/client-sdk-video`）を一次資料として
照合した。結論は「**Video のセッション作成だけが仕様と食い違っていた**。Voice は概ね正しいが、
届きうるステータスの取りこぼしと `ringing_timer` の上限未検証があった」。

| 項目 | 実装（照合前） | 仕様（一次資料） | 対応 |
| --- | --- | --- | --- |
| Video セッション作成 | `POST /v2/project/{appId}/session`、JSON `{ mediaMode: 'routed', archiveMode: 'manual' }` | `POST https://video.api.vonage.com/session/create`、**form-urlencoded** `archiveMode=manual&p2p.preference=disabled`、`Accept: application/json`、応答は配列 `[{ session_id }]`（Node/Python/Java SDK すべて同じ） | 🔴 **修正**。旧経路は存在せず、実資格情報を入れた時点で 404 になっていた |
| Video client token claims | `application_id / scope=session.connect / session_id / role / iat / exp / jti` | 同左 ＋ 公式 SDK は `sub: "video"`、`acl.paths["/session/**"]` を必ず載せる（Python は「変更するな」と明記）。`initial_layout_class_list` / `connection_data` は任意。上限 30 日 | `sub` / `acl` を追加 |
| Video アプリ JWT | `application_id / iat / exp / jti`、RS256 | 同左（SDK 既定 TTL 900s。こちらは 120s） | 変更なし |
| Video web SDK | `https://static.opentok.com/v2/js/opentok.min.js` を動的ロード、`OT.initSession(applicationId, sessionId)` | 公式サンプルは同 URL・同シグネチャ（第 1 引数は unified では applicationId）。npm は `@vonage/client-sdk-video` 2.35.1（`dist/js/opentok.js`） | 変更なし（要ライブ検証のまま） |
| Voice 発信 `POST /v1/calls` | `to/from` phone、`answer_url[]`、`answer_method=POST`、`event_url[]`、`event_method=POST`、`ringing_timer` | 同左。`ringing_timer` は **1〜120**（Java は例外、Python は `le=120`）、`length_timer` 1〜86400 | `ringing_timer` を 120 へ丸める（超えると 400 で発信が失敗し、来訪者が有人支援へ倒れる） |
| Voice 基底 URL | `https://api.nexmo.com` | SDK 既定 `apiHost` も同じ。webhook の `region_url` に**通話の所属リージョン**の基底 URL が載り、通話の制御はそこへ送るのが案内 | `region_url` を許可リスト（`https://*.vonage.com` / `*.nexmo.com`）で濾して相関へ残し、切断がそこへ撃つ。無ければグローバル |
| Voice 切断 | `PUT /v1/calls/{uuid}` + `{ action: 'hangup' }` | 同左（DELETE は存在しない） | 変更なし |
| Voice event webhook `status` | ringing / answered / busy / unanswered / timeout / rejected / failed / completed | started / ringing / answered / **cancelled** / busy / unanswered / **disconnected** / rejected / failed / timeout / completed（＋ human / machine / input / transfer / record） | `started`（無変化）・`cancelled` / `disconnected`（completed と同じ扱い）を追加。**一覧は domain の `VONAGE_CALL_STATUSES` を正本にし、route は写しを持たない**（`cancelled` は route 側の一覧に無く黙って無視されていた） |
| Voice signed webhook | `Authorization: Bearer <HS256 JWT>`（signature secret）＋ `payload_hash`（本文の SHA-256 hex）＋ `iat` の鮮度 ＋ `jti` | 公式 SDK の `verifySignature` は署名のみ（HS256）。`payload_hash` / `iat` の検査はドキュメント側の推奨で、こちらはそれを実装している | 変更なし（SDK より厳しい側） |
| NCCO `talk` | `text / language / bargeIn` | 同左。任意で `style / premium / loop / level`。`voiceName` は廃止 | 変更なし |
| NCCO `input` | `type: ['dtmf']`、`dtmf: { maxDigits, timeOut }`、`eventUrl` | 同左 ＋ `eventMethod`（既定 POST）、`speech` は任意 | `eventMethod: 'POST'` を明示（この設計は署名済み本文だけを権威にするので GET では成立しない） |
| 通知 adapter `HttpVonageAdapter` | 任意 `endpoint` へ Bearer `token` で `{ to, requestId, text, audioBase64 }` を POST | **どの Vonage API とも一致しない**（Messages API は `POST /v1/messages` に `{ message_type, text, to, from, channel }`、認証は JWT）。骨組みのまま | 変更なし。実装するなら Messages API へ揃える必要があり、新しい外部送信の配線＝停止境界なので別 Issue |

疎結合の観点で直したもの:

- **webhook 本文の読み取りを 1 か所へ**（`src/lib/routing/vonage-webhook-body.ts`）。`uuid` を
  context、`status` を `/events`、`dtmf.digits` を `/dtmf` と `/choice` が別々に `JSON.parse` していた。
  返すのは非機微の識別子と定型値だけで、`to` / `from`（電話番号）は読める形にしない
- **ステータス一覧の写しを route から撤去**（上表）。domain の配列から型を導く

残（実資格情報が要るもの・#65）: `/session/create` の応答形、client SDK のグローバル名、
`region_url` が answer / event の両 webhook に載ること、`cancelled` の後に `completed` が
続くか（続かなくても状態機械は壊れない）。
