# クラウド開発環境（Claude Code on the web）

開発を Claude Code on the web（クラウドセッション）へ移すための**正本**。環境設定の実体は
claude.ai/code の環境ダイアログにあり、リポジトリからは触れない。ここは「何をどう設定してあるか」
「なぜそうしたか」「何が動かないか」を残す場所。

セッションは Ubuntu 24.04 の使い捨て VM（4 vCPU / 16 GB RAM / 30 GB ディスク）で、
リポジトリはクローンされた状態で始まる。

## 0. 人がやる手順（チェックリスト）

**このファイルの残りは「なぜそうなっているか」の記録。ここは「あなたが何をするか」だけ。**

### 0-A. 環境の初期設定 — 1 回だけ（✅ 2026-08-18 時点で設定済み）

claude.ai/code の環境 **open-reception**（`env_012h7PiJKNb4EYzKRSuBwpX3`）に対して:

1. **Network access を Custom** にし、「Also include default list of common package managers」に
   チェックを入れたうえで `cdn.playwright.dev` と `awscli.amazonaws.com` を足す（§1）
2. **Setup script 欄**に `scripts/cloud-setup.sh` の**中身をそのまま貼る**。
   🔴 **このファイル自体は実行されない。** 実体は貼られた文字列なので、
   `cloud-setup.sh` を変更したら**環境ダイアログ側も貼り替える**

**済んでいるかの判定は §0-E の点検で付く**（設定を眺めるより、実物を見る方が確実）。

### 0-B. 毎回 — web セッションで 1 周回す

1. claude.ai/code で環境 **open-reception** のセッションを開く
2. 最初にこれを渡す:

   ```
   issue #<N> を 1 周してください。手順は docs/loop-workflow.md、
   着手前に .claude/skills/issue-ac-mapping に従って AC を実コードへマッピングすること。
   PR 作成は `npx tsx scripts/create-pull-request.ts`、
   マージは `npx tsx scripts/merge-pull-request.ts --number <番号>`。
   ```

3. **完了は実物で確かめる。** 「終わりました」を信じない ―― PR の URL と、
   `merged=true` の確認結果を報告させる（**ブランチが出来たこと≠PR が出来たこと**。#656 は
   これで FAIL の記録を 5 日間失った）
4. マージ後、**ローカル macOS で**後始末する（クラウドからは ref を消せない）:

   ```bash
   git switch main && git pull --ff-only
   git push origin --delete <branch> && git branch -D <branch>
   ```

### 0-C. AWS の窓を開ける／閉じる — デプロイのときだけ

**短命 STS の発行はローカル macOS 限定**（`guard-destructive.sh` がクラウドでブロックする / #675）。

1. **ローカル**で `./scripts/aws-issue-credentials.sh`（既定 4h・最大 12h）。値はクリップボードへ
2. 環境ダイアログの**環境変数**へ 5 つ登録:
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` /
   `AWS_CREDENTIAL_EXPIRATION`
3. クラウドから `docs/runbook-cloud-aws-deploy.md` の手順（verify → preflight → diff → deploy → smoke）
4. 🔴 **終わったら 5 つとも削除して窓を閉じる**（runbook ステップ 11）

> **実例**: 2026-08-18 の点検で、**8/13〜15 のデプロイ時の 5 変数が残ったまま**だった。
> STS は最大 12 時間なので値は失効していたが、**閉じる手順が実施されていなかった**。
> 期限切れに頼らず、明示的に消す。

### 0-D. 週次ゲート routine（`docs/gate-runs.md` を埋めるもの）

https://claude.ai/code/routines を開き、本文を **`./scripts/record-gate-run.sh --publish` を
呼ぶだけ**の形にする。PR 作成まで完結する（#678 で REST 化済み）。

🔴 **これは人にしかできない。** `RemoteTrigger` の `list` は新しい 20 件しか返さず cursor も
受け付けないため、one-shot routine を作るほど古い cron routine が読めなくなる（#656 のブロッカー）。

### 0-E. 環境の健康診断 — たまに／ゲートの結果が不審なとき

web セッションでこれを流す。**値は出さない**（名前だけ）:

```bash
for c in gh aws gitleaks semgrep; do printf '%-10s %s\n' "$c" "$(command -v $c || echo MISSING)"; done
ls /opt/pw-browsers 2>/dev/null | head -3
env | grep -o '^AWS_[A-Z_]*' || echo "AWS 変数なし（正常）"
gh api graphql -f query='query{viewer{login}}' >/dev/null 2>&1 \
  && echo "GraphQL OK" || echo "GraphQL 403（REST スクリプトを使う）"
```

見るべきは 3 点:

| 見るところ | 期待 | 外れていたら |
| --- | --- | --- |
| 4 コマンド | 全部パスがある | Setup script が古い or 貼られていない → §0-A 2. を貼り直す |
| `AWS_*` | **なし** | 窓が開けっぱなし → §0-C 4. で削除 |
| GraphQL | どちらでもよい | 403 なら REST スクリプト必須（routine は 403 と実測済み。§4） |

> **なぜ「4 コマンドが入っていること」を気にするのか**: `gitleaks` / `semgrep` が無いと
> `quality-gate.sh` は **FAIL ではなく SKIP** する。SKIP は赤くならないので、
> **マージゲートが黙って弱くなる**（#545 で実際に踏んだ）。

### 0-F. 実測の記録（2026-08-18）

環境が実際にどうなっているかを read-only の probe で確認した結果:

```
Setup script cached from previous run          ← 貼られている（環境ログ）
gh 2.45.0 /usr/bin/gh        aws-cli 2.36.22 /usr/local/bin/aws
gitleaks 8.29.0              semgrep 1.173.0
/opt/pw-browsers: chromium-1194 / chromium-1228 （イメージ同梱）
cdn.playwright.dev 400 / awscli.amazonaws.com 301   ← どちらも到達＝許可済み
AWS_* が 5 つ残存                                    ← 窓が開けっぱなしだった
```

`aws` の mtime = `2026-08-13 18:59`、`semgrep` = `19:02` ―― #680 で AWS CLI を
`cloud-setup.sh` へ足した時期と一致する。**素のイメージでは説明が付かない**ので、
Setup script は貼られていると判断できる。

---

## 1. 環境ダイアログ側の設定（claude.ai/code）

### Network access: **Custom**

「Also include default list of common package managers」に**チェックを入れた上で**、
次を許可ドメインへ追加する。

```
cdn.playwright.dev
awscli.amazonaws.com
```

**理由**: Playwright はブラウザバイナリを `cdn.playwright.dev` から取る。このホストは
Trusted の既定許可リストに**入っていない**。Trusted のままだと `playwright install` が
失敗し、**e2e / VRT / `--full` が丸ごと回らない**。

`awscli.amazonaws.com` は AWS CLI v2 の公式インストーラ配布元。`apt`/`pip`/`npm` のような
「よくあるパッケージマネージャ」には含まれないため、同じく既定の許可リストに**入っていない**
可能性が高い（Playwright と同型の罠）。許可しないと `scripts/cloud-setup.sh` の AWS CLI
インストールが `curl` の時点で失敗し、`|| true` に握り潰されて**セッションは正常に起動する
のに `aws` だけ黙って入っていない**状態になる（semgrep の PyJWT 罠・gitleaks と同型。
§4 参照）。

> このリポジトリは過去に「e2e はこの環境では動かない」という**誤った結論を 5 周にわたって
> 引き継いだ**ことがある（真因は Playwright のビルド番号不一致で、`executablePath` を渡せば
> 動いた。`docs/handoff-2026-07-27.md`）。同じ轍を踏まないため、**動かないときは必ず
> 再現コマンドと実際の失敗メッセージを残す**こと。

### Setup script

`scripts/cloud-setup.sh` の内容をそのまま貼る（あちらが正本。変更したら両方更新する）。
入れているのは 4 つ:

| 対象 | なぜ要るか |
| --- | --- |
| `gh` CLI | プリインストールされていない。ループ workflow が PR 作成（REST 経由・§4）と `gh pr merge` に全面依存する |
| `gitleaks` / `semgrep` | 無いと `quality-gate.sh` が SKIP する。SKIP は FAIL にならないので**マージゲートが黙って弱くなる** |
| Playwright chromium | イメージに同梱されない場合の保険（同梱時は `playwright.config.ts` が `/opt/pw-browsers` を自動検出する） |
| `aws` CLI v2（#680） | プリインストールされていない。`scripts/aws-cloud-deploy.sh`（`docs/runbook-cloud-aws-deploy.md` の verify → preflight → diff → deploy → smoke）が preflight/diff/deploy の全経路で直接シェルアウトする。無いと `aws: command not found` で失敗し、しかも旧実装はそれを「AWS 認証情報を解決できません」という**誤った層**のせいにしていた ―― 実際に初回の cloud deploy 試行で踏んだ。今は `scripts/aws-cloud-deploy.sh` 側に `aws` の有無を先に確認する preflight（`src/domain/governance/command-preflight.ts`）を入れてあるので、入れ忘れても診断メッセージは正しい層を指す（が、動かないことに変わりはない） |

制約: 非ゼロ終了すると**セッションごと起動しない**ので非必須は `|| true`。5 分以内。
初回だけ実行され、以後はファイルシステムのスナップショットとしてキャッシュされる
（スクリプトか許可ドメインを変えると再実行される）。

### 環境変数

**長期 secret を置かない。** 環境変数はその環境を使う全員が読めて、専用の secrets store が
無い。有効期限付きの STS credential のみ可とし、窓を閉じたら削除する（`docs/runbook-cloud-aws-deploy.md`）。
長期アクセスキー・API キー・秘密鍵は置かない。

## 2. リポジトリ側（クローンに含まれ、自動で効く）

| ファイル | 役割 |
| --- | --- |
| `.claude/settings.json` | プラグイン宣言・許可リスト・フック。**クラウドへ引き継がれる** |
| `scripts/hooks/pr-gate-guard.sh` | ゲート未実行の PR / マージをブロック |
| `scripts/hooks/guard-destructive.sh` | 破壊的コマンドをブロック（下記） |
| `scripts/hooks/push-secret-guard.sh` | `git push` 直前に push しようとしている範囲だけ gitleaks でスキャンし、秘密情報を検出したらブロック（#682） |
| `scripts/install_pkgs.sh` | SessionStart で `npm ci`（クラウドのみ） |
| `.nvmrc` | Node 22 を固定。クラウドの nvm は 20 / 21 / 22 を持ち、既定が 22 とは限らない |

### 引き継がれるもの / 引き継がれないもの

リポジトリにコミットされた `CLAUDE.md` / `.claude/settings.json` / `.claude/rules/` /
`.claude/agents/` / `.claude/skills/` / `.mcp.json` は**引き継がれる**。

**引き継がれない**のはユーザ階層（`~/.claude/`）の設定すべて。とくに:

- `~/.claude/hooks/guard-destructive.sh` … だから `scripts/hooks/` へ移した。
  移植時に **macOS 専用のホームパス（`/Users/<user>`）しか見ていなかったため、
  Linux の `/home/<user>` と `/root` を素通しにしていた**ことが判明したので追加してある。
- `~/.claude/settings.json` の `enabledPlugins` … リポジトリの `.claude/settings.json` 側で宣言済み。

## 3. コミット署名

**クラウドセッションのコミットは署名されない。** 署名鍵はサンドボックスに入らない
（Anthropic 側の設計で、認証は外部プロキシが代行する）。

**それで問題ない。** 本リポジトリは全て squash マージで、**ブランチのコミットはマージ時に
破棄される**。`main` に残る squash コミットは GitHub が自前の鍵で署名するため、
`main` の履歴は verified のまま保たれる。実際に現在の `main` も、ユーザ鍵ではなく
GitHub の署名で `verified: true` になっている（`gh api repos/:owner/:repo/commits/:sha`
の `commit.verification` で確認できる）。

> ⚠️ **feature ブランチに「署名済みコミット必須」のブランチ保護を掛けないこと。**
> 掛けるとクラウドセッションからの push が全て弾かれ、この前提が崩れる。

## 3.5. 実行レーン（どこで回してよい作業か） (#675)

開発の既定はクラウド。**止めるのは列挙したものだけ**で、既定は cloud-eligible にしてある
（分からないものを止める設計にすると、移管そのものを妨げる）。

| レーン | 中身 | 強制 |
| --- | --- | --- |
| `cloud-eligible` | 実装・テスト・`--pr` / `--full`・linux VRT ベースライン・dev への wrapper 経由デプロイ | 既定 |
| `local-required` | **短命 STS 資格情報の発行**（`scripts/aws-issue-credentials.sh`） | `scripts/hooks/guard-destructive.sh` が darwin 以外でブロック |

規則の正本は `src/domain/governance/execution-lane.ts`（純関数・unit テスト済み）。
フック側は**安いリテラル一致で絞ってから**判定 CLI（`scripts/check-execution-lane.ts`）を
呼ぶ ―― フックは全 Bash 呼び出しで起動されるので、毎回 tsx を起動すると体感で遅くなる。
両者のドリフトは `execution-lane.test.ts` が検出する（**規則を TS に足しただけでは何も
止まらない**ため）。

**載せなかったもの**（載せた方が目立つが、載せると腐る）:

- **本番デプロイ** … `scripts/aws-cloud-deploy.sh` が `OR_DEPLOY_ENV != dev` を全環境で
  既に拒否している。ここへ足すと**一致し得ない規則**になり、「ガードが効いている」ように
  見えて何も見ていない状態になる（2026-08-15 に IAM の Deny で同じ形を踏んだ）。
- **VRT ベースラインの更新** … linux 側は**クラウドでしか取り直せない**（§6）。止めると
  正しい作業ができなくなる。

### 判定保留（証拠が無いものを「完了」と読まない）

`npm run evaluate:gate-runs` は、**push 済み・PR 未作成・猶予内**のブランチを
`判定保留: N 本` として出す。指摘（warning）ではない ―― PR 作成前は正常な窓である。

**「指摘はありません」を「全部片づいた」と読ませないため**にある。2026-08-15、この情報が
無いためにクラウド routine を「死んだ」と誤診して同じ作業を再投入し、PR が 2 本
（#698 / #699）でき、`main` に空コミットが残った。**ターンが idle であることは、
セッションが終わったことではない。**

## 4. 動かないもの・注意点

| 事項 | 状態 |
| --- | --- |
| **AWS デプロイ** | wrapper（`scripts/aws-cloud-deploy.sh`）経由で **dev のみ**可。当初「対話型 SSO がクラウドセッションで使えない」としていたが、これは**誤りだった**（実体は SSO ではなく `user/CDK` という IAM user + 静的キー）。手順は `docs/runbook-cloud-aws-deploy.md`。IAM の実適用・bootstrap・短命 credential 発行は人間がローカルで行う |
| **VRT ベースライン（linux）** | ✅ 解消（第 94 wave）。欠落 4 枚を生成し、stale だった 5 枚を取り直した。詳細は §6 |
| **VRT ベースライン（darwin）** | ⚠️ 逆に darwin 側が stale になった。`kiosk-idle` 3 枚が待機カードの並び順を #422 inc5-b 以前のまま持つ。**macOS でしか取り直せない**。詳細は §6 |
| **VRT の自動生成** | `playwright.config.ts` で `updateSnapshots: 'none'` にしてある。既定の `'missing'` は欠落分をその場の描画で自動生成し、`retries: 1` と組み合わさると**1 回目が書いて落ち retry が通る**ため、レビューされていない描画が「正」として焼き付く。取り直すときは `--update-snapshots` を明示し、**差分を見てからコミットする** |
| **`gh` の GraphQL**（routine セッション） | 🔴 **PR レビュー用の pinned な操作セットしか通らない。** `gh pr list` / `gh pr view` に加えて **`gh pr create`（2026-08-10 実測 / #678）も `gh pr merge`（2026-08-18・PR #701 で実測 / #702）も 403**。PR #665 の時点では作成もマージも通っていた ―― **通っていたことを根拠に残さない**。作成は `npx tsx scripts/create-pull-request.ts --head … --title …`、マージは `npx tsx scripts/merge-pull-request.ts --number …`、照会は `gh api repos/{owner}/{repo}/…`（すべて REST のみ） |
| **`gh` の GraphQL**（web セッション） | ⚠️ **未検証。** 上の 403 はすべて **routine セッション**での観測で、人が claude.ai/code で開くインタラクティブなセッションで同じ制限がかかるかは**測っていない**。§0 の手順 3 で判別する。**どちらであれ REST 経路（上記スクリプト）は動く**ので、迷ったらそちらを使う |
| **`git push`** | セッションの作業ブランチに対してのみ可。force push と remote 削除は不可（非 fast-forward を作らない運用で回避する）。**マージ後のブランチ削除もできない**（`git push origin --delete` が HTTP 403）ので、ローカルの後始末として扱う |
| **`.open-next/`** | fresh checkout には無い。以前は `infra WebStack synth` が SKIP → `--strict` で FAIL になっていたが、**`quality-gate.sh` が自分でビルドするようになった**（#677）。手で `npm run build:open-next` を先に打つ必要はもう無い |
| **lighthouse** | `lhci` は npm 依存なので `npm ci` で入る。Chrome は `playwright.config.ts` と同じ理由で `quality-gate.sh` が `CHROME_PATH` を補完する |

## 5. 最初のクラウドセッションでやること（受入確認）

**順序が重要。逆にすると受入確認は成立しない。**

1. **先に linux VRT ベースラインを作る。** 欠落 4 枚（結果系 connected/failed/fallback/
   timeout）と #480 の `kiosk-idle`。`--update-snapshots` で生成し、**差分を目視してから**
   コミットする。
2. **その後で `./scripts/quality-gate.sh --full --strict`。これが移行の受入条件そのもの。**

   ⚠️ 1 と 2 を逆にすると、`updateSnapshots: 'none'` が欠落ベースラインを**意図的に落とす**
   ため `kiosk-vrt-a11y` が必ず赤くなる。これは**移行の失敗ではなく手順の誤り**なので、
   ここで赤を見ても「クラウドでは e2e が動かない」と結論しないこと。

   `--strict` を付けるのは、任意ツール（gitleaks / semgrep / lhci）が未導入のとき
   **SKIP は FAIL にならず、マージゲートが黙って弱くなる**ため。summary の目視確認に
   頼らず、`--strict` で機械的に落とす。
3. 動かないものがあれば、**再現コマンドと実際の失敗メッセージ**をここへ追記する
   （「動かない」とだけ書くと次の周回が再検証できず、stale な制約として引き継がれる）。

## 6. 受入確認の結果（第 94 wave / 2026-07-30）

**結論: 移行は成立する。`--full --strict` は全ステップ PASS。**

```
  PASS  loop halt / 変更量 (#424)      PASS  e2e (playwright)  (191s)
  PASS  typecheck (tsc)  (10s)         PASS  secrets (gitleaks)  (1s)
  PASS  lint (eslint)  (25s)           PASS  sast (semgrep)  (24s)
  PASS  unit (vitest)  (35s)           PASS  audit (npm audit)  (0s)
  PASS  build (next build)  (42s)      PASS  lighthouse (lhci)  (39s)
✅ quality-gate PASSED
```

unit は 416 files / 4,375 tests が PASS。3 回の `--full` を通じてフレークは 1 件だけ
（`kiosk-calling-stage.spec.ts` が 1 回 flaky → retry で PASS）で、既知の負荷由来タイミング
フレークの範囲。クラウド固有の不安定性は観測していない。

**e2e は動く**（219 passed / 1 skipped / 191s、webkit を除く既定 project 構成）。`/opt/pw-browsers` に
chromium が同梱されており、`playwright.config.ts` の `resolveChromiumExecutablePath()` が
自動検出した。`playwright install` も `PW_EXECUTABLE_PATH` の明示も要らなかった。
§1 の警告どおり「クラウドでは e2e が動かない」は**誤り**であることを再確認した。

到達までに 3 つ詰まった。以下、再現コマンドと実際のメッセージ。

### 6.1 semgrep が黙って入らない（→ `scripts/cloud-setup.sh` 修正済み）

`--full --strict` の 1 回目:

```
  FAIL  sast (semgrep)  (semgrep not installed; --strict)
```

再現:

```bash
pip install --break-system-packages semgrep
```

```
ERROR: Cannot uninstall PyJWT 2.7.0, RECORD file not found.
       Hint: The package was installed by debian.
```

イメージの PyJWT は debian パッケージ由来で RECORD を持たず、pip が uninstall できずに
依存解決ごと中断する。`cloud-setup.sh` の `|| true` がこれを握り潰すため、
**セッションは正常に起動するのに semgrep だけ存在しない**状態になる。`--strict` を付けて
いなければ SKIP で流れ、§1 が警戒していた「マージゲートが黙って弱くなる」がそのまま起きる。

対処（`cloud-setup.sh` に反映済み。環境ダイアログ側も貼り替えること）:

```bash
pip install --break-system-packages --ignore-installed PyJWT semgrep
```

→ `semgrep 1.172.0` が入り `sast` PASS（23s）。

### 6.2 shallow clone が `.gitleaksignore` の指紋を無効化する（→ `quality-gate.sh` 修正済み）

`--full --strict` の 1 回目:

```
  FAIL  secrets (gitleaks)  (1s)
      INF 50 commits scanned.
      WRN leaks found: 2
```

検出された 2 件はいずれも退館 token のテストフィクスチャ（`credential-display.test.ts:5` /
`self-id.test.ts:81`）で、**`.gitleaksignore` に受容済みとして登録されている**もの。

原因は指紋の形式。`.gitleaksignore` は `<commit>:<file>:<rule>:<line>` で受容対象を特定し、
登録されている commit は `6ce134ac` / `04915c88`（2026-07-12）。ところが
**クラウドの clone は depth 50 の shallow** で、この 2 つは存在しない:

```bash
git rev-parse --is-shallow-repository   # → true
git rev-list --count HEAD               # → 51
git cat-file -e 6ce134ac4c759431cadfb328ef5cc68f74e5a665   # → 不在
```

切り詰められた根より古い履歴が無いため、当該文字列は grafted root（`e2540e76`）で
**新規追加されたもの**として現れ、別 SHA で報告される。指紋は一致せず、受容済みのはずの
フィクスチャが毎回上がる。実 secret と見分けが付かない red なので放置できない。

対処:

```bash
git fetch --unshallow
gitleaks detect --no-banner --redact
#   INF 399 commits scanned.
#   INF no leaks found
```

`quality-gate.sh` の secrets ステップが shallow を検出して自動で unshallow するようにした。
走査範囲が増える方向なので検出は弱まらない。

### 6.3 VRT の取り直し範囲が §4 の記述より広かった

§4 は「linux は結果系 4 枚が欠落 ＋ #480 の `kiosk-idle` 2 枚が stale」としていたが、実際に
`--update-snapshots=missing` を回すと **既存の linux ベースライン 3 枚も落ちた**:

```
  33057 pixels (ratio 0.04 of all image pixels) are different.      … purpose
  Expected an image 1080px by 1506px, received 1080px by 1475px.    … target
  65399 pixels (ratio 0.08 of all image pixels) are different.      … confirm
```

差分を目視した結果、旧ベースラインには **#496 で撤去済みの進捗ステッパー**
（「2 相手 / 3 情報 / 4 確認」）が焼き付いていた。darwin 側は #496 で取り直され、
linux 側だけが取り残されていた。プラットフォーム差ではなく**時点差**。

さらに `kiosk-idle-large-display` は **stale なのにテストが通っていた**。実測:

| | 値 |
| --- | --- |
| 旧新の差分 | 13,028 px（ratio 0.00628） |
| `maxDiffPixelRatio: 0.02` の許容（1920x1080） | 41,472 px |

文言の総取り替えと CTA カードの入れ替わり（「QR で受付」→「部署から選ぶ」）が両方あっても
許容差の 1/3 に収まる。**この viewport の VRT は退行検出として実効していない。**
閾値の見直しは全 viewport に影響するため本受入確認の範囲外とし、#480 の残件とする。

### 6.4 手順上の注意（次の周回向け）

- **`--update-snapshots=missing` は 1 回では終わらない。** `kiosk-screenshot.spec.ts` が属する
  `chromium-ipad` は `pristine-state` に `dependencies` で依存する。1 回目は
  `pristine-state`（`kiosk-vrt-a11y`）が baseline 書き込みで fail するため後続が
  `did not run` になる。**green になるまで複数回**回すこと。
- **既存ベースラインの更新には先に `rm` が要る**（#480 記載の罠）。`missing` は既存を書き換えず、
  `changed` は許容差内だと書き換えない。
- 生成物は必ず darwin 版および現行コードと突き合わせる。今回 5 枚が「stale だから差分が出た」
  ものだったが、同じ症状は**本物の退行**でも出る。区別できるのは目視だけ。

### 6.5 残課題（macOS 側でしかできない）

`kiosk-idle` の **darwin ベースライン 3 枚**が、待機カードの並び順を #422 inc5-b 以前
（`担当者を呼ぶ` → `QR で受付` → …）のまま持っている。現行コードは
`turnAnswersFor('idle')`（callStaff / department / delivery / other）を先に描き、
`turnHandoffsFor('idle')`（QR）を**その後**に描くため、正しい並びは
`担当者を呼ぶ` → `部署から選ぶ` → `配送・納品` → `その他` → `QR で受付`。

`{platform}` 込みの名前ゆえ **Linux からは原理的に取り直せない**。

> **✅ 第 95 wave（macOS 側）で対応済み。ただし上の「2 件が落ちる見込み」という予測は
> 外れた — 実際には 3 件とも PASS していた。**
>
> 診断（darwin ベースラインが旧並びのまま）は**正しかった**が、`npm run test:e2e` を回しても
> 落ちない。カードの**位置は同じで中身の文字とアイコンだけが入れ替わる**ため、差分は
> 4900px / 4900px / 12319px（実比 ~0.006）にしかならず、当時の
> `maxDiffPixelRatio: 0.02` の内側に収まっていた。
>
> **つまり VRT が退行を隠していた**（第 77 wave に続き 2 度目）。ベースラインの取り直しと
> あわせて `kiosk-screenshot.spec.ts` の許容値を **0.002** へ下げた（同一プラットフォームの
> 再撮影は実測ノイズ 0。12 連続 pass で確認）。
>
> **教訓: 「落ちる見込み」を検証せずに残さない。** 予測を残すなら実際に走らせて確かめる
> （このリポジトリは stale な制約の引き継ぎで繰り返し損をしている）。

### 6.6 残課題: `kiosk-vrt-a11y` の許容値は下げられない（両プラットフォーム同時対応が要る）

`kiosk-screenshot` と違い、`kiosk-vrt-a11y.spec.ts` の `maxDiffPixelRatio: 0.02` は
**下げると毎日落ちる**。`maxDiffPixelRatio: 0` で実測したところ 9 件中 1 件
（`kiosk-landscape-out-of-hours`）が 1813px 差分で落ち、**差分は「次回の受付開始」の
日時テキストだけ**だった（日付が変われば必ず動く）。

筋の良い直し方は閾値ではなく**その要素の `mask`**（第 72 wave で通話中パネルに使った手法。
ただし PII の本文だけに絞ったように、**必要最小限へ絞る**こと)。

**ただし mask は描画を変えるので linux ベースラインも取り直しになる。** macOS 側だけで
やると linux が壊れるため、**両プラットフォームを 1 周で揃える必要がある**。

#### ✅ 完了（ブランチ `fix/vrt-a11y-reopen-time-mask`。macOS → クラウドの 1 周で両 OS を揃えた）

macOS 側で実施済み:

- `kiosk-out-of-hours-reopen-time`（**日時の値のノードだけ**）を mask に追加。
  枠（`-reopen-time` の親 `-reopen`）ごとは隠さない — 第 72 wave の反省に従い最小へ絞る。
  ラベル「次回の受付開始」・緊急連絡枠・言語切替は**比較対象のまま残る**。
- `SHOT_BASE` の `maxDiffPixelRatio` を **0.02 → 0.002**。
- darwin ベースラインは **`out-of-hours` の 1 枚だけ**再生成。
  **残り 8 枚は再生成せずに 0.002 で PASS した**（＝ノイズが実測 0 であることの裏付け）。
- `--repeat-each=3` で 30/30 PASS。

linux 側（クラウドセッション）で実施済み:

- 再生成は **`out-of-hours` と `qr-intro` の 2 枚**。上の「1 枚だけのはず」という予測は外れた。
- **予測どおり「止めて差分を見る」を実行した結果、`qr-intro` は本物の stale だった**（下記）。
- 0.002 で 10 件 PASS。さらに `maxDiffPixelRatio: 0` で計測すると **10 件とも完全一致**
  （linux 側もノイズ実測 0。macOS の 8/9 より強い — 唯一ずれていた日時を mask したため）。
- `./scripts/quality-gate.sh --full --strict` 全 10 ステップ PASS。

##### 発見: 閾値を締めた瞬間に 3 例目の stale が出た（`qr-intro` / linux）

`kiosk-landscape-qr-intro-chromium-ipad-linux.png` が **12,376px（実比 0.0142）** で落ちた。
差分は「最初に戻る」の位置で、旧ベースラインでは**コンテンツ列の中の小さなボタン**、
現行は**画面幅いっぱいの常設バー**。これは **#506（QR 受付の逃げ道を常設バーへ一本化）**
の描画で、darwin 版は #506 で取り直されたが linux 版が取り残されていた。

**0.02 のときは 0.0142 なので通っていた。** 第 94 wave の受入確認（`--full --strict` 全 PASS）
でも当然素通りしている。つまり:

| | 隠れていた退行 | 実比 | 見つけた契機 |
| --- | --- | --- | --- |
| 1 例目 | `kiosk-idle-large-display` の文言・CTA（linux） | 0.0063 | §6.3・目視 |
| 2 例目 | `kiosk-idle` 3 枚のカード並び（darwin） | ~0.006 | §6.5・第 95 wave の実測 |
| 3 例目 | `qr-intro` の逃げ道バー（linux） | 0.0142 | **閾値を 0.002 へ締めたこと** |

**「ゲートが全 PASS」は「退行が無い」ではない。** 3 例とも `--full` green の状態で潜んでいた。
閾値を実測ベースまで締めて初めて機械的に出てくる。
