# ADR 0010: Realtime production ingress — CloudFront を唯一の公開入口にする

- ステータス: **提案（dev spike の実測待ち。production 採用は未承認）**
- 日付: 2026-09-12
- 関連 Issue: #1069（親 #1067）、#366、#369、#1068、#1070
- 置き換える決定: ADR 0003 の Phase 0 endpoint を production 恒久構成とはみなさない

## 文脈

ADR 0003 / #366 は、1 日 10〜50 件規模の受付を前提に固定費を抑えるため、Realtime Runtime を
`ASG min=0 / max=1`・単一 AZ・public subnet・動的 Public IPv4 + Route 53 で構成した。
SSH は閉じ、Session Manager、IMDSv2、暗号化 EBS、最小 IAM を採用しているため、**Phase 0 としての
判断は維持する**。

一方、現行 skeleton は Security Group で `0.0.0.0/0:443` を許可し、iPad が EC2/Caddy の
Internet-facing endpoint へ直接 WSS 接続する形である。これは production の恒久的な公開境界としては
広すぎる。

2026-09-12 時点の AWS 公式仕様では次が利用可能である。

- CloudFront は RFC 6455 WebSocket を正式サポートする。WebSocket は Distribution で自動的に利用可能。
- CloudFront VPC Origins は private subnet の EC2 / ALB / NLB を origin にでき、CloudFront を単一の
  public entry point にできる。VPC Origin 自体の追加料金はない。
- Tokyo `ap-northeast-1` も VPC Origins 対応（`apne1-az3` を除く）。
- AWS CDK 2.263 系では `aws_cloudfront_origins.VpcOrigin` が利用可能。
- Public IPv4 は $0.005 / IP-hour。現行の 15h/day × 30 日なら約 $2.25/月。
- ALB/NLB は load balancer hour + LCU/NLCU の継続料金を持つため、低トラフィックでは固定 hourly charge の
  比重が大きい。

## 決定（候補）

production ingress の原則を **CloudFront single public front door** とする。
ただし 1 段で最終構成へ移行せず、利用量と可用性要求に応じて 2 段階にする。

### Stage 1 — low-cost production candidate

```text
iPad
  ↓ wss://realtime.<public-domain>
CloudFront (Realtime 専用 Distribution)
  ↓ WebSocket / cache disabled
  ↓ origin verification header
origin-realtime.<domain>
  ↓ Route 53 dynamic A
EC2 public IPv4 / ASG max=1
  SG: CloudFront origin-facing prefix list ONLY :443
  Caddy: origin verification + voice transport token verification
```

具体的には:

1. `0.0.0.0/0:443` を production では禁止する。
2. EC2 Security Group の 443 ingress は AWS managed prefix list
   `com.amazonaws.global.cloudfront.origin-facing` のみにする。
3. CloudFront → origin に high-entropy の origin verification header を付け、Caddy でも照合する。
   prefix list は「CloudFront 全体」なので、別 Distribution からの到達に対する defense-in-depth とする。
4. viewer/session 認証は network boundary と分離し、既存 #369 の短命 Voice Transport token を使う。
   現行実装は 2 分 TTL、`tenantId/siteId/kioskId/receptionSessionId` binding、`jti` replay guard を持つ。
5. Realtime は WebStack の既存 Distribution に混在させず、専用 Distribution を第一候補とする。
   Web と Realtime の deploy lifecycle / WAF policy / timeout / blast radius を分離するためである。
6. CloudFront の realtime behavior は cache disabled とし、WebSocket に必要な `Sec-WebSocket-*` headers を
   origin へ forward する。
7. WAF は #1068 の責務とし、本 ADR では認証の代替にしない。

**重要**: Stage 1 はまだ承認ではない。下記 dev spike が green であることを採用条件とする。

### Stage 2 — availability / scale promotion

#1070 の promotion threshold 到達後は次を候補とする。

```text
iPad
  ↓
CloudFront + WAF
  ↓ VPC Origin
internal ALB or NLB
  ↓
ASG private subnet / Multi-AZ
```

CloudFront VPC Origin により instance を private subnet に置き、public IPv4 を不要にする。
LB を stable endpoint とすることで ASG の instance replacement と CloudFront origin lifecycle を分離する。
ALB / NLB の選択はその時点の WSS latency、health/drain、connection 数、費用の実測で決める。

## VPC Origin → EC2 direct を Stage 1 にしない理由

VPC Origins は EC2 instance 自体を endpoint にでき、追加料金もないため一見もっとも安い。しかし
`VpcOrigin.withEc2Instance(instance)` は特定 EC2 instance を origin resource として扱う。

現行 #366 は instance crash 時に ASG が新 instance を作り直すことを自己復旧の主要価値としている。
EC2 直 VPC Origin と組み合わせると、instance replacement のたびに CloudFront VPC Origin を再配線する
control plane が必要になる。

これは「LB 固定費を避けるために独自の origin 再配線を作る」構成になり、Phase 0 の単純さを失う。
よって **ASG を維持する Stage 1 では不採用候補**とする。

## 代替案

### A. 現行の direct public EC2 を恒久化

却下候補。固定費は最小だが、Internet-wide 443 を runtime 自身が受ける。CloudFront/WAF の edge 防御を
使えず、scanner / connection flood / origin discovery の負担を Caddy/runtime が直接持つ。

### B. CloudFront + public ASG instance（Stage 1）

第一候補。ただし dynamic Route 53 A record 変更後に CloudFront が新 origin IP へ追従する実時間を
AWS 公式文書だけでは十分確定できないため、dev spike が必須。

### C. CloudFront VPC Origin + internal LB + private ASG（Stage 2）

security / lifecycle 分離は最も明瞭。VPC Origin 自体に追加料金はないが、ALB/NLB の hourly charge が
継続するため、1 日 10〜50 件の現時点では #1070 の昇格条件まで保留する。

### D. VPC Origin + EC2 direct

上記 lifecycle coupling のため、ASG 自己復旧を維持する現行要件とは相性が悪い。
固定 Instance の start/stop へ戻す場合のみ再評価余地がある。

## セキュリティ境界

Stage 1 では次を別々に成立させる。

```text
Edge / network
  CloudFront + WAF
  + SG CloudFront-origin-facing only
  + origin verification

Session
  short-lived voice transport token
  + tenant/site/kiosk/reception binding
  + replay rejection

Runtime
  frame size / send rate / concurrent streams / idle timeout / max connection
  + not-ready / draining rejection

AWS authority
  EC2 instance role least privilege
  + no WebStack/DynamoDB/app secret authority unless explicitly required
```

1 つの層を他の層の代替にしない。

## Dev spike / 反証条件

Stage 1 は次の実測を通過した場合だけ採用する。

1. EC2-A へ CloudFront 経由 WSS 接続成功。
2. ASG replacement で EC2-B を起動し、Route 53 origin A record を更新。
3. 既存接続が失われた後、1 / 5 / 15 / 30 / 60 / 120 秒で再接続を試行。
4. CloudFront が stale origin IP を保持して許容 RTO を超える場合、Stage 1 は **不採用**。
5. viewer → CloudFront → origin の handshake RTT / first-audio latency を direct baseline と比較。
6. EC2 public hostname/IP への viewer direct request が SG で拒否されること。
7. CloudFront 経由でも origin verification が無い要求は Caddy が拒否すること。
8. expired / replayed / 別 kiosk token が拒否されること（#369 の既存契約）。
9. runtime unavailable 時も Web/signage/touch/QR が継続すること。

### 成功条件

- reconnect / DNS 追従が #366 で定める RTO 内。
- first-audio の増分が #365 の UX latency budget を破らない。
- direct origin bypass が成立しない。
- production 固定費が ALB/NLB 常設案より明確に小さい。

### 停止条件

- DNS 追従が不定または RTO 超過。
- CloudFront 経由で音声 UX に有意な遅延増。
- origin verification / prefix list の運用が再現可能に固定できない。

いずれかなら Stage 1 を捨て、Stage 2（stable LB + VPC Origin）を前倒し比較する。

## コスト影響

### Stage 1

- Public IPv4: 450h/月なら約 $2.25/月。
- CloudFront: request/data transfer 従量。現在規模では既存 CloudFront free tier/低使用量の範囲をまず実測する。
- WAF: #1068 で別途評価。
- ALB/NLB: なし。

### Stage 2

- VPC Origin 自体: 追加料金なし。
- Public IPv4: instance を private 化できれば不要。
- ALB/NLB: hourly + LCU/NLCU の継続料金を追加。

固定費増加は #1070 の promotion threshold / Human Gate を通す。

## 運用への影響

- `realtime.enabled=false` は、本 ADR の spike と #366 の readiness/drain が完了するまで維持する。
- Route 53 の viewer endpoint と origin endpoint を分離する。
- Realtime Distribution の failure は WebStack の deploy/failure domain と分離する。
- CloudFront/WAF を入れても touch/QR fallback を production readiness の必須条件から外さない。

## 撤回・見直し条件

次のいずれかで本 ADR を見直す。

- #1070 の Multi-AZ / LB promotion threshold 到達。
- WebRTC / LiveKit 等へ Transport 自体を変更（#369）。
- AWS が ASG を安定して直接参照できる VPC Origin endpoint を提供。
- CloudFront WebSocket の仕様・料金・timeout が本要件と非互換に変更。
- 実機 latency / reconnect evidence が Stage 1 を否定。

## Human Gate

この ADR の「提案」状態では次を実行しない。

- production Realtime の有効化
- production public ingress の切替
- ALB/NLB の追加
- 継続固定費を増やす構成変更

## 公式参照

- CloudFront WebSocket:
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html
- CloudFront VPC Origins:
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html
- CloudFront origins / EC2 / LB:
  https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistS3AndCustomOrigins.html
- AWS CDK `VpcOrigin`:
  https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins.VpcOrigin.html
- Public IPv4 pricing:
  https://aws.amazon.com/vpc/pricing/
- Elastic Load Balancing pricing:
  https://aws.amazon.com/elasticloadbalancing/pricing/
