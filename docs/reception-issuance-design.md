# 受付画面の発行・エンロール設計

LP → ログイン → 管理画面 → **受付画面の発行（URL+QR）** → 受付端末エンロール、の導線を設計する。
受付端末（`/kiosk`）は**公開導線に出さず**（LP 直リンク撤去）、管理画面が発行した URL/QR からの
エンロールで kiosk セッションを確立する。`/kiosk` への直接到達自体のアクセス制御は #23（PIN/IP
allowlist）が担い、`/kiosk` を kiosk セッション必須にする完全なゲートは §6 の後続課題とする。

- 親 / 関連: #87（拠点・受付端末管理 `docs/site-device-management-design.md`）, #23（kiosk セッション）,
  #80（テナント境界・認可）, #19/#22（監査）, #105（ライセンス・プライバシー
  `.claude/rules/pii-secret-minimization.md`）, #97/#98（予約 QR — QR 描画基盤を共有）。
- 本書は increment 方式。**本 PR = increment 1**。

## 1. 背景と現状

- LP `src/app/page.tsx` は `/kiosk` と `/admin` の 2 ボタンハブで、誰でも `/kiosk` を直接開けた。
- 管理ログイン `/admin/login`（password 既定 / Entra 任意）と `src/proxy.ts` の `/admin/*` ガードは完備。
- `DeviceService.reissueToken`（#87 inc2）は `tokenRegistered=true` を立てるのみで、
  **実トークンの発行・配布は次増分に先送り**されていた（本書がその増分）。
- 受付端末 `/kiosk` はハードコード `KIOSK_ID` + PIN/IP authorize → 長期 `kiosk_session` cookie で起動し、
  **URL/QR から起動する経路が無い**。

## 2. 望む導線

```
/ (LP)
  └─[ログイン]→ /admin/login → /admin（管理画面）
        └─ /admin/devices で端末を選び［受付URLを発行］
              → モーダルに URL + QR + 有効期限（平文は一度だけ表示）
                    → その URL/QR を受付端末で開く
                          → /kiosk/enroll?token=… → セッション交換 → /kiosk（受付画面）
```

## 3. トークンモデル（一回限りエンロール → セッション交換）

URL/QR には**使い捨て・期限付きのエンロールトークン**を埋め込む。端末が一度開くと httpOnly な
`kiosk_session` cookie に交換し、トークンは無効化する。端末側に秘密を残さず、以後はリロード/
再起動でも受付画面へ復帰できる（既存 #23 セッションの挙動）。

### 署名トークン

- `src/lib/auth/session.ts` の汎用 `signSession`/`verifySession`（HMAC-SHA256・Web Crypto・role+exp）を再利用。
- role = `kiosk-enroll`、payload = `{ role, exp, tenantId, siteId, deviceId, jti }`。
- 秘密鍵は **server 専用** `KIOSK_ENROLLMENT_SECRET`（未設定時は dev フォールバック）。`NEXT_PUBLIC_` に出さない。
- 既定 TTL = 15 分（`DEFAULT_ENROLLMENT_TTL_MS`）。`verifySession` が exp 切れを null 化する。

### 単回性（再利用防止）

ステートレス署名だけでは再利用を防げないため、**Device に `enrollmentTokenId`（= 現行 jti）を保存**する。

- 発行: 新 jti を採番し `enrollmentTokenId` に保存（旧 URL は無効化）。
- 消費: enroll 時に `jti === device.enrollmentTokenId` を検証。成功で `enrollmentTokenId` を消去（consume）。
- 二度目以降・再発行後の旧 URL は jti 不一致で `used` 拒否。

### 秘密の取り扱い（#105 / #19）

- 平文トークン / URL は**発行 API レスポンスに一度だけ**返す。**永続化・監査・アプリログには残さない**。
- 監査 `device.token_reissued` の metadata は従来どおり id/name/siteId/status のみ（token 値を入れない）。
- QR に載せるのは URL（= 推測困難な token 参照）のみ。PII は載せない。

## 4. 認可

- 発行は **サイト write**（`canAccessSite(write)`、#80 純関数）。viewer 不可・テナント越境拒否（既存 reissue と同等）。
- enroll API（`/api/kiosk/enroll`）は**端末自身のパス**で管理 actor を介さない。`recordHeartbeat`/`authorize` と同じく
  認可せず、トークンの署名・単回性・端末状態（revoked 拒否）で守る。proxy は `/kiosk/*` を素通しする。

## 5. increment 1 実装範囲（本 PR）

- `src/lib/auth/kiosk-enrollment.ts`: `issueEnrollmentToken` / `readEnrollmentToken`（role 検証つき）。
- `Device` 型に `enrollmentTokenId?: string`（jti のみ・平文不保持）を追加。
- `DeviceService.issueEnrollment`（平文を value とは別の一過性フィールドで 1 回返す・audit token-free）と
  `consumeEnrollment`（単回・成功時 `lastSeenAt` 更新・交換用 kioskId 返し）。
- `POST /api/admin/devices/[id]/reissue-token`: レスポンスに `{ enrollmentUrl, expiresAt }` を一度だけ追加。
- `POST /api/kiosk/enroll`: token 検証 → consume → `issueKioskSession` → `kiosk_session` cookie 設定。
- `DevicesManager`: ［受付URLを発行］→ URL（コピー可）+ QR（`renderTextToQrSvg` 再利用）+ 期限 + 再表示不可の注意。
- `src/app/kiosk/enroll/page.tsx`: `?token=` を POST し成功で `/kiosk` へ `replace`、失敗は明確なメッセージ。
- `src/app/page.tsx`: LP を **ログイン主導線**へ。公開 `/kiosk` 直リンク撤去。

### エラー区分（enroll API）

| 状態 | HTTP | UI メッセージ |
| --- | --- | --- |
| 署名NG / exp 切れ | 400 `invalid_token` | URL が無効か期限切れです。管理画面で再発行してください。 |
| jti 不一致（消費済/再発行後） | 409 `used` | この URL は既に使用されています。 |
| 端末が見つからない | 404 `not_found` | 端末が見つかりません。 |
| 端末が無効（revoked） | 403 `revoked` | この端末は無効化されています。 |

> 署名検証は exp 切れと改ざんを区別できないため `invalid_token` に集約する（UI は「無効か期限切れ」と案内）。

## 6. 非スコープ（後続）

- **`/kiosk` の kiosk セッション必須ゲート**: 本増分は LP から公開直リンクを撤去し、エンロールで
  セッションを確立する導線を入れたが、`/kiosk` への直接到達自体は依然可能（アクセス制御は #23
  PIN/IP）。セッション未保持なら「未エンロール」画面へ誘導するゲートは後続で入れる（既存 e2e の
  `/kiosk` 直接遷移前提の見直しを伴う）。
- **エンロール consume の原子性**: `consumeEnrollment` は read→check→put で、条件付き書き込み
  （compare-and-swap）を持たない。同一 URL の同時アクセスで二重消費の理論的レースがある。実害は
  DynamoDB 永続化増分で顕在化するため、その増分で条件式付き `putDevice`（または専用 CAS）にする。
- 実機 iPad での発行〜エンロール疎通検証（#65 にスタック。実機・実 URL が要る）。
- Device と既存 kiosk レジストリ（#18）の完全統合（kioskId ↔ deviceId 一意化の本対応）。
- 複数テナント切替 UI（#87 後続）。Entra ロール写像。
- トークンの DynamoDB 永続化最適化（現状 in-memory / DataBackedTenantStore に準拠）。
- 受付 URL の bearer トークンはクエリ文字列で運ぶ（既存予約 QR `rt=` と同方式）。アクセスログ/
  履歴への露出を避ける強化（POST 受け渡し等）は後続のハードニング候補。

## 7. テスト

- token util: 署名往復・exp 切れ・改ざん・role/secret 不一致 → null。
- service: `issueEnrollment` が enrollmentTokenId/ tokenRegistered を立て平文を 1 回返す・audit が token-free・
  viewer forbidden・越境拒否。`consumeEnrollment` が単回成功（jti 消去・lastSeenAt 更新）・二度目 used・
  not_found・revoked。
- enroll route: invalid_token(400) / 正常(200・Set-Cookie) / 二度目(409)。
- LP / enroll page は DOM テスト基盤が無いため build + 手動/E2E で検証。
