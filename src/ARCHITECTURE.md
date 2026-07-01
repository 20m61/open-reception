# ソース構成

UI / ドメインロジック / アダプタ / インフラを分離する (issue #9)。
**domain/ はフレームワーク非依存**（next/react/adapters を import しない）を厳守する。

```text
src/
  proxy.ts          ルート保護 (Next 16 で middleware から改称。admin/platform 認証リダイレクト)
  instrumentation.ts起動時初期化
  app/              Next.js App Router
    kiosk/          受付端末画面 (/kiosk, 長期 kiosk session)
    admin/          テナント管理画面 (/admin, 認証・認可必須)
    platform/       プラットフォーム運用コンソール (/platform, developer 限定) (issue #83)
    staff/          担当者応答画面 (/staff)
    api/
      kiosk/        受付端末 API (/api/kiosk/*, 公開 + kiosk session)
      admin/        管理 API (/api/admin/*, 認証・認可必須)
      platform/     プラットフォーム API (/api/platform/*, developer + JIT 昇格)
  components/
    kiosk/          受付端末向け (avatar/ 含む。three/three-vrm は VrmAvatarViewer 内で動的 import)
    admin/          管理画面向け (admin/platform/ = 運用コンソール UI)
    staff/          担当者向け
    ui/             共通 UI
  domain/           ドメインロジック (フレームワーク非依存・純関数中心)
    reception/      受付セッション / 状態遷移 / UI 契約 / カスタムフロー
    tenant/         マルチテナント認可 (authorization.ts が認可判定の単一実装)
    auth/           ロール / JIT 昇格 (elevation) / エリア・画面ガード (route-guard)
    platform/       運用コンソール集計 (console-summary 等)
    staff/ department/ security/ assets/ ほか (visit, signage, usage, audit, …)
  adapters/         外部サービス境界
    call/           呼び出し (Vonage / mock) (issue #4)
    speech/         TTS / STT
    storage/        アセットストレージ
  lib/              横断ユーティリティ / サービス層 / データアクセス
    auth/           actor 解決・セッション (resolveAdminActor)
    admin/          admin API ガード (guard.ts: requireActor/assertCanRead/assertCanWrite)
    platform/       platform API ガード (request.ts: authorizePlatform/assertElevated)
    data/           データバックエンド抽象 (backend.ts: Collection/Singleton/LogStore、
                    index.ts が DATA_BACKEND env で memory / dynamodb を選択) (#273)
    mock-backend/   実データアクセス層 (名前に反して本番経路。リネーム予定 #273)
    tenant/ notification/ checkin/ reservation/ signage/ call/ i18n/ ほか
  server/
    notification/   通知ワーカー側 (handler/authorizer/polly/vonage adapter) (#275 で lib と統合予定)
infra/              AWS CDK (web-stack / notification-stack) — OpenNext + DynamoDB
scripts/            quality-gate.sh / seed-dynamodb.ts / url-quality-gate.sh
tests/e2e/          Playwright (iPad viewport)
```

## 認可境界の方針 (issue #24, #80, #83)

- `/kiosk` と `/api/kiosk/*` は長期 kiosk session 前提。kiosk session で管理 API を操作できない。
- `/admin` と `/api/admin/*` は管理者認証・認可必須。テナント越境は拒否（developer のみ横断可）。
- `/platform` と `/api/platform/*` は developer 限定。**破壊的操作は JIT 昇格**
  （`domain/auth/elevation.ts` + `lib/platform/request.ts` の `assertElevated`）を必須とする。
- 認可判定は `domain/tenant/authorization.ts` の純関数に一元化し、ルートで再実装しない。
  入口 UX ガードは `domain/auth/route-guard.ts`（canEnterArea 等）。最終認可は必ず API 側。
- Vonage secret / 管理 secret は server-only に閉じ込め、client component へ流出させない。

## データ層 (issue #273, #274)

- ルート → `lib/*` サービス/store → `lib/data` バックエンド（memory | dynamodb 単一テーブル）。
- **本番は `DATA_BACKEND=dynamodb` 必須**。デプロイ実行（Lambda マーカーあり）で未設定なら
  起動時に throw する fail-closed（#273 inc1 済。判定は `resolveBackendKind`）。
- 永続化イディオムは store 直呼びと repository 三点セットが併存中 → 収斂方針は #274。
