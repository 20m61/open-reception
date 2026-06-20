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
- [ ] 担当者応答ページ UI（subscriber ビデオ表示）→ 2c-残（要ライブ検証）
- [ ] 通話イベントの監査ログ拡充（応答イベント等）→ 2c-残
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
  - `createSession(receptionId)`: Vonage Video REST `POST /v2/project/{appId}/session` を
    **注入された transport（fetch 互換）** で呼ぶ（テスト時は mock）。
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

### increment 2c-残（後続）

- 担当者応答ページ UI（subscriber ビデオ表示・通知リンクからの導線）。
- 通話イベント（応答等）の監査ログ拡充。
- **すべて実 Vonage 認証情報・実機での結合検証が前提**（REST/JWT/SDK のグローバル名・API 差異を調整）。
