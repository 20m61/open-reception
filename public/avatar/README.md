# 受付アバター（VRM）モデルの配置

受付端末（kiosk）の待機〜案内で表示する VRM アバターのモデルファイル置き場です。

## 同梱の既定モデル

`default.vrm` … CC0 の VRM モデル「Rose」（作者: Polygonal Mind / 100Avatars R1）。
CC0（パブリックドメイン相当・商用可・クレジット不要）であることをコレクション定義と VRM 埋め込み
メタ（`licenseName=CC0` / 商用可 / 全員利用可）の双方で確認済み。出所:
[Open Source Avatars (toxsam)](https://github.com/toxsam/open-source-avatars)。差し替え可。

## 使い方

1. ライセンス上問題のない VRM 1.0 モデル（`.vrm`）を、このディレクトリに置く。
   例: `public/avatar/default.vrm`
2. 環境変数で URL を指す。
   ```
   KIOSK_DEFAULT_VRM_URL=/avatar/default.vrm
   ```
3. 管理画面（`/admin/motions` / アセット管理）で VRM を登録・選択した場合は、そちらが優先される
   （`KIOSK_DEFAULT_VRM_URL` は「未登録時の既定」）。

`KIOSK_DEFAULT_VRM_URL` を未設定 / 空 / `none` / `off` にすると VRM 無し（プレースホルダ表示）に戻る。

## ⚠️ ライセンス（#105）

VRM モデルは**著作物**です。配置するモデルは必ずライセンス（再配布・改変・商用利用・クレジット表記の
要否）を確認し、本リポジトリ／配信物の利用形態に適合するものだけを使うこと。出所不明・ライセンス不明の
モデルをコミット／配信しないこと。`.vrm` バイナリはリポジトリに含めず（`.gitignore` 済）、配備時に配置する
運用を推奨する。

## 同梱の既定モーション

`idle.vrma` … `scripts/generate-idle-vrma.mjs` で**自作生成**した待機モーション（呼吸・ゆるい揺れ・
腕を下ろした立ち姿。VRM Animation 1.0 / `VRMC_vrm_animation`）。自作のため CC0 相当・出所明確。
管理画面（/admin/motions）でアセット登録（URL: `/avatar/idle.vrma`）して割り当てる。

## 実装メモ

- 表示は `src/components/kiosk/VrmAvatarViewer.tsx`（three / @pixiv/three-vrm）。
  VRM 0.x モデルは `VRMUtils.rotateVRM0()` で +Z 向きへ正規化する（無いと背面向きになる）。
- 受付状態 → 表情（expression）の写像は `src/components/kiosk/avatar/vrm-expression.ts`。
- モーション（.vrma）再生は `@pixiv/three-vrm-animation` の AnimationMixer 切替で実装済み。
  再生中は手続き的ポーズ（`vrm-idle.ts`）を適用しないため、待機系クリップは腕を下ろす回転を
  含めること（`generate-idle-vrma.mjs` 参照）。
- 実描画・.vrma 再生は SwiftShader(WebGL2) の headless Chromium で検証済み
  （`scripts/vrm-visual-check.mjs`、2026-07-22。記録: `docs/ui-review-2026-07-22.md`）。
  実機 iPad の負荷・リップシンク優先順位の検証は引き続き #65。WebGL 不可・読込失敗時は
  静止画/プレースホルダへ安全に fallback する。
