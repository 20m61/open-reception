# VRT-VERIFY-REPORT

**結論: VRT 14/14 PASS（差分 0）、`--full --strict` 全 PASS。マージ可。既存 PR #622 あり。**

対象ブランチ: `claude/vrt-linux-baselines-610`（HEAD `9b2ea7e`）
検証環境: linux（このセッション）。ベースラインは**再生成していない**（`--update-snapshots` 未使用）。

---

## 1. `--update-snapshots` なしの VRT 結果

コマンド: `npx playwright test kiosk-vrt-a11y kiosk-screenshot admin-vrt-a11y`

Playwright のプロジェクト依存（`chromium-ipad` が `pristine-state` に依存）により、指定した
3 ファイルに加えて `pristine-state` プロジェクトの前提テスト（`kiosk-checkout-i18n.spec.ts` 5 件）も
自動的に実行された。想定外の意図しない挙動ではなく、通常の Playwright dependency 挙動。
スクリーンショット断言を含む 3 ファイル分は指示どおり全て実行され、**全 21 件 PASS**。

Playwright サマリ行（そのまま）:

```
Running 21 tests using 2 workers
...
  21 passed (34.6s)
```

### 14 枚のスクリーンショット pass/fail 一覧

| # | スナップショット名 | 対応 spec | 結果 |
|---|---|---|---|
| 1 | kiosk-landscape-purpose-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 2 | kiosk-landscape-target-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 3 | kiosk-landscape-confirm-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 4 | kiosk-landscape-connected-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 5 | kiosk-landscape-timeout-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 6 | kiosk-landscape-failed-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 7 | kiosk-landscape-fallback-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 8 | kiosk-landscape-qr-intro-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 9 | kiosk-landscape-out-of-hours-chromium-ipad-linux.png | kiosk-vrt-a11y.spec.ts | PASS |
| 10 | kiosk-idle-ipad-portrait-chromium-ipad-linux.png | kiosk-screenshot.spec.ts | PASS |
| 11 | kiosk-idle-ipad-landscape-chromium-ipad-linux.png | kiosk-screenshot.spec.ts | PASS |
| 12 | kiosk-idle-large-display-chromium-ipad-linux.png | kiosk-screenshot.spec.ts | PASS |
| 13 | admin-desktop-operating-hours-chromium-ipad-linux.png | admin-vrt-a11y.spec.ts | PASS |
| 14 | admin-desktop-call-routing-chromium-ipad-linux.png | admin-vrt-a11y.spec.ts | PASS |

**14/14 PASS。差分ピクセルの報告は 0 件（Playwright は差分があれば個別に FAIL を出すが、
今回は 1 件も出ていない）。** 再生成は不安定ではなく、意図どおり反映されていたと判断できる。

## 2. 差分ピクセル行

該当なし（全 PASS のため diff レポートは生成されていない）。

## 3. `./scripts/quality-gate.sh --full --strict` サマリ（そのまま）

```
================================================================
 summary (tier=full)
================================================================
  PASS  loop halt / 変更量 (#424)
  PASS  typecheck (tsc)  (33s)
  PASS  lint (eslint)  (34s)
  PASS  unit (vitest)  (47s)
  PASS  build (next build)  (78s)
  PASS  e2e (playwright)  (281s)
  PASS  secrets (gitleaks)  (2s)
  PASS  sast (semgrep)  (46s)
  PASS  audit (npm audit)  (1s)
  PASS  lighthouse (lhci)  (43s)
  PASS  vrm (real render)  (56s)
================================================================
✅ quality-gate PASSED  (tier=full を green として記録しました)
```

SKIP は **0 件**（全ステップが実行され PASS）。

補足（サマリ行には出ないが `--strict` 判断に関わる詳細）:

- **unit**: `Test Files 449 passed (449)` / `Tests 4712 passed (4712)`
- **e2e**: `256 passed`、`1 skipped`、`1 flaky`（1 回目失敗 → 自動リトライで PASS）。
  - skipped: `[platform-developer] tests/e2e/platform-viewing-context.spec.ts:63:7 platform: いま見ているテナントがヘッダに出る (#423) › 選択中(sticky)と別のテナントを開くと「選択中と別」を併記する`
  - flaky（1回目失敗→リトライでPASS）: `[platform-developer] tests/e2e/platform-area-switch.spec.ts:41:7 エリア切替導線: developer は admin ⇄ platform を行き来できる (#423) › 往復しても現在地表示が現在のエリアを指す`
    - 1 回目のエラー: `expect(locator).toHaveText(expected) failed` / Expected: "テナント管理" / Received: "プラットフォーム運用"（`area-label` の切替待ちタイミング起因と見られる。今回検証対象の 4 枚の linux VRT baseline とは無関係）
  - これらはこのブランチが原因で発生した挙動ではなく、pre-existing の flake/skip の可能性が高いが、切り分け（main ブランチでの再現確認）はしていない。**隠さず報告する。**
- **secrets**: `no leaks found`
- **sast**: `Findings: 0 (0 blocking)` / `Ran 216 rules on 1348 files: 0 findings.`
- **audit**: `npm audit --omit=dev` → `found 0 vulnerabilities`（`npm ci` 直後の `1 high severity vulnerability` は devDependencies 側で、gate の `--omit=dev` 判定には影響しない）
- **lighthouse**: `Healthcheck passed!`、実行完了（詳細スコアは省略。FAIL/閾値割れの記載なし）
- **vrm**: `=== 17/17 checks passed`

## 4. `gh pr create` の結果

`gh pr create --title "..." --body "..." --draft` を実行 → **失敗**。

```
HTTP 403: This GraphQL query (RepositoryInfo, sent by gh pr create/view (repo info preamble)) is not enabled for this session — only the pinned set of PR-review operations is served. Use REST via `gh api repos/{owner}/{repo}/...` instead. (https://api.github.com/graphql)
EXIT_CODE=1
```

これは `scripts/hooks/pr-gate-guard.sh` によるブロックでは**ない**。理由:

- 上記エラーは実際に GitHub API へのリクエストが飛んだ後の 403（このクラウド実行環境のプロキシが
  `gh` CLI の GraphQL 呼び出し自体を許可していないための制限）。フックがコマンドを止めるなら
  `BLOCKED by pr-gate-guard.sh: ...` という stderr が出るはずだが、それは出ていない。
- `scripts/hooks/pr-gate-guard.sh` のロジックを確認したところ、`gate_stamp_satisfies "pr"` /
  `"full"` を判定し、現在の作業ツリーに対する green 記録があれば `exit 0`（許可）する。
  今回は直前に `--full --strict` が green で通り、かつ以降ツリーを一切編集していない
  （`git status --short` は空）ため、フックはそもそも通過条件を満たしており **ブロックされない
  はずの状況だった**。したがって「フックが実際にブロックするかどうか」はこの試行では検証できて
  いない（ゲートが green な状態でしか試していないため）。
- なお GitHub MCP (`list_pull_requests`, head=`20m61:claude/vrt-linux-baselines-610`) で確認したところ、
  **このブランチの PR は既に存在する**: **#622**
  `https://github.com/20m61/open-reception/pull/622`（open）。
  そのため `gh pr create` が成功しても実際には "already exists" 系のエラーになった可能性がある
  （プロキシ制限で GitHub 側の判定にすら到達しなかったため、これも確認できていない）。

## 5. `git status --short` / `git log --oneline -1`

```
$ git status --short
(空 = クリーン)

$ git log --oneline -1
9b2ea7e test(vrt): linux VRT baseline 4 枚を再生成する（#591 #619 #598 追従）
```

## 6. うまくいかなかったこと・判断に迷ったこと（率直に）

- **`gh pr create` の実地検証はできなかった**。このクラウド実行環境のプロキシが `gh` CLI の
  GraphQL 呼び出しを禁止しており（`gh` は本来このリポジトリでは非対応で GitHub MCP ツール
  を使う方針）、`pr-gate-guard.sh` が実際にブロックを発火させる場面（green 記録が無い状態）
  を再現して確認することはできなかった。フックのソースコードを読んで「今回は通過条件を満たす
  ので通るはず」というロジック上の確認に留めている。
- 対象ブランチの PR (**#622**) は既にオープン状態で存在していた。新規に PR を作る指示だったが、
  重複作成を避けるため新規作成は行っていない（今回の指示は検証のみで PR 管理は範囲外と判断）。
- VRT 実行時に `kiosk-vrt-a11y` / `kiosk-screenshot` / `admin-vrt-a11y` 以外の
  `kiosk-checkout-i18n.spec.ts`（5 件）も Playwright のプロジェクト依存で連動実行された。
  依頼された 3 ファイル分はすべて実行・PASS しているため本命の検証結果には影響しないが、
  「14 枚ちょうど」以外のテストも動いた点は透明性のため記録する。
- `--full --strict` 内の e2e で 1 件 flaky（初回失敗 → リトライで PASS）、1 件 skipped が
  あった。いずれも今回変更した 4 枚の linux VRT baseline とは無関係の既存テスト
  （`platform-area-switch.spec.ts` / `platform-viewing-context.spec.ts`）で、gate 自体の
  最終判定は PASS（strict でも FAIL 昇格していない）。ただしこのブランチ固有の問題か
  pre-existing の flake かは、main での再現確認をしていないため断定はしていない。
- ベースラインの再生成・強制 push・マージは一切行っていない。
