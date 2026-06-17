# open-reception

open-reception は、iPad を受付端末として利用する無人受付システムです。
来訪者がタッチ画面・音声認識・音声合成・VRM アバターを通じて受付操作を行い、担当者を Vonage などのリアルタイム通信基盤で呼び出します。

## 目的

- 来訪者が迷わず担当者を呼び出せる受付体験を提供する
- 担当者が外出中・在席中を問わず、適切に来訪を把握し応対できるようにする
- iPad を専用受付端末として安全・安定運用できるようにする
- VRM アバターと音声 UI により、無人でも冷たくない案内体験を作る

## 想定利用環境

- 受付端末: iPad / iPadOS / Safari または PWA
- 入力: タッチ操作、音声認識
- 出力: 画面表示、音声合成、VRM アバターの表情・モーション
- 通信: Vonage Video API / WebRTC 相当のリアルタイム通話
- 管理: 担当者、部署、呼び出し先、受付履歴、端末設定

## 初期ドキュメント

- [Project Charter](./PROJECT_CHARTER.md)
- [Requirements](./docs/requirements.md)
- [Specification](./docs/specification.md)
- [Security and Testing Plan](./docs/security-testing-plan.md)

## 品質方針

- 仕様は Issue と Pull Request に紐づける
- Semgrep / dependency audit / secret scan / lint / unit test / e2e test を段階的に導入する
- OWASP ASVS をセキュリティ要件の参照軸にする
- iPad 実機検証を受け入れ条件に含める
