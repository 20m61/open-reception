# Local AWS development

🔴 **正本は `docs/local-aws.md`、設計判断は ADR 0010。** エミュレータは**交換可能**に
してある（`AWS_RUNTIME=ministack|moto|localstack`）。既定は **MiniStack（Docker 不要）**。

- AWS 変更は **まず Moto / MiniStack** で検証し、ローカルで再現不能なものだけ実 AWS へ回す。
- 入口は `npm run aws:local:*`。`scripts/aws-local.sh` は `AWS_RUNTIME=aws` を**拒否する**。
- エミュレータ固有の分岐をアプリへ書かない。差は endpoint / region / credentials の解決だけ。
- 🔴 ローカル検証に実 AWS 資格情報を持ち込まない（`aws-runtime.ts` が fail-fast する）。
- 🔴 Tier 3 の green は AWS 互換性の保証ではない（IAM / KMS / Cognito 実トークン /
  CloudFront / Transcribe streaming / 実機は実 AWS のみ）。
- ベンダ固有の health パス（`/_localstack/health` 等）でテストの到達性を判定しない。
  実際に使う AWS API で確かめる ―― 実装時にこれで Moto が落ち、交換可能性を検証する
  テスト自身がロックインを持っていた（2026-09-14）。
- 🔴 **Cognito 認証の判定をローカルの緑で担保しない。** MiniStack / Moto はどちらも
  **SRP のパスワード検証をしていない**（誤った PW でトークンが出る。2026-09-14 実測 / #1103）。
  ⛔ より危険で、緑のまま嘘をつく。実測と扱いは `docs/local-aws.md`「Cognito は素通りする」。
- 能力の主張は**負の対照つき**で測る（拒否されるべきものが拒否されること）。判定は
  `src/domain/governance/emulator-capability.ts`、実測は `npm run aws:local:capability`
  （素通りなら exit 1 / 判定不能なら exit 3）。

## open-reception-specific boundary

- Keep `DATA_BACKEND=memory` as the fastest unit/UI path.
- Add/use `DATA_BACKEND=dynamodb` against LocalStack as the integration path so the real DynamoDB repository implementation is exercised before AWS deployment.
- Prioritize DynamoDB, S3, Secrets Manager, Cognito, Lambda and API Gateway integration locally where supported.
- Treat telephony/WebRTC/Vonage, device/browser behavior, real Cognito edge cases, CloudFront/certificate/DNS delivery, and speech-service fidelity as external or real-AWS/device verification concerns.
- Seed deterministic local fixture data and reset the emulator rather than preserving a shared developer state.

See `docs/development/local-aws-sandbox.md` for the replacement trial and verification ladder.
