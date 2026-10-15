# Runbook: 既存の予約に `ttl` を後付けする（#1022 / PR #1244）

**実行するのは owner（Mac の端末）だけ。** 本番データへの書き込みであり Human Gate。
Claude のセッションからはエミュレータ（MiniStack）に対してしか回さない。

- 何のためか: PR #1244 以降、予約は書き込みのたびに DynamoDB TTL 属性 `ttl` を持つ。
  **それより前に書かれた予約は `ttl` を持たない**ので、アプリの読み取りからは期限どおり外れても、
  DynamoDB からは物理削除されない。この手順で `ttl` を後付けする。
- 規則の正本: `docs/visit-reservation-design.md`（保存期間）、`src/domain/reservation/retention.ts`
- 道具: `src/lib/reservation/ttl-backfill-cli.ts`（CLI）、`src/lib/reservation/ttl-backfill.ts`（読み書き）、
  `src/domain/reservation/ttl-backfill.ts`（何をするかを決める純関数）

## この道具がすること・しないこと

| | |
|---|---|
| 読む範囲 | 予約のパーティション（`PK = col#visit_reservation`）を最後のページまで。読む属性は `SK` / `visitAt` / `expiresAt` / `retentionDays` / `ttl` だけ。氏名・会社名・メモは読まない |
| `ttl` の値 | `reservationTtlSeconds`（アプリの書き込みと同じ関数）。`now` を使わない。同じレコードなら、アプリが次に書き戻したときと同じ値になる |
| 書き込み | `ttl` だけを足す `UpdateItem`。条件: まだ在る・まだ `ttl` が無い・`visitAt` / `expiresAt` / `retentionDays` が走査時と同じ。ほかの属性は変えない |
| 既定 | **dry-run**（書き込まない）。書くには `--apply --expect-to-set <N>` が要る。`N` は dry-run の `toSet` |
| しないこと | 期限を計算できないレコード・`ttl` が計算値と違うレコードは**変えない**（件数と id を出す。扱いは手順 5 で owner が決める）。レコードを削除しない |
| 何度流しても | 同じ結果になる（条件付きなので、`ttl` を付け終えたレコードには二度と書かない） |

### 報告の読み方

| 行 | 意味 |
|---|---|
| `scanned` | 走査した件数。下の 4 区分の和と一致する（どの区分にも入らないレコードは無い） |
| `toSet` | `ttl` を後付けする件数 |
| `(already expired when set: n)` | そのうち、付ける `ttl` が既に過去のもの。**付けると DynamoDB の TTL 削除の対象になり、48 時間程度で物理削除される。** アプリからは既に読めない予約で、削除は保存期間の規則どおりの結果である |
| `alreadySet` | 計算値と同じ `ttl` を既に持つ（#1244 以降に書かれた・書き戻された）。何もしない |
| `mismatch` | 計算値と違う `ttl`（数値でないものを含む）を持つ。アプリは常に計算値を書くので、**調べるべき異常**。変えない |
| `uncomputable` | 期限を計算できない（`retentionDays` が正の安全整数でない、日付を解釈できない）。**どの読み取り経路からも返らず、`ttl` も無いので物理削除もされない**（「読めず消えない PII」）。変えない |
| `updated` / `skippedChanged`（apply のみ） | 書いた件数 / 走査の後にアプリが書いた・編集された・消えたので書かなかった件数 |

## 0. 前提（先に確認する）

| 確認 | 方法 | 期待 |
|---|---|---|
| PR #1244 が main に merge 済み | GitHub | merged |
| **#1244 を含む版が、対象の環境へ deploy 済み** | deploy の記録 | 済み。🔴 古い版が動いていると、backfill の後もその版が `ttl` 無しで書き続ける |
| 作業するのは Mac の owner 端末 | — | Claude のセッションではない |
| 対象環境の短命 credential を発行済み | `scripts/aws-issue-credentials.sh`（通常の窓の開け方） | 有効期限内 |
| 対象テーブル名 | WebStack の出力 `DataTableName` | 控えておく |
| PITR が有効か | 下記 | stg / prod は有効（最大 35 日）。dev は環境の設定による |

```bash
# 向き先をエミュレータから外す（ローカル検証の値が残っていると、そちらを向く）
unset AWS_RUNTIME AWS_ENDPOINT_URL
aws sts get-caller-identity --query Account --output text   # 対象環境のアカウントであること

TABLE=<DataTableName>
aws dynamodb describe-time-to-live --table-name "$TABLE" \
  --query 'TimeToLiveDescription.{status:TimeToLiveStatus,attr:AttributeName}'   # ENABLED / ttl
aws dynamodb describe-continuous-backups --table-name "$TABLE" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus'
```

TTL が `ENABLED` / `ttl` でなければ止める（CDK の `timeToLiveAttribute: 'ttl'` が効いていない。
`ttl` を付けても何も削除されない）。

## 1. dry-run（書き込まない）

```bash
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE" | tee ~/ttl-backfill-dryrun.txt
```

1 行目（標準エラー）に `target: runtime=aws region=… table=…` が出る。**`runtime=aws` と
テーブル名が意図どおりであることを確かめる。** 違えば止める。

出力には件数と予約 id だけが載る（来訪者の情報は載らない）。保存してよい。

## 2. 件数を読む

- `scanned = toSet + alreadySet + mismatch + uncomputable` であること
- `toSet` を控える（手順 4 で使う）
- `already expired when set` の件数は、apply の後 48 時間程度で物理削除される件数である
- `mismatch` / `uncomputable` が 1 件以上なら `ACTION NEEDED` の行が出る。apply とは独立に
  手順 5 で扱う（apply はこれらに触れない）

件数は Issue / PR のコメントへ記録する（id は必要なときだけ。id は予約の識別子で、個人情報ではない）。

## 3. apply するかを決める

apply すると:

- `toSet` 件に `ttl` が付く。期限が過去のものは DynamoDB が 48 時間程度で物理削除する。
  **削除は元に戻せない**（PITR の範囲内でテーブルごと復元する以外の手段は無い）
- 期限が未来のものは、その期限が来たときに削除される（手順 7 で取り消せる）
- 予約の読み取り・受付・管理画面の見え方は**変わらない**（アプリは `ttl` ではなく業務フィールドで判定している）

## 4. apply

```bash
N=<手順 2 で控えた toSet>
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE" --apply --expect-to-set "$N" \
  | tee ~/ttl-backfill-apply.txt
```

| 終了コード | 意味 | 次にすること |
|---|---|---|
| 0 | 完了 | `updated + skippedChanged = toSet` を確かめる。手順 6 |
| 3 | dry-run の後に `toSet` が変わった（新しい予約が書かれた等）。**1 件も書いていない** | 手順 1 からやり直す |
| 1 | 途中で失敗した（スロットリング・権限・credential 失効など）。メッセージにそこまでの件数と失敗した id が出る | 原因を除き、手順 1 からやり直す。付け終えたレコードは `alreadySet` に数えられ、二度と書かれない |
| 2 | 引数の誤り | 何も読み書きしていない |

`skippedChanged` は、走査の後にアプリがそのレコードを書いた（その時点で `ttl` が載る）、
編集された、または削除されたもの。手順 6 の dry-run で `alreadySet` か `toSet` に現れる。

## 5. `uncomputable` / `mismatch` の扱い（owner 判断）

この道具はこれらを**変えない**。件数を見て、レコードごとに決める。調べるときも
個人情報の属性は出さない:

```bash
ID=<報告に出た id>
aws dynamodb get-item --table-name "$TABLE" \
  --key "{\"PK\":{\"S\":\"col#visit_reservation\"},\"SK\":{\"S\":\"$ID\"}}" \
  --projection-expression 'SK, visitAt, expiresAt, retentionDays, #t, #s' \
  --expression-attribute-names '{"#t":"ttl","#s":"status"}'
```

選択肢:

- **削除する** —— `uncomputable` はアプリから既に読めないので、削除しても見え方は変わらない。
  ```bash
  aws dynamodb delete-item --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"col#visit_reservation\"},\"SK\":{\"S\":\"$ID\"}}" \
    --condition-expression 'attribute_not_exists(#t)' --expression-attribute-names '{"#t":"ttl"}'
  ```
- **値を直して `ttl` を付ける** —— 例えば `retentionDays` を正しい日数へ直してから手順 1 へ戻る
  （直したレコードは `toSet` に入る）。直す値は保存期間のポリシー判断である
- `mismatch` は、なぜ計算値と違う `ttl` が載ったのかを先に調べる（アプリ以外の書き手が
  いないか）。原因が分かるまで変えない

決めた内容は件数とともに Issue / PR へ記録する。

## 6. 確認

```bash
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE"
```

- `toSet: 0`（または、その間に新しく書かれたレコードの分だけ）
- `alreadySet` が増えている
- 48 時間程度の後にもう一度回すと、`already expired when set` だった分だけ `scanned` が減っている

## 7. 取り消し

- **まだ期限が来ていない**レコードの `ttl` は外せる（その期限まで削除されない）:
  ```bash
  aws dynamodb update-item --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"col#visit_reservation\"},\"SK\":{\"S\":\"$ID\"}}" \
    --update-expression 'REMOVE #t' --expression-attribute-names '{"#t":"ttl"}'
  ```
  ただしアプリは次の書き込みでまた `ttl` を付ける（それが #1244 の仕様）。
- **既に削除されたもの**は戻せない。PITR の範囲内でテーブルを別名へ復元し、必要な項目を
  取り出す以外に手段は無い（それ自体が PII を復元する操作なので、要否から owner が判断する）。

## エミュレータでの予行（Claude のセッションでも可）

実データを使わず、手順をなぞって確かめられる。`ttl` の無い旧形式のレコードを手で置き、
dry-run → 件数違いの apply（終了コード 3・未書き込み）→ apply → 再 dry-run（`toSet: 0`）を回す。

```bash
npm run aws:local:up
export AWS_RUNTIME=ministack AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
unset AWS_SESSION_TOKEN AWS_PROFILE
TABLE=open-reception-local
# ttl の無い旧形式（retentionDays=0 は uncomputable として報告される）
aws dynamodb put-item --table-name "$TABLE" --item '{"PK":{"S":"col#visit_reservation"},"SK":{"S":"legacy-1"},"id":{"S":"legacy-1"},"visitAt":{"S":"2099-01-01T00:00:00.000Z"},"expiresAt":{"S":"2099-01-02T00:00:00.000Z"},"retentionDays":{"N":"30"}}'
aws dynamodb put-item --table-name "$TABLE" --item '{"PK":{"S":"col#visit_reservation"},"SK":{"S":"legacy-2"},"id":{"S":"legacy-2"},"visitAt":{"S":"2099-01-01T00:00:00.000Z"},"expiresAt":{"S":"2099-01-02T00:00:00.000Z"},"retentionDays":{"N":"0"}}'
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE"                                  # toSet: 1 / uncomputable: 1
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE" --apply --expect-to-set 2; echo $? # 3
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE" --apply --expect-to-set 1         # updated: 1
npx tsx src/lib/reservation/ttl-backfill-cli.ts --table "$TABLE"                                  # toSet: 0 / alreadySet: 1
npm run aws:local:stop
```

🔴 エミュレータの緑は、実 AWS の TTL 削除（遅延・GSI からの消失）を保証しない
（`docs/local-aws.md` の unsupported 節）。
