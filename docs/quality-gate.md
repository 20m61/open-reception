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

### どのタイミングでどのゲートを適用するか

実測（`--full` 5 回の平均・2026-07-30）: 合計 **598s ≈ 10 分**。内訳は
e2e 265s (44%) / unit 86s (14%) / lighthouse 70s (12%) / build 62s (10%) /
sast 49s (8%) / lint 37s (6%) / typecheck 25s (4%) / secrets + audit 4s。

> その後 `platform-developer` project（下記）を追加し、**e2e は 320s / 合計 733s** になった
> （同日実測 1 回）。伸びの内訳は 2 本目の Next サーバ +10s と、それまで skip / 未実行だった
> platform の 4 本。表中の実測値は上記平均のままなので、絶対値ではなく**比率の目安**として読む。

| タイミング | 何を回すか | 実測 | なぜ |
| --- | --- | --- | --- |
| 1 ファイルを直している間 | `npx vitest run <path>` | **0.3〜1s** | `npm test` の 95s を払わない。red → green の確認回数がそのまま増える |
| 各変更ごと | `--fast` | 148s | typecheck + lint + unit |
| PR 前（フック必須） | `--pr` | 210s + 約 75s | + build + **infra**（CDK テンプレートのアサーション、#628） |
| UI / a11y / VRT に触れた変更 | `--pr --e2e` | 475s | VRT 差分は**閾値内でも実物を見る**（`maxDiffPixelRatio` に本物の崩れが隠れた実績あり） |
| マージ前（フック必須） | `--full` | 598s / **152s** | 文書のみの変更では下記の省略が効く |
| 定期 | `--full --strict` | — | SKIP を FAIL 扱い。記録は `docs/gate-runs.md`（本書「定期運用」節） |

### infra ステップと `.open-next` の状態（#628）

`infra (cdk vitest)` は `npm --prefix infra test` を回す。root の `npm test` は root
`vitest.config.ts` の include（`src/**` ほか）しか走らせないため、**`infra/test/**` は
#628 まで 1 度も実行されていなかった**。型は `tsc --noEmit` が見ているが、合成される
テンプレートの中身は誰も見ていない状態だった。

`WebStack` の synth は `.open-next/` 成果物を要求する。状態は 3 値で、扱いが違う
（判定の実装は `infra/lib/build-artifacts.ts` に一本化。synth ガードとテストが同じ関数を使う）:

| 状態 | 意味 | ゲートの挙動 |
| --- | --- | --- |
| `fresh` | 成果物が揃い、`src/` より新しい | synth suite を実行 |
| `stale` | 成果物はあるが `src/` の方が新しい | **`npm run build:open-next` を実行して揃えてから** synth suite を実行（#677） |
| `absent` | 未ビルド（4 つの必須成果物のいずれかが無い） | 同上 |

**`fresh` 以外はゲートが自分でビルドして復旧する (#677)。** 以前は SKIP（理由付き）で
人間の再実行に委ねていたが、fresh checkout は**クラウドセッションの既定の姿**なので、
2026-08-10 の週次ゲート（#318）が `.open-next/` 未ビルドのまま SKIP → `--strict` で FAIL に
なった。`--pr` / `--full` も毎回「SKIP → 手でビルド → 再実行」の 2 パスを強いていた。

- **ビルドの失敗は FAIL**（SKIP ではない）。ビルドが通らないツリーは synth もデプロイも
  できないので「検査を省いた」ではなく「壊れている」。
- **ビルドしても揃わなければ従来どおり `skip_unverified`。** 「復旧を試みた」ことは
  「検査できた」ことではない（#640 の保護をここで緩めない）。
- `--fast` は infra を含まないので、この自動ビルドが走るのは `--pr` / `--full` だけ。

`stale` それ自体を **FAIL にしていない**理由: `src/` を触れば毎回 `stale` になるため、赤にすると
**ゲートが常時赤になり「赤を無視する習慣」がつく**（#424 増分 3 と同じ理屈）。復旧できる
前提の欠落は復旧し、復旧できなかったときだけ summary へ
`SKIP  infra WebStack synth  (理由)` を出す。**黙って 0 件にしない**ことが #628 の要点。

**復旧できなかったときは green としても記録しない (#640)。** ここが「FAIL にしない」との
両立点で、`--fast` は infra を含まないため各変更ごとの高速チェックは赤くならず、
影響を受けるのは **PR / マージの直前**（`--pr` / `--full`）だけになる。

### SKIP には 2 種類ある（#640）

**この区別がゲートの信頼性の要**なので、新しいステップを足すときは必ずどちらか選ぶこと。

| 種類 | 例 | 実装 | 記録 |
| --- | --- | --- | --- |
| 任意ツール未導入 | gitleaks / semgrep / lhci が無い | `skip_or_fail` | **green として記録する**（`--strict` で FAIL にできる） |
| 検査できなかった | `.open-next` がビルド後も揃わない / 状態を判定できない / **停止境界を判定できなかった** (#713) | `skip_unverified` | **記録しない**（exit 1） |

前者は「その検査を持っていない」だけだが、後者は**やるはずの検査が前提の破損で走らなかった**
状態で、「落ちなかった」だけであり「通った」根拠が無い。

### ゲートが赤いとき（切り分け）

**コードを疑う前に資源を見る。** ゲートは末尾に必ずこの 1 行を出す:

```
▶ 一時領域 (#721)
  ディスク空き: 26G / /tmp の cdk.out 残骸: 0 件
```

| 症状 | 疑うもの | 確認 |
| --- | --- | --- |
| `Test timed out in Nms`（アサーション到達前） | メモリ枯渇 | `top -l 1` の `PhysMem` / swapins |
| `page.screenshot: Target crashed` / SSL handshake failed | **ディスク枯渇** | `df -h`、上記 1 行 |
| infra の `Tests` 行に skip が混じる | `.open-next` が stale | `npm run build:open-next` |

🔴 **ディスクは症状が原因を指さない。** 2026-08-19、`/tmp/cdk.out*` が **740 個・26GB**
まで積もってディスクが 100% になり、`--full` の e2e が上記の形で落ちた。メモリも load も
正常だったため、**変更内容を疑う方向へ 1 時間費やした**。

infra テストは `TMPDIR` を周回ごとの一時 root へ向けて後始末する（#721）。ただし
**後始末が走るのは正常終了・テスト失敗・SIGINT のときだけで、SIGKILL では走らない** ——
そして SIGKILL が起きるのはディスク枯渇・メモリ枯渇のとき、つまり事故そのものの状況。
置き去りの root は次の infra テストが 6 時間より古いものを掃く（走行中の並列トラックを
壊さないよう age で判断する）。上の 1 行はその両方を分けて数える:

- `cdk.out N 件` … `<tmp>` 直下の素の残骸（別の生成元・古いもの）
- `周回 root N 件` … kill された周回が残したもの

空きの表示が「開始時」と大きく違うなら、その周回が食っている。

**パスは `-z` で採る (#718)。** 既定の git は非 ASCII パスをエスケープして返すため
（`"docs/\346\227\245\346\234\254\350\252\236.md"`）、`docs/` 判定にも停止境界の
判定にも一致しなくなる。実測では `infra/lib/stacks/認証.ts` を変更しても change-risk が
**「停止境界に触れていません」と報告した**（停止境界の偽陰性）。
**変更パスの分類**は `collectChangedPaths`（`src/domain/governance/git-base.ts`）1 箇所に
閉じている。`change-budget` は分類せず行数を数えるだけだが、パスでファイルを読むので
同じく `-z` を使う。`-z` はエスケープも引用も一切しないので `"` を含むパスも壊れない。

**リネーム検出は切る (#719)。** 検出が効いていると git は**新側しか返さない**ので、
`git mv infra/lib/stacks/認証.ts docs/x.md` のような**ガード対象からの持ち出し**が
見えなくなる。実測では change-risk が「停止境界に触れていません」と言い、change-scope は
`docs` と判定して build / e2e / sast / lighthouse を飛ばした（＝未検証のツリーが green）。
`--no-renames` を付けると git が「削除 + 追加」として新旧を独立レコードで返すので、
`R100\0旧\0新\0` と `R  新\0旧\0` で**順序が逆**という厄介なパースを持たずに済む。
同一ディレクトリ内のリネームは新旧とも同じ分類なので、`docs` 判定は従来どおり効く。

**変更範囲による省略は「測れたとき」だけ (#712)。** `change-scope` は変更パスを集めきれ
なかったら `docs` 判定をやめて `code` へ倒す（＝何も省略しない）。全滅すれば
`classifyChangeScope([])` が `code` を返すので安全側だったが、**部分失敗は安全側ではない**
——`git diff` だけが失敗し未コミットが docs のみだと `docs` に倒れ、build / e2e / sast /
lighthouse が飛んだまま green が記録される。しかも `gate_stamp_satisfies` はスタンプの
**scope 列を読み捨てる**ので、その green は `code` の green と区別なくマージガードを満たす。
倒した理由は `note=` としてゲート出力に出す（黙って倒すと、効いているか確かめる術が無い）。

**change-risk（停止境界の検出器）も後者に入る (#713)。** 報告専用なのは変わらず
**FAILED は立てない**が、変更パスを集めきれずに判定できなかった実行は green として
**記録しない**。#705 で委譲プロンプトはこの報告を「停止境界に触れたかどうかの唯一の根拠」と
宣言しており、その根拠が「測れなかった」と言っているのに `pr-gate-guard` がマージを
許すのでは、実効性が散文の規律に依存したままになる。検出器の終了コードは
`0`（判定できた）/ `3`（判定できなかった）/ その他（クラッシュ）で、後ろ 2 つが
`skip_unverified` へ落ちる。

🔴 **かつて後者を前者として扱っていたため、`infra WebStack synth` が 45 件 SKIP されたまま
`✅ PASSED (tier=full)` と記録され、`pr-gate-guard` がそれを根拠にマージを許していた**
（2026-08-07 に 1 周回で 2 回踏んだ。2 回目は `gh pr merge` が working tree を書き換えて
mtime が進んだだけで、ソース変更は一切していない）。

偽の green を後から見分けるには **infra の `Tests` 行**を見る:
`93 passed | 45 skipped (138)` ← 偽 / `138 passed (138)` ← 本物。
現在は記録自体が拒否されるので、この見分けは過去ログの読み方としてだけ要る。

### 依存監査はどの manifest を見るか（#634）

`audit` ステップ（`npm run audit:deps` → `scripts/audit-deps.ts`）は **root と `infra/` の
両方**を `npm audit --omit=dev` で監査する。

元は root だけを見ていたため、**`infra/` が 1 度も監査されていなかった**。Dependabot が
報告していた 6 high はすべて `infra/package-lock.json` 由来で、ゲートの `PASS audit` と
食い違っていた（どちらも正しく、見ている manifest が違った）。#628 と同じ構造の穴。

#### 期限付き allowlist（`audit-allowlist.json`）

`npm audit` は 1 件でも見つかれば非ゼロで終わる。**上流が直すまでこちらでは直せない**
advisory が 1 件あるだけでゲートが恒久的に赤になり、「赤を無視する習慣」がつく。かといって
`--audit-level` で緩めるとその severity 全体が盲点になる。よって **advisory 単位・理由付き・
期限付き**で受容する。判定は `src/domain/governance/audit-allowlist.ts`（純関数・unit test 済み）。

| 状態 | 挙動 |
| --- | --- |
| allowlist に無い | **FAIL** |
| 期限内の entry に一致 | 受容（ログに出す） |
| **期限切れ** | **FAIL**（放置すると必ず表面化する） |
| 期限内だが該当なし | ⚠ 未使用として警告（＝上流が直した合図。entry を消す） |

`reason` には「対応中」ではなく**こちらでは直せない手段的な理由**を書く。現在の唯一の entry
（`GHSA-rgw5-rvv9-x895` / `brace-expansion`）は、`aws-cdk-lib` の **`bundleDependencies`** に
同梱されていて `overrides` でも `npm audit fix` でも到達できないことが理由。

> 💡 `npm audit fix` が「fix available」と言うのに lockfile が変わらないときは、bundled
> dependency を疑う。**上流のバージョンを上げる以外に手段が無い**（実際 `aws-cdk-lib`
> 2.260.0 → 2.263.0 で 6 件中 5 件が解消した）。

### 実行計画の確認（`QUALITY_GATE_DRY_RUN=1`）

```sh
QUALITY_GATE_DRY_RUN=1 ./scripts/quality-gate.sh --pr   # tier=pr … infra=1 … を出して終了
```

ステップを 1 つも起動せず、tier がどのステップに解決したかだけを出す。tier の中身は
`tests/config/quality-gate-tiers.test.ts` がこれを**実際に起動して**固定している
（字面の grep ではリファクタで簡単に嘘になる）。

### ループの緊急停止（kill switch, #424 増分 4）

ゲートは**最初に** `scripts/change-budget.ts` を呼び、停止指示が立っていれば**その場で
abort する**（green も記録しないので、`pr-gate-guard.sh` の PR / マージも通らない）。

```bash
echo "本番調査中" > .loop-halt   # 止める（理由を書く。理由は運用者が読むためのもの）
rm .loop-halt                      # 解除する
OPEN_RECEPTION_LOOP_HALT=1 ...     # 一時的に止める（env。file の方が優先される）
```

`.loop-halt` は **gitignore 済み＝追跡しない**。コミットすると全員のゲートが止まる。

**最初に置くのが要点**で、10 分のゲートを走り切ってから止めても kill switch の意味が無い
（実測 4.9s で abort する）。人間の明示操作なので偽陽性が原理的に無く、止める資格がある。

同じステップが **1 周回の変更量**（ファイル数 / 追加+削除の行数）も報告する。こちらは目安を
超えても **FAIL させない** — 大きい変更が自動的に悪いわけではなく、FAIL にすると override が
習慣化して change-risk（増分 3）で避けた「赤を無視する習慣」を作る。超えたときは PR 本文の
「リスクと戻し方」に**分割しない理由**を書く。既定の目安は 40 ファイル / 1500 行で、
**通常の周回では鳴らない水準**（暴走の検出が目的で、大きさの禁止ではない）。

### 変更範囲による省略（docs スコープ）

`build` / `e2e` / `lighthouse` / `sast` は**ソースを入力に取る**。文書だけを触った周回では
その入力が 1 バイトも変わらないので、結果は前回と同一にしかならない。それでも毎回 10 分
払っていた（あるセッションでは 5 PR 中 3 本が文書のみ）。`scripts/change-scope.ts` が
「文書のみ」と判定した場合、この 4 つを SKIP する（**598s → 約 152s**）。

- 判定は `src/domain/governance/change-scope.ts`（純関数・ユニットテスト済）。**省略してよい
  ステップ名の一覧もここが唯一の真実源**で、shell は `skip=<step>` の出力を読むだけ。
- **厳しい方へ倒す。** `docs/**`・ルートの `*.md`・`.github/**/*.md`・`LICENSE` **だけ**が
  docs 扱い。allowlist の補集合で判定するので、未知の種類のファイルが増えたら自動的に
  `code` 側（＝全ステップ実行）へ落ちる。変更ゼロも `code`（収集失敗の可能性があるため）。
  起点（`origin/main`）が解決できないときも `code`。
- **`typecheck` / `lint` / `unit` は docs でも回す。** 判定器自体のバグでソースが混ざった
  場合の**トリップワイヤ**（148s と安い）。`secrets` も回す（文書にも鍵は混入しうる）。
- 有効性の担保は**指紋側**。省略はそのツリーに対してのみ成立し、コードを 1 文字でも触れば
  指紋が変わって記録は無効になる。スタンプの 4 列目に scope を残すので、後から
  「なぜ e2e が走っていないのか」を追える。
- `--no-skip-docs` で無効化して tier の全ステップを実行できる。
- **残件**: 文書 PR で省略し続けた分を定期実行で必ず一度は踏む網（`--full --strict` の
  頻度と起点の設計）は未整備。現状の担保はトリップワイヤのみ。

### ゲートの強制（`pr-gate-guard` フック）

CI が無い以上、「PR 前に `--pr` / マージ前に `--full`」は**規約だけでは守られない**。
そのため Claude Code の PreToolUse フック `scripts/hooks/pr-gate-guard.sh`
（`.claude/settings.json` で登録・チーム共通）が `gh pr create` / `gh pr merge` を
実行直前に捕まえ、**現在の作業ツリーに対する green 記録が無ければブロック**する。

- 記録（スタンプ）は `quality-gate.sh` が PASS 時に `.git/open-reception-gate-stamp`
  へ追記する。コミットされず、**worktree ごとに独立**（並列トラックが互いの結果を
  流用できない）。実装は `scripts/lib/gate-stamp.sh`。
- 記録は「そのゲートが実際に検査したツリー」に紐づく。HEAD・追跡ファイルの差分・
  未追跡（非 ignore）ファイルの内容から指紋を採るため、**ゲート後に 1 文字でも編集
  すれば stale として無効**になり、走らせ直しが要る。`.gitignore` 済み（`node_modules`・
  `.next` 等）は指紋に影響しない。
- 要求 tier は `gh pr create` → `--pr` 以上、`gh pr merge` → `--full`
  （`feedback: merge-gate`）。`--fast` だけでは PR を作れない。
- 🔴 **REST 経由の PR 作成（`scripts/create-pull-request.ts`）も `--pr` を要求する (#678)。**
  クラウドの routine セッションでは `gh pr create` が GraphQL 403 で使えず、そちらが PR 作成の
  主経路になる（web セッションでの挙動は未検証。`docs/cloud-dev-environment.md` §4）。
  見ていないと**移した先がそのままゲートの抜け道**になる。
- 🔴 **REST 経由のマージも `--full` を要求する (#702)。** `gh pr merge` も 403 になるため、
  マージの主経路は `scripts/merge-pull-request.ts` と生の `gh api .../pulls/<n>/merge`。
  **両方**を見る。PR の照会（`.../pulls/<n>`）は止めない — 日常的に使うので、広く取ると
  誤検出でガードごと迂回される。
- 意図的な迂回は明示的に行う: `OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr create ...`。
- 振る舞いは `tests/hooks/pr-gate-guard.test.ts` で検証している（`npm test` に載る）。

### push 前の秘密情報スキャン（`push-secret-guard` フック）

`--secrets`（gitleaks）が走るのは `--full` のときだけで、`--pr` / `--full` は既定でクラウド
委譲（本ドキュメント冒頭）。つまり「実装 → `--fast` → `git push` → クラウドで `--full`」の
**push が実際に外部へ出る境界**の手前に、ローカルで秘密情報を見る検査が無かった（#682）。

`scripts/hooks/push-secret-guard.sh`（PreToolUse:Bash、`.claude/settings.json` で登録）が
`git push` を実行直前に捕まえ、**push しようとしているコミット範囲**（`<base>..HEAD`。base は
`origin/main` → `main` → `origin/master` → `master` の順で見つかったもの）だけを
`gitleaks detect --log-opts` で走査する。

- 範囲を絞ったコミットベースの走査なので、`.gitleaksignore` の commit SHA ベースの指紋が
  そのまま使える（`--no-git` のように指紋形式が変わらない）。全履歴の unshallow も不要。
- `--fast` には足していない（内側ループを毎回スキャンで重くしない）。push は低頻度の境界
  アクションなので、そこでだけ発火する。
- gitleaks 未導入時は**既定で SKIP**（警告を出した上で push は通す）。
  `OPEN_RECEPTION_STRICT_SECRET_SCAN=1` で未スキャンの push 自体をブロックする
  （`--strict` と同じ考え方）。
- 意図的な迂回: `OPEN_RECEPTION_SKIP_SECRET_SCAN=1 git push ...`。
- 振る舞いは `tests/hooks/push-secret-guard.test.ts` で検証している（`npm test` に載る）。

### E2E のブラウザ（macOS 13 対応）

E2E は iPad 受付端末を主対象とするが、ブラウザは 2 系統で回す（`playwright.config.ts`）。

| プロジェクト | ブラウザ | 既定で実行 | 用途 |
| --- | --- | --- | --- |
| `chromium-ipad` | chromium（iPad viewport エミュレート） | ✅ 常時 | ローカル主ゲート。全 OS で動く |
| `ipad-landscape` / `ipad-portrait` | webkit（Safari 忠実度） | CI または `E2E_WEBKIT=1` 時のみ | 実 Safari 相当の検証 |
| `platform-developer` | chromium（desktop 1280×900） | ✅ 常時（`PLAYWRIGHT_BASE_URL` 指定時を除く） | developer 専用の `/platform/*` 検証 |

### `platform-developer` が別サーバな理由（#423）

platform エリアは developer ロール専用で、password セッションが developer になるのは
`OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer` の**プロセス env** 指定時だけ
（`buildActorConfig` が `process.env` から読む。email allowlist は email を持たない password
セッションには適用できない）。**テスト側の helper では developer セッションを張れない。**

そこで e2e は **Next サーバを 2 本**起こす（`playwright.config.ts` の `webServer` 配列）。

| ポート | env | 対象 project |
| --- | --- | --- |
| `PORT`（既定 3000） | 既定（`passwordRole=tenant_admin`） | `chromium-ipad` ほか |
| `PLATFORM_PORT`（既定 `PORT + 1` = 3001） | `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer` | `platform-developer` |

既定サーバの env に developer を足す案は却下した — 全 password ログインが developer 化して
admin 側 e2e（TenantSwitcher の母集合、テナント境界）の意味が変わる。**サーバを分ければ
developer はそのプロセスに閉じる。**

- 実測コスト: 全 e2e が **299s → 310s（+10s / +3.5%）**。project 間に依存を張っていないため
  2 本目の起動は並行で吸収される。
- **3001 が使用中だと e2e が起動に失敗する**。`PLATFORM_PORT` で退避できる。
- `PLAYWRIGHT_BASE_URL`（実環境向け実行）では passwordRole を制御できないため、この project は
  **設定ごと生成しない**（走らせれば必ず admin へリダイレクトされて落ちる＝実行方法の欠陥）。

第 85 wave まで `/platform/*` の e2e は **1 本も実効していなかった**。`capture-screens.spec.ts` の
「platform 主要画面」は撮るだけで検証しなかったため、**リダイレクト先の admin を
`platform-*.png` として撮り続けていた**（撮影は成功するので誰も気づけない）。撮るだけの spec は
「撮れた＝正しい」と読めるので、**撮る前に居場所を表明する**
（`tests/e2e/capture-screens-platform.spec.ts`）。

**Playwright は macOS 13 (Ventura) で webkit 非対応**（`playwright install webkit` が
`does not support webkit on mac13` で失敗する）。このため macOS 13 のローカルでは
`chromium-ipad` のみが既定で走り、webkit プロジェクトは自動的に除外される。実 Safari
忠実度が要る検証は webkit 対応 OS の CI、または明示的に `E2E_WEBKIT=1 npm run test:e2e`
で実行する（webkit が入っている環境が前提）。

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

## 受付UXの安全性・プライバシーゲート（#125 / Epic #119）

タッチ受付UXは公共空間で使うため、見た目・会話だけでなく以下を E2E ゲートで担保する。

- **a11y（深部・画面種別）**: `tests/e2e/a11y.spec.ts` で待機/トップ/管理ログインに加え、
  呼び出し直前の**確認画面**、および **iPad 横置き / 大型横画面**の待機画面でも axe critical 0 件を検証。
- **プライバシー非保持**: `tests/e2e/kiosk-privacy.spec.ts` で、完了/キャンセル後にリロード
  せず次の受付へ進んでも来訪者の氏名（PII）が残らないことを検証（アプリ状態としての非保持）。
- **呼び出し前の確認必須**: 確認画面を経ずに結果へ遷移しないことを検証（安全側の明示確認）。
- 受付の主要分岐（成功/未応答/失敗・代替導線・待機復帰）は `tests/e2e/reception-flow.spec.ts`。

> inc2 予定: 主要 viewport のスクリーンショット差分、音声/カメラ/VRM/TTS/STT 失敗時の
> フォールバックの網羅、キーボード/スイッチ操作の検証。

## 定期運用（`--full`、#318）

`scripts/quality-gate.sh --full`（secrets/sast/audit/e2e/lighthouse）は「マージ前・定期」
の重ゲートと位置づけているが、コード変更を伴わない PR がしばらく無い期間でも依存脆弱性・
secret 混入・ライセンス問題（#105 方針）は時間経過だけで発生し得る。マージ駆動の `--pr`
ゲートだけでは検出が漏れるため、以下の運用で**定期実行**を仕組み化する。

### 定期実行方式

- **推奨**: Claude Code の Routine（`create_trigger`、cron 週次、例:
  毎週月曜 09:00 JST）で `./scripts/quality-gate.sh --full --strict` を実行させる。
  🔴 **Routine のプロンプトは `./scripts/record-gate-run.sh --publish` を呼ぶだけにする**（#656）。
  ゲート実行・記録の追記・ブランチ/commit/push・**PR 作成とその実在確認**まで全部この
  スクリプトが持つ。FAIL 時の issue 起票だけは人間（FAIL 時ハンドリング参照）。

  **散文の手順に頼らない**のが要点。2026-08-03 の週次ゲートは記録を push したのに
  **PR を作らずに終わり**、FAIL が 5 日間 main に載らなかった（#656）。当時この手順は
  Routine の指示文に散文で書かれていて、抜けても誰も気づかなかった。
  `docs/ai-development-loop.md` の「規律で守るものを機械検証へ移す」に従い、保証を
  version 管理されたコードへ移してある。

  - `--publish` を付けずに実行すると「push も PR 作成もしていない」旨を **stderr へ警告**する
    （黙って終わらせない）。
  - `gh pr create` の終了コードだけを信じず、**返された URL を REST で引き直して実在を確認**し、
    確認できなければ非ゼロで落ちる。「ブランチが出来たこと＝PR が出来たことではない」が
    #656 そのものなので。
  - 確認に `gh pr list` / `gh pr view` は使わない。**クラウドのサンドボックスは GitHub GraphQL を
    絞っており 403 になる**（PR #665 で実測）。REST の `gh api repos/.../pulls/<n>` を使う。
  - `--publish --dry-run` でゲートも副作用も実行せず、公開手順だけを歩ける。
  - 本 Issue (#318) 自体はこの仕組みを**文書化**するのみで、実際の Routine 作成は
    ユーザーの判断で行う（自動では作成しない）。
- **代替**: Claude Code Routine が使えない環境では、開発マシンのローカル cron/launchd で
  同等のコマンドを週次実行する。例（cron）:
  ```cron
  0 9 * * 1 cd /path/to/open-reception && ./scripts/record-gate-run.sh >> /tmp/open-reception-gate.log 2>&1
  ```
- **GitHub Actions は使わない方針を維持する**。定期実行はあくまでローカル実行 or
  Claude Code Routine 経由で、Actions 相当の外部 CI は導入しない。
- 実行頻度は**週次以上**（週次を既定、依存監査の重大度が高い時期は前倒しで手動実行してよい）。

### 記録先・形式: `docs/gate-runs.md`

- 毎回の `--full` 実行結果を `docs/gate-runs.md` の表へ**追記**する（append-only、既存行は
  書き換えない）。列は次の通り。

  | 列 | 内容 |
  | --- | --- |
  | 日時 (UTC) | 実行開始時刻。`date -u +"%Y-%m-%dT%H:%MZ"` |
  | コミット SHA | 実行時の `git rev-parse --short HEAD` |
  | tier | 通常は `full`（`--strict` 併用が定期実行の必須条件、後述） |
  | 結果 | `PASS` / `FAIL` |
  | SKIP 項目 | 未導入ツール等で SKIP になった項目（`--strict` 下では発生しない想定。発生時はそれ自体が FAIL 扱い） |
  | 起票 Issue / 備考 | FAIL 時の issue 番号、ツール追従作業のメモ等 |

- 手動追記でも、`scripts/record-gate-run.sh`（本 Issue で追加、任意）を使った自動追記でも良い。

**`scripts/record-gate-run.sh` は記録した直後に `npm run evaluate:gate-runs -- --report` を
呼ぶ**（#656）。記録の健全性（下記の `record_gap` / `orphan_branch` / 直近 FAIL 等）を、
**週次運用が回ったその場で**目に入れるため。2026-08-08 時点で**この検査を呼ぶものは
リポジトリ内に 1 つも無く**、実装しただけで誰も走らせていなかった。

- **報告のみで、スクリプトの終了コードには混ぜない。** 本スクリプトの終了コードは
  「ゲートの結果」という契約で、そこへ記録の健全性を混ぜると意味が二重になる。加えて
  「解決手段のない指摘で永久に赤くなる」罠は FAIL / SKIP / orphan で既に 3 度踏んでいる。
- **`quality-gate.sh` 側には入れない。** あちらはコード品質の門で、こちらは「運用が
  回っているか」の点検。混ぜると Routine が止まっている間ずっと開発者のローカルゲートが
  赤くなり、override が習慣化する。

#### 記録に穴が空いていないかを検査する（#656）

`npm run evaluate:gate-runs` が、隣接する `full` 記録の間隔が週次運用の想定（8 日）を
超えていれば `record_gap` として **error** で指摘する。

**「止まっている」の検査（`stale`）では代替できない。** `stale` は直近 1 件の経過日数しか
見ないので、途中の 1 回が main に載らなくても**次の回が載った時点で永久に見えなくなる**。
2026-08-03 の FAIL が 5 日間 main に無かった事故（#656）がこの形だった。

穴を見つけたら、**抜けた回の行を追記して解決する**（表の並びは日時で決まるので後から挿せる）。
ゲート出力が復元できない場合も、経緯を備考に書いた行を追記すれば記録の連続性は取り戻せる
（実際 2026-08-03 の行はそうやって回収した）。**FAIL 行の改変・削除はしない**（append-only）。

#### PR にならなかった push を検出する（#656）

同じコマンドが、**リモートに在るのに PR が 1 つも無いブランチ**を `orphan_branch` として
error で指摘する。2026-08-03 の記録が失われた直接の原因がこれで、`chore/gate-run-20260803` は
push されたのに PR が作られず、誰の目にも触れないまま残っていた。

- **squash マージなので ancestry では判定できない**（main に同じ commit は無い）。見るのは
  「そのブランチ名を head に持つ PR が在るか」だけ。open なら進行中、merged なら内容は main に
  載っており、closed なら捨てた判断が見えている — いずれも**一度は人間の目を通っている**。
- PR は**ブランチ 1 本ずつ問い合わせる**。`gh pr list` を一括で引くと `--limit` を超えた古い
  PR が落ち、**その PR を持つブランチが orphan に誤検出される**。
- `gh` やネットワークが無く**検査できなかった**場合は `branch_check_unverified`（warning）を出す。
  **「取りこぼし無し」ではなく「未検査」**であり、緑にはしない。

これは週次 routine 側の修正の**代わりではない**（routine 自身が PR 作成失敗に気づいて失敗
終了するのが本筋）。routine の挙動がどうであれ、外側から取りこぼしを拾う網である。

### FAIL 時のハンドリング

FAIL したステップの重大度に応じて**即時 issue を起票**し、対応期限を設ける。

| 重大度 | 該当例 | 対応期限 |
| --- | --- | --- |
| Critical | gitleaks で secret 検出、npm audit の critical、semgrep のセキュリティ error | 起票から **24 時間以内**に着手 |
| High | npm audit の high、e2e a11y critical/serious（axe） | 起票から **3 営業日以内** |
| Moderate 以下 | npm audit の moderate 以下、lighthouse の warn 系劣化 | 次スプリント（**2 週間**）以内 |

- 起票する issue には、`docs/gate-runs.md` の該当行・実行ログの要約（該当ステップの出力抜粋）・
  再現コマンド（`./scripts/quality-gate.sh --full --strict` あるいは個別トグル）を含める。
- 対応完了後は再度 `--full --strict` を実行して green を確認し、issue をクローズしてから
  `docs/gate-runs.md` に PASS の行を追記する（FAIL 行は削除・改変しない。履歴として残す）。

### ツールのバージョン・ルール更新への追従方針

- `gitleaks` / `semgrep` はローカルインストールのツール（npm 管理外）で、脆弱性・秘密情報の
  検出ルールは日々更新される。**四半期に一度**、`gitleaks version` / `semgrep --version` を
  最新リリースと比較し、メジャー更新があれば変更点（`semgrep scan --config p/default` の
  ルールセット変更含む）を確認してから追従する。追従作業自体も `docs/gate-runs.md` の
  備考欄に記録する（例: 「semgrep 1.x→1.y 追従」）。
- `npm audit` は実行のたびに最新の advisory DB を参照するため、追従は定期実行の副次効果として
  自動的に行われる。

### 未導入ツールの扱い（定期実行では SKIP=FAIL）

- 通常運用（`--pr` 等、各変更ごと）では未導入ツールは SKIP 表示のみで許容する。
- **定期実行（`--full`）では必ず `--strict` を付与し、SKIP を FAIL 扱いにする。** これにより
  「ツールが未導入のまま気づかずゲートが素通りする」事故を防ぐ。SKIP=FAIL になった場合も
  上表の重大度表に従って issue を起票する（対象ツールの導入自体をタスク化する）。

### 変更範囲による省略との関係

`--strict` は**変更範囲による省略（docs スコープ）を無効化する**（`effectiveScope`）。
定期実行は「コードが変わっていないのに劣化するもの」——依存 advisory の更新・ブラウザ更新・
gitleaks/semgrep のルール変更——を捕まえるための実行なので、文書のみのブランチで走ったからと
いって `e2e` や `sast` を省略したら**その実行が存在する意味が無くなる**。倒す方向は
`docs` → `code` の一方通行で、`code` を緩めることはしない。

つまり役割分担はこうなる。

| 何を守るか | 誰が守るか |
| --- | --- |
| コード変更による退行 | マージ前の `--full`（コードが変われば scope は必ず `code`） |
| コード非変更の時間経過による劣化 | **定期の `--full --strict`**（省略しない） |

### 現状（2026-07-30）

**定期実行は一度も回っていない。** 下記の `docs/gate-runs.md` は EXAMPLE 行のみで実運用の記録が
0 件。本節が「実際の Routine 作成はユーザーの判断で行う（自動では作成しない）」と定めている
ためで、仕組みは文書化済み・**実行の設定がユーザー操作として未了**という状態。
稼働環境が要る検査（`scripts/url-quality-gate.sh` の ZAP・live lighthouse）は dev 環境削除
（2026-07-24）以降回せておらず #65 にスタックしている。

## 1 営業日連続稼働 soak テスト（#317, charter 成功指標）

PROJECT_CHARTER の成功指標「受付端末として 1 営業日以上の連続稼働テストに耐える」を検証する
soak ハーネス。長時間表示で顕在化する問題（メモリリーク・DOM ノード堆積・heartbeat 欠落・
自動復旧 (#30) の劣化）は `--pr`/`--full` の通常ゲートでは検出できないため、別建てで運用する。

**既定の `npm run test:e2e` / `scripts/quality-gate.sh --pr|--full` の対象には含まれない。**
`playwright.config.ts` の `testIgnore` と、専用設定ファイル `playwright.soak.config.ts`
（テスト自体も `tests/e2e/soak/` に隔離）の二重の仕組みで構造的に分離している。

### 実行コマンド・モード

```bash
npm run test:soak       # 既定 = smoke（2 分）。ローカル/dev URL に対して毎回検証できる短時間版
npm run test:soak:30m   # opt-in（30 分）
npm run test:soak:2h    # opt-in（2 時間）
npm run test:soak:8h    # opt-in（8 時間。1 営業日の一部相当）
```

`SOAK_MODE` 環境変数（`smoke` 既定 / `30m` / `2h` / `8h`）でモードを切り替える。各モードの
totalMs・サンプリング間隔・閾値は `tests/soak/thresholds.ts`（`parseSoakMode`）を単一の
情報源とする（unit test: `tests/soak/thresholds.test.ts`、`npm test` で検証）。長時間モードほど
許容増加率を厳しくする（微小なリークでも長時間では顕在化するため）。

`PLAYWRIGHT_BASE_URL` を指定すれば、他 E2E と同様にローカル本番ビルドではなく稼働中の任意
URL（実環境相当）へ向けられる。

### ハーネスの内容（`tests/e2e/soak/`）

- `soak-kiosk.spec.ts`: 待機 → 受付完走（`soak-driver.ts` の `runReceptionCycle`）を
  `SOAK_MODE` の総時間だけループし、次を定期サンプリング・判定する。
  - JS heap 使用量（`performance.memory`。Chromium 限定、非対応環境では判定をスキップ）
  - DOM ノード数（デタッチノード堆積の検知）
  - heartbeat 疎通（`/api/kiosk/heartbeat` を直接ポーリングし、最大欠落間隔を計測）
  - console エラー / 未捕捉例外（1 件でも FAIL）
  - 一定サイクルごとにネットワーク断→復帰（`context.setOffline`）・タブ非表示→復帰
    （`visibilitychange` 疑似発火）を注入し、自動復旧 (#30) の劣化（白画面・操作不能化）を検出
- `soak-time-boundaries.spec.ts`: 既存の `?inactivityMs=` 短縮フラグと Playwright の
  Clock API（`page.clock`）を組み合わせ、「無操作リセットの延長（セッション更新）」
  「無操作タイムアウト境界（閾値直前/直後）」「connected 状態の無操作境界 (#324)」
  「日付跨ぎ後も受付が完走すること」を実時間を待たず決定的に検証する。

### 判定基準（FAIL 条件）

`tests/soak/thresholds.ts` の `evaluateSoakRun` が判定する。いずれか 1 つでも該当すれば FAIL。

| 指標 | 既定閾値（モード別に `parseSoakMode` で変動） | 備考 |
| --- | --- | --- |
| console エラー / 未捕捉例外 | 0 件 | 1 件でも FAIL |
| JS heap 使用量増加率 | smoke 80% / 30m 50% / 2h 35% / 8h 25% | 起動直後のウォームアップ 1 サンプルは除外してから先頭比で算出 |
| DOM ノード数増加率 | heap と同じ既定値（`maxDomNodeGrowthPercent` で個別上書き可） | デタッチノード堆積の代理指標 |
| heartbeat 最大欠落間隔 | 90,000ms（heartbeat 間隔 30s の 3 倍） | 直近成功時刻からの経過で計測。一度も成功しなければ即 FAIL |
| ネットワーク断/タブ非表示からの復帰 | 復帰後に待機画面（`start-reception`）が表示されること | 白画面・操作不能化を検知（#30） |

### 実行結果・既知の制約

- ローカル/dev URL に対して実行でき、閾値超過時は非 0 終了（FAIL）する（soak-kiosk.spec.ts /
  soak-time-boundaries.spec.ts とも `smoke` モードで実行確認済み）。
- charter の「1 営業日連続稼働」を CI/ローカルの自動テストだけで毎回検証するのは非現実的
  （8h モードでも実行時間そのものが長大）。そのため **8h モードは opt-in**とし、実運用での
  「1 営業日連続稼働」は §「iPad 実機 soak チェックリスト」（`docs/ipad-uat.md`）で担保する
  （#65 スタック方針）。
- `performance.memory` は Chromium 限定・非標準 API。webkit 等では heap 判定はスキップされ
  （`heapGrowthPercent: null`）、DOM ノード数・heartbeat・console エラーの判定は継続する。

## 関連

- a11y E2E: `tests/e2e/a11y.spec.ts`（#7 / #125）
- 受付安全性・プライバシー E2E: `tests/e2e/kiosk-privacy.spec.ts`（#125）
- soak（1 営業日連続稼働）E2E: `tests/e2e/soak/`・純ロジック `tests/soak/thresholds.ts`（#317）
- セキュリティ・テスト方針: `docs/security-testing-plan.md` / `docs/security-checklist.md`（#6）
- 定期実行の記録: `docs/gate-runs.md`、記録ヘルパ: `scripts/record-gate-run.sh`（#318）
