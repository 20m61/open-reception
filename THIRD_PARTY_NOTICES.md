# THIRD PARTY NOTICES

本ファイルは open-reception が利用する第三者 OSS のうち、帰属表示（attribution）が必要な
ものを集約する（`docs/license-privacy-guide.md` §1.4 NOTICE 運用）。

依存ライセンスの俯瞰は `npx license-checker --production --summary` を都度実行して確認する
（同 §3）。本ファイルは新規依存追加時に手動で更新する。

---

## qrcode-generator

- バージョン: 2.0.4
- SPDX: MIT
- 商用利用: 可
- 改変 / 再配布: 可（帰属表示）
- 依存: なし（zero dependency）
- 著作権: Copyright (c) Kazuhiko Arase
- リポジトリ: https://github.com/kazuhikoarase/qrcode-generator
- 用途: 来訪予約 (issue #97) の予約参照トークン checkin URL を QR 画像（SVG）へ描画する。
  QR に載せるのは token 参照 URL のみで、来訪者の個人情報は載せない。

```
The MIT License (MIT)

Copyright (c) Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 「QR Code」は DENSO WAVE INCORPORATED の登録商標です。本プロダクトでは QR コードの
> 基本仕様（ロイヤリティフリー）のみを用い、装飾 QR / フレーム QR は使用しません。商標を
> プロダクト名・ロゴで強調しません（`docs/license-privacy-guide.md` §2.8）。

---

## jsQR

- バージョン: 1.4.0
- SPDX: Apache-2.0
- 商用利用: 可
- 改変 / 再配布: 可（帰属表示要・特許許諾あり）
- 依存: なし（zero dependency）
- 著作権: Copyright the jsQR authors (Cozmo and contributors)
- リポジトリ: https://github.com/cozmo/jsQR
- 用途: QR 読み取りチェックイン (issue #98 increment 2) で、受付端末カメラ映像の
  Canvas フレーム（RGBA 画素列）から QR を decode し、予約参照トークンの checkin URL を
  読む。カメラ映像・フレームは**ローカル処理のみ・非送信・非保存**（録画 / 画像保存しない）。
  WASM / worker は同梱しないピュア JS デコーダ。

> Apache-2.0 のため NOTICE ファイル同梱があればその内容を転記する必要があるが、jsQR の
> 配布物に `NOTICE` ファイルは含まれない（`LICENSE`（Apache-2.0 全文）のみ）。上記の帰属
> 表示と Apache-2.0 ライセンス（http://www.apache.org/licenses/LICENSE-2.0）の参照で
> 帰属条件を満たす。`node_modules/jsqr/LICENSE` に全文を同梱。

## 受付アバター 既定 VRM モデル: "Rose" (100Avatars R1)

- ファイル: `public/avatar/default.vrm`
- 作者: Polygonal Mind（100Avatars プロジェクト R1）
- ライセンス: **CC0 1.0**（パブリックドメイン相当・商用利用可・改変可・クレジット表記不要）
- 検証: コレクション定義（toxsam/open-source-avatars の projects.json で 100Avatars R1 = CC0）
  および VRM 埋め込みメタ（`licenseName=CC0` / `commercialUssageName=Allow` /
  `allowedUserName=Everyone`）の双方で確認。
- 出所: https://github.com/toxsam/open-source-avatars
- 用途: 受付端末（kiosk）の既定アバター表示（issue #31）。差し替え可能（`KIOSK_DEFAULT_VRM_URL`）。

> CC0 のためクレジット表記は不要だが、provenance（出所・ライセンス確認）を上記に明記する。

---

## AWS SDK for JavaScript v3 — `@aws-sdk/client-auto-scaling` / `@aws-sdk/client-ec2` /
`@aws-sdk/client-route-53` / `@aws-sdk/client-ssm`

- バージョン: 3.1093.0（`infra/package.json` devDependencies）
- SPDX: Apache-2.0
- 商用利用: 可
- 改変 / 再配布: 可（帰属表示要・特許許諾あり）
- 著作権: Copyright Amazon.com, Inc. or its affiliates
- リポジトリ: https://github.com/aws/aws-sdk-js-v3
- 用途: リアルタイム会話 EC2 基盤 (issue #366 Phase 0) の Reconciler Lambda
  （`infra/lambda/realtime-reconciler/handler.ts`）が、営業時間ポリシーに応じて ASG の
  DesiredCapacity を調整し（`client-auto-scaling`）、起動した EC2 の Public IPv4 を参照し
  （`client-ec2`）、Route 53 A レコードを更新し（`client-route-53`）、緊急停止フラグ（SSM
  Parameter）を読む（`client-ssm`）ために使う。
- 配布形態: **devDependency**（型定義用途のみ）。実行時は Lambda Node.js 22 ランタイムに
  同梱される AWS SDK v3 を使用するため（`NodejsFunction` の `externalModules: ['@aws-sdk/*']`
  でバンドル対象から除外、`infra/lib/constructs/realtime-reconciler-function.ts` 参照）、
  デプロイ artifact には含まれない。個人情報・秘密情報は扱わない（IAM 認証情報は Lambda
  実行ロールから取得、コードへ埋め込まない）。
- NOTICE: `aws-sdk-js-v3` の配布物には `NOTICE` ファイルが含まれない（`LICENSE`
  （Apache-2.0 全文）のみ）。上記の帰属表示と Apache-2.0 ライセンス
  （http://www.apache.org/licenses/LICENSE-2.0）の参照で帰属条件を満たす。

---

## axe-core / @axe-core/playwright（アクセシビリティ自動検査）

- パッケージ: `@axe-core/playwright`（`^4.12.1`）＋ 依存 `axe-core`（`package.json` devDependencies）
- SPDX: **MPL-2.0**（Mozilla Public License 2.0・**ファイル単位**の弱いコピーレフト）
- 商用利用: **可**（下記「利用形態」の条件下で問題なし）
- 改変 / 再配布: MPL-2.0 は「改変した MPL ファイルを配布する場合、その**当該ファイルの**ソースを
  同一ライセンスで開示する」義務を課す。ファイル単位のコピーレフトであり、リンク/併用しただけの
  非 MPL コード（本プロダクトのソース）へは伝播しない（GPL のような感染はしない）。
- 著作権: Copyright Deque Systems, Inc. and axe-core contributors
- リポジトリ: https://github.com/dequelabs/axe-core / https://github.com/dequelabs/axe-core-npm
- ライセンス全文: https://www.mozilla.org/en-US/MPL/2.0/ （`node_modules/axe-core/LICENSE` に同梱）
- 用途: 受付端末（kiosk）主要画面の e2e アクセシビリティ自動検査（issue #361 / #7）。
  `tests/e2e/kiosk-vrt-a11y.spec.ts` ほかで critical/serious の a11y 違反ゼロを assert する。
- **利用形態（#105 判定の要）**: **devDependency・テスト自動化専用**。axe-core を**改変せず**、
  そのまま実行して検査するのみ。フロントエンド配布バンドル（kiosk / admin の shipped bundle）にも、
  OpenNext デプロイ artifact にも**一切含めない**（`npm run build` の対象外・実行時ロードなし）。
  改変も再配布もしないため MPL-2.0 のソース開示義務は発生せず、商用利用に支障はない。
- 判定: **導入可（既存 devDependency の継続利用）**。本 issue で新規依存は追加していない
  （`@axe-core/playwright` は既存の devDependency）。本記載は #105（`docs/license-privacy-guide.md`）
  に基づく SPDX / 商用可否 / 利用形態の確認結果の明文化。
