# Motion Lab

Motion Lab は、mocopi 等で収録したモーションを受付用途の標準モーションとして採用する前に、機械検査・AIレビュー・人間レビューを通す品質管理フローです。

## Workflow

1. Motion Script: 意図・尺・loop・動作量・禁止事項を定義する
2. Capture: raw BVH/FBX を保存する。raw は上書きしない
3. Motion Analyzer: joint 時系列から QA metrics を抽出する
4. Auto Fix: 補正は派生物へ非破壊適用する
5. VRM Renderer: default.vrm と 4:3 iPad 構図で確認用レンダリングを作る
6. AI Review: 台本・metrics・連番/動画を使い修正候補を出す
7. Human Review: PASS / NEEDS_TUNING / REJECT を確定する
8. Standard Motion Library: 採用品だけを標準ライブラリへ昇格する

## Deterministic QA gates

- duration: 台本想定の尺
- neutral-start: 開始姿勢とneutralの差
- neutral-end: 終了姿勢とneutralの差
- loop-seam: loop先頭/末尾の姿勢差
- motion-range: 最大関節角度
- jerk: 急激な加速度変化
- stillness: 低運動フレームの割合
- framing: 4:3構図から頭部・手先がはみ出す割合
- gaze-conflict: head/neckをVRMAが占有する割合

初期閾値は `src/domain/motion/qa.ts` と `src/domain/motion/qa-profiles.ts` に置く。behavior ごとに duration / loop / stillness を分け、実録モーションと iPad UAT を根拠に調整する。

## BVH analyzer

`src/domain/motion/bvh.ts` は conventional BVH の `HIERARCHY` / `MOTION` を解析し、各 joint の rotation channel 宣言順を保持した quaternion へ変換して QA メトリクスを算出する。

BVH から直接算出する値:

- duration (`N frames = N - 1 intervals`)
- loop seam rotation error
- maximum local joint rotation
- per-joint peak angular jerk
- low-motion frame ratio
- semantic head / neck animated ratio

`neutralStartErrorDeg` / `neutralEndErrorDeg` は calibration reference がある場合だけ算出する。`framingOverflowRatio` は骨格データだけでは正しく判定できないため、VRM レンダリング段階で計測した値を注入する。未計測値を `0 = 正常` と仮定しない。

### Local analysis in admin

`/admin/motions/lab` では `.bvh` を選択するとブラウザ内で `parseBvh -> deriveBvhQaMetrics -> evaluateMotionQa` を実行する。現在の実装はファイル内容を API へ送信せず、ローカル解析だけを行う。

運用者は解析前に `MotionKey` を選び、`motionQaProfileFor(key)` により受付行動ごとの QA profile で評価する。raw capture は変更しない。

### Analyzer limitations

- BVH 数値は一次 gate。最終的な自然さは VRM retarget 後の見た目で評価する。
- neutral start/end は capture calibration / reference pose が入るまで `not-applicable`。
- framing は VRM retarget + 4:3 render が入るまで `not-applicable`。
- head / neck は semantic resolver で vendor prefix を許容する。必要に応じて aliases を options から追加できる。
- jerk を含む初期閾値は実録データで再調整する。
- FBX はまだ対象外。将来は BVH と同じ normalized motion へ変換する adapter として実装する。

## Review principle

自動QAは採用候補を絞るための gate であり、自然さそのものの最終判定ではない。AIレビューも同様に補助とし、標準ライブラリへの採用は必ず人間が確定する。

## Correction model

将来の補正は raw ファイルを直接変更せず、処理履歴を持つ派生物として保存する。

- reduceAmplitude(bone, factor)
- smooth(bone, window)
- delay(bone, seconds)
- blendToNeutral(seconds)
- trim(start, end)
- loopNormalize()

修正提案は可能な限り `timecode + bone + adjustment` 形式にする。例: `0.72-1.05s rightUpperArm amplitude -18%`。

## Storage shape (planned)

```text
motions/
  raw/
  processed/
  reports/
  renders/
```

各 take には motionId, take, source, capturedAt, intendedBehavior, sourceHash を持たせ、provenance を追跡できるようにする。

## Next increments

1. 実際の mocopi BVH を複数 take 投入し、profile と jerk / stillness 閾値を校正する
2. capture calibration / neutral reference を導入する
3. `default.vrm` へ retarget し、4:3 iPad 構図を自動レンダリングする
4. framing overflow を実測する
5. timeline 上に警告区間を表示する
6. amplitude / smoothing / delay / blend-to-neutral / loop-normalize を非破壊補正として実装する
7. AI review へ timecode + bone + suggested adjustment を渡す
