# Runbook: origin-verify secret の移行（#1148 / #1149 / #1180）

**実行するのは owner（Mac の端末）だけ。** Claude は値を見ない・受け取らない・生成しない。
この手順は dev の Secrets Manager に書き込み、次の deploy で CloudFront と Lambda の値を
入れ替える。いずれも Human Gate であり、Claude のセッションからは実行しない。

- 背景と正本: `docs/runbook-cloud-aws-deploy.md` の「#1148 後の初回 deploy の前に一度だけ行うこと」
- 何が変わったか: origin-verify の値は deploy context（`OR_ORIGIN_VERIFY_SECRET`）で渡す方式を廃止し、
  app secret（`open-reception/dev/app-v2`）の `ORIGIN_VERIFY_SECRET` キーを CloudFormation の
  dynamic reference で読む方式に一本化した（#1148）。#1180 は、旧変数が環境に残っていれば
  すべての wrapper（`aws-issue-credentials.sh` / `aws-cloud-deploy.sh`）で止めるようにした。
- 旧方式では生値が Claude の環境に置かれていた。**旧値は露出済みとして扱い、必ず新しい値を作る。**

## 0. 前提（先に確認する）

| 確認 | 方法 | 期待 |
|---|---|---|
| #1149 と #1180 が main に merge 済み | GitHub | merged |
| 作業するのは Mac の owner 端末 | — | Claude のセッションではない |
| dev の短命 credential を発行済み | `scripts/aws-issue-credentials.sh`（通常の窓の開け方） | 有効期限内 |
| deploy の窓を別途確保している | 利用の少ない時間帯 | 手順 4 の deploy 中、一時的に 403 が出うる |

## 1. 旧変数を消す（Claude 側の設定）

1. claude.ai/code の環境ダイアログを開き、`OR_ORIGIN_VERIFY_SECRET` が**あれば削除する**。
   値を貼り替えるのではなく、変数ごと消す。
2. Mac の context ファイル `~/.config/open-reception/deploy-context.env` に
   `OR_ORIGIN_VERIFY_SECRET=` の行が**あれば削除する**。残すのは次の 3 つだけ:
   `OR_APP_SECRETS_NAME` / `OR_PUBLIC_ORIGIN_OVERRIDE` / `OR_PROVIDER_SECRET_BACKEND`。
3. 確認（値は表示しない。行があるかどうかだけを見る）:

   ```bash
   grep -c '^OR_ORIGIN_VERIFY_SECRET=' ~/.config/open-reception/deploy-context.env   # 0 であること
   npx --no-install tsx scripts/deploy-context-block.ts retired-only; echo "exit=$?"  # exit=0 であること
   ```

   `retired-only` は、廃止した変数が環境変数にも context ファイルにも**無ければ黙って 0、あれば 3**
   を返す（#1180。検査自体を実行できないときは 2）。

## 2. 現在の app secret を確認する（値は出さない）

```bash
SECRET_ID=open-reception/dev/app-v2
aws secretsmanager describe-secret --secret-id "$SECRET_ID" --query '{Name:Name,LastChanged:LastChangedDate}'
# キーの一覧だけを見る（値は出さない）
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text | jq -r 'keys[]'
```

- 期待: `KIOSK_ENROLLMENT_SECRET` / `CALL_ANSWER_SECRET` など既存のキーが並ぶ。
- `ORIGIN_VERIFY_SECRET` が**既にあっても**手順 3 で新しい値に置き換える（旧方式で露出した値と
  同じ可能性があるため）。

## 3. 新しい値を生成して app secret に追加する

値は端末の外に出さない。argv（`ps` で見える）にも、画面にも、ファイルにも残さない。

```bash
SECRET_ID=open-reception/dev/app-v2
umask 077
TMP=$(mktemp)                       # 0600 で作られる
VAL=$(mktemp)
openssl rand -base64 32 > "$VAL"    # 値は argv に載せず、0600 のファイル経由で jq に渡す
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text \
  | jq --rawfile v "$VAL" '. + {ORIGIN_VERIFY_SECRET: ($v | rtrimstr("\n"))}' > "$TMP"
rm -P "$VAL"; unset VAL
# 形の確認（値は出さない）: 既存キーがすべて残り、ORIGIN_VERIFY_SECRET が 44 文字であること
jq -r 'keys[]' "$TMP"
jq -r '.ORIGIN_VERIFY_SECRET | length' "$TMP"          # 44
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$TMP" \
  --query '{VersionId:VersionId}'
rm -P "$TMP"; unset TMP
```

- `put-secret-value` は新しい version（`AWSCURRENT`）を作り、直前の値は `AWSPREVIOUS` に残る
  （手順 6 の rollback で使う）。
- 値は ASCII（base64）に限る。以前、非 ASCII の値が CloudFront に拒否された事故がある。

確認（値は出さない）:

```bash
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text \
  | jq '{has_key: has("ORIGIN_VERIFY_SECRET"), length: (.ORIGIN_VERIFY_SECRET | length)}'
# {"has_key": true, "length": 44}
```

## 4. deploy で CloudFront と Lambda に反映する

通常の deploy 手順（`docs/runbook-cloud-aws-deploy.md`）に従う。この回で特に見ること:

- `diff` に、WebStack の CloudFront の origin custom header と Lambda の env
  （`ORIGIN_VERIFY_SECRET` の dynamic reference）が変更として出る。**値は diff に出ない**
  （出たら中止して報告する）。
- deploy 中から CloudFront の反映が終わるまで、**一時的に 403** が出うる。

## 5. 成功の確認

| 確認 | 期待 |
|---|---|
| `scripts/aws-cloud-deploy.sh smoke`（`OR_SMOKE_URL` = CloudFront の公開 origin。URL 品質ゲートと `npm run test:e2e:live`） | green |
| Lambda の Function URL を CloudFront を通さず直接 `GET /kiosk` | **403**（ヘッダが無い・違うものは拒否。`src/proxy.ts` の `checkTrustedOrigin`） |
| 同上で **503** が返る | **失敗**: Lambda に secret が設定されていない（`missing-secret`）。app secret のキー名と deploy を確認する |
| deploy log（verify / diff / deploy の 3 つ）に `OR_ORIGIN_VERIFY_SECRET` が出る回数 | 0（`grep -c -F`） |

## 6. Rollback

- **手順 3 の直後で deploy 前**: 何もしなくてよい（deploy されるまで値は使われない）。
  やり直すなら手順 3 をもう一度実行する。
- **deploy 後に CloudFront 経由でも 403 が続く（10 分以上）**:
  1. 原因の切り分け: CloudFront の配信状態が `Deployed` か。未反映なら待つ。
  2. 戻す場合は、app secret を直前の version に戻してから再 deploy する:

     ```bash
     SECRET_ID=open-reception/dev/app-v2
     PREV=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
       --query 'VersionIdsToStages' --output json | jq -r 'to_entries[] | select(.value | index("AWSPREVIOUS")) | .key')
     CUR=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
       --query 'VersionIdsToStages' --output json | jq -r 'to_entries[] | select(.value | index("AWSCURRENT")) | .key')
     aws secretsmanager update-secret-version-stage --secret-id "$SECRET_ID" \
       --version-stage AWSCURRENT --move-to-version-id "$PREV" --remove-from-version-id "$CUR"
     ```

     そのうえで通常の deploy を行う。**旧値は露出済みなので、戻すのは一時的な復旧に限る。**
     原因を直してから手順 3 からやり直す。
- 旧方式（`OR_ORIGIN_VERIFY_SECRET` を context で渡す）には戻さない。WebStack は
  `originVerifySecret=<生値>` を全環境で synth 時に拒否する（#1148）。

## 7. 記録

完了したら、#1149 に次を残す（値は書かない）: 実施日時、secret の新しい `VersionId`、
手順 5 の結果、rollback の有無。
