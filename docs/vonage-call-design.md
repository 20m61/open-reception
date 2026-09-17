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

## 10-A. 🔴 CSP と SDK 配信（#1132）

**この設計は「CDN から SDK を動的ロードする」と書いているのに、CSP に一言も触れていなかった。**
実測（2026-09-16）では、その CSP が SDK の取得を拒否している:

```
Refused to load the script 'https://static.opentok.com/v2/js/opentok.min.js'
because it violates the following Content Security Policy directive:
"script-src 'self' 'nonce-…'".
```

`src/lib/security/csp.ts` の `buildCsp` は `script-src 'self' 'nonce-…'` /
`connect-src 'self' blob:` / `media-src 'self' data:` で、**外部オリジンを 1 つも許可していない**。
`src/adapters/call/vonage-client.ts` はその CDN を動的 `<script>` で読む。
したがって **`onError` が実資格情報の有無に関わらず常に発火する** ——
「認証情報が無いから繋がらない」ではなく、**配信側の設定で繋がらない**。

影響は担当者側だけではない。`new VonageCallClient(` の本番消費者は
**`StaffCallView` と `KioskCallView` の 2 つ**（`src/adapters/call/vonage-client.test.ts` が
走査で固定している）で、**来訪者側の映像通話も同じ理由で成立しない**。

### 壁は 1 つではない（増分 2 で扱う）

| 壁 | 現物 | 状況（実測） |
| --- | --- | --- |
| `script-src` | `src/lib/security/csp.ts` | 外部オリジン無し。**拒否を確認済み** |
| **COEP `require-corp`** | `next.config.ts` / `infra/lib/stacks/web-stack.ts` | 🔴 **`script-src` を開いても止まる。** CDN は `Cross-Origin-Resource-Policy` を返さないので、`crossorigin` 無し（no-cors）の cross-origin script は `ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep` になる。**`crossorigin="anonymous"` を付ければ通る**（`Origin` 付きなら CDN は `access-control-allow-origin: *` を返す） |
| `connect-src` / `media-src` | 同上 | signaling / media の接続先が要る。**静的なホストは SDK のソースから引ける**（下記）。残る未知は**セッションごとに動的に割り当たる**メディア/シグナリングのホストだけ |
| 🔴 **`style-src 'self'`** | 同上（#289 が `unsafe-inline` を明示的に排除した） | **壁 1・2 を開いた実測で 4 つ目の壁として出た。** SDK が inline style を当てるため `Refused to apply inline style` が 2 件。**ホストを足しても解けない** |

🔴 **方式 A は「CSP に 1 行足す」では済まない。** `src/adapters/call/vonage-client.ts` の
`defaultLoadSdk` に **`script.crossOrigin = 'anonymous'` を足すコード変更**を伴う。
「A は依存が増えないだけ」という説明は誤りだった（レビュー 1 周目の実測で訂正）。

#### 壁 1・2 を開いたときに実際に起きること（2026-09-16 実測）

`script-src` に CDN を許可し、`defaultLoadSdk` に `crossOrigin = 'anonymous'` を足した
隔離ツリーを実ビルドし、担当者画面を開いた結果（`ignoreHTTPSErrors` で証明書の壁は迂回）:

```
typeof OT: object                                      ← SDK は読める（壁 1・2 は解ける）
Refused to apply inline style ... "style-src 'self'"   ← 🔴 4 つ目の壁（2 件）
Refused to connect to 'https://config.opentok.com/project/<app>/config.json'
Refused to connect to 'https://video.api.vonage.com/session/<id>?extended=true'
Refused to connect to 'https://hlg.tokbox.com/prod/logging/ClientEvent'
OT_CONNECT_FAILED (1006)
```

🔴 **`style-src` は「ホストを足す」では解けない。** 選択肢は (a) ハッシュを列挙する
（SDK の版に追随する必要がある）、(b) `unsafe-inline` を戻す（**#289 の決定を覆す**）、
(c) SDK の UI を使わない、のいずれか。**増分 2 の方式選択（A/B）と一緒にユーザー判断へ回す。**

#### 静的ホスト（SDK バンドルの grep。2026-09-16。**網羅ではない**）

`https://static.opentok.com/v2/js/opentok.min.js`（2.8 MB）を落として
`https://` のリテラルを拾った結果。**選別の基準を書いておく** ——
下は「prod の通常経路で出るもの」で、**条件付き・非 prod のものを含まない**:

```
config.opentok.com    anvil.opentok.com    hlg.tokbox.com
static-eu.opentok.com static.opentok.com   video.api.vonage.com
```

含めなかったもの（**増分 2 で機能を有効にするなら要る**）:

- `d3opqjmqzxf057.cloudfront.net` … 背景ぼかし・ノイズ抑制のモデル取得先
  （`noise-suppression/` / `vonage-tensorflow-wasm/` / `ml/vonage_selfie_segmenter/`）
- `cdn.jsdelivr.net` … **別ベンダの CDN**。MediaPipe `tasks-vision` の既定取得先
  （`@mediapipe/tasks-vision@…/+esm` と `${o}/wasm`）で、背景ぼかし系を
  `modelAssetUriPath` 未指定で有効にすると使われる。**依存/送信先が増えるので #105 の対象**
- `static.rel.tokbox.com` / `static.dev.tokbox.com` … 非 prod 分岐

`wss://` のリテラルは 1 つも無い（`grep -c wss` → 0）―― **シグナリング/メディアのホストは
実行時に組み立てられる**。当初この節は「必要ホストの一覧はどこにも無い」と書いていたが
**言い過ぎ**で、外部待ちなのは**動的ホストだけ**である。

🔴 動的ホストを扱うためにワイルドカードへ逃げたくなるが、**`buildCsp` が返す CSP に
ホスト source を足すと `src/lib/security/csp.test.ts` が赤くなる**（全文固定＋
「引用キーワードでもディレクティブ固有スキームでもない source」の報告）。

🔴 **ただし「緩め方の誤りは全部機械が止める」とは書けない。** レビュー 8 周目の実測で、
**赤くならない緩め方が 2 つ**見つかった（どちらも修正済みだが、射程は限定して書く）:

| 緩め方 | 8 周目の実測 | 今の扱い |
| --- | --- | --- |
| `buildCsp` に opts を 1 つ足し、経路別に緩める（`call: pathname.startsWith('/kiosk')`） | **unit 8824 + e2e 29 とも緑**。`/kiosk` に `*` を配りながら無言。検査が**3 つの呼び出し形**にしか当たっていなかった | opts のキーを**型**で縛り（`Record<keyof …, …>`。キーが増えると `TS2741`）、**直積の全域**に当てる（I1/I2/I3）。`proxy.test.ts` が**全ルート**を走査して全文固定（I4） |
| `proxy.ts` 側で経路・cookie・query・ヘッダ・環境変数を条件に CSP を緩める | 9・10 周目の実測で**全緑**（リテラル表に無い `/demo/`、cookie 条件、query、`sec-fetch-dest`、`process.env.CSP_DEV_RELAX`）。テストレーンでは env が未設定なので**期待値と実測が揃って緩まず、本番だけが緩む** | **導出を `csp.ts` の `cspOptionsFor(pathname)` へ移した**（引数にリクエストの形は渡せない）。env の面は**実行時に読まれた env キーを記録**して `NODE_ENV` 以外がゼロであることを縛る（綴り非依存）。`proxy.ts` 側は**読まれた env キー全部に毒値を入れても配る CSP が変わらない**ことを負の対照で縛る |
| `OPTION_VALUES` に `[undefined]` だけのキーを足して緩和を仕込む | 10 周目の実測で **tsc 0 / unit 8842 本とも全緑**。I3 はキーが宣言されたので黙り、直積は緩和側の枝を一度も踏まない（個数は積なので下界 10 も動かない） | 各キーが**出力を実際に動かす値**を持つことを縛る（直積の非空虚性） |
| `csp.ts` がモジュールスコープで `process.env` を読む | 9 周目の実測で**全緑**（テストでは未設定なので**本番だけが緩む**） | **実行時に読まれた env キーを記録**し `NODE_ENV` 以外がゼロであることを縛る（`vi.resetModules()` + 動的 import なのでモジュールスコープも拾う）。`NODE_ENV` 自体への依存は別の 2 本が**モジュールを評価し直して**総当たりする |
| 引用キーワードだけの新ディレクティブ（`script-src-elem 'self' 'unsafe-inline'`） | **緑のまま nonce 無し inline script が実行された**（負の対照で確認）。`-elem` は `script-src` / `style-src` を**上書きする** | ディレクティブ名を allowlist 化（I2）。前方一致の引き方も完全名へ直した |

**この 2 つは「方式を allowlist へ裏返したときに生まれた新しい族」**である。2 周目の述語版は
ディレクティブ名を見ずに殺していたので、概念上存在しなかった。

🔴 **増分 2 がやることは 3 つある**（「期待値を書き換える」だけでは緑にならない）:

1. `buildCsp` を緩める（**ホスト境界を持つ形**まで絞る。`https://*.opentok.com` など）
2. `EXPECTED_PROD_CSP` を同じ内容へ書き換える
3. **許可の機構を導入する** —— 今日はホストの allowlist を持っていない
   （空の Set を置いたが、守るものが無いので撤回した）。実際に許可するホストを持った
   時点で導入し、そのとき満たすべき不変条件を書く。**その判断が diff に出るのが設計**

**オプションを足すなら** `OPTION_VALUES` にも足す（足さないと **typecheck が落ちる**。
`readonly x?:` のような綴りでも効く —— ソース走査を撤回して型検査へ裏返したため）。
**ディレクティブを足すなら** `PINNED_DIRECTIVE_NAMES` と個別テストも足す（I2 が赤くなる）。
**経路を足すなら**`page.tsx` / `route.ts` なら何もしなくてよい（走査が自動で拾う）。
**メタデータルート**（`manifest.ts` / `icon.tsx` / `sitemap.ts` 等）は走査の射程外なので、
`src/proxy.test.ts` の `EXTRA_PROBE_PATHS` へ足すこと。
**`OPTION_VALUES` に値を足すなら**、その値が**出力を実際に動かす**こと（`[undefined]` だけにしない）。

🔴 **機械で止まらない面を明示しておく**（増分 2 の PR で **CSP テストの diff を人が読む**こと）:

- **ホスト source は 1 つも許可していない**（許可の機構自体を持たない）。形で判定するのを
  やめたので `*.co.uk` / public suffix / port / path の穴は消えた。増分 2 は上の 3 点を揃える
- **`http://` も報告される**（当初「10055 の射程外なので通る」と書いたが、形で判定するのを
  やめた結果そうなった。安全側のずれ）
- 引用キーワードを値まで縛る個別テストが在るのは **`script-src` / `style-src` /
  `style-src-attr` / `default-src` の 4 つだけ**。残り 8 ディレクティブは
  全文固定とディレクティブ名の allowlist だけが守る
- 🔴 **実ビルドで CSP の中身を見ているのは `/` と `/kiosk` と `/admin/login` の 3 経路だけ。**
  unit の全ルート固定（I4）は `NODE_ENV=test` の世界でしか測れないので、
  **本番ビルドで配られる値**を見るのはこの 3 本である
- **`proxy.ts` の経路は走査で全ルートに当てているが、`page.tsx` / `route.ts` の配置から
  導いている。** メタデータルート・`public/` 配信・404 はリテラルの `EXTRA_PROBE_PATHS` で
  補っており、rewrite・middleware matcher の外・将来の配信層は射程外
- **`proxy.ts` が CSP を書き換える形**（戻り値を渡す前・ヘッダへ配った後・別 helper へ
  委譲・配布行を条件で囲む）は、`src/proxy.test.ts` が **CSP を作って配る 2 関数の本体を
  丸ごと固定**して見る（コメントと字下げは落とすので、説明を足すだけでは赤くならない）。
  `CspContext` は **`readonly` ＋ `Object.freeze`** なので、`route()` 経由で
  `csp.value` を書き換える形は、キャスト無しなら **`tsc` が落とし**、キャストを挟んだ場合は
  **実行時にそのリクエストが 500** になる（CSP は緩まないが、**テストは緑のまま**。
  「機械が止める」とは書けない。レビュー 14 周目の実測）。
  13 周目まではここが**開いていた** —— `route()` が参照を持っていた
- **`buildCsp` の出どころ（import 元）**も固定する。薄いラッパへ差し替えると本体テキストは
  変わらないので、本体の固定だけでは足りない（13 周目の実測）
- 🔴 **`config.matcher` は「CSP を配るかどうか」の配線である。** ここから経路を外すと、
  その経路は **CSP も origin-verify も丸ごと効かなくなる**（実測で unit 8860 本が全緑だった）。
  matcher は **I4 で当てている全経路が一致すること**で縛っている（除外 3 本の下界つき）。
  リテラルの固定は 14 周目に**撤回**した —— 一致テストが包含していることを実測で確認済み。
  **「matcher の外は射程外」は「外側のパス」の意味であって、matcher を書き換えてよいという
  意味ではない**
- 🔴 **一度「ソースの綴りで env を縛る」方式を 2 度書いて 2 度撤回した**
  （`/process\.env\.(\w+)/` は `process.env['X']` を、1 行ピンは「配った後の上書き」を
  素通りさせた）。**テキスト走査は fail-open になりやすい** —— 綴りではなく
  **実行時に観測できるもの**で縛ること
- **route handler が自前で `Content-Security-Policy` を設定する**形は射程外
  （今日 CSP を発行する本番コードは `src/proxy.ts` の 2 箇所だけ。全域 grep で確認）
- **CloudFront 層は誰も見ていない。** `infra/lib/stacks/web-stack.ts` の
  `ResponseHeadersPolicy.SECURITY_HEADERS` は CSP 項目を持つ。今日はオリジンが常に CSP を
  返すので上書きされない想定だが、**それを固定したテストは無い**（実 AWS でしか測れない）
- ZAP 10055 本体は `--full` に無い（稼働 URL 前提の手動レーン）。
  ワイルドカード禁止の保証は**この手書き検査 1 本に載っている**
- 🔴 **`NODE_ENV` は allowlist から除外していたので、そこが最後の抜け穴だった**（14 周目）。
  除外をやめ、**`buildCsp` は `NODE_ENV` に一切依存しない**／**`cspOptionsFor` の依存は
  `dev` の 1 ビットだけ**を 1 文字ずつ縛った。`NODE_ENV === 'production'` で条件付けた緩和は
  9 機構すべてと unit 8863 本を素通りしていた。
  🔴 **その 14 周目の対処は関数スコープしか覆っていなかった**（15 周目の実測）——
  モジュールスコープで `const PROD = process.env.NODE_ENV === 'production'` と読むと、
  静的 import 済みのモジュールは `NODE_ENV=test` で一度だけ評価済みなので値が動かず、
  **tsc 0 / unit 8864 / e2e 30 とも全緑**のまま `/kiosk` が本番で `frame-ancestors 'self'` を
  返した（実ビルド ＋ `curl` で確認）。総当たりを `vi.resetModules()` + 動的 import へ替え、
  **モジュールスコープと関数スコープの両方**を覆うようにした
- 🔴 **env の allowlist と毒値は「全ルート × リクエストの形」で記録した集合に依存する。**
  綴りには依存しないが、**入力のサンプルには依存する** —— 走査で導けない経路
  （`EXTRA_PROBE_PATHS` の外）でだけ env を読む形は射程外である
- 🔴 **リクエストの形（cookie 名・ヘッダ名・query）は数え上げのまま。** 族ごと塞いでいるのは
  「`cspOptionsFor` が pathname しか受け取らない」ことと「2 関数の本体の固定」で、
  変種テストはその 2 つが崩れたときに気づくための第 2 の証人にすぎない
- 🔴 **応答種別を全部無効化したサイトでは、担当者向けの新文言が空の領域を指す（#1137）。**
  e2e は既定シードを見るので**機械では止まらない**。増分 2 / #1129 で経路を分けるときに一緒に閉じる

### 方式（**未決定。停止境界なのでユーザー判断**）

- **A: CDN を allowlist** … `script-src` に具体ホストを足す。依存は増えない
- **B: SDK を同梱** … `@vonage/client-sdk-video` を依存に加える。`script-src 'self'` のままにできるが、
  **npm の `license` が SPDX ではなく Vonage の利用規約 URL**（＝プロプライエタリ・unpacked 23 MB）で、
  `docs/license-privacy-guide.md` §1.3 の許容リストに当たらない。**新規依存＝停止境界**

**どちらを採っても `connect-src` の問題は同じだけ残る。**

### 増分 1（実施済み）でやったこと

方式を選ばずに進められる前提整備だけ:

1. `not.toContain(' https:')`（ZAP 10055）が**具体ホストを巻き添えにしていた**のを、
   **配る CSP そのものの固定**へ裏返した（`src/lib/security/csp.test.ts`）。
   いったん「ワイルドカードとは何か」を判定する述語を書いたが、**禁止の列挙は裾が長く**
   （`https://*` に port や path が付いた形、`*:*`、`script-src data:` …）、
   正規表現へ足し続ける形になったので**機構ごと撤回した**。
   e2e（`tests/e2e/security-headers.spec.ts`）は中身ではなく**配線**を縛る
2. 通話画面で CSP 違反が出ていることを **e2e が固定**した。
   **#1132 増分 2 が CSP を開いたらその test が赤くなる**契約（`broken-deploy-reachability.test.ts` と同型）
3. 担当者側 `unreachable` の文言から**回線の断定を外した**（`onError` 側では嘘だったため）。
   🔴 **来訪者側（`KioskCallView`）は検査で充足を確認しただけで、ピンは置いていない** ——
   来訪者が**落ち着く**画面は `reception-screens.tsx` が `CALL_FAILED` を `reason` 無しで
   dispatch した先の **`reception.failedBody`**（「呼び出しに失敗しました。別の方法で
   お呼びすることもできます。」）＋代替導線 CTA で、**5 ロケール**（ja/en/ko/zh/やさしい日本語）
   いずれも回線に触れていない。**今日 AC5 違反は無い。**
   （`kiosk.call.fallback` は `CALL_FAILED` までの短い窓にしか出ないので、当初そちらを
   根拠に挙げていたのは**検査対象を取り違えていた**。レビュー 6 周目で訂正）
   退行ピンを置かないのは、来訪者側の失敗表示が #1129 / 増分 2 で作り替わる見込みだからで、
   **「縛った」とは書かない**
4. 本節を書いた（設計正本と実装のギャップを閉じた）

### 何が本当に外部待ちか（当初の分類を訂正）

当初「AC1（実ブラウザで SDK が読める）も AC3（`connect-src` が足りる）も外部待ち」と書いたが、
**どちらも言い過ぎだった**（レビュー 1 周目の実測）。

| AC | 訂正後 |
| --- | --- |
| AC1 | **この環境で検証できる。** サンドボックスの TLS 終端プロキシを Chromium が信頼しないのは事実だが（`net::ERR_CERT_AUTHORITY_INVALID`）、playwright の `ignoreHTTPSErrors` で越えられる。ただしそれは**証明書検証を外した条件下の確認**なので、実配信の TLS 経路までは保証しない |
| AC3 | **静的ホストは検証できる。** 外部待ちは**動的ホスト**の部分だけ |
| AC6 | AC1 と同じ |

実機（iPad）・実 Vonage 資格情報での通し確認は引き続き **#65** へスタックする。

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
