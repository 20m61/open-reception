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

初期閾値は `src/domain/motion/qa.ts` に置く。閾値は実機UAT結果を根拠に調整し、暗黙の感覚値にしない。

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
