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

## ディレクトリ
- 純ドメイン: `src/domain/auth/elevation.ts`
- 監査: `src/domain/reception/log.ts`（AuditAction）/ `src/lib/admin/audit.ts`
- （inc4b 以降）セッション連携: `src/lib/auth/**`、ガード適用: `src/app/api/platform/**`
