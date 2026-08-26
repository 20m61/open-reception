# Cursor CLI を bounded worker として使う (#808)

公式 Cursor CLI（`agent`）を**低リスク実装の委譲先**として使うための手順と境界。
正本は `CLAUDE.md`（品質ゲート・調査/検証の作法）と `.claude/rules/opus5-autonomous-loop.md`
（停止境界・レビューの停止条件）であって、**本書はそれらを置き換えない**。

> **時期**: #808 は post-MVP rollout として起票されている。8/30 の受付 MVP ゲート前は
> **本書の整備までで、書き込みワーカーとしての実運用はゲート後**。ゲート前に使うのは、
> critical path の容量を食わないと確認できたときだけ。

## 0. 何より先に読むこと — ガードは Cursor には効かない

🔴 **このリポジトリの安全装置は全部 Claude Code の PreToolUse フックである。**
`.claude/settings.json` に登録された 3 本だけで、**git hook は 1 本も無い**
（`.git/hooks/` はサンプルのみ。実測で確認）。

| ガード | 何を止めるか | Cursor に効くか |
| --- | --- | --- |
| `scripts/hooks/pr-gate-guard.sh` | ゲート green 記録の無い `gh pr create` / `gh pr merge` | **効かない** |
| `scripts/hooks/guard-destructive.sh` | darwin 以外でのデプロイ、保護ブランチへの `reset --hard`、`rg -r` | **効かない** |
| `scripts/hooks/push-secret-guard.sh` | secret を含む push | **効かない** |

つまり #808 の contract にある「commit/push/PR/deploy/AWS/Vonage 資格情報の操作をさせない」は
**現状ポリシーでしかなく、機械強制されていない**。委譲プロンプトで禁じるだけでなく、
**Cursor に資格情報を渡さない**ことで担保する（§3）。

### 唯一効く構造的な歯止め: ゲートスタンプ

`scripts/lib/gate-stamp.sh` の `gate_tree_fingerprint` は**作業ツリーの内容ハッシュ**を取る
（mtime ではない）。したがって:

**Cursor が 1 バイトでも書き換えれば、それ以前のゲート green 記録は stale になる。**

マージを Claude Code 経由に限る限り、Cursor の出力が**ゲートを通らずに main へ入ることはない**。
これが「bounded worker」を成立させている唯一の構造で、**この前提を崩さない**
（＝ Cursor に `gh pr merge` をさせない）。

## 1. 導入

`agent` は**このクラウドサンドボックスには入っていない**（実測: `command not found`）。
ローカル macOS とクラウドのどちらで走らせるかで手順が変わる。

### 1-A. ローカル macOS

```bash
curl https://cursor.com/install -fsS | bash    # 公式インストーラ
agent --version                                 # 疎通確認
agent -p "print the repository name"            # headless の疎通確認
```

認証はブラウザ経由（`agent` 初回起動時）か API キー。**API キーをリポジトリに置かない** ——
`.env*` も `.claude/settings.local.json` も追跡対象になりうるので、シェルの環境変数か
Cursor 自身の資格情報ストアに置く。

### 1-B. クラウドセッション

`scripts/cloud-setup.sh` には**足さない**。理由は 2 つある:

1. **資格情報の置き場所が無い。** クラウド環境の環境変数は claude.ai/code の環境ダイアログで
   設定するもので、`docs/cloud-dev-environment.md` §158 の一覧に載る。Cursor のキーをそこへ
   置くと、**このリポジトリの全クラウドセッションが Cursor を撃てる**状態になる
2. **並走が起きる。** クラウドセッションは Claude Code が作業ツリーを持っている。
   同じツリーで Cursor を走らせると §2 の禁止に直ちに当たる

クラウドで使うなら、**そのセッション限りで**インストールし、キーを手で渡す:

```bash
curl https://cursor.com/install -fsS | bash
export CURSOR_API_KEY=...        # セッション限り。repo にも環境ダイアログにも置かない
```

## 2. 並走させない — worktree で分ける

🔴 **Claude と Cursor が同じ作業ツリーを同時に書かない。** #808 の contract にあるが、
理由はこのリポジトリで実際に踏んでいる（2026-08-26）:

- ゲートと並走したエージェントがファイルを触り、**ゲートが丸ごと落ちた**
- タイムアウトで復元前に死んだエージェントが変異を 1 つ残し、**以降の全測定が汚染された
  ベースに対して行われて、健全なテストを「flaky」と誤判定した**

`.claude/rules/opus5-autonomous-loop.md`「変異検証エージェントは作業ツリーを隔離する」と
同じ扱いにする:

```bash
git worktree add /tmp/wt-cursor -b feat/<topic> origin/main
cd /tmp/wt-cursor
npm ci                            # ⚠️ worktree に node_modules は無い（§2.1）
agent -p "<委譲プロンプト>"
```

### 2.1 worktree では `npm ci` を省かない

**本ツリーの `node_modules` をシンボリックリンクで借りない。** 2026-08-26 に実際にやって
失敗した —— `npx vitest` は通るが `--fast`（typecheck 含む）を回さないままコミットし、
**vitest は型を見ないので unit は緑のまま**、ゲートまで型エラーに気づかなかった。

worktree で作業するなら、**そこで `./scripts/quality-gate.sh --fast` が回る状態にする**。
回せないなら、コミット前に本ツリーへ変更を持ち帰って `--fast` を通す。

## 3. 委譲してよいもの / いけないもの

`.claude/rules/opus5-autonomous-loop.md` の停止境界がそのまま上位に効く。そのうえで
Cursor には**さらに狭い**範囲だけを渡す。

### 渡してよい

- 振る舞いが凍結済みで、**決定的に検証できる**実装（既存テストが仕様を固定している）
- 機械的な同型変換（命名の統一、重複の抽出、型の付け替え）
- テストの追加（既存の実装を変えないもの）

### 渡さない

- テナント / 認証 / secret / 電話連携の**設計判断**
- commit / push / PR / deploy / AWS / Vonage 資格情報の**操作**
- 停止境界（本番デプロイ、認可境界、DynamoDB 非互換変更、外部送信の実配線、
  PII / 監査方針、新規依存、主要 Journey の意味の変更）
- **判断が要るもの全般。** Cursor の出力は**証拠ではなく候補**である

## 4. 完了の判定

🔴 **Cursor の出力は完了の根拠にならない。** 判定するのは、これまでと同じもの:

1. `./scripts/quality-gate.sh --pr`（PR 前）/ `--full`（マージ前）が current revision で green
2. 変更が主張どおりに効いていることの**変異検証**（`CLAUDE.md`「検証の作法」）
3. リスクに応じた独立レビュー（`.claude/rules/opus5-autonomous-loop.md`「レビューの停止条件」）

Cursor が「できた」と言っても、**ゲートと変異検証を通っていなければ何も終わっていない**。

## 5. やめるとき

Cursor を外す判断は、**ワークフローの作り直しを伴わない**ようにしてある。
本書の手順は「worktree を切る → 委譲する → ゲートで判定する」だけで、
委譲先が Claude のサブエージェントでも Cursor でも同じ形になっている。
やめるときは**この節ごと使わなくなるだけ**で、`scripts/` にも `.claude/` にも
Cursor 固有の配線を作らない（作らないことが、やめやすさの正体である）。

## 6. 記録すること（#808 の受入条件）

パイロットを回したら、`docs/gate-runs.md` と同じ粒度で残す:

- **介入回数** … 委譲した仕事のうち、人／Claude が手を入れ直した割合
- **スコープ逸脱** … 頼んでいない変更が混ざった件数
- **回帰** … Cursor の出力が原因でゲートが赤くなった件数
- **実時間** … 委譲した場合としなかった場合の所要

**介入回数とスコープ逸脱が下がらないなら、委譲は速くなっていない。**
このリポジトリは「散文が実測から遅れる」型を何度も踏んでいるので、
体感ではなく数えたもので判断する。
