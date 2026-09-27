# AWS dev promotion

正本: `docs/architecture/aws-dev-deploy-broker.md` / Foundation `safe-dev-deploy/promotion-strategy.md`。

## Branch strategy is unchanged

`dev-deploy` は開発ブランチではない。GitFlow の `develop` として扱わない。

通常の開発ループは従来どおり:

```text
<type>/<topic> short-lived branch
  -> local / unit / MiniStack
  -> PR
  -> squash merge to main
  -> branch delete
```

AWS dev へ出すためだけに通常の feature/fix ブランチ戦略を変えない。

## dev-deploy is a promotion pointer

`dev-deploy` が表すのは「この revision を rare real-AWS integration proof に昇格する」のみ。

- この branch 上で実装しない。
- PR の base/head として通常開発に使わない。
- 普通の push / PR 更新 / merge のたびに動かさない。
- branch 名を deploy identity にしない。
- promotion を開始した CodePipeline Source の full commit SHA が `source_revision` の正本。
- 実行中に `dev-deploy` が動いても、その execution の SHA を変更しない。
- Validation / cloud assembly / broker policy / deploy ledger / override / ChangeSet / smoke / feedback は同じ SHA に束縛する。
- candidate artifact が別 SHA を主張したら deny。

## Current Phase 1 rule

#1146 / PR #1147 の broker は **UNARMED**。

🔴 **通常作業では `dev-deploy` を更新しない。**
Pipeline構造そのものの検証を明示的に行うIssue/手順以外ではpromotionを発火させない。
AWS role chainをarmするまでは、real-AWS deployの新経路として扱わない。

既存の人間承認つきADR 0009経路を勝手に置換・削除しない。

## After broker arming

promotion は次の全条件を満たすときだけ候補にする:

1. unit/static/品質ゲートがgreen。
2. MiniStack/Motoでattest可能なAWS挙動がgreen。
3. 実AWSでしか確認できない具体的な evidence gap がある、または明示的なfinal integration proofが必要。
4. 同じ変更について「念のため」だけの再deployではない。
5. sparse-deploy ceiling / retry policyに収まる。

**「AWSで試しながら直す」は禁止。**
失敗したらまずlocal/emulator/静的policyへ戻し、同じdeterministic denialを自動再promotionしない。

## Promotion reason

promotion evidenceには少なくとも以下を残す:

```yaml
source_revision: <full commit SHA>
reason: <why real AWS evidence is required>
local_evidence: <local/MiniStack evidence ref>
expected_aws_evidence: <what cannot be proven locally>
```

「念のため」「一応確認」はreasonとして不十分。

## Production

`dev-deploy` からproduction authorityを推論しない。
production release/tag/approvalは別契約であり、このpointerを再利用しない。
