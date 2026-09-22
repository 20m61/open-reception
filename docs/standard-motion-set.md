# Open Reception Standard Motion Set

Open Reception の受付アバターが、テナントごとのアセット差し替え後も一貫した振る舞いを維持するための標準モーション仕様です。

## 方針

- 既存の 11 `MotionKey` を製品上の安定した契約として維持する。
- VRMA ファイル自体ではなく、loop / transition / gaze / expression / authoring notes を標準化する。
- VRMA がない場合は既存 procedural pose を安全な fallback として使う。
- runtime expression / lip-sync / blink / gaze は、VRMA が存在しても製品側の制御権を維持する。

## 実アセット整備優先度

1. greeting
2. listening
3. selecting
4. thinking
5. calling
6. success
7. failed

`idle` は同梱済み。`connected` は最小限の生命感でよいか実機確認し、`timeout` / `fallback` は failed/selecting 系の再利用をまず評価する。

## 品質判定

各モーションは実機 UAT で `PASS` / `NEEDS_TUNING` / `REJECT` の3段階評価を行う。最低限、ループ継ぎ目、腕肩首の破綻、4:3 iPad でのフレーミング、視線誘導との競合、TTS/STT 中の自然さ、長時間運転時のリソース安定性を確認する。

## 関連 issue

- #1058 実 VRMA 整備
- #1060 BehaviorPreset の実行時接続
- #1061 実機 UAT チェックリスト
- #1062 procedural fallback 対応表
