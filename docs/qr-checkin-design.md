# QR 読み取りチェックイン（Kiosk）設計 (issue #98)

受付端末 `/kiosk` で QR を読み取り、来訪予約（#97）を取得してチェックインする機能の設計。

QR 読み取り後に**即時呼び出しは行わず**、予約内容確認画面を挟んでから来訪者が
明示的に「呼び出す」を押す。誤読・スクリーンショット転送・他人の QR 利用・期限切れ・
使用済み QR があり得るため、読み取り後は**必ず確認操作**を経由する。

親 Issue: #96 / 関連: #97（予約・QR 発行）, #10–#16（受付フロー/状態機械）,
#80（テナント境界・認可）, #19/#22（監査）, #105（ライセンス・プライバシー）。

本書は increment（増分）方式で実装する。**今回の PR は increment 1**
（チェックインフロー状態機械 + token 解決 service + checkin API route + 注入可能な
scanner アダプタ（mock）+ UI（カメラ権限確認 / QR スキャン / 予約確認 / エラー）+ 本書 +
ユニットテスト）。実カメラ QR デコードライブラリの採用は increment 2 へ送る（後述）。

---

## 1. スコープ

### increment 1（本 PR）

- チェックインフロー状態機械（`src/domain/checkin/state.ts`）。
- token → 予約サマリ解決と「確認後のみ使用済み化」する service（`src/lib/checkin/**`）。
  #97 の repository / service / lifecycle 純関数を **import 利用のみ**（編集しない）。
- checkin API route（`src/app/api/kiosk/checkin/**`）: token から**最小限**の予約サマリ取得、
  および確認後の受付セッション接続。
- 注入可能な **scanner アダプタ** interface（`src/domain/checkin/scanner.ts`）と
  inc1 用 mock 実装（`src/lib/checkin/mock-scanner.ts`）。
- UI（`src/components/kiosk/CheckinFlow.tsx` ほか）: 受付方法選択導線、カメラ権限確認、
  QR スキャン、予約内容確認、各エラー表示、通常受付フォールバック。
- `/kiosk` への「QR で受付」導線を**非破壊**で追加。

### 非スコープ（後続 increment / Issue 非スコープ）

- 実カメラ QR デコードライブラリの採用（increment 2。§6 ライセンス判断参照）。
- 顔認証 / 画像保存 / 録画 / スクリーンショット保存（Issue 非スコープ）。
- QR 読み取りだけでの自動呼び出し（設計上禁止。確認操作必須）。
- 来訪予約作成画面（#97 の admin 側）。
- DynamoDB 実装（#97 increment 3 に追従）。

### 触らない（import のみ）

- `src/domain/reservation/**` / `src/lib/reservation/**`（#97）。
- admin 配下・他トラック領域。

---

## 2. チェックインフロー状態機械

`src/domain/checkin/state.ts`。受付フロー状態機械（`src/domain/reception/state.ts`）に
倣い、状態 × イベントの遷移表で不正遷移を防ぐ。UI から場当たり的に画面遷移を制御しない。

```text
idle（待機）
  └ START ─▶ selectingMethod（受付方法選択）
selectingMethod
  ├ CHOOSE_QR ─▶ checkingCamera（カメラ権限確認）
  └ CHOOSE_MANUAL ─▶ manualFallback（通常受付へ委譲）
checkingCamera
  ├ CAMERA_GRANTED ─▶ scanning（QR 読み取り）
  ├ CAMERA_DENIED ─▶ cameraError（カメラ不可）
  └ CANCEL ─▶ idle
scanning
  ├ QR_DETECTED ─▶ resolving（予約取得）
  ├ SCAN_ERROR ─▶ scanError（不正 QR / 読み取り不能）
  └ CANCEL ─▶ idle
resolving
  ├ RESERVATION_OK ─▶ confirming（予約内容確認）
  ├ RESERVATION_EXPIRED ─▶ expiredError
  ├ RESERVATION_USED ─▶ usedError
  ├ RESERVATION_REVOKED ─▶ revokedError
  ├ RESERVATION_INVALID ─▶ scanError
  └ RESOLVE_NETWORK_ERROR ─▶ networkError（通信断）
confirming（※ ここで来訪者が明示的に「呼び出す」/「やめる」）
  ├ CONFIRM ─▶ calling（既存呼び出しフローへ接続）
  ├ RESCAN ─▶ scanning（読み直し）
  └ CANCEL ─▶ cancelled
calling
  ├ CALL_DONE ─▶ completed
  └ CALL_FAILED ─▶ networkError
{cameraError, scanError, expiredError, usedError, revokedError, networkError}
  ├ USE_MANUAL ─▶ manualFallback（通常受付へ）
  ├ RETRY ─▶ selectingMethod（カメラ拒否時など最初からやり直し）
  └ RESET ─▶ idle
{manualFallback, completed, cancelled}
  └ RESET ─▶ idle
```

- **確認必須**: `resolving` から呼び出し（`calling`）へ直接遷移する経路は**存在しない**。
  必ず `confirming` を経由し、`CONFIRM` イベント（来訪者の明示操作）でのみ前進する。
- **エラー種別の区別**: 期限切れ / 使用済み / 失効 / 不正 QR / 通信断 / カメラ不可を
  別状態として持ち、UI が文言を出し分ける（受け入れ条件）。
- **フォールバック**: どのエラー状態からも `USE_MANUAL` で通常受付へ完走できる。
  カメラ拒否（`cameraError`）でも通常受付に戻れる（セキュリティ要件）。
- `RESET` は全状態から `idle` に戻せる（端末の自動リセット。個人情報を画面に残さない）。

---

## 3. token 解決 service

`src/lib/checkin/service.ts`（`CheckinService`）。

- 入力は QR の payload（`<baseUrl>/kiosk/checkin?rt=<token>` もしくは生 token）。
  `parseReservationCheckinUrl`（#97）で token を取り出す。URL でも生 token でも受ける。
- `ReservationRepository.findByToken`（#97）で予約を引く。**tenantId/siteId 境界**で
  越境参照を防ぐ（高エントロピー token + 境界チェックの二重防御）。
- `isUsableAt`（#97 純関数）で利用可否を判定し、不可の理由（expired / used / revoked /
  out-of-window）を**区別して**返す。`markExpiredIfNeeded` で期限切れは状態反映する。
- **即時呼び出ししない**: service が返すのは「予約サマリ」のみ。`markUsed`（#97）は
  確認後の `confirm` 操作（受付セッション接続時）に限って呼ぶ。

### 予約サマリ（確認画面用・最小限）

確認画面には**必要最小限**の情報のみを返す。`reservationToken` や `note`、`retentionDays`、
内部 id を**含めない**（画面に長期有効値・余分な PII を残さない）。

```ts
type CheckinSummary = {
  visitorName: string;       // 本人確認のため表示（PII・最小限）
  companyName?: string;      // 任意
  visitAt: string;           // 予定日時
  targetType: 'staff' | 'department';
  targetId: string;          // 呼び出し先解決用（表示名は directory で解決）
  usagePolicy: 'single_use' | 'same_day';
};
```

解決結果は判別共用体で返す:

```ts
type ResolveResult =
  | { ok: true; summary: CheckinSummary }
  | { ok: false; reason: 'expired' | 'used' | 'revoked' | 'invalid' | 'not_found' };
```

通信断（リポジトリ例外）は service より上位（route / UI）で `networkError` として扱う。

---

## 4. checkin API route

`src/app/api/kiosk/checkin/route.ts`。

| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | `/api/kiosk/checkin/resolve` | token（or URL）→ 予約サマリ解決（**使用済み化しない**） |
| POST | `/api/kiosk/checkin/confirm` | 確認後: `markUsed` + 受付セッション作成（既存フロー接続） |

- **kiosk セッション必須**（`readKioskSession`）。管理 API ではなく端末からの要求に限定。
- `resolve` は閲覧のみ。`confirm` で初めて single_use の `markUsed` が走る
  （**確認後のみ使用済み化**）。
- 受付方法（QR 受付 / 通常受付）を受付セッション・監査に記録できるよう、
  `confirm` は `entryMethod: 'qr'` を受付セッション作成に渡す（履歴記録は #16 の
  reception-store 拡張が必要。inc1 では reception 作成時のメタとして渡す経路を用意し、
  store 側のフィールド追加は同トラックの後続で行う — 本 PR では route が受付セッションを
  作成し QR 受付であることを監査ログ（PII なし）に残す）。

### テナント/サイト境界（inc1 の既知の制約）

kiosk セッションは現状 `kioskId` のみを持ち、kiosk→tenant/site 写像は未配線
（#80 / #18 の後続）。#97 `request.ts` が actor 解決を暫定実装にしているのと同様、
inc1 では checkin scope を dev 既定（`asTenantId('dev-tenant')` / `asSiteId('dev-site')`）に
解決する暫定実装とし、実 kiosk→site 解決は次増分で配線する。token 自体が高エントロピーの
ため、境界チェックは越境参照の二重防御として機能する（推測は計算上不可能）。

---

## 5. scanner アダプタ（注入可能・inc1 は mock）

`src/domain/checkin/scanner.ts` に interface を定義し、UI へ**注入**する。

```ts
interface QrScanner {
  start(onResult: (text: string) => void, onError: (e: ScanError) => void): Promise<void>;
  stop(): Promise<void>;
}
```

- inc1 は `src/lib/checkin/mock-scanner.ts`（`MockQrScanner`）で、与えた payload を
  一定遅延後にコールバックする実装。テスト/開発でフロー・エラー・確認画面を完成させる。
- 実カメラ + デコードは increment 2 で実アダプタを差し替える（interface は不変）。
- **新規 runtime 依存（html5-qrcode / @zxing/\* 等）は inc1 では追加しない。**

---

## 6. ライセンス判断ログ — QR デコードライブラリ（採用は increment 2）

`docs/license-privacy-guide.md` §2.1 / §0 / §1.3 に従い、QR **読み取り（decode）**
ライブラリ採用の判断を記録する。**inc1 では新規 runtime 依存を追加しない**
（scanner アダプタ interface + mock でフロー側を完成させる）。

候補の事前調査（採用は increment 2 で最終確認・`npm view <pkg> license` +
`npx license-checker` を別途実行）:

```
- 候補 A: @zxing/library（+ @zxing/browser）/ 想定 v0.21 系
  - ライセンス: MIT（SPDX: MIT。ZXing 本体 Java は Apache-2.0、JS port は MIT 表記）
  - 用途: 受付端末カメラ映像から QR を decode（token 参照 URL のみを読む）
  - 商用利用: 可（MIT、許容リスト内）/ 改変・再配布: 可（帰属表示要）
  - WASM/worker: ピュア JS 実装（WASM 同梱なし）。worker 利用時もライセンスは MIT
  - 特許: QR 基本仕様はロイヤリティフリー。装飾 QR / フレーム QR は使わない
  - 個人情報・映像: カメラ映像は**ローカル処理・非保存**（録画/画像保存しない）
  - 判断: 暫定第一候補（permissive・WASM なしで監査が容易）

- 候補 B: html5-qrcode / 想定 v2.x
  - ライセンス: Apache-2.0（SPDX: Apache-2.0、許容リスト内・NOTICE 転記要）
  - 用途: 同上。カメラ UI を内包し導入は容易だが DOM への結合が強い
  - 内部に zxing-js を内包。transitive ライセンス（Apache/MIT）を increment 2 で確認
  - WASM: 同梱なし（JS）。画像/録画保存はしない設定で使う
  - 判断: 候補。アダプタ interface に合わせるため候補 A の方が結合が薄い

- 候補 C: jsQR / 想定 v1.x
  - ライセンス: Apache-2.0（SPDX: Apache-2.0）。デコーダのみ（カメラ UI なし）
  - 判断: アダプタ実装に最も薄く乗るが、カメラ取得を自前で書く必要あり
```

最終採用は increment 2 で SPDX 再確認 + transitive ライセンス確認
（`npx license-checker`）+ WASM/worker 同梱有無の確認後に決定し、本書に確定記録する。
帰属が要るものは `THIRD_PARTY_NOTICES.md` に集約する。

---

## 7. セキュリティ / プライバシー

- QR 読み取り後も**確認操作必須**（`confirming` を必ず経由）。自動呼び出しは設計上不可。
- 確認画面は**必要最小限**の情報のみ（token / note / id / retentionDays を含めない）。
- 受付完了 / キャンセル / タイムアウト後は `RESET` で**個人情報を画面に残さない**。
- カメラ拒否（`cameraError`）でも**通常受付で完走**できる（`USE_MANUAL`）。
- single_use の使用済み化（`markUsed`）は**確認後の confirm でのみ**実行する
  （閲覧（resolve）では状態を変えない）。
- token 参照のみ（QR に PII を載せない設計は #97 で担保。本機能は読むだけ）。
- 監査ログに来訪者 PII を残さない（#19/#22。残すのは予約 id・targetType・受付方法のみ）。
- カメラ映像は**ローカル処理・非保存**（録画・画像保存・スクリーンショット保存をしない）。

---

## 8. increment 計画

- **increment 1（本 PR）**: 状態機械 / token 解決 service / checkin API / scanner アダプタ
  (mock) / UI（カメラ権限・スキャン・確認・エラー・フォールバック）/ `/kiosk` 導線 / 本書 /
  ユニットテスト。**新規 runtime 依存なし。**
- **increment 2**: 実カメラ QR デコードライブラリの採用（§6 判断を確定）+ 実 scanner
  アダプタ差し替え + iPad Safari/PWA 実機での読み取り検証（#65 スタック） +
  受付履歴への entryMethod（qr/manual）記録（reception-store 拡張） +
  Playwright iPad viewport smoke test の拡充。
- **increment 3**: kiosk→tenant/site 写像の実配線（#80/#18）+ #97 increment 3
  （DynamoDB）への追従。

---

## 関連ドキュメント

- 来訪予約・QR 発行: `docs/visit-reservation-design.md`（#97）
- 受付フロー状態機械: `src/domain/reception/state.ts`（#10）
- テナント境界・認可: `docs/multitenant-design.md`（#80）
- 監査ログ・PII: `docs/audit-logging.md`
- ライセンス / プライバシー: `docs/license-privacy-guide.md`（#105）
</invoke>
