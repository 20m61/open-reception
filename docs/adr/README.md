# ADR インデックス

アーキテクチャ決定記録（Architecture Decision Record）の一覧。**Issue / PR からここを参照して
決定の根拠を辿れるようにする**（#425 台帳の「ADR index」）。

## 一覧

| ADR | 主題 | ステータス | 関連 Issue |
| --- | --- | --- | --- |
| [0001](0001-voice-transport.md) | iPad 音声ストリーム Transport（WSS + AudioWorklet, PCM 16kHz/16bit, 20ms チャンク） | 承認（MVP・実測により見直す前提） | #369 |
| [0002](0002-voice-tts-cache-boundaries.md) | TTS 音声キャッシュの境界（S3 → CloudFront → Service Worker → IndexedDB） | 承認（設計のみ。実配線は #65） | #371 |
| [0003](0003-realtime-runtime-ec2-phase0.md) | リアルタイム会話 EC2 基盤 Phase 0（lifecycle・endpoint・fallback・instance type） | 承認（設計 + skeleton のみ。**deploy 未実施**） | #366 |

## 書くとき

- ファイル名は `NNNN-<kebab-topic>.md`（連番は採番済みの次番号）。
- 先頭に「ステータス」「文脈」「決定」「代替案」「影響（コスト・運用・撤回条件）」を置く
  （既存 3 件の構成に合わせる）。
- **ADR を起こす基準**: 覆すのに実装のやり直しが要る決定、コスト構造を変える決定、
  セキュリティ境界を動かす決定。1 増分で閉じる実装判断は ADR にせず module doc に書く。
- 追加したら本書の表と `docs/product-integration-plan.md` §8 の「ADR が要る決定」を更新する。
