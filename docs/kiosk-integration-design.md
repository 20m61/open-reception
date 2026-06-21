# 受付端末 統合設計（Kiosk Integration）

親 Issue: #96 / 関連: #79（来訪検知）/ #100（カスタムフロー）/ #101（待機サイネージ）/
#102（退館チェックアウト）。

これまでスタンドアロンで実装した 4 機能を、中核 `KioskFlow`（`src/components/kiosk/KioskFlow.tsx`）
の実端末体験へ**フォールバック付きで**配線する増分（inc1）の設計。

## 最重要原則：非破壊（フォールバック）

統合はすべて「設定が無い / 取得失敗 / 未対応」時に**現行どおり動く**ことを保証する。
判断ロジックは純関数 `src/components/kiosk/integration.ts` に集約し、`KioskFlow` は結果に従って
分岐するだけにした（ユニットテスト: `src/components/kiosk/integration.test.ts`）。

| 機能 | 配線 | フォールバック条件 → 挙動 |
| --- | --- | --- |
| カスタムフロー #100 | `/api/kiosk/flow` を取得し、有効フローがあれば目的選択→来訪者情報入力を `custom-flow` 部品で駆動 | 取得前 / 403 / 503 / 空配列 → `shouldUseCustomFlow=false` で既存の `PurposeView` / `VisitorInfoView` |
| 待機サイネージ #101 | `/api/kiosk/signage` の再生可能項目が idle 時にあれば、埋め込み版 `SignageDisplay` を待機画面に表示 | 項目 0 / 取得失敗 / オフライン / 端末失効 → `shouldShowSignage=false` で既存 `IdleView` |
| 来訪検知 #79 | 待機サイネージ表示中かつトグル ON のとき `usePresenceCamera` がカメラ + Canvas 差分 + presence 状態機械で接近を推定し受付開始 | トグル OFF（既定）/ getUserMedia 未対応 / 権限拒否 / 取得失敗 → `status='unavailable'`、タップ起動で完走 |
| 退館チェックアウト #102 | 待機画面（既定 idle / サイネージ待機）に `/kiosk/checkout` への小ボタンを常設 | スタンドアロン `/kiosk/checkout` はそのまま。導線追加のみで既存フローに影響なし |

## 配線の要点

### カスタムフロー（#100）

- 受付状態機械（`src/domain/reception/state.ts`）は inc1 では**変更しない**。
- `selectingPurpose` で `CustomPurposeView`（`PurposeSelector` を受付画面枠で包む）を表示。
  選択したフローを `selectedFlow` に保持し、同時に `SELECT_PURPOSE` を発火して状態機械を進める。
- `purpose` は API（`/api/kiosk/receptions`）が `ReceptionPurposeId` に限定検証するため、
  `purposeIdForFlow` で `purposeKey`→`ReceptionPurposeId`（未知は `other`）へ写す。元の
  `purposeKey` は payload に併送し、サーバ将来拡張に備える（未知キーでも非破壊）。
- `inputVisitorInfo` で `CustomVisitorInfoView`（`VisitorInfoForm`）を表示。送信値は
  `flowValuesToVisitorInfo` で既存 `VisitorInfo`（name/company/note）へ写す。慣習キー
  （name/company/note）以外の入力は「ラベル: 値」で `note` へ畳み込み、受付を止めない。
- **確認・呼び出し（confirm/call）は既存状態機械へ委譲**する（独自に作り替えない）。
- `target`（担当者/部署選択）は inc1 では既存どおり常に通す（保守的スコープ）。フロー定義の
  `steps` による target 省略は次増分。
- idle へ戻ったら `selectedFlow` を破棄（次の来訪者へ持ち越さない）。

### 待機サイネージ（#101）

- `SignageDisplay` に `onStart?` を追加（非破壊）。未指定（スタンドアロン `/kiosk/signage`）は
  従来どおり `/kiosk` へ router.push。指定（`KioskFlow` 埋め込み）は画面遷移せず `START` を発火。
- `shouldShowSignage` は idle・online・非失効・項目ありのときだけ true。オフライン / 失効表示を
  サイネージより優先する（issue #101 の優先順位方針）。

### presence カメラの扱い（#79）

- **既定 OFF**。待機画面の「来訪検知」トグルで ON にしたときだけ `getUserMedia` を呼ぶ。
- 実装は `usePresenceCamera`（`src/components/kiosk/usePresenceCamera.ts`）。
  - 低解像度（内部 80x60）・低 fps（約 400ms）でフレーム差分（`src/lib/presence/motion-diff.ts`）。
  - 中央 ROI のモーション量を presence 状態機械（`src/domain/presence/state.ts`）へ流し、
    CANDIDATE で継続モーションを観測したら ATTRACT 相当とみなして受付開始（`onDetected`）。
  - 顔検出（MediaPipe 等）は inc1 では起動しない。CANDIDATE 中の継続モーションを軽量代替とした。
- 映像・フレームは**ローカルでのみ処理**し、サーバ送信・保存はしない（プライバシー方針）。
- **実機カメラ検証は #65 にスタック**（権限 UX・端末ごとの挙動差・しきい値調整は実機が必要）。
  未対応/拒否時は `unavailable` に倒れ、タップ起動が常に生きるため受付は完走する。

### 退館チェックアウト（#102）

- 待機画面に `/kiosk/checkout` への小ボタンを常設（`CheckoutLink`）。既存 `CheckoutFlow` は無改変。

## 個人情報・終了後表示

- 完了 / タイムアウト後の自動リセットは既存どおり。idle 復帰時に `selectedFlow` を破棄。
- カスタムフロー入力値は `VisitorInfo` に最小限写すのみ（既存方針を維持）。サイネージ・フロー定義・
  presence いずれも来訪者 PII を画面に残さない。

## テスト

- ユニット（`integration.test.ts`、13 ケース）: フロー有/無、サイネージ有/無/オフライン/失効、
  purposeKey 写像、フロー入力値→VisitorInfo 畳み込み。
- e2e（`tests/e2e/kiosk-integration.spec.ts`）: 既定フォールバック（受付開始/QR/目的選択が出る）と
  退館導線（`/kiosk/checkout` 遷移）。既存 kiosk e2e（checkin/access/heartbeat 等）は無改変で緑。

## 次増分（inc2 以降）

- カスタムフローの `steps` による target/visitorInfo の省略・順序制御、`completionMessage` 反映。
- サイネージの緊急停止 / 通信断の優先表示の `kiosk/config` 統合の精緻化。
- presence の顔検出起動（CANDIDATE 短時間）と ATTRACT 演出、`session_started` のサーバ発火、
  実機検証（#65）。
- 退館の QR / 受付番号検索導線の拡充（#102 後続）。
