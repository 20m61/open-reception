# ループ開発ワークフロー（Issue 順次消化）

Issue を 1 件ずつ「ブランチ → 実装 → ローカル品質ゲート → PR → セルフレビュー →
squash マージ → クリーンアップ → Issue クローズ」で消化するためのランブック。

**前提方針**

- **GitHub Actions は使用しない。** 品質ゲートはローカル（または Actions 以外の
  ランナー）で `scripts/quality-gate.sh` を実行して担保する。
- main へのブランチ保護は設定しない代わりに、**「ゲート green を確認してからマージ」**
  をこのランブックで運用ルールとして強制する。
- マージは **squash**、マージ後はブランチを削除する（リポジトリ設定は
  `deleteBranchOnMerge=false` のため `--delete-branch` を明示する）。

---

## 1 周のサイクル

### 0. 起点を green にする

```bash
git switch main && git pull --ff-only
./scripts/quality-gate.sh --fast      # 起点が green であることを確認
```

ループ中、main が red の状態で次の Issue に進まない。

### 1. Issue を選ぶ

優先キュー（`docs/loop-queue.md` 参照、なければ本書末尾の表）から先頭を取る。
依存のある Issue（基盤系）を先に消化する。

```bash
gh issue view <N>
```

### 2. ブランチを作る

命名規約: `<type>/<topic>`（既存実績に合わせる。例 `feat/visit-reservation-qr`）。
`type` は Conventional Commits に合わせる（`feat` / `fix` / `refactor` / `docs` /
`chore` / `test`）。

```bash
git switch -c feat/<topic>
```

### 3. 実装（TDD 推奨）

- 失敗するテストを先に追加 → 実装 → green、の順を基本にする。
- 既存コードの命名・コメント密度・構成に合わせる。
- 1 Issue が大きい場合は **increment 単位**で PR を分割する
  （実績: Vonage は 1 / 2a / 2b / 2c に分割）。
- 外部認証情報・実機・アセットが必要な部分は **interface + mock 先行**で実装し、
  実物が必要なタスクは #65 にスタックする。

### 4. ローカル品質ゲート（PR 前・必須）

```bash
./scripts/quality-gate.sh --pr        # typecheck + lint + unit + build
```

セキュリティ/依存に触れた変更では追加で:

```bash
./scripts/quality-gate.sh --pr --secrets          # gitleaks
./scripts/quality-gate.sh --pr --secrets --sast --audit   # 重め
```

UI ルートやアクセシビリティに触れた変更では:

```bash
./scripts/quality-gate.sh --pr --e2e --lighthouse
```

`--full` はマージ前または定期に流す全部入り。任意ツール未導入は SKIP 表示
（`--strict` で FAIL 扱い）。

### 5. コミット

Conventional Commits（日本語可）。Issue 参照を含める。

```bash
git add -A
git commit -m "feat(reservation): 来訪予約ドメインと QR トークン発行 (#97)"
```

> **署名の注意**: コミット署名は 1Password の `op-ssh-sign`。1Password がロック中だと
> `git commit` が署名失敗で止まる。失敗したら 1Password をアンロックして再実行する
> （`--no-verify` での回避はしない）。

### 6. PR を作る

```bash
git push -u origin HEAD
gh pr create --fill --base main \
  --body-file .github/pull_request_template.md   # テンプレを編集して使う
```

PR タイトルは squash 後の main コミットになるため、Conventional Commits で書く。
本文には `Closes #<N>` を入れ、Issue の受け入れ条件をチェックリストとして転記する。

### 7. セルフレビュー

マージ前に自分の diff を読み直す。必要なら専門エージェントを使う:

- `pr-review-toolkit:code-reviewer` … 規約・ベストプラクティス
- `pr-review-toolkit:silent-failure-hunter` … エラー握りつぶし
- `/code-review` … 差分のバグ/簡素化レビュー

指摘を反映したら再度 `./scripts/quality-gate.sh --pr`。

### 8. マージ（**ゲート + レビュー green で自動マージ**）

運用方針: PR は、次の両方を満たせば **ユーザー確認なしで自動マージ**してよい。
1. 品質ゲート green（`./scripts/quality-gate.sh --pr`、UI/a11y 変更時は `--e2e` 等も）。
2. レビューで blocking 指摘なし（セルフレビュー + `code-reviewer` /
   `silent-failure-hunter` / `/code-review` のいずれかを回し、blocking を解消済み）。

```bash
gh pr merge --squash --delete-branch
```

ただし次のいずれかに該当する場合は**マージ前にユーザー確認する**:
重大な設計判断 / 破壊的変更（スキーマ・公開 API・移行）/ 外部影響（本番デプロイ・
外部サービスへの送信）/ 依存・ライセンス追加（#105）/ secret・PII の取り扱い変更。
ユーザーはいつでも interrupt してマージを止められる。

### 9. クリーンアップ & クローズ

```bash
git switch main && git pull --ff-only
```

PR 本文に `Closes #<N>` があれば squash マージで Issue は自動クローズされる。
親 Epic（#96 等）のチェックボックスを更新する。

### 10. 次の Issue へ

起点（手順 0）に戻る。

---

## 並列オーケストレーション

「独立した作業は並行、依存・統合点は直列」を原則にする。依存 DAG と並列トラックは
`docs/loop-queue.md` を正とする。

### 何を並列化するか

1. **Issue 横断（実装の並列）**: 依存関係のない Issue は **git worktree で分離**して
   同時に実装する。互いのファイルを書き換えないトラックだけを同時に走らせる。
   - 例（初期 DAG）: トラックA `#105`（compliance/docs）・トラックB `#80`（multitenant 基盤）・
     トラックC `#79`（来訪者検知）は相互独立 → 並行可。
   - チェーンは直列: `#97 → #98 → #99`、`#80 → #85 → 管理画面クラスタ`。
2. **Issue 内（調査・設計の並列）**: 1 Issue 着手時、`Explore`（探索）と `Plan`（設計）
   エージェントを**並行 fan-out**して着手前の地図を作る。レビューも
   `code-reviewer` / `silent-failure-hunter` を並行で回す。

### どう分離するか（worktree）

並行トラックは作業ツリーを分けて衝突を防ぐ。

```bash
# 例: 独立トラックごとに worktree を切る
git worktree add ../open-reception-105 -b feat/compliance-guard
git worktree add ../open-reception-79  -b feat/presence-detection
# 各 worktree で実装 → それぞれ ./scripts/quality-gate.sh --pr → PR
git worktree remove ../open-reception-105   # マージ後に撤去
```

サブエージェントに実装させる場合は `isolation: "worktree"` を使い、
**並行で書き込むトラック同士が同一ファイルを触らない**ことを割り当て時に保証する。

> fresh な worktree には `node_modules` / `infra/node_modules` が無い。
> `scripts/quality-gate.sh` は既定で不足を検出して `npm ci`（無ければ `install`）を
> 実行し自己修復するため、手動インストールは不要（`--no-bootstrap` で抑止可能）。

### 直列を守る点（重要な制約）

- **マージは直列**（手順 8）。並列で PR が積まれても、マージは 1 本ずつ（ゲート + レビュー
  green を満たせば自動で）行い、後続トラックはマージ後の main を `git pull --ff-only` で
  取り込んでから整合を取る。重大変更時のみユーザー確認（手順 8 の例外条件）。
- **コミット署名は対話的**（1Password `op-ssh-sign`）。並行エージェント内でのコミットは
  署名で詰まりやすい。コミットは 1Password アンロック済みを確認してから行う。
- **ローカルゲートは重い**（build ~30s 超）。同時実行は **最大 2〜3 トラック**を目安に
  し、`--pr` の同時多重起動でマシンを飽和させない。
- 依存チェーン内（`#97→#98`）は**前段がマージされてから**後段を本実装する。先行して
  下調べ（Explore/Plan）するのは可。

### 並列度の決め方

- 既定: 独立トラック **2〜3 本**を上限に回す。
- 調査/レビューの fan-out（読み取り専用エージェント）はこれと別枠で並行してよい。
- 大規模な多段オーケストレーション（多数エージェントのワークフロー）が必要なときのみ、
  ユーザーの明示同意の上で Workflow を使う。

---

## やらないこと / ガード

- `git push --force` を保護ブランチへ行わない。
- `--no-verify` でフック（署名・lint）を回避しない。
- 品質ゲート red のまま PR・マージしない。
- 外部サービスへ秘密情報を出さない。フロント bundle に secret/private key を含めない。
- 外部依存を追加するときは #105 のライセンス/プライバシーチェックを通す
  （SPDX / LICENSE / 商用利用可否 / 個人情報の最小化）。

---

## 着手キュー

依存 DAG・並列トラック・ウェーブは **`docs/loop-queue.md`** を正典とする。
概略: 独立ルート `#105` / `#80→#85→管理画面クラスタ` / `#79` を並行、QR チェーン
`#97→#98→#99` を直列、`#4/#31/#65` は外部リソース待ちで対象外。
