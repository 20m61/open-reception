---
name: issue-ac-mapping
description: Map an issue's acceptance criteria onto the code that actually exists in main before implementing anything. Use at the start of every loop round, when picking up an issue, when docs/loop-queue.md claims something is unimplemented or blocked, or when an epic's child issues need scoping. Prevents rebuilding what already exists and prevents treating stale queue classifications as fact.
---

# issue-ac-mapping

このリポジトリで**最も繰り返し再学習されている失敗**は、issue 本文や
`docs/loop-queue.md` の分類を信じて着手し、既に main に在るものを作り直す／
「外部待ち」と書かれた issue が実はローカルで消化可能だったと後から気づくことである。

実績: 2026-07-03 の周回で「#284/#290 = 外部待ち」分類が **stale** と判明した
（#284 は 4 AC 中 3 つが既に充足、#290 も真の外部待ちは item1 の実 deploy のみ）。
2026-07-13 も同様に、残りと思われていた item2/item3 がローカルで消化できた。

**issue 本文とキューの分類は仮説であって事実ではない。事実は main のコードだけ。**

## 手順

### 1. AC を列挙する

```bash
gh issue view <N>
```

受け入れ条件を**チェック可能な粒度に分解**して箇条書きにする。親 epic なら子 issue を
辿り、実装単位（increment）まで割る。曖昧な AC は、何が満たされれば green かを自分で定義する。

### 2. AC ごとに現物を探す

AC 1 つにつき最低 1 回は実コードを検索する。**読まずに「未実装」と判定しない。**

```bash
rg -n '<ドメイン語・関数名・API パス>' src/ infra/ docs/
```

探す順序:
1. `src/ARCHITECTURE.md` と `docs/` 配下の該当設計書（設計が先に在ることが多い）
2. `src/domain/` … 純ロジックは先行実装済みのことが多い
3. `src/app/api/` … ルートの有無と認可ゲート
4. `src/components/` … UI 配線
5. `infra/lib/` … CDK スタック
6. 既存テスト（`*.test.ts`）— AC がテスト名でそのまま表現されている場合がある

### 3. 判定を記録する

各 AC を 3 分類し、**根拠のファイルパスを必ず添える**:

| 判定 | 意味 |
| --- | --- |
| 充足 | 実装 + テストが在る。根拠パスを書く。実装しない。 |
| 部分 | 土台は在るが AC を満たしきらない。**差分だけ**を increment 化する。 |
| 未着手 | 現物が無い。新規実装の対象。 |

さらに実行可能性で分類する:
- **ローカル可** … このまま TDD で消化できる
- **外部待ち** … 実 AWS apply / 実認証情報 / 実機 UAT が要る → #65 にスタック、
  ただし **interface + mock 先行**でローカル分を切り出せないか必ず検討する
- **要ユーザー確認** … 破壊的変更・スキーマ/公開 API・本番デプロイ・外部送信・
  依存追加(#105)・secret/PII・**コスト増**（CLAUDE.md の重大変更条件）

### 4. 未充足の AC だけを実装する

充足済み AC は触らない。部分充足は差分だけ。純ロジック（`src/domain/`）を先行させ、
新規ビルドの重複を避ける。ここから `superpowers:test-driven-development` に入る。

### 5. キューを直す

分類が stale だったら、その場で `docs/loop-queue.md` を現物に合わせて更新する。
**次の周回に同じ誤りを再学習させない。** 判明した根拠（どのパスで充足していたか）を残す。

## 落とし穴

- epic の「主なギャップ」節は起票時点のスナップショット。数周回で陳腐化する。
- 「外部待ち」は多くの場合 **AC の一部だけ**が外部待ち。全体を止める理由にしない。
- 設計書（`docs/*-design.md`）が在ることと実装が在ることは別。両方確認する。
- 逆に、実装が在ってもテストが無ければ「充足」ではない（このプロジェクトは CI 無し・
  ローカルゲートが唯一の担保なので、テスト不在は AC 未達として扱う）。
