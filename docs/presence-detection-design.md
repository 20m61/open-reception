# 来訪者検知（presence detection）設計 (issue #79)

iPad を往来に常時設置する受付端末で、**Web のみ・追加ハードウェアなし・低負荷**で
来訪者の接近/利用意図を推定し、受付開始イベントを発火する仕組みの設計。

最重要要件は **誤発火の抑制**。「人が映った＝受付開始」ではなく、
**この端末に用がありそうな人だけを受付候補として扱う**。

## 状態モデル

5 状態の段階設計。下に行くほど処理が重くなる。常時 AI 推論は行わない。

| 状態 | 役割 | 処理負荷 | カメラ/AI |
| --- | --- | --- | --- |
| `IDLE` | 待機画面。中央ゾーンの軽量モーション検知のみ | 最小 | 低解像度・低 fps、AI 停止 |
| `CANDIDATE` | 「何か来たかも」。短時間だけ顔検出で見極める | 中（短時間のみ） | 顔検出を 3〜5 秒だけ起動 |
| `ATTRACT` | 端末前に人がいそう。画面だけ軽く反応（音声/通話なし） | 低 | 顔検出停止 |
| `ACTIVE` | 受付開始。session_started を発火 | 高（受付フロー） | 受付フローへ委譲 |
| `COOLDOWN` | 発火直後/終了後の再発火抑制（15〜30 秒） | 最小 | AI 停止 |

### 遷移図（テキスト）

```text
                 motion >= threshold
   ┌────────────────────────────────────────────┐
   │                                             ▼
 IDLE ◀── candidateMax timeout ──── CANDIDATE ──── face detected ──▶ ATTRACT
   ▲                                  (顔検出を 3〜5s だけ起動)            │
   │                                                                     │ TAP
   │◀──────── attractMax timeout ────────────────────────────────────────┤
   │                                                                     ▼
   │                                                                  ACTIVE
   │                                                          (session_started)
   │                                                                     │
   │◀── cooldownDone timeout ── COOLDOWN ◀── SESSION_ENDED ──────────────┘

RESET: 任意状態 → IDLE（端末復帰 / visibilitychange）
SESSION_ENDED: 任意状態 → COOLDOWN（受付セッション終了）
```

- `IDLE → CANDIDATE`: 中央受付ゾーンのモーション量が `motionEnterThreshold` 以上。
- `CANDIDATE → ATTRACT`: 短時間の顔検出が成功（端末前に立ち止まった蓋然性が高い）。
- `CANDIDATE → IDLE`: `candidateMaxMs`（3〜5 秒）を超過。通行人の横切りを切り捨てる。
- `ATTRACT → ACTIVE`: タップ（明示操作）。将来は追加近接判定でも可（次増分以降）。
- `ATTRACT → IDLE`: 無操作のまま `attractTimeoutMs` 超過。
- `ACTIVE → COOLDOWN`: 受付セッション終了（`SESSION_ENDED`）。
- `COOLDOWN → IDLE`: `cooldownMs`（15〜30 秒）経過。

状態機械は純粋関数 `presenceTransition(state, input, config)` として
`src/domain/presence/state.ts` に実装。タイマ実体やイベント送信は持たず、
「次状態 + 張り直すべきタイマ + 発火イベント」をヒントとして返す。

## 低負荷の段階設計

往来に常時設置するため、iPad / Safari / PWA の負荷を抑えることが必須。

1. **IDLE（常時）**: AI を動かさず、Canvas フレーム差分だけで動きを見る。
   - 80x60 程度の小さい内部フレームへ縮小して比較（`src/lib/presence/motion-diff.ts`）。
   - 毎フレームではなく 500〜1000ms 間隔で評価する。
   - 画面全体ではなく**中央受付ゾーン（ROI）のみ**を走査する。
2. **CANDIDATE（短時間のみ）**: 中央ゾーンに変化があったときだけ顔検出を起動。
   - MediaPipe Face Detector 等の軽量モデルを想定（次増分で配線）。
   - 最大 3〜5 秒で打ち切り、取れなければ IDLE に戻す。
3. **ATTRACT / COOLDOWN**: AI を止め、画面反応とタイマのみ。

`motion-diff.ts` は ROI 内のピクセルのみを O(N) で走査し、輝度差を
`pixelThreshold` で 2 値化してノイズを切り捨てる。実カメラに依存しない純粋関数で、
`getImageData().data`（RGBA）は `rgbaToGrayscale` で輝度配列へ縮約してから渡す。

## しきい値 / タイマのチューニング指針

`PresenceConfig`（`state.ts`）と `MotionDiffOptions`（`motion-diff.ts`）に集約し、
設置環境ごとに調整できるようにする。既定値は `DEFAULT_PRESENCE_CONFIG` / `DEFAULT_ROI`。

| パラメータ | 既定 | 調整指針 |
| --- | --- | --- |
| `motionEnterThreshold` | 0.12 | 往来が多い設置なら上げて誤候補化を減らす。暗所カメラノイズが多ければ上げる |
| `candidateMaxMs` | 4000 | 顔検出が間に合わないなら延ばす。誤発火が多ければ短く（横切り切り捨て強化） |
| `attractTimeoutMs` | 8000 | 通行人が見て通り過ぎる時間より少し長く |
| `cooldownMs` | 20000 | 連続来訪が多い受付なら短く、誤発火再発が多ければ長く |
| `pixelThreshold`（ROI） | 24 | カメラノイズが多い/暗い設置で上げる |
| `DEFAULT_ROI` | x[0.25,0.75] y[0.15,0.90] | 端末正面に立つ人の胴体〜顔を覆うよう設置高さに合わせる |

チューニング手順（次増分以降）:
1. 実カメラで motionLevel を可視化し、無人時のベースライン（ノイズ）を測る。
2. ベースライン上限より少し高く `motionEnterThreshold` を設定。
3. 通行人横切り / 立ち止まりの両方で誤発火率・取りこぼし率を計測して調整。

## プライバシー方針

- カメラ映像・静止画・顔画像を**サーバー保存しない**。
- 推論（モーション差分・顔検出）は**端末内ブラウザで完結**する。
- 顔検出は CANDIDATE の**短時間のみ**起動し、結果（検出有無）だけを使う。顔画像は保持しない。
- サーバーへ送るのは受付開始に必要なイベントのみ（`visitor_intent_confirmed` /
  `session_started`）。**`motion_detected` を逐次送信しない**（ログ爆発・通信負荷の回避）。
- 設定で Web カメラ検知を無効化できるようにする（次増分の配線で UI 提供）。

## increment 計画

### increment 1（本 PR・このトラック）— 純粋ロジック + テスト
- `src/domain/presence/state.ts`: 5 状態の純粋関数遷移、誤発火抑制パラメータ化。
- `src/lib/presence/motion-diff.ts`: Canvas フレーム差分の純粋関数（ROI / グレースケール縮約）。
- 各モジュールの vitest ユニットテスト（遷移表 / しきい値境界 / COOLDOWN / 差分境界）。
- 本設計ドキュメント。
- **非スコープ**: 実カメラ getUserMedia、MediaPipe 実装、KioskFlow 統合、ATTRACT 演出。

### increment 2（次）— カメラ / 検知ループ配線
- `getUserMedia()` で低解像度・低 fps 取得、権限エラー復旧 UI、停止時の再初期化。
- Canvas 縮小 → `rgbaToGrayscale` → `computeCenterMotion` → `presenceTransition` の検知ループ
  （500〜1000ms 間隔、タイマ実体の管理）。
- CANDIDATE 時のみ MediaPipe Face Detector を短時間起動するアダプタ。

### increment 3（次々）— UI 統合 / 運用
- KioskFlow への統合、ATTRACT 画面演出（「ご用の方は画面をタップしてください」）。
- `visibilitychange` 復帰時のカメラ / 検知ループ / Wake Lock 再初期化。
- 設定でのカメラ検知 有効/無効トグル。
- `session_started` / `visitor_intent_confirmed` のサーバー連携。

## 受け入れ条件との対応（increment 1 で満たす範囲）

- IDLE 中に AI 推論を常時実行しない → `shouldRunFaceDetection` は CANDIDATE のみ true。
- Canvas 差分による軽量モーション検知 → `computeCenterMotion`（純粋関数、テスト済）。
- 中央ゾーン外の動きでは候補化しない → ROI 走査（テストで周縁変化を無視を確認）。
- 通行人横切りでは受付開始しない → CANDIDATE の candidateMax timeout で IDLE 復帰。
- 連続発火抑制 → SESSION_ENDED → COOLDOWN → cooldownDone。
- 映像を保存しない → 純粋ロジックは映像を保持せず、輝度差の数値のみ扱う。

残り（実カメラ・復旧 UI・visibilitychange・設定トグル）は increment 2/3 で対応。
