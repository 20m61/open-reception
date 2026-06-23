# デプロイ後 対応計画（統合ロードマップ）

初回 AWS dev デプロイと実環境向け品質ゲート整備（2026-06-23）で判明した課題を統合した対応計画。
背景の詳細は `docs/deploy-aws.md` / `docs/quality-gate.md`、デプロイ知見は session メモリ参照。

## 課題インベントリ

### デプロイ / インフラ
- 🔴 **CloudFront OAC 403**: CloudFront → Lambda Function URL の OAC 署名が IAM に受理されず実環境が
  アプリ未到達。設定は公式構文 `FunctionUrlOrigin.withOriginAccessControl` で正しいが、伝播待ち/
  再デプロイ/再伝播/invalidation すべて無効。アプリ本体は Function URL 直接(SigV4)で 200 動作確認済み。
- #189 カスタムドメイン（ACM 証明書 + Route53 + CloudFront 別名）— OAC 解消後。
- **Secrets Manager 化**: 現状は env 注入方式。server Lambda が runtime 取得する方式へ（読取権限付与）。
- **Notification / Monitoring スタック未デプロイ・未検証**（siteTokenSecret 必須・alarmEmail 任意）。
- **prod スタック**デプロイ + 監視アラーム実起動確認 + **seed/CSV** で実データ投入。
- dev スタック稼働中＝**AWS 課金**。不要時 `cd infra && npx cdk destroy OpenReception-Web-dev -c env=dev`。

### セキュリティ / 認可
- 🟠 **ZAP 警告**: CSP ワイルドカード[10055] の絞り込み、COEP/CORP/COOP[90004] 付与（`next.config.ts`）。
- #83 **`platform_developer` ロール分離 + 通常/昇格権限 + JIT/MFA**（console 本体は #90 で完了。MFA/JIT は
  実 IdP=Entra #70 / #65 連動）。

### 品質 / 性能
- Lighthouse **perf 一部 0.68–0.72**（`/`・`/kiosk`・`/admin/login`）改善。
- スクショ baseline は**ローカル専用**（CI 不在）。GitHub Actions 不使用方針の継続 or ランナー導入は要判断。

### 外部リソース依存（interface+mock 済・実物待ち → #65）
- #4 Vonage 実通話（実認証情報）/ #31 VRM 実アセット / #65 実機 UAT（iPad/4K・presence #79）。

### 開発運用 / ガバナンス
- **1Password コミット署名**が一時オフ（#185 以降 `commit.gpgsign=false`）→ 復帰・過去再署名の判断。

## フェーズ別計画（依存・優先度）

| フェーズ | 内容 | 依存 | 担当 |
|---|---|---|---|
| 0 ガバナンス | 1Password 署名復帰（次コミットから通常運用） | — | 自律 |
| 1 到達可能化 🔴 | OAC 403 切り分け（NONE 診断 or AWS サポート）→ 解消 → 実環境 E2E/smoke + url-quality-gate | — | 要協力 |
| 2 セキュリティ 🟠 | ZAP: CSP 絞り込み + COEP/CORP/COOP → 再 ZAP 0 WARN | — | 自律 |
| 2 認可 | #83 auth（ロール分離・昇格・JIT/MFA 設計→実装） | #70/#65 一部 | 自律+外部 |
| 3 性能 🟡 | Lighthouse perf 改善 → 閾値安定 | — | 自律 |
| 4 本番準備 🟠 | Secrets Manager 化 → #189 ドメイン → Notification/Monitoring → prod デプロイ + seed | フェーズ1 | 自律+判断 |
| 5 外部 ⚪ | #4 / #31 / #65 ライブ検証 | 実物 | 外部 |

## 自律着手順（ブロッカーなし分）
フェーズ0（署名復帰）→ フェーズ2（ZAP/CSP・COEP ヘッダ）→ フェーズ3（perf）。
OAC（フェーズ1）は NONE 診断の結果を待って確定対応。

## 追跡 issue
OAC 403 / ZAP セキュリティヘッダ / Secrets Manager / 監視デプロイ検証 / Lighthouse perf を新規 issue 化。
既存: #83(auth) / #189(ドメイン) / #4・#31・#65(外部)。
