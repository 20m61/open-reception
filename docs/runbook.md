# 運用 Runbook（アラーム対応・手動受付切替） (issue #316)

本番運用中に CloudWatch アラームが発報したとき、または障害で受付を止めざるを得ないときに
**この 1 冊だけ**を見て一次対応・手動受付への切替・復旧ができることを目的とする。

対象読者: 運用当番（開発者に限らない）。開発視点の設計判断は
`docs/infrastructure-design.md` / `docs/deploy-aws.md` を参照。

## 0. 前提: アラームの発生源

CloudWatch アラームは CDK Stack 3 つが作成する（`infra/lib/stacks/`、実装元は括弧内）。

| Stack (CDK) | デプロイ先リージョン | ダッシュボード | SNS Topic |
| --- | --- | --- | --- |
| `OpenReception-WebMonitoring-<env>`（`web-monitoring-stack.ts`, issue #299） | `ap-northeast-1`（既定） | `<prefix>-web`（例 `open-reception-prod-web`） | `<prefix> web alarms` |
| `OpenReception-CfMonitoring-<env>`（`cloudfront-monitoring-stack.ts`, issue #303） | **us-east-1 固定**（CloudFront メトリクスの発行先制約） | 専用ダッシュボードなし（アラームは us-east-1 の CloudWatch コンソール「すべてのアラーム」で確認。5xxErrorRate の推移は上記 `<prefix>-web` ダッシュボードの CloudFront widget で見られる） | `<prefix> cloudfront alarms`（us-east-1） |
| `OpenReception-Monitoring-<env>`（`monitoring-stack.ts`, 通知サブシステム #34） | `ap-northeast-1`（既定） | `<prefix>-notification` | `<prefix> notification alarms` |

`<prefix>` は `infra/lib/config/environments.ts` の環境別 `prefix`（例: 本番は
`open-reception-prod`）。CloudWatch コンソールでダッシュボード名検索、またはアラーム名から
該当 Stack をたどる。

アラーム通知メールの宛先は `-c alarmEmail=...` で購読した SNS Topic 経由（`docs/deploy-aws.md`
「alarmEmail の運用」）。メールが来ない場合はまず SNS のサブスクリプション確認（Confirm
Subscription）が承認済みかを疑う。

全アラーム共通の初動:

1. アラームメールの **AlarmName** から下表の行を特定する。
2. 「確認先ダッシュボード」を開き、発報時刻付近のグラフで実際にメトリクスが悪化しているか
   （false positive/瞬間的ノイズでないか）を見る。
3. 「一次対応」を実施する。改善しない/原因不明なら「エスカレーション」に従う。
4. 利用者影響がある（受付が止まっている/繋がらない）と判断したら、直ちに
   **§2 手動受付切替フロー**を開始する（アラーム原因調査と並行してよい）。

---

## 1. アラーム別 一次対応（14 個・1:1 対応）

### 1.1 WebMonitoringStack（`OpenReception-WebMonitoring-<env>`, issue #299）— ダッシュボード `<prefix>-web`

| # | アラーム名 (CDK Construct ID) | 意味 | 一次対応 | エスカレーション |
| --- | --- | --- | --- | --- |
| 1 | `ServerErrors` | server Lambda（Next.js SSR/Route Handlers 本体）でエラー発生（5分で1件以上） | ダッシュボード「Server Lambda」widget でエラー件数の推移を確認。CloudWatch Logs Insights で当該 Lambda（`OpenReception-Web-<env>` の server 関数）のログを直近5〜15分検索し、スタックトレース/直前のデプロイの有無を確認。直近デプロイ起因なら前バージョンへロールバック（再デプロイ）を検討。利用者影響（受付が使えない）が続くなら §2 手動受付切替へ。 | 単発のエラーで原因不明・再発する場合は開発者へ連絡し `docs/deploy-aws.md` の再デプロイ手順で修正版を出す。 |
| 2 | `ServerThrottles` | server Lambda がスロットル（同時実行上限超過） | ダッシュボード「Server Lambda」でスロットル件数を確認。アクセス急増（本来のトラフィック増）か異常なリクエスト（攻撃/バグループ）かを CloudFront アクセスログ/`AccountConcurrentExecutions`（#5）の状況と合わせて判断。異常アクセスなら WAF/IP 制限を検討し開発者へエスカレーション。 | 継続する場合は開発者へ連絡し Lambda 予約済み同時実行数の引き上げを検討。 |
| 3 | `ServerDurationP95` | server Lambda の p95 応答時間がタイムアウトの80%を3期間（15分）継続で超過 | ダッシュボード右軸の p95 Duration を確認。DynamoDB 側の遅延・外部呼び出し（通知 API 等）の遅延が無いか、同時刻の `DdbReadThrottles`/`DdbWriteThrottles`（#8,#9）も確認。 | 原因が特定できない・悪化が続く場合は開発者へエスカレーション（コード起因のパフォーマンス劣化の可能性）。 |
| 4 | `ServerConcurrentExecutions` | server Lambda の同時実行数がアカウント既定上限(1000)の80%(=800)に到達 | 暴走/攻撃の兆候。ダッシュボードとアクセスログで急増元（特定 IP/UA/パス）を確認。 | 直ちに開発者・責任者へエスカレーション。必要ならセキュリティ設定（`/admin/security` の IP 許可リスト）で暫定遮断、収まらなければ §2 手動受付切替へ。 |
| 5 | `AccountConcurrentExecutions` | リージョン全体（アカウント×リージョン共有）の Lambda 同時実行数が800到達 | #4 と同じ原因調査。他の Lambda（image/通知）を含めた合算枯渇の可能性があるため、`ImageErrors`(#6) や通知系アラームの同時発報も確認。 | #4 と同様、直ちにエスカレーション。 |
| 6 | `ImageErrors` | image Lambda（`/_next/image` 最適化）でエラー発生 | ダッシュボード「Image Lambda」でエラー件数を確認。CloudWatch Logs で image 関数のログを確認。画像最適化のみの障害なので受付フロー自体（テキスト/ボタン操作）は継続可能なことが多い — 影響範囲（画像が表示されないだけか、ページ全体が落ちているか）を切り分ける。 | 全体影響がなければ低優先で開発者へ連絡し修正を待つ。ページ全体に影響する場合は `ServerErrors`(#1) と合わせて扱う。 |
| 7 | `ImageDurationP95` | image Lambda の p95 応答時間がタイムアウトの80%を3期間継続で超過 | ダッシュボード「Image Lambda」右軸で確認。大きな画像アセット（`/admin/assets` で登録した背景等）の追加直後なら原因の可能性が高い。 | 継続する場合は開発者へ連絡し画像サイズ最適化を検討。 |
| 8 | `DdbReadThrottles` | DynamoDB 読み取りスロットル発生（オンデマンド上限/ホットパーティション） | ダッシュボード「DynamoDB」でスロットル発生時刻を確認。特定操作（一覧取得の急増等）に偏りがないか CloudWatch Logs と突き合わせる。オンデマンドのため通常は自動でキャパシティが追随するが、急激なスパイクでは一時的に発生し得る。 | 継続・悪化する場合は開発者へエスカレーション（ホットパーティション設計の見直しが必要な可能性）。 |
| 9 | `DdbWriteThrottles` | DynamoDB 書き込みスロットル発生 | #8 と同様の確認。受付登録・端末ハートビート等の書き込み急増が無いか確認。 | 継続・悪化する場合は開発者へエスカレーション。 |

### 1.2 CloudFrontMonitoringStack（`OpenReception-CfMonitoring-<env>`, issue #303, us-east-1）

| # | アラーム名 (CDK Construct ID) | 意味 | 一次対応 | エスカレーション |
| --- | --- | --- | --- | --- |
| 10 | `CloudFront5xxErrorRate` | CloudFront の 5xxErrorRate が 1% を 3×5分=15分継続で超過（オリジン非到達・設定破壊などの持続的障害） | us-east-1 の CloudWatch コンソールでアラーム詳細を開くか、`<prefix>-web` ダッシュボードの「CloudFront (us-east-1)」widget で 5xxErrorRate の推移を見る。同時刻に `ServerErrors`(#1) や `ServerThrottles`(#2) が発報していないか確認（オリジン=server Lambda 側の障害が原因であることが多い）。 | オリジン側アラームが同時発報していれば該当行の手順を優先。オリジンは正常なのに 5xx が続く場合（CloudFront 設定・OAC・証明書の問題）は開発者へ直ちにエスカレーション。利用者影響が続く場合は §2 手動受付切替へ。 |

### 1.3 MonitoringStack（`OpenReception-Monitoring-<env>`, 通知サブシステム #32/#34）— ダッシュボード `<prefix>-notification`

| # | アラーム名 (CDK Construct ID) | 意味 | 一次対応 | エスカレーション |
| --- | --- | --- | --- | --- |
| 11 | `NotificationErrors` | 通知 Lambda（担当者呼び出し通知）でエラー発生 | ダッシュボード「Notification Lambda」でエラー件数を確認。CloudWatch Logs で通知 Lambda のログを確認。Vonage/Polly 連携先の障害か、拠点 authorizer/Secret 設定の問題かを切り分ける（`docs/deploy-aws.md` の通知サブシステム節の Secret 設定を参照）。担当者呼び出しが届かない状態のため、受付端末では引き続き受付は可能だが**呼び出し結果が代替導線（電話等）に誘導される**運用になっていないか確認する。 | 解消しない場合は開発者へエスカレーション。呼び出し不達が続く場合は現場に対して口頭/内線等の代替呼び出しを依頼する。 |
| 12 | `NotificationLatencyP95` | 通知 Lambda の p95 応答時間がタイムアウトの80%を3期間継続で超過 | ダッシュボード右軸で確認。外部連携先（Vonage 等）の応答遅延が主因になりやすい。 | 継続する場合は開発者へエスカレーション。外部サービス側の障害情報も確認する。 |
| 13 | `NotificationThrottles` | 通知 Lambda がスロットル | ダッシュボードで件数を確認。呼び出しの急増（イベント時など）か異常呼び出しかを判断。 | 継続する場合は開発者へエスカレーション（同時実行数見直し）。 |
| 14 | `Api5xx` | 通知 API（`POST /notify` の HTTP API）が 5xx を応答 | ダッシュボード「API 4xx / 5xx」で確認。`NotificationErrors`(#11) と同時発報なら Lambda 側障害が主因。単独で 5xx が出る場合は API Gateway/authorizer 側の設定問題の可能性。 | 解消しない場合は開発者へエスカレーション。 |

> 全アラーム共通: `treatMissingData: NOT_BREACHING`（メトリクス欠測はアラーム状態にしない）。
> つまり「データが来ない静かな障害」（Lambda が完全に呼ばれていない等）はこれらのアラームでは
> 検知できない。**受付端末側の異常（画面が固まる/呼び出しできない）を現場から報告された場合は、
> アラームが鳴っていなくても §2 の障害検知として扱う。**

---

## 2. 手動受付切替フロー（障害検知 → 緊急停止 → 代替受付 → 復旧確認 → 解除）

対応する requirements: 5.3「障害時に手動受付へ切り替えられる」（UC-05）。

### 2.1 障害検知

次のいずれかで検知する。

- 上記アラームメールの受信（§1）。
- 現場（受付端末の前にいるスタッフ・来訪者）からの「画面が反応しない」「呼び出しても繋がらない」報告。
- 定期巡回での目視確認（受付端末画面が待機画面から進まない等）。

障害の疑いが強い、または受付が実際に機能していない（担当者呼び出しができない）と判断した時点で
次のステップへ進む。**原因の完全な特定を待つ必要はない**（切替を先に行い、原因調査は並行する）。

### 2.2 緊急停止（受付停止 + メンテナンス表示）

管理画面 `/admin/security`（実装: `src/components/admin/SecurityManager.tsx`、
API: `PUT /api/admin/security`、実装: `src/app/api/admin/security/route.ts`）で
**緊急停止モード**を有効化する。

1. 管理者アカウントで `/admin/security` を開く（`tenant_admin` 以上の権限が必要。
   `viewer` ロールでは書込不可 = 403）。
2. 画面上部「緊急停止モード」セクションの **「緊急停止する」**ボタン
   （`data-testid="emergency-stop"`）を押す。
3. 確認ダイアログで **「本当に全端末を停止する」**（`data-testid="emergency-confirm"`）を押す。
   — 内部的には `PUT /api/admin/security` に `{ "emergencyStop": true }` が送られる
   （`src/domain/security/types.ts` の `effectiveKioskActive()` により、この間は端末レジストリの
   有効/無効状態に関わらず**全受付端末が利用停止**になる）。
4. 表示が「停止中（全端末で受付を停止）」に変わったことを確認する
   （`data-testid="emergency-state"`）。
5. 実際に受付端末（iPad）側が「利用停止」表示に切り替わっていることを1台以上で目視確認する
   （反映は端末が次回設定を取得するタイミング。数秒〜数十秒程度）。

この操作は `security.updated` として監査ログ（`/admin/audit`）に記録される（PIN 値などの機微値
は記録されない）。

> 特定の 1 端末・1 拠点だけを止めたい場合（全体障害ではない場合）は、緊急停止モードではなく
> 個別端末の無効化を使う。`/admin/devices`（サイト別受付端末管理、
> `src/components/admin/DevicesManager.tsx`）で対象端末の「無効化」ボタンを押す
> （内部的には `PATCH /api/admin/devices/:id` に `{ "enabled": false }`。
> 実装: `src/app/api/admin/devices/[id]/route.ts`）。あるいは `/admin/kiosks`
> （`src/components/admin/KiosksManager.tsx`、`POST /api/admin/kiosks/:id/revoke`）でも同等の
> 個別失効ができる（`/admin/kiosks` での失効は Device レジストリへも自動同期される）。

### 2.3 代替受付（紙・電話等）への切替

1. 受付停止中である旨を来訪者に見える場所（受付台・入口）に掲示する（紙の案内）。
2. 事前に用意した**紙の来訪者記入用紙**（氏名・会社名・訪問先部署/担当者・来訪目的）に
   手書きで記入してもらう。
3. 受付スタッフ（不在の場合は最寄りの職員）が**内線電話または直接連絡**で訪問先担当者を呼び出す。
   — 通知サブシステム（Vonage 経由の自動呼び出し）が使えない前提のため、社内の代替連絡手段
   （固定電話・内線・チャット等、拠点ごとに事前整備）を使う。
4. 紙の記入用紙は復旧後、必要に応じて `/admin/receptions`（受付履歴、
   `src/app/api/admin/receptions/route.ts`）とは別に、来訪者記録として拠点の運用ルールに従い
   保管・破棄する（紙の記入内容は本システムの監査ログには入力しない — 個人情報を電子化して
   保存しないため。運用要件は拠点管理者の指示に従う）。

### 2.4 復旧確認

原因調査・修正が完了したら、本番反映前に次を確認する。

1. 該当アラームがダッシュボード上で正常範囲に戻っている（§1 の該当行の「確認先ダッシュボード」）。
2. `/admin` トップ（ダッシュボード）または対象拠点の状況で異常が続いていないか確認する。
3. **緊急停止を解除する前に**、テスト用の1台（本番端末のうち影響のない1台、または検証用端末）
   で実際に受付〜呼び出しが通ることを可能なら確認する。

### 2.5 解除

1. `/admin/security` を開き、「受付を再開する」（`data-testid="emergency-resume"`）を押す
   （`PUT /api/admin/security` に `{ "emergencyStop": false }`）。
2. 表示が「通常稼働」に戻ったことを確認する。
3. 個別端末を無効化していた場合（§2.2 の個別無効化ルート）は、`/admin/devices` または
   `/admin/kiosks` で該当端末を再度有効化する。
4. 受付端末（iPad）側が待機画面に復帰していることを1台以上で目視確認する。
5. 掲示していた紙の案内を撤去する。
6. 対応内容（発生時刻・原因・対応・復旧時刻）を振り返りメモとして残す
   （社内の障害記録運用に従う。監査ログ `/admin/audit` は操作記録のみのため、原因分析は別途
   記録する）。

---

## 3. 付録

### 3.1 関連ドキュメント

- `docs/deploy-aws.md` — 各 Stack のデプロイ手順・`alarmEmail` 設定・監視 Stack の構成詳細。
- `docs/operator-guide.md` — 日常運用（担当者/部署 CSV・端末追加/失効/再登録・文言/アセット
  変更・受付履歴の見方・iPad 設置手順）。
- `docs/security-checklist.md` / `docs/security-testing-plan.md` — セキュリティ設計・検証観点。
- `docs/audit-logging.md` — 監査ログの仕様。
- `docs/ipad-uat.md` — 実機 UAT チェックリスト（§5 に緊急停止モードの実機確認項目あり）。

### 3.2 アラーム発生源ソースコード（一次情報）

- `infra/lib/stacks/web-monitoring-stack.ts`（#1〜#9）
- `infra/lib/stacks/cloudfront-monitoring-stack.ts`（#10）
- `infra/lib/stacks/monitoring-stack.ts`（#11〜#14）
- `infra/bin/open-reception.ts`（Stack 構成・デプロイ順序・crossRegionReferences）
- `src/domain/security/types.ts`（`emergencyStop` / `effectiveKioskActive` の判定ロジック）
- `src/app/api/admin/security/route.ts`（緊急停止 API）
