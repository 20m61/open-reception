# 退館チェックアウトと滞在状態管理 設計 (issue #102)

親 Epic: #96 / 関連: #97（予約）, #98（QR チェックイン）, #89（監査）。

本書は来訪者の **滞在状態（在館 / 退館）** モデルと、受付端末（kiosk）からの **退館チェックアウト**、
管理画面（admin）の **在館状況** を定義する。既存の予約・チェックイン基盤を **import 参照** で活用し、
他トラック（flow / signage）と疎結合に作る。

## 1. スコープ（increment 1）

| 領域 | 内容 |
| --- | --- |
| ドメイン | `src/domain/visit/**` — `StayStatus`・`VisitStay` 純モデルと状態遷移純関数 |
| 永続化 | `src/lib/visit/**` — `getBackend()` ベースの stay store・テナント/サイト境界・サービス層 |
| Kiosk 退館 | `/kiosk/checkout`（スタンドアロン）・`/api/kiosk/checkout/**`（kiosk セッション保護） |
| Admin 滞在状況 | `/admin/stay`（在館者一覧・状態表示）・`/api/admin/stay/**`（認可 + guard） |
| 監査 | 事前定義済み `visitor.checked_out` / `stay.updated` を使用（log.ts は触らない） |

非スコープ（後続増分・他 Issue）: 入館ゲート / スマートロック、顔認証退館、災害一斉通知、バッジ印刷、
予約 QR 退館の本配線（inc1 は受付番号 = stayId / 受付セッション参照で退館）、DynamoDB GSI 最適化。

## 2. 滞在状態モデル（`StayStatus`）

```text
present（在館中）── checkout ──▶ checked_out（退館済み）   ← 終端
       │
       └────────── cancel ────▶ cancelled（取消・誤入力訂正） ← 終端
```

- **present**: チェックイン完了。受付端末で受付したか、予約で来館した来訪者が在館している状態。
- **checked_out**: 退館チェックアウト済み。`checkedOutAt` と滞在時間（`durationMs`）が確定する。
- **cancelled**: 誤登録の取消。滞在実績として数えない（管理操作のみ）。

未退館（overstay）は **独立した永続状態ではなく派生表示** とする（`present` かつ
`checkedInAt` から一定時間経過）。永続状態を増やさず、判定は純関数 `isOverstay(stay, now, thresholdMs)` で行う。
これにより閾値変更が状態マイグレーションを伴わない。

二重退館防止: `checkout` は `present` からのみ許可（終端からの再退館は `invalid_state`）。

### `VisitStay`（永続モデル）

```ts
type VisitStay = {
  id: StayId;            // 受付番号として来訪者へ案内できる短命参照（PII ではない）
  tenantId; siteId;      // テナント/サイト境界（必須）
  status: StayStatus;
  checkedInAt: string;   // 在館起点（ISO）
  checkedOutAt?: string; // 退館時刻（checked_out 遷移時）
  durationMs?: number;   // 滞在時間（退館時に確定）
  // 来訪者識別は参照のみ。PII（氏名/会社名）は VisitStay に保存しない。
  reservationId?: string;   // 予約から来館した場合の参照（#97）
  receptionId?: string;     // 受付セッション参照（#16）
  retentionDays: number;    // 滞在情報の保存期間（運用方針の根拠）
  createdAt; updatedAt;
};
```

## 3. 来訪者識別とプライバシー

- `VisitStay` には **氏名・会社名・メモ等の PII を保存しない**。来訪者の識別は
  予約 token / 受付セッション（`receptionId`）/ 受付番号（`stayId`）の **参照** で行う。
- 退館導線は **受付番号（stayId）** または **在館一覧からの選択** を MVP とする
  （予約 QR 退館は token 解決の後続余地として設計のみ）。
- 退館後は受付端末・管理画面に個人情報を残さない。kiosk 退館完了画面は「退館を受け付けました」のみ表示し、
  一定時間で待機へ戻る（PII 非表示）。
- **監査ログに PII を残さない**: `visitor.checked_out` / `stay.updated` の metadata は
  `status` / `durationBucket`（滞在時間のバケット化）等の非 PII のみ。生の滞在時間や氏名は載せない。

## 4. 保存期間（retention）方針

- 滞在情報は業務証跡として有用だが PII 連結のリスクがあるため **必要最小限・期限付き** とする。
- `retentionDays`（既定 30 日）を `VisitStay` に持たせ、超過分は破棄する運用根拠とする
  （実際の TTL 削除配線は DynamoDB 増分で `getBackend().collection(..., { ttlSeconds })` を使う）。
- 災害時用途に拡張する場合は表示範囲と権限を別途整理する（本増分では扱わない）。

## 5. 認可・境界

- Admin API: 管理セッション必須（401）。`@/lib/admin/guard`（`requireActor` / `assertCanReadSite` /
  `assertCanWriteSite`）で tenantId/siteId 境界を判定（403）。フロントで隠した操作も API 側で 403。
- Kiosk API: kiosk セッション必須（cookie）。scope（tenant/site）は inc1 では dev 既定へ解決する暫定実装
  （#98 `resolveCheckinScope` と同方針。実 kiosk→site 写像は後続増分）。

## 6. increment 計画

- **inc1（本 PR）**: 純モデル + 遷移、stay store/service（getBackend）、kiosk 退館ルート/API、
  admin 在館一覧 read + 退館操作、監査配線、ユニットテスト。永続化は memory（dev/CI）/ dynamo は既存 backend 経由。
- **inc2 以降**: 予約 QR からの退館 token 解決、チェックイン完了時の VisitStay 自動生成配線（#98 confirm と接続）、
  在館サイネージ連携（#101）、滞在時間ダッシュボード、DynamoDB GSI と TTL 削除。

## 7. 意図するナビ配線（本 PR では navigation.ts を編集しない）

`src/components/admin/navigation.ts` の「日常運用」グループへ
`{ href: '/admin/stay', label: '在館状況' }` を追加するのが意図。nav 編集は所有外のため別 PR で行う。
本 PR の `/admin/stay` は直 URL で到達可能。

## 8. 退館の自己特定（self-identification）再設計 (issue #328)

### 8.1 課題（旧 inc1 の欠陥）

inc1 の退館導線は **受付番号（内部 stayId, `stay-<uuid>`）の直入力** を前提にしていた。来訪者は
自分の stayId を記憶しておらず入力不能。在館一覧も stayId + 入館時刻のみで、来訪者が自分の行を
判別できず**誤退館**し得た。本再設計は「ID を記憶させない自己特定手段」を導入する。

### 8.2 自己特定の 2 手段（#98 の QR 機構を流用）

チェックイン時（VisitStay が `present` になる時点）に、その滞在に紐づく**退館クレデンシャル**を
発行する。クレデンシャルは #98 の checkin token と同じ設計方針に従い、**PII を一切含まない**。

1. **退館 QR / token（主手段）**
   - `generateCheckoutToken()` = `node:crypto.randomBytes(32)` の base64url（**256 bit エントロピー**）。
   - QR には token を参照する URL `<baseUrl>/kiosk/checkout?ct=<token>` のみを載せる（氏名・stayId・
     予約 ID 等は載せない）。受付端末は QR/URL/生 token のいずれからも token を抽出する
     （`extractCheckoutToken`、#98 `extractReservationToken` と同型）。
   - 解決は token 一致の O(1)。総当り 2^256 は計算上不可能なため、**試行回数制限なし**でよい
     （TTL・consumed 状態のみ検査）。ただしテナント/サイト境界は二重防御として必ず照合する。

2. **短い退館コード（カメラ非対応・QR 紛失時のフォールバック）**
   - `4 桁の数字コード`。4 桁 = 10,000 通りで**単体では総当り可能**なため、以下で必ずハードニングする:
     - **サイト境界スコープ**: コードは kiosk の (tenantId + siteId) 内でのみ解決。他サイトの同一コードは
       絶対に一致しない（cross-site isolation）。
     - **呼び出し先ラベル照合（第 2 要素）**: コード解決には来訪者が**呼び出し先ラベル**（部署名等の
       非 PII）を合わせて入力・照合する必要がある。コード単体では確定に至らせない
       （`code + label 一致 + 明示的な確認` の三点が揃って初めて退館確定）。実効的な秘匿空間を
       `code × label` へ広げ、盲目的総当りを「特定の在館者に対する狙い撃ち推測」に変える。
     - **短い TTL**: 既定 12 時間で失効（同日退館を許容しつつ長期滞留を防ぐ）。失効後は解決不可。
       退館確定時に consumed へ遷移し無効化。
     - **試行回数上限**: コード毎（かつサイト毎）に失敗回数を数え、**5 回**で `locked`（再発行必須）。
       オンライン総当りを TTL 内 5 回に制限する。
     - **アクティブ窓内の一意性**: 発行時、同一サイトのアクティブ（未 consumed・未失効）コードと衝突
       しないよう再ロールする（最大 50 回、枯渇時は例外）。4 桁コードは在館者へ一意に対応する。

### 8.3 脅威モデル / 総当り解析

- **攻撃者像**: 受付端末（kiosk セッション保護 API）の前に物理的に立つ者。他人になりすまして
  退館確定を試みる（＝誤退館の誘発）。退館は「自分が退館したという記録の付与」のみで、入館ゲート
  解錠等の高価値操作は伴わない（低価値操作）。
- **token 経路**: 256 bit。推測・総当りは不可能。紛失/共有時のみリスクだが失効 + consumed で緩和。
- **code 経路**: 1 コード TTL あたり ≤5 試行 + サイト境界 + ラベル照合必須。ラベル要素を無視しても
  盲目的成功確率は ≤ 5/10000 = 0.05%。さらに攻撃者は在館者の有効な呼び出し先ラベルを知る必要があり、
  試行上限 + 短 TTL が持続的列挙を阻む。**低価値操作 + 監査証跡あり**の前提で受容可能なリスクとする。
  より高価値な操作（入館ゲート等・本スコープ外）では **QR 専用**とし、コード経路は提供しない。
- **設計フォーク（安全側を実装）**: 「QR のみ」対「QR + 4 桁コード」。QR のみは最も安全だが、
  カメラ非対応端末・QR 紛失時に来訪者が詰む（AC「ID を記憶せず退館完了できる導線」を損なう）。
  よって **QR を主・コードを上記ハードニング付きフォールバック**として両方実装する。オーケストレータの
  レビューでリスク受容可否を判断できるよう本節に明記する。

### 8.4 確認ステップ（誤退館防止）

退館確定の直前に本人確認ステップを置く（AC）。表示は **入館時刻 + 呼び出し先ラベル + 用件**のみで
**氏名等 PII は出さない**:「◯時◯分に △△ 宛で入館した方ですか？」→「はい（退館する）／いいえ（戻る）」。
これは在館一覧の判別材料（入館時刻 + 呼び出し先ラベル + 用件、氏名なし）とも一致する。

### 8.5 監査

- 自己特定による退館は既存 `visitor.checked_out` に加え、新規 `visitor.checkout_self_identified` を
  記録する（誤退館調査のため自己退館と staff/admin 退館を区別）。metadata は **method（`qr`/`code`）**
  と滞在状態のみで、**token/code/PII は残さない**（`rules/pii-secret-minimization.md`）。

### 8.6 増分境界（本 PR = 関連 #328 の増分）

- **本 PR で提供**: 退館クレデンシャルの純ロジック（format/正規化/ラベル照合/TTL/試行上限）、
  クレデンシャルサービス（発行・解決・確定、in-memory・サイト境界・TTL・試行上限・一意性）、
  kiosk 保護 API（`/api/kiosk/checkout/resolve`・`/confirm`・`/issue`）、在館一覧への判別材料追加
  （時刻 + ラベル + 用件）、確認ステップ付きの再設計 UI（kiosk デザインシステム統一）、i18n（4 locale）、
  監査アクション追加、ユニットテスト（総当り耐性・TTL・cross-site・locked・二重確定）。
- **次増分（他トラック所有 UI に依存＝本 PR 対象外）**: 受付完了画面 / 予約 QR への退館 QR/コード
  発行の**表示配線**（`KioskFlow` / reservation UI は #326 等が所有）、チェックイン完了時の
  VisitStay 自動生成 + 自動発行の接続（design §6 inc2）、クレデンシャルストアの getBackend 永続化と
  カメラスキャナ UI（実カメラは #65 スタック）。本 PR の発行は `/api/kiosk/checkout/issue`（kiosk 保護）
  で行える状態にし、表示側の配線は次増分でオーケストレータが束ねる。
