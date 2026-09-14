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
        └ aws         staging / production / 最終検証
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
| 4 | AWS compatibility | 実 AWS dev/staging | `npm run aws:diff-gate` / `aws:negative-tests` / runbook |

Tier 1 は **hermetic** である。`vitest.config.ts` が AWS 資格情報を dummy に固定する
ので、開発者の ambient な資格情報でテストの通り方が変わらない
（`tests/config/unit-lane-aws-hermetic.test.ts` が走行中プロセスで縛る）。

## Compatibility matrix

**「起動した」ではなく「このプロジェクトが実際に使う操作が通ったか」**で判定している
（2026-09-14 実測 / `matrix.py`）。

| Service / 操作 | Moto | MiniStack | Real AWS 必須 | Notes |
| --- | --- | --- | --- | --- |
| DynamoDB table + GSI1 | ✅ | ✅ | — | 本番 backend をそのまま通して 8 本 green |
| DynamoDB TTL | ✅ | ✅ | — | 受付セッションの失効機構 |
| DynamoDB 条件付き書き込み | ✅ | ✅ | — | `putIfAbsent` / CAS |
| DynamoDB GSI query | ✅ | ✅ | — | テナント分離 |
| Secrets Manager | ✅ | ✅ | — | |
| SSM Parameter Store | ✅ | ✅ | — | |
| Cognito user pool + SRP client | ✅ | ✅ | **実トークン検証** | LocalStack freemium は⛔ |
| Polly synthesize | ✅ | ⛔ 405 | 音質 | **Moto のみ**。音質評価は実 AWS |
| S3 | ✅ | ✅ | 配信 | CloudFront 配信は実 AWS |
| CloudFormation | ✅ | ✅ | 実デプロイ | CDK synth/diff は実 AWS ゲート |
| Route53 / EC2 / AutoScaling | ✅ | ✅ | 実挙動 | LocalStack は ASG ⛔ |
| Transcribe **streaming** | ⛔ | ⛔ | **必須** | 現在 SDK 未導入（型のみ） |
| Bedrock | ⛔ | ⛔ | **必須** | 現在 SDK 未使用 |
| IAM 評価 / KMS | ⛔ | ⛔ | **必須** | 下記 unsupported |

参考: LocalStack(freemium) は Cognito / Polly / AutoScaling が⛔（ライセンス制約）。

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
| Cognito が使えない | LocalStack freemium の制約。`ministack` か `moto` を使う |
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
