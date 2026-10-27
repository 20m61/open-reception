# ADR 0010: ローカル AWS エミュレータを交換可能にする

- ステータス: **提案**（実装は本 PR。既定エミュレータの切替はユーザー承認待ち）
- 関連 Issue: #1103
- 関連 ADR: [0009](0009-claude-cloud-aws-dev-deploy-boundary.md)（実 AWS 側の境界）

## 文脈

ローカル AWS レーンは LocalStack を直接名指しして実装されていた（`scripts/local-aws.sh`）。
2026-09-14 に Claude Code on the web で実際に走らせたところ、**製品固有の制約が
レーンの可否そのものを決めていた**ことが分かった:

- `lstk` はコンテナ起動に**ライセンスサーバへの到達**を要求し、TLS 終端 proxy 越しでは
  activation に失敗する（exit 55）
- activation できても tier は `freemium` で、**Cognito と AutoScaling は
  「ライセンスに含まれない」として拒否される**
- `lstk` は CLI 自身の認証にトークンを要求するため、community イメージを選んでも
  無ライセンス化できない

つまり「ローカルで AWS を検証できるか」が**単一ベンダのライセンス状態に従属**していた。
本プロジェクトの認証は Cognito に依存するので、これは実際に検証範囲を削っている。

> 🔴 **2026-09-14 追記（#1103）。** この ADR は当初「MiniStack / Moto なら Cognito を
> 検証できる」と書いていたが、**誤りだった**。両者とも user pool / client / user は作れる
> ものの、**SRP のパスワード検証をしていない**（誤ったパスワードでトークンが出る）。
> ライセンスで⛔になるより悪く、**緑のまま嘘をつく**。交換可能性という本 ADR の判断は
> 変わらないが、「Cognito を含む」を交換の動機に数えてはいけない。
> 実測と扱いは [`../local-aws.md`](../local-aws.md)「Cognito は素通りする」、
> 再測は `npm run aws:local:capability`。

### 実測した代替（2026-09-14、同一セッション）

`ministack` (MIT) と `moto` (Apache-2.0) はいずれも **PyPI の pure-Python** で、
**Docker を要求しない**。本プロジェクトが実際に行う操作単位で測った:

🔴 **この表は能力の判定記号を使わない。正本は `docs/local-aws.md` の compatibility matrix
である。** 記号つきの判定を複数の文書へ転記すると必ずずれるので、ここには置かない（#1114）。

- `OK` は「**その操作が通った**」であって、負の対照は当てていない
- `NG 素通り` は「MiniStack / Moto はどちらも**誤ったパスワードを受理した**」という
  ADR 執筆時の実測（正本の該当行は matrix の `Cognito SRP のパスワード検証`）
- 以前この表は `OK` の位置に判定記号を書いており、**matrix と食い違っていた**
  （`CloudFormation` の Moto を「通った」と書いていたが、matrix は「**Moto では未測**」）。
  🔴 **`（未測）` へ落とした根拠は matrix 側の記述であって、新たに測り直してはいない。**
  ADR 執筆時の実測を否定したのではなく、**食い違ったので安全側へ寄せた**という扱いである
- `（未測）` は matrix の凡例と同じ語だが、ここでは**判定ではなく「測っていない」という
  事実の記述**として使っている（能力の判定記号そのものは、この文書では一切使わない）

**能力を主張したくなったら、この表ではなく matrix を直すこと。**

| 操作 | LocalStack | MiniStack | Moto |
| --- | --- | --- | --- |
| DynamoDB: table + GSI1 | OK | OK | OK |
| DynamoDB: TTL | OK | OK | OK |
| DynamoDB: 条件付き書き込み | OK | OK | OK |
| DynamoDB: GSI query | OK | OK | OK |
| Secrets Manager | OK | OK | OK |
| SSM Parameter Store | OK | OK | OK |
| **Cognito: user pool / client の CRUD** | ⛔ ライセンス | OK | OK |
| **Cognito: SRP のパスワード検証** | ⛔ ライセンス | NG 素通り | NG 素通り |
| **Polly: synthesize** | ⛔ ライセンス | ⛔ 405 | OK |
| S3 | OK | OK | OK |
| CloudFormation | OK | OK | （未測） |
| Route53 / EC2 | OK | OK | OK |
| **AutoScaling** | ⛔ ライセンス | OK | OK |

🔴 **「起動した」ではなく「この操作が通った」で判定している。** サービスが health で
`available` と出ることと、使う API が通ることは別である。

## 決定

**エミュレータを実装差し替え可能な設定層として扱い、アプリのコードから製品名を消す。**

1. `AWS_RUNTIME` で実行系を選ぶ: `aws` / `ministack` / `moto` / `localstack`
2. 選択は **endpoint / region / credentials / account の解決** にだけ影響させる。
   アプリ内に `if ministack` のような分岐を作らない
3. 既定のローカル統合環境は **MiniStack**（Docker 不要）
4. **Moto** は高速 fallback かつ Polly の唯一の経路
5. **LocalStack** は compatibility layer として残す（削除しない）
6. 実 AWS は最終検証にのみ使う（現状の実環境は `dev`。staging は定義のみで未構築）

### レイヤ

```
Application
  → AWS SDK / CDK
    → resolveAwsRuntimeConfig()   ← 単一の設定解決点
      ├ ministack  (default local integration, no Docker)
      ├ moto       (fast fallback / Polly)
      ├ localstack (compatibility, Docker)
      └ aws        (最終検証。現状は dev)
```

### 安全境界（本 ADR の主目的）

エミュレータを増やすと**誤接続の面が増える**。したがって設定解決と同じ場所で
fail-fast させる:

- エミュレータ実行時に**実資格情報**（`ASIA`/`AKIA` 形、session token、`AWS_PROFILE`）を
  検出したら **ABORT**
- エミュレータ実行時に endpoint が `amazonaws.com` を向いていたら **ABORT**
- `AWS_RUNTIME=aws` かつ **production アカウント**なら、明示的な opt-in が無い限り **ABORT**

> LOCAL AWS TEST + REAL PRODUCTION CREDENTIAL => ABORT

🔴 `src/lib/platform/aws-cost-explorer.ts` は SDK を経由せず
`https://ce.us-east-1.amazonaws.com/` へ直接 SigV4 で叩く（1 リクエスト $0.01 の課金 API）。
**endpoint 抽象では捕まらない**ので、ここだけは呼び出し側で明示的に guard する。

## 代替案

- **LocalStack を有料 tier にする**: 却下。ライセンス依存を強めるだけで、priority 3
  （ロックイン回避）に反する。CI が有料ライセンス前提になるのも `#1103` 条件 12 に反する
- **Moto 一本**: 却下。Moto は in-process mock として強いが、CloudFormation/CDK や
  複数プロセスからの共有状態は MiniStack の方が素直
- **MiniStack へ全面移行し LocalStack を削除**: 却下（今は）。実測は 1 セッション分しかなく、
  既存レーンを消すと戻れない。compatibility layer として残す

## 影響

- **コスト**: 常時稼働の dev AWS を必要としない方向へ進む。ただし本 ADR は
  dev 環境の削除を決めない（#1103 条件 7 は別途、実測で判断する）
- **運用**: エミュレータは pure-Python になり Docker 必須でなくなる。
  Docker がある環境では LocalStack を選べる（progressive enhancement）
- **セキュリティ**: 設定解決点が 1 か所になるので、誤接続 guard を**そこだけ**に置ける。
  現在は各モジュールが個別に client を組んでおり、guard を置く場所が無い
- **撤回条件**: MiniStack が本プロジェクトの使用 API で LocalStack を下回ると実測された場合、
  `AWS_RUNTIME=localstack` を既定へ戻すだけでよい（アプリ変更なし）。これが
  「交換可能にする」ことの目的である

## 保証しないこと

🔴 **Tier 3（ローカル統合）の green は AWS 互換性の保証ではない。** エミュレータは AWS
ではない。IAM の評価、KMS、CloudFront/DNS の配信、Cognito の実トークン検証、
Transcribe streaming、実機・実ブラウザは**実 AWS / 実機でしか保証できない**。
`docs/local-aws.md` の「unsupported」節を正本とする。
