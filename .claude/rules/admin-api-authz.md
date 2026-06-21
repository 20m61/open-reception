---
paths:
  - "src/app/api/admin/**"
  - "src/app/api/platform/**"
---

# 管理 API の認可（#80 / #91）

`src/app/api/admin/**` と `src/app/api/platform/**` のルートハンドラは、処理本体の前に
必ず認可ガードを通す。クライアントが送る `tenantId`/`siteId` をそのまま信用しない。

- actor は `resolveAdminActor()`（`@/lib/auth/actor`）で解決する。未認証は 401。
- 認可は `@/lib/admin/guard` のヘルパで行う:
  - read: `requireActor()` + `assertCanRead(actor, tenantId)` / `assertCanReadSite(...)`
  - write（作成/更新/失効/削除）: `assertCanWrite(...)` / `assertCanWriteSite(...)`。viewer は書込不可。
- テナント越境は拒否（403 または存在秘匿の 404）。`developer` のみ横断可。
- platform ルートは developer 限定（`canEnterArea(actor, 'platform')`）。
- 認可判定そのものは `src/domain/tenant/authorization.ts` の純関数に委譲し、ルートで再実装しない。
