# Opus 5 autonomous loop guardrails

既存の `CLAUDE.md`、`docs/loop-workflow.md`、`docs/loop-queue.md`、`scripts/quality-gate.sh` を正本として補強する。来訪者・運用者向け変更では `docs/experience/README.md` を体験設計の正本として併用する。

## モデル役割

- Opus 5 high: リアルタイム会話、AWS/CDK、運用制御、認証、コスト、ジャーニー/状態モデルを横断する設計
- Opus 5 xhigh: 音声遅延、割込、WebRTC、VRM、外線連携、受付完遂の複数レイヤ障害の根本原因分析
- Sonnet: 通常実装、TDD、テスト、文書更新
- Explore/Haiku: 読み取り専用探索

## 実行規約

1. 各周回の冒頭で Issue AC を実コードへマッピングする。
2. 来訪者・運用者向け変更は `docs/experience/README.md` から Actor、Journey ID/step、entry/exit/exception state を特定する。
3. 音声とタッチの等価性、表示・読上げ、timeout、cancel、fallback、PII を受入条件へ含める。
4. 編集前に変更範囲、非変更範囲、検証、ロールバックを明示する。
5. 同時トラックは2〜3、同一ファイルを触らせず、マージは直列。
6. 自己確認目的だけのサブエージェントを増やさない。
7. テスト削除、skip、弱体化、型安全性低下で green にしない。
8. 同じ失敗が3回続いたら systematic debugging / 根本原因分析へ切り替える。
9. スコープ外の改善は Issue 候補として残す。

## Experience loop

来訪者・運用者向け変更は次の順序を守る。

`Journey -> State timeline -> Multimodal interaction contract -> Implementation -> Layered evaluation -> Operational outcome`

各 Issue / 周回には最低限以下を残す。

- Actor / user outcome
- Related journey ID and step
- Entry, exit and exception states
- Voice and touch equivalence
- Visible and spoken system response
- Timeout, cancellation and fallback
- PII / audit impact
- Experience acceptance criteria
- Evaluation level and target device/browser

静止画だけを最適化せず、受付開始、音声認識、確認、発信、接続、失敗復帰、有人支援まで一つの時間的体験として検証する。

## 停止境界

- 本番デプロイ、本番データ操作
- Cognito、認可、PIN/IP制御の境界変更
- DynamoDB**非互換**変更（互換なら下記のとおり自律でよい）
- **Vonage等への新しい外部送信を「本番経路へ配線する」変更**（下記「配線されたときだけ止まる」）
- secret / PII / 監査ログ方針変更
- 新規依存・ライセンス判断
- 継続的AWS費用増加
- 主要 Journey / state / fallback の意味を変える仕様判断

### 外部送信は「配線されたときだけ止まる」

`change-risk` 検出器は**ファイルに送信コードが含まれる**と発火するが、それだけでは停止境界に
当たらない。本プロジェクトは「interface + mock 先行」を型としており（`CLAUDE.md` ガード）、
adapter を足す増分と、それを実経路へ繋ぐ増分は**別**である。

**止まる**のは、その変更によって**実際に送信が起こりうるようになる**とき:

- 本番のコードパスから adapter が構築・呼び出されるようになる（dispatch への配線）
- 実資格情報が供給される経路が繋がる
- 送信内容に PII が乗り始める

**進めてよい**のは、送信が原理的に起こらないと**検証できた**とき。検証は
`CLAUDE.md`「調査の作法」に従い**2 通り以上**で行い、結果を PR 本文に書く:

1. シンボル名での走査（`rg 'createXxx|XXX_KEY'`、テスト除外）
2. **モジュールパス**での走査（`rg 'path/to/module'`、当該ファイル自身を除外）

両方で**本番の呼び出し元がゼロ**、かつ外部 I/O（`fetch` 等）が注入である場合は、
「これから真になる」旨を PR の「人間承認が必要な変更」節に明記したうえで自律マージしてよい。

> 由来: 2026-08-07 / #4 Inc D-1（PR #639）。adapter 追加のみで消費者ゼロだったが検出器が
> 発火し、自律ループが停止した。ユーザー判断でこの粒度へ改めた。

### 永続スキーマも「互換なら進めてよい」

`change-risk` は永続スキーマに触れると発火するが、**互換／非互換を区別できない**。
停止境界は「**非互換**変更」なので、次をすべて満たすなら自律で進めてよい（PR 本文に明記する）:

- 追加するフィールドが**任意**（`readonly x?: T`）である
- 読み側に**既定値**があり、そのフィールドを持たない旧レコードを読めることを**テストで固定**した
- 既存フィールドの意味・型・必須性を変えていない（削除・改名・narrowing はいずれも非互換）

**止まる**のは、削除・改名・型変更・必須化・キー構造の変更など、旧レコードが読めなくなる
（または旧コードが新レコードを誤読する）変更。移行が要るものは全部こちら。

> 由来: 2026-08-07 / #4 Inc D-2a（PR #643）。`StoredCallCorrelation.voiceState` の追加が
> 「非互換変更」として発火したが、任意フィールド＋既定値＋TTL 6 時間で実際には互換だった。

## 完了証拠

変更中は `./scripts/quality-gate.sh --fast`、PR前は `--pr`、マージ前または高リスク変更は `--full`。評価は次の安い層から段階的に実行する。

1. static: 用語、コントラスト、タップ領域、フォーカス、PII、状態欠落
2. state/model: 正常・例外・timeout・cancel・fallback
3. browser/E2E: タッチ導線、権限拒否、無デバイス、通信失敗
4. instrumentation: STT/TTS、割込、発信、状態遷移の時間
5. screenshot: レイアウト・視線誘導が変わる画面だけ
6. video/agent: 変更対象ジャーニーを通しで確認
7. human/device: 横向き iPad、騒音、距離、初見ユーザー

UI・VRM・音声変更は実ブラウザ、実時間、必要範囲のスクリーンショット、E2Eまたはsoakの証拠を残す。
