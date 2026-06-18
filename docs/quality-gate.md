# 品質ゲート（Lighthouse / アクセシビリティ） (issue #38)

受付端末は kiosk 的に長時間表示され来訪者が直接操作するため、パフォーマンス・
アクセシビリティ・タッチ操作性の劣化を早期に検知する。

**本リポジトリは GitHub Actions を使用しない方針**のため、品質ゲートは
ローカル（または将来 Actions 以外の CI を採用する場合はそのランナー）で実行する。

## 実行コマンド

```bash
npm run verify        # typecheck / lint / unit / build
npm run test:e2e      # iPad viewport の E2E（axe a11y を含む）
npm run lighthouse    # Lighthouse CI（performance / accessibility / best-practices / seo）
```

`npm run lighthouse` は本番ビルドを `npm run start` で起動し、主要ルートを検査する
（`lighthouserc.json`）。Chrome が必要で、`CHROME_PATH` で明示できる。

```bash
# 例: Playwright の Chromium を使う
CHROME_PATH=/path/to/chrome npm run build && npm run lighthouse
```

## 対象ルート（PR smoke）

- `/`（入口）
- `/kiosk`（受付待機）
- `/admin/login`（管理ログイン）

main / nightly では主要画面（目的選択・担当者選択・入力・呼び出し中・結果）まで
広げることを推奨する。VRM / 音声 / 通信は mock 可能な状態で検査する。

## 閾値（段階導入）

| 指標 | 閾値 | 区分 |
| --- | --- | --- |
| Accessibility | ≥ 0.90 | error（未満で失敗） |
| Best Practices | ≥ 0.90 | error（未満で失敗） |
| Performance | ≥ 0.70 | warn（CI 環境差が大きいため大幅劣化検知を重視） |
| SEO | 参考値 | off（kiosk アプリのため必須にしない） |
| axe critical / serious | 0 件 | E2E（`tests/e2e/a11y.spec.ts`、#7） |
| axe moderate | 原則 0 件 | 例外は理由を記録 |

### 現状の参考スコア（ローカル測定）

| ルート | Performance | Accessibility | Best Practices |
| --- | --- | --- | --- |
| `/` | ~0.99 | 0.92 | 0.96 |
| `/kiosk` | ~1.0 | 0.92 | 0.96 |
| `/admin/login` | ~1.0 | 0.93 | 0.96 |

## 例外・注意

- Performance は CI 環境差が出るため、初期は絶対値より**大幅劣化の検知**を重視する（warn）。
- 本番相当の重い VRM アセットは常時検査せず、PR では軽量 fixture を使う。
- iPad / Safari 固有の問題は Playwright WebKit smoke（iPad viewport）でも補完する。
- アクセシビリティの最重大（critical/serious）違反は E2E（axe）で 0 件をゲートする。

## 関連

- a11y E2E: `tests/e2e/a11y.spec.ts`（#7）
- セキュリティ・テスト方針: `docs/security-testing-plan.md` / `docs/security-checklist.md`（#6）
