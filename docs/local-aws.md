# ローカル AWS 開発環境

> 正本。ADR は [0010](adr/0010-swappable-aws-emulator.md)。
> LocalStack 固有の運用知見は [`development/local-aws-sandbox.md`](development/local-aws-sandbox.md)。

## 目的

AWS 依存の開発・検証を、**特定のエミュレータ製品に依存せず**に回せるようにする。

「LocalStack を MiniStack へ置き換える」ことが目的ではない。**エミュレータを交換可能に
する**ことが目的である。2026-09-14 の実測で、LocalStack の freemium ライセンスが
**Cognito と AutoScaling を拒否**し、「ローカルで何を検証できるか」が単一ベンダの
ライセンス状態に従属していた。これは検証範囲の欠落そのものだった。

## Architecture

```
Application
  → AWS SDK / CDK
    → resolveAwsRuntimeConfig()        src/domain/governance/aws-runtime.ts
      → awsClientConfig()              src/lib/aws/client-config.ts
        ├ ministack   既定のローカル統合環境（Docker 不要）
        ├ moto        高速 fallback / Polly の唯一の経路
        ├ localstack  compatibility layer（Docker が要る）
        └ aws         最終検証（現状の実環境は dev。staging は未構築）
```

実行系の違いは **endpoint / region / credentials の解決だけ**に落ちる。
アプリのコードに `if (ministack)` のような分岐は無い（`AWS_RUNTIME` を読むのは
上記 2 ファイルと `scripts/aws-local.sh` のみ）。

## Setup

Docker は要らない。必要なのは **Python 3** と **AWS CLI** だけ。

```bash
npm run aws:local:up       # venv 作成 → エミュレータ起動 → bootstrap → seed
```

初回は venv 作成と pip install を含めて **約 16 秒**（実測）。版は固定してある
（`MINISTACK_VERSION` / `MOTO_VERSION`）。venv は `.aws-local/`（gitignore 済）。

## コマンド

| コマンド | 何をするか |
| --- | --- |
| `npm run aws:local:start` | エミュレータを起動する |
| `npm run aws:local:bootstrap` | AWS リソースを作る（DynamoDB テーブル + GSI1 + TTL） |
| `npm run aws:local:seed` | 決定的な合成データを投入する |
| `npm run aws:local:up` | start + bootstrap + seed |
| `npm run aws:local:test` | up + smoke + 統合テスト |
| `npm run aws:local:reset` | 捨てて作り直す |
| `npm run aws:local:stop` | 停止する |
| `npm run aws:local:status` | 実行系と稼働状態 |
| `npm run aws:local:env` | **前提なしで**観測できる診断（下記） |
| `npm run aws:local:capability` | 能力を**負の対照つき**で実測する（下記 matrix。素通りがあれば非 0） |

実行系は `AWS_RUNTIME` で差し替える:

```bash
AWS_RUNTIME=moto npm run aws:local:test
AWS_RUNTIME=localstack npm run aws:local:test   # Docker が要る
```

## テストの段（Tier）

🔴 **Tier 3 の green は AWS 互換性の保証ではない。**

| Tier | 何を | どこで | 実行 |
| --- | --- | --- | --- |
| 1 | pure unit（AWS 不要） | プロセス内 | `npm test` |
| 2 | mock AWS | Moto | `AWS_RUNTIME=moto npm run aws:local:test` |
| 3 | local integration | MiniStack | `npm run aws:local:test` |
| 4 | AWS compatibility | 実 AWS（現状 **dev** のみ。staging は未構築） | `npm run aws:diff-gate` / `aws:negative-tests` / runbook |

Tier 1 は **hermetic** である。`vitest.config.ts` が AWS 資格情報を dummy に固定する
ので、開発者の ambient な資格情報でテストの通り方が変わらない
（`tests/config/unit-lane-aws-hermetic.test.ts` が走行中プロセスで縛る）。

## Compatibility matrix

🔴 **「操作が通ったか」でも足りない。負の対照が要る。**

この表は当初「このプロジェクトが実際に使う操作が通ったか」で判定していた。それでも
**Cognito の行が誤っていた**（#1103 / 2026-09-14）—— MiniStack は誤ったパスワードでも
トークンを発行しており、「正しいパスワードで通る」だけを見た判定が ✅ を付けていた。
**認証で価値があるのは拒否するほうである。**

以後、能力の主張には**正の対照**（通らなければならない操作）と**負の対照**
（拒否されなければならない操作）を組で当てる。判定は
`src/domain/governance/emulator-capability.ts` に閉じる（probe の出力はそこから導出される）。

🔴 **下表は probe の実測記録と機械で突き合わせてある**（#1113）。突き合わせ相手は
`docs/evidence/emulator-capability.<runtime>.json`（`npm run aws:local:capability -- --json`
の出力そのもの）で、判定は `src/domain/governance/capability-doc.ts`、検査は
`tests/config/capability-doc-sync.test.ts` が**既定の品質ゲートの中で**行う
（エミュレータの稼働は要らない。記録との比較なので。#1103 条件 5）。
**セルを手で書き換えると落ちる** —— この型で 6 周連続の誤りを出し、うち 3 周は
「この型を直すために」書き換えた表の中で再発した。**表を直す前に記録を取り直すこと**
（`docs/evidence/README.md`）:

| 判定 | 記号 | 意味 |
| --- | --- | --- |
| `verified` | ✅ | 正は通り、負は拒否された。ローカルの緑に意味がある |
| `permissive` | 🔴 素通り | **正も負も通る。緑のまま嘘をつく** ―― `unavailable` より危険 |
| `unavailable` | ⛔ | 正が通らない。**その能力をローカルで使えない**。🔴 「素通りしない」ことまでは主張しない |
| `inconclusive` | ? | 対照を走らせられなかった（測定環境の問題。能力の判定ではない） |
| （正の対照のみ） | ◯ 正のみ | **操作は通った。負の対照は当てていない** ―― 「使える」以上を主張しない |
| （未測） | （未測） | そもそも測っていない |

🔴 **機械が予約しているのは ✅ と 🔴 素通り の 2 つだけである。** この 2 つは負の対照を
当てなければ原理的に到達できない（`NEGATIVE_CONTROL_ONLY_VERDICTS` は `classifyCapability`
から導出されている）ので、**`負の対照` 列に ✓ が無い行では使えない** —— 使えば検査が落ちる。
これが「まだ測っていない」と「測って ✅ だった」の区別で、**凡例ではなく記号が担う**
（#1113 AC3）。凡例に書いただけの区別は round3 で実際に読み飛ばされた。

🔴 **⛔ と ? はそうではない。** どちらも正の対照だけで書けてしまう判定なので、機械は
予約していない ―― 下表の ⛔（Transcribe / Bedrock / IAM 評価 / KMS / MiniStack の Polly）は
**probe の裏付けを持たない**。「使えない」という主張も、負の対照を当てていない限り
「呼び方を変えれば素通りするかもしれない」を排除しない（Moto の Cognito が現にその形だった）。
**⛔ を「嘘はつかない」と読まないこと。** この凡例表そのものも記号の出どころ
（`matrixMark`）と機械で突き合わせてある。

再測は **`npm run aws:local:capability`**（素通りなら exit 1、判定不能なら exit 3）。

🔴 **下表で ✅ が付いているのは、負の対照まで当てた 3 行だけである。** `◯ 正のみ` の行は
「このプロジェクトが使う操作が通った」以上を主張しない ―― Cognito 行を誤らせたのと
**同じ過大主張**がそこに残りうるので、その行の緑を能力の根拠にする前に probe へ
負の対照を足すこと（足せば ✅ になり、記録と表が同時に動く）。

🔴 **この凡例は下表（と `docs/development/local-aws-sandbox.md` の証拠表）にしか効かない。**
同じ文書の別の表 —— 例えば下記「CDK はローカルで往復する」の `| 段 | 結果 |` —— の ✅ は
「その手順が通った」という意味で、負の対照とは無関係であり**機械検査の対象外**である。
検査対象の表の外に在る ✅ を能力の裏付けとして読まないこと（機械で縛るのは #1114）。

| Service / 操作 | 負の対照 | Moto | MiniStack | Real AWS 必須 | Notes |
| --- | --- | --- | --- | --- | --- |
| DynamoDB 条件付き書き込み | ✓ | ✅ | ✅ | — | `putIfAbsent` / CAS。二重作成が拒否されることまで実測 |
| DynamoDB GSI テナント分離 | ✓ | ✅ | ✅ | — | 他テナントから引けないことまで実測 |
| **Cognito SRP のパスワード検証** | ✓ | 🔴 **素通り** | 🔴 **素通り** | **必須** | 下記「Cognito は素通りする」 |
| DynamoDB table + GSI1 | | ◯ 正のみ | ◯ 正のみ | — | 本番 backend をそのまま通して 8 本 green |
| DynamoDB TTL | | ◯ 正のみ | ◯ 正のみ | — | 受付セッションの失効機構 |
| Secrets Manager | | ◯ 正のみ | ◯ 正のみ | — | |
| SSM Parameter Store | | ◯ 正のみ | ◯ 正のみ | — | |
| Cognito user pool / client の CRUD | | ◯ 正のみ | ◯ 正のみ | **実トークン検証 / JWKS** | 作れるだけ。トークンの正当性は別（unsupported 節） |
| Polly synthesize | | ◯ 正のみ | ⛔ 405 | 音質 | **Moto のみ**。音質評価は実 AWS |
| S3 | | ◯ 正のみ | ◯ 正のみ | 配信 | CloudFront 配信は実 AWS |
| CloudFormation / CDK deploy + diff | | （未測） | ◯ 正のみ | 置換挙動・drift | 下記「CDK はローカルで往復する」。**Moto では未測** |
| Route53 / EC2 / AutoScaling | | ◯ 正のみ | ◯ 正のみ | 実挙動 | LocalStack は ASG ⛔ |
| Transcribe **streaming** | | ⛔ | ⛔ | **必須** | 現在 SDK 未導入（型のみ） |
| Bedrock | | ⛔ | ⛔ | **必須** | 現在 SDK 未使用 |
| IAM 評価 / KMS | | ⛔ | ⛔ | **必須** | 下記 unsupported |

参考: LocalStack(freemium) は Cognito / Polly / AutoScaling が⛔（ライセンス制約）。

### 🔴 Cognito は素通りする ―― ローカルで管理者ログインを検証しない

本プロジェクトの Cognito **SDK** の面は `src/lib/auth/cognito-srp.ts` の
`InitiateAuth(USER_SRP_AUTH)` + `RespondToAuthChallenge(PASSWORD_VERIFIER)` だけである
（実行時にはこのほかに **JWKS による実トークン検証**がある ―― `src/proxy.ts` /
`src/lib/auth/actor.ts`。そちらは下記 unsupported のとおり実 AWS でしか担保できない）。
本番モジュールをそのまま両エミュレータへ当てた実測（2026-09-14 / #1103）:

| | 呼び方 | 正しい PW | **誤った PW** | 結論 |
| --- | --- | --- | --- | --- |
| MiniStack | 本番と同じ | トークン発行 | **トークン発行** | 🔴 SRP 証明を検証していない |
| Moto | 本番と同じ（`USER_ID_FOR_SRP`） | `UserNotFoundException` | `UserNotFoundException` | 正の対照が通らない |
| Moto | 平文 username | トークン発行 | **トークン発行** | 🔴 **こちらも検証していない** |

🔴 **Moto を「使えないが嘘はつかない」と読まないこと。** 本番の呼び方では動かないだけで、
**平文 username に変えれば誤った PW でもトークンが出る**（ゴミの `PASSWORD_CLAIM_SIGNATURE`
でも通ることを独立に確認済み）。ハーネスを「動くように」直した瞬間に素通りへ踏み込む。

- MiniStack は `PASSWORD_VERIFIER` チャレンジを正しい形（`SRP_B` / `SALT` /
  `SECRET_BLOCK`）で返すので、**API の形だけを見る測り方では区別できない**。
  署名の合わない証明を返しても ID/Access/Refresh トークンが出る。
  ただし**存在しないユーザー**は拒否するので、「何も見ていない」わけではない
  —— 見ていないのは**パスワードだけ**である。
- Moto は本番と同じ呼び方（`ChallengeResponses.USERNAME` に `USER_ID_FOR_SRP`。
  実機検証でこれが正だと判明している、`cognito-srp.ts` のコメント参照）では
  ユーザーを解決できない。**平文 username を渡すと通るが、その場合は誤った PW も
  受理する** —— つまり Moto も SRP 証明を検証していない。

**欠陥は SRP の経路に限られる（＝測り方の誤りではない）。** 同じ MiniStack を
`ADMIN_USER_PASSWORD_AUTH`（平文 PW 流）で叩くと、誤った PW は
`NotAuthorizedException: Incorrect username or password` で**正しく拒否される**
（AWS CLI で確認。`cognito-srp-helper` を通さない独立の経路）。つまり PW は確かに
保存され検証可能な状態にあり、**検証されていないのは SRP の証明だけ**である。
本プロジェクトは PW を平文で送らないため SRP を使っており、平文流への切り替えは
回避策にならない。

したがって **`/admin/login` の認証判定をローカルの緑で担保しない。**
ログイン経路に触る変更は**実 AWS でしか**確かめられない ―― 現状それは `dev` である
（`staging` は `infra/lib/config/environments.ts` に定義だけあり、一度も立っていない）。

🔴 これは「Cognito が使えない」より悪い。使えなければ使った瞬間に分かるが、
**素通りするエミュレータはテストを緑にしたまま嘘をつく**。ここへ
「ローカルで管理者ログインが通った」という e2e を足すと、認証を丸ごと外す変異が
**全部素通りする**テストが 1 本増えるだけである
（`CLAUDE.md`「検証の作法」の「下界を併せて縛る」がそのまま当てはまる）。

### CDK はローカルで往復する（synth → deploy → diff）

2026-09-14 / #1103 実測（**MiniStack のみ**、資格情報なし）。再現は
`npm run aws:local:up` のうえで `cd infra && npx cdk synth --quiet` /
`npx cdk deploy <stack> --require-approval never` /`npx cdk diff <stack>`
（`AWS_ENDPOINT_URL` をレーンの値にし、実資格情報を unset すること）:

| 段 | 結果 |
| --- | --- |
| `cdk synth` | ✅ 18s。**エミュレータすら要らない**（資格情報も不要）。ただし `build:open-next` が新しいこと |
| `cdk bootstrap` | ✅ CDKToolkit スタックが作られる |
| `cdk deploy` | ✅ 13.9s。CloudFormation スタックが実際に作られる |
| デプロイ後の `cdk diff` | ✅ **There were no differences**（change set を実際に作る経路） |

素の CDK v2 が `AWS_ENDPOINT_URL` を尊重するので、**`cdklocal` も新規依存も要らない**。

🔴 **往復したのは「機構」であって「AWS 互換性」ではない。** エミュレータは IAM を評価せず、
置換挙動・drift・ロールバックも実 AWS の挙動ではない。`npm run aws:diff-gate` /
`aws:negative-tests` と runbook（Tier 4）は**そのまま要る**。

## Unsupported — 実 AWS でしか保証できないこと

エミュレータは AWS ではない。以下は**ローカルの green では保証されない**:

- **IAM の評価**（policy の許可/拒否、SCP、権限境界）。`npm run aws:negative-tests` は実 AWS で走る
- **KMS の実暗号**、鍵ポリシー、grant
- **Cognito の実トークン検証**（JWKS、署名、有効期限、MFA、ホストされた UI）
- **CloudFront / 証明書 / DNS / 公開配信**、キャッシュ挙動
- **Transcribe streaming**（WebSocket/HTTP2）、**Polly の音質**
- **Vonage / WebRTC / 外線**、実機 iPad・実ブラウザ・騒音・距離
- **CloudFormation の置換挙動・drift**、実デプロイのロールバック
- **課金 / Cost Explorer**（`src/lib/platform/aws-cost-explorer.ts` は実 AWS のみ）
- **スロットリング・整合性・レイテンシの実挙動**

## Production safety

> LOCAL AWS TEST + REAL PRODUCTION CREDENTIAL => ABORT

`src/domain/governance/aws-runtime.ts` が解決と同時に fail-fast する。
**「どこを向くか」を決める場所と「向いてよいか」を判定する場所を分けない。**

| 検知 | 条件 | 動作 |
| --- | --- | --- |
| `real_credentials` | エミュレータ実行なのに `AKIA`/`ASIA` 形の key・`AWS_SESSION_TOKEN`・`AWS_PROFILE`・`AWS_CREDENTIAL_EXPIRATION` がある | **ABORT** |
| `endpoint_is_real_aws` | エミュレータ実行なのに endpoint が `amazonaws.com` | **ABORT** |
| `real_aws_without_opt_in` | デプロイ外で実資格情報が見えるのに `AWS_ALLOW_REAL=1` が無い | **ABORT** |

補足:

- **既定の実行系は `aws`**。デプロイされた Lambda は `AWS_RUNTIME` を持たないので、
  既定をエミュレータにすると**本番が黙ってエミュレータを向く**。危険側は上の guard で止める
- **デプロイ実行（`AWS_LAMBDA_FUNCTION_NAME` あり）は止めない**。guard の対象は
  ローカル / CI からの誤接続であって、本番の実行ではない
- `AWS_CREDENTIAL_EXPIRATION` は**値ではなく存在**が効く。デプロイ窓の残骸が残っていると
  dummy の `test` まで「失効済み」として拒否される（2026-09-14 実測）
- `scripts/aws-local.sh` は実資格情報を**無条件に**落とす（`:-` を使わない）。
  `AWS_RUNTIME=aws` はこのレーンでは**使えない**

## データ

🔴 **dev / staging / production のデータをローカルへ複製しない。**
ローカルは `scripts/seed-dynamodb.ts` の**合成データ**からのみ作る。PII・顧客データ・
実 secret をローカルへ持ち込まない。同じ commit から同じ環境が再構築できる。

## Docker あり / なし

Docker は**必須ではない**。

| 環境 | 既定 | 備考 |
| --- | --- | --- |
| Claude Code on the web / sandbox / CI | `ministack`（Docker 不要） | pure Python |
| Docker が使えない Linux | `ministack` / `moto` | 同上 |
| 開発 PC（Docker あり） | `ministack`。必要なら `localstack` | progressive enhancement |

Docker が要るのは `AWS_RUNTIME=localstack` のときだけ。`npm run aws:local:env` の
`DOCKER_REQUIRED` 行で確認できる。

## Troubleshooting

**まず `npm run aws:local:env` を読む。** これは venv もエミュレータ本体も AWS CLI も
要求しない ―― 前提が壊れていても「どこを向き、どの資格情報で動くか」が分かる。

| 症状 | 見るところ |
| --- | --- |
| `real_credentials` で落ちる | デプロイ窓の残骸。`AWS_SESSION_TOKEN` / `AWS_PROFILE` / `AWS_CREDENTIAL_EXPIRATION` を unset する（レーン経由なら自動） |
| `Credentials ... still expired` | 同上。`AWS_CREDENTIAL_EXPIRATION` は存在するだけで効く |
| ポート衝突 | `ministack`/`localstack` は 4566、`moto` は 5000。`AWS_ENDPOINT_URL` で変えられる |
| `ready` にならない | `.aws-local/<runtime>.log` |
| Cognito が使えない | LocalStack freemium の制約。ただし **`ministack` / `moto` でも SRP のパスワード検証はできない**（上記「Cognito は素通りする」） |
| Polly が 405 | MiniStack は非対応。`AWS_RUNTIME=moto` を使う |
| LocalStack がライセンスで落ちる | `development/local-aws-sandbox.md`（proxy 環境の事情） |

## CI

CI は **`ministack` 既定・Docker 不要・有料ライセンス不要**で回せる:

```bash
npm run aws:local:up
npm run aws:local:test
npm run aws:local:stop
```

🔴 **Tier 3 の green を release evidence に昇格しない。** 既存の AWS diff / negative /
security / release ゲートは弱めない。統合テストは `LOCAL_AWS_INTEGRATION=1` が無ければ
skip されるので、既定の品質ゲートは不変である。
