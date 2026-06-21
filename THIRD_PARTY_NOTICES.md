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
