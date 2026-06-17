# ソース構成

UI / ドメインロジック / アダプタ / インフラを分離する (issue #9)。

```text
src/
  app/            Next.js App Router (ルート / レイアウト / API Route)
    kiosk/        受付端末画面 (/kiosk)
    admin/        管理画面 (/admin, 認証・認可必須)
    api/
      kiosk/      受付端末用 API (/api/kiosk/*)
      admin/      管理用 API (/api/admin/*, 認証・認可必須)
  components/     UI コンポーネント
    kiosk/        受付端末向け
    admin/        管理画面向け
    ui/           共通 UI
  domain/         ドメインロジック (フレームワーク非依存)
    reception/    受付セッション / 状態遷移 (issue #10, #16)
    staff/        担当者 (issue #13, #26)
    department/   部署 (issue #13, #25)
    security/     アクセス制御 / kiosk session (issue #23, #29)
    assets/       背景 / VRM / モーション (issue #27, #31)
  adapters/       外部サービス境界
    call/         呼び出し (Vonage / mock) (issue #4, #20)
    speech/       TTS / STT (issue #28)
    storage/      アセットストレージ (issue #27)
  lib/            横断ユーティリティ
    auth/         認証・認可 (issue #24)
    config/       アプリ設定
    validation/   入力・スキーマ検証 (issue #7, #14)
```

## 認可境界の方針 (issue #24)

- `/kiosk` と `/api/kiosk/*` は長期 kiosk session 前提。
- `/admin` と `/api/admin/*` は管理者認証・認可必須。
- kiosk session で管理 API を操作できない。
- Vonage secret / 管理 secret は server-only に閉じ込め、client component へ流出させない。
