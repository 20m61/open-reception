/**
 * 読み込んだ VRM の仕様版を「観測できる形」に正規化する (#578 増分 1)。
 *
 * ## なぜ要るか
 *
 * `VrmAvatarViewer` は `VRMUtils.rotateVRM0` で 0.x の向きを補正しているが、
 * **どちらの版を読んだのかはどこにも出ていない**（公開している診断情報は `data-motion-url` だけ）。
 * そのため実機で「モーションが変」と分かっても、モデル版・モーション・カメラのどれに
 * 帰属するのか切り分けられない。まず**版を観測可能にする**のが、以降の判断の前提になる。
 *
 * ## 版が効いてくる場所
 *
 * - **向き**: 0.x は -Z 向き規約なので 180° 回さないと後ろ姿になる（実描画検証 2026-07-22 で発覚。
 *   同梱 Rose は 0.x）。補正自体は `rotateVRM0` が行う。
 * - **モーション**: `.vrma`（VRM Animation）は VRM 1.0 前提の仕様。0.x モデルへ適用したときの
 *   扱いは増分 2 で判断する。その判断の入力がこの版。
 *
 * ここは**判定と表現だけ**を持ち、three.js には依存しない（GPU 無しでテストできる）。
 */

/** VRM 仕様版。`unknown` は「VRM として読めたが版を判別できない」。 */
export type VrmSpecVersion = '0' | '1' | 'unknown';

/**
 * `vrm.meta.metaVersion`（three-vrm v3 は `'0' | '1'`）を正規化する。
 *
 * **推測で埋めない。** 読めなければ `unknown` を返し、呼び出し側が「判別できなかった」ことを
 * そのまま観測できるようにする。既定を `'1'` などに倒すと、判別失敗が「1.0 だった」として
 * 記録され、実機の切り分けで嘘をつく。
 */
export function resolveVrmSpecVersion(meta: unknown): VrmSpecVersion {
  if (typeof meta !== 'object' || meta === null) return 'unknown';
  const raw = (meta as { metaVersion?: unknown }).metaVersion;
  if (raw === '0' || raw === 0) return '0';
  if (raw === '1' || raw === 1) return '1';
  return 'unknown';
}

/**
 * 観測用の表示値。`data-vrm-version` にそのまま載る。
 *
 * VRM を読めていない状態（読込前・読込失敗）と、読めたが版が不明な状態を区別する
 * — 前者は `none`、後者は `unknown`。まとめると実機で「まだ読んでいない」のか
 * 「読んだが判別できない」のかが分からなくなる。
 */
export function vrmVersionAttribute(input: { loaded: boolean; version: VrmSpecVersion }): string {
  return input.loaded ? input.version : 'none';
}
