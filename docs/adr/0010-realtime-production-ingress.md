# ADR 0010: Realtime production ingress

- ステータス: **提案**（#1073 の実測待ち。production 未承認）
- 日付: 2026-09-12
- 関連: #1069, #1073, #366, #369, #638, #1068
- 前提: ADR 0003 の direct Public IPv4 endpoint は Phase 0 として維持するが、production 恒久構成とはみなさない

## 文脈

Realtime Phase 0 は `ASG min=0 / max=1`、単一 AZ、public subnet、動的 Public IPv4 + Route 53 で固定費を抑えている。
一方、現行 skeleton は `0.0.0.0/0:443` を許可し、EC2/Caddy が直接 Internet boundary になる。

production では、低コストを保ちながら公開面を狭めたい。ただし ALB / Multi-AZ / WAF を「best practiceだから」で追加しない。

## 決定候補

### Stage 1 — low-cost candidate

```text
iPad
  ↓ WSS
CloudFront (Realtime専用)
  ↓ cache disabled
origin DNS
  ↓
EC2 public IPv4 / ASG max=1
```

候補条件:

- production SG の 443 は `0.0.0.0/0` ではなく CloudFront origin-facing managed prefix list に限定
- viewer/session auth は #369 の短命 Voice Transport token を継続
- WebStack と Realtime Distribution は分離
- origin verification を使う場合は #638 と同じ secret rotation 問題を複製しない
- `realtime.enabled=false` は採用決定まで維持

**Stage 1 はまだ採用しない。** #1073 の synth/live spike が green の場合だけ承認候補にする。

### Stage 2 — stable LB + private runtime

```text
iPad
  ↓
CloudFront
  ↓ VPC Origin
internal ALB/NLB
  ↓
private ASG / Multi-AZ
```

可用性・lifecycle分離は強いが、LB固定費が増えるため現時点では保留する。

Multi-AZ/LBへの昇格は別Issueにせず #1069 で見直す。判断材料は concurrency、availability、実測RTO、fallback完遂率、停止影響、SLA、コスト差分とする。実運用前に根拠のない数値閾値は置かない。

## 代替案

| 案 | 判断 |
| --- | --- |
| direct public EC2を恒久化 | 最小コストだが runtime が直接公開境界を背負う。原則不採用候補 |
| CloudFront → public ASG | Stage 1候補。DNS追従・latencyを実測して決める |
| VPC Origin → LB → private ASG | Stage 2候補。固定費増加に見合う条件でのみ採用 |
| VPC Origin → EC2 direct | ASG replacement と origin lifecycle が結合するため現行要件とは相性が悪い |

## 採用条件 / 反証条件

詳細な測定手順は #1073 を正とする。

Stage 1を採用できるのは、少なくとも以下を満たす場合だけ。

- ASG replacement後の DNS/reconnect が許容RTO内
- CloudFront追加による handshake / first-audio 遅延がUXを壊さない
- direct-origin bypassを閉じられる
- token replay / cross-kiosk rejectionが維持される
- runtime障害時も Web / signage / touch / QR が継続する
- origin secret lifecycleを安全に運用できる、またはsecret依存なしで境界を成立させられる

1つでも満たさなければ Stage 1を捨て、Stage 2を再比較する。

## WAF

WAFは本ADRの必須要素にしない。#1068 で、application側対策・実トラフィック・false positive・月額費用を比較して「導入 / 見送り」を別途決める。

## Human Gate

このADRが提案状態の間は、以下を実施しない。

- production Realtime enable
- production public ingress切替
- ALB/NLB追加
- 継続固定費を増やす変更

## 見直し条件

- #1073 evidence が Stage 1 を否定
- concurrency / availability / RTO / SLA が単一ノードを許容しなくなる
- TransportをWSSから変更する
- AWS CloudFront/VPC Origin仕様・料金が前提から変わる

## 公式参照

- CloudFront WebSocket: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html
- CloudFront VPC Origins: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html
- AWS CDK `VpcOrigin`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins.VpcOrigin.html
- Public IPv4 pricing: https://aws.amazon.com/vpc/pricing/
- Elastic Load Balancing pricing: https://aws.amazon.com/elasticloadbalancing/pricing/
