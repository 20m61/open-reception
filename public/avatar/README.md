# 受付アバター（VRM）モデルの配置

受付端末（kiosk）の待機〜案内で表示する VRM アバターのモデルファイル置き場です。

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

## 実装メモ

- 表示は `src/components/kiosk/VrmAvatarViewer.tsx`（three / @pixiv/three-vrm）。
- 受付状態 → 表情（expression）の写像は `src/components/kiosk/avatar/vrm-expression.ts`。
- モーション（.vrma）再生は `@pixiv/three-vrm-animation` 導入後に対応（現状はモーション URL を
  受け渡すところまで）。
- WebGL を使うため実描画の確認は実機 UAT（#65）で行う。WebGL 不可・読込失敗時は静止画/プレースホルダへ
  安全に fallback する。
