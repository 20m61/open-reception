# クラウド開発環境（Claude Code on the web）

開発を Claude Code on the web（クラウドセッション）へ移すための**正本**。環境設定の実体は
claude.ai/code の環境ダイアログにあり、リポジトリからは触れない。ここは「何をどう設定してあるか」
「なぜそうしたか」「何が動かないか」を残す場所。

セッションは Ubuntu 24.04 の使い捨て VM（4 vCPU / 16 GB RAM / 30 GB ディスク）で、
リポジトリはクローンされた状態で始まる。

## 1. 環境ダイアログ側の設定（claude.ai/code）

### Network access: **Custom**

「Also include default list of common package managers」に**チェックを入れた上で**、
次を許可ドメインへ追加する。

```
cdn.playwright.dev
```

**理由**: Playwright はブラウザバイナリを `cdn.playwright.dev` から取る。このホストは
Trusted の既定許可リストに**入っていない**。Trusted のままだと `playwright install` が
失敗し、**e2e / VRT / `--full` が丸ごと回らない**。

> このリポジトリは過去に「e2e はこの環境では動かない」という**誤った結論を 5 周にわたって
> 引き継いだ**ことがある（真因は Playwright のビルド番号不一致で、`executablePath` を渡せば
> 動いた。`docs/handoff-2026-07-27.md`）。同じ轍を踏まないため、**動かないときは必ず
> 再現コマンドと実際の失敗メッセージを残す**こと。

### Setup script

`scripts/cloud-setup.sh` の内容をそのまま貼る（あちらが正本。変更したら両方更新する）。
入れているのは 3 つ:

| 対象 | なぜ要るか |
| --- | --- |
| `gh` CLI | プリインストールされていない。ループ workflow が `gh pr create` / `gh pr merge` に全面依存する |
| `gitleaks` / `semgrep` | 無いと `quality-gate.sh` が SKIP する。SKIP は FAIL にならないので**マージゲートが黙って弱くなる** |
| Playwright chromium | イメージに同梱されない場合の保険（同梱時は `playwright.config.ts` が `/opt/pw-browsers` を自動検出する） |

制約: 非ゼロ終了すると**セッションごと起動しない**ので非必須は `|| true`。5 分以内。
初回だけ実行され、以後はファイルシステムのスナップショットとしてキャッシュされる
（スクリプトか許可ドメインを変えると再実行される）。

### 環境変数

**設定しない。** 環境変数はその環境を使う全員が読めて、専用の secrets store が無い。
AWS 認証情報などは置かないこと。

## 2. リポジトリ側（クローンに含まれ、自動で効く）

| ファイル | 役割 |
| --- | --- |
| `.claude/settings.json` | プラグイン宣言・許可リスト・フック。**クラウドへ引き継がれる** |
| `scripts/hooks/pr-gate-guard.sh` | ゲート未実行の PR / マージをブロック |
| `scripts/hooks/guard-destructive.sh` | 破壊的コマンドをブロック（下記） |
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

## 4. 動かないもの・注意点

| 事項 | 状態 |
| --- | --- |
| **AWS デプロイ** | 不可。対話型 SSO がクラウドセッションで使えない。そもそも本番/dev デプロイは CLAUDE.md の**停止境界**でユーザー確認が要るため、ローカルに残す |
| **VRT ベースライン** | ベースラインは**実行プラットフォームでしか作れない**。linux 版は 4 枚欠けている（結果系 4 状態は darwin のみで生成された）。加えて #480 で `kiosk-idle` の linux 版が #324 以前のまま。**クラウド（Linux）は #480 を閉じられる唯一の手段**（macOS からは原理的に取り直せない） |
| **VRT の自動生成** | `playwright.config.ts` で `updateSnapshots: 'none'` にしてある。既定の `'missing'` は欠落分をその場の描画で自動生成し、`retries: 1` と組み合わさると**1 回目が書いて落ち retry が通る**ため、レビューされていない描画が「正」として焼き付く。取り直すときは `--update-snapshots` を明示し、**差分を見てからコミットする** |
| **`git push`** | セッションの作業ブランチに対してのみ可。force push と remote 削除は不可（非 fast-forward を作らない運用で回避する） |
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
