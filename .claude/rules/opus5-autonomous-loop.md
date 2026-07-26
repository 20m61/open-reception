# Opus 5 autonomous loop guardrails

既存の `CLAUDE.md`、`docs/loop-workflow.md`、`docs/loop-queue.md`、`scripts/quality-gate.sh` を正本として補強する。

## モデル役割

- Opus 5 high: リアルタイム会話、AWS/CDK、運用制御、認証、コストを横断する設計
- Opus 5 xhigh: 音声遅延、割込、WebRTC、VRM、外線連携など複数レイヤ障害の根本原因分析
- Sonnet: 通常実装、TDD、テスト、文書更新
- Explore/Haiku: 読み取り専用探索

## 実行規約

1. 各周回の冒頭で Issue AC を実コードへマッピングする。
2. 編集前に変更範囲、非変更範囲、検証、ロールバックを明示する。
3. 同時トラックは2〜3、同一ファイルを触らせず、マージは直列。
4. 自己確認目的だけのサブエージェントを増やさない。
5. テスト削除、skip、弱体化、型安全性低下で green にしない。
6. 同じ失敗が3回続いたら systematic debugging / 根本原因分析へ切り替える。
7. スコープ外の改善は Issue 候補として残す。

## 停止境界

- 本番デプロイ、本番データ操作
- Cognito、認可、PIN/IP制御の境界変更
- DynamoDB非互換変更
- Vonage等への新しい外部送信
- secret / PII / 監査ログ方針変更
- 新規依存・ライセンス判断
- 継続的AWS費用増加

## 完了証拠

変更中は `./scripts/quality-gate.sh --fast`、PR前は `--pr`、マージ前または高リスク変更は `--full`。UI・VRM・音声変更は実ブラウザ、実時間、スクリーンショット、E2Eまたはsoakの証拠を残す。
