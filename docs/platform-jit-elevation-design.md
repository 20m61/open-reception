# JIT 権限昇格・危険操作の安全装置 設計 (issue #83 inc4 / #91)

総合開発者（`developer`）等の上位ロールでも危険操作を常時許可せず、**理由付き・対象スコープ
限定・期限付きの一時昇格（Just-in-Time elevation）**を必須にするための設計。read 系（inc3）が
出揃った後の「書き込み解禁」フェーズ。本書は inc4a（基盤）で確定した方針を記す。

## 原則（#83 準拠）
- 通常時は読み取り中心。破壊的・機密操作は明示的な一時昇格を必須にする。
- 昇格は最小権限・期限付き（既定 30分、15〜60分）。失効後は自動で読み取りへ戻る。
- すべての昇格・危険操作を監査に残す（reason・対象スコープ。PII/機微値は残さない）。

## 既存土台の再利用
- 監査: 統一 `AuditLog`（`src/domain/reception/log.ts`）＋ `recordDangerAction` /
  `sanitizeAuditMetadata`（`src/lib/admin/audit.ts`, #91）。並行スキーマは作らない。
- セッション: 署名付き admin セッション（`SessionPayload` は拡張可能 `[key: string]: unknown`）。
- 認可: `authorizePlatform()` / `canWrite` / `src/domain/tenant/authorization.ts`。

## 設計判断
- **昇格の保持**: 署名付きセッションに `elevation`（`until`/`reason`/`scope`）を載せる。サーバ側
  ストアは持たず署名で改ざんを防ぐ。判定は純ドメイン（`src/domain/auth/elevation.ts`）。
- **監査スキーマ**: 統一 `AuditLog` を踏襲。`reason`・対象スコープ・（将来）before/after・ip/ua は
  sanitize 済 metadata 文字列で持つ。新規 AuditAction: `privilege.elevated` / `auth.reauthenticated`。
- **MFA 再認証**: interface + mock 先行（CLAUDE.md ガード）。`provider=entra`→step-up、`provider=none`
  →パスワード再入力。実 MFA は #65 / Entra にスタック。
- **break-glass**: 分離概念として定義し後続増分で実装（緊急権限・高重要度監査）。

## スコープ判定
昇格スコープ `{tenantId?, siteId?, deviceId?}`（undefined=ワイルドカード）が操作対象を覆うかで判定
（`elevationCoversScope`）。platform 全体昇格 `{}` は全対象を覆い、tenant 昇格は当該テナント配下を
覆うが platform スコープ操作は覆わない。

## increment 計画
- **inc4a（実装済・非破壊）**: 純ドメイン `elevation.ts`（`grantElevation`/`isElevated`/
  `elevationCoversScope`/`requireElevation`/`elevationAuditMetadata`）＋ AuditAction 2 件追加＋テスト。
  **破壊的操作は一切解禁しない**（基盤のみ）。
- **inc4b**: 再認証/理由入力フロー（mock MFA）＋セッションへの昇格載せ降ろし＋危険操作 1 件
  （例: テナント機能フラグ変更）を `requireElevation` 越しに解禁。`privilege.elevated` を監査。
- **inc4c+**: 他の危険操作（制限変更・メンテ発動・障害/お知らせ登録・保守操作）・break-glass・
  高詳細監査コンテキスト（before/after・ip/ua・riskLevel）。

## inc4b 詳細設計（**レビュー用・未実装**）

inc4a の純ドメイン（`grantElevation`/`isElevated`/`requireElevation`/`elevationCoversScope`）は
実装済み。inc4b はこれを**セッションと write ルートに配線**する。実装前に以下を確定する。

### (1) 昇格の保持は「独立した短命署名 cookie」にする
当初案（admin セッションに `elevation` を載せる）を見直す。actor 解決は SSO トークン由来
（`resolveAdminActor`：Entra/Cognito の署名トークン検証）で、**書き換え可能な署名 admin セッション
cookie が常に在るとは限らない**。よって昇格は**別 cookie** に分離する（既存ログインを一切壊さない）。

- Cookie: `platform_elevation`（`HttpOnly; Secure; SameSite=Strict; Path=/`）。
- ペイロード（`signSession/verifySession`（`src/lib/auth/session.ts`）を再利用、HMAC-SHA256 + `exp`）:

  ```ts
  type ElevationClaim = {
    role: 'platform_elevation';   // verifySession の role カテゴリ
    sub: string;                  // 昇格した developer の安定 subject（別人の cookie 使い回し防止）
    exp: number;                  // grantElevation の until（既定 30 分）
    scope: ElevationScope;        // inc4a の {tenantId?,siteId?,deviceId?}
    reason: string;               // 必須・sanitize 済み
    jti: string;                  // リプレイ/失効検知
  };
  ```
- secret は admin session とは別 env（`PLATFORM_ELEVATION_SECRET`、Secrets Manager #194）。
- `verifyElevation(cookie, actor)`: 署名 + `exp` を `verifySession` で確認 → `role==='platform_elevation'`
  かつ `sub === actor の subject` を要求 → inc4a の `Elevation` を復元。

### (2) 再認証エンドポイント `POST /api/platform/elevate`
1. `authorizePlatform()`（未認証 401 / 非 developer 403）。
2. body `{ reason, scope?, credential }`。`reason` 必須（空は 400）。`scope` 既定は platform 全体 `{}`。
3. **再認証**は interface 先行（`reauthenticate(provider, credential)`）:
   - inc4b: **mock**（`provider=none` はパスワード再入力、テストは固定 mock）。
   - 実 MFA（Cognito `SOFTWARE_TOKEN_MFA`/TOTP）は `cognito-srp.ts` に検証経路を足すが**実物は #65**。
4. 成功: `grantElevation(scope, reason, now, 既定30分)` → `ElevationClaim` を Set-Cookie。
   `recordDangerAction`（`auth.reauthenticated` + `privilege.elevated`、reason・sub・scope）を監査。
5. 失敗: 403。監査に否認を残す（**credential/OTP は残さない**）。
- `POST /api/platform/elevate/end`（任意）: cookie 失効。

### (3) write ゲート `assertElevated(request, target)`（`src/lib/platform/request.ts`）
```
authorizePlatform() → verifyElevation(cookie, actor) → requireElevation(elevation, targetScope, now)
  → ok: 処理本体 + recordDangerAction(before/after/reason/actor/IP/UA)
  → ng: 403 { error:'elevation_required' | 'out_of_scope' | 'expired' }（UI が昇格導線を出す）
```

### (4) inc4b で最初にゲートする write
**テナント機能フラグ変更**（AC5 の直接対象・影響が限定的）を 1 本だけ実装し、`assertElevated` +
`recordDangerAction` を通す。以降の write（利用制限・メンテ発動・障害/お知らせ登録・保守操作）は
**同じ型**で inc4c 以降に追加する。

### (5) テスト（inc4b）
- `verifyElevation`: 署名改ざん/期限切れ/sub 不一致で null。
- `POST /elevate`: 非 developer 403 / reason 空 400 / mock 再認証成功で cookie＋監査。
- flag 変更 write: 未昇格 403(elevation_required) / 昇格中 200＋before/after 監査 / scope 外 403。

### レビュー論点（**確定済み** 2026-07-01）
1. 昇格ウィンドウ = **30 分**（inc4a 準拠）。
2. ロール = **現 `developer` のまま**（新ロールを作らず scope 判定。昇格は `platform_elevation` cookie で表現）。
3. PlatformAuditLog = **既存 `audit` ストア再利用**（`/platform/audit-logs` read 配線済み・重複を作らない）。
4. 最初にゲートする write = **機能フラグ変更**（`POST/PATCH /api/platform/feature-flags`）。
5. `jti` = inc4b は **cookie 失効のみ**（サーバ側失効リストは持たない）。将来必要なら別増分。
6. MFA = **interface + mock 先行**（`reauthenticate(provider, credential)`）。実 Cognito TOTP は #65。

## ディレクトリ
- 純ドメイン: `src/domain/auth/elevation.ts`（inc4a 実装済）
- 監査: `src/domain/reception/log.ts`（AuditAction）/ `src/lib/admin/audit.ts`
- （inc4b）昇格 cookie: `src/lib/auth/session.ts` 再利用 + `src/lib/platform/request.ts`（`assertElevated`）、
  再認証エンドポイント `src/app/api/platform/elevate/route.ts`、ガード適用: `src/app/api/platform/**`
