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

## BVH analyzer

`src/domain/motion/bvh.ts` は conventional BVH の `HIERARCHY` / `MOTION` を解析し、各 joint のチャンネル順を XYZ に正規化して QA メトリクスへ変換する。

BVH から直接算出する値:

- duration
- neutral start / end rotation error
- loop seam rotation error
- maximum joint rotation
- peak angular jerk
- low-motion frame ratio
- head / neck animated ratio

`framingOverflowRatio` は骨格データだけでは正しく判定できないため、VRM レンダリング段階で計測した値を analyzer に注入する。

### Analyzer limitations

- Euler 角ベースの判定は一次 gate。最終的な自然さは VRM retarget 後の見た目で評価する。
- neutral error は現時点ではゼロ回転を基準にする。mocopi 実データ確認後、capture calibration / reference frame を導入する。
- head / neck の別名は options で渡せる。特定ベンダーのボーン名を domain model に固定しない。
- FBX はまだ対象外。将来は BVH と同じ正規化フレームへ変換する adapter として実装する。

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

1. 管理画面または API から BVH を投入して analyzer を実行する
2. joint alias / rest-pose calibration を追加する
3. `default.vrm` へ retarget し、4:3 iPad 構図を自動レンダリングする
4. framing overflow を実測する
5. timeline 上に警告区間を表示する
6. amplitude / smoothing / delay / blend-to-neutral / loop-normalize を非破壊補正として実装する
7. AI review へ timecode + bone + suggested adjustment を渡す
