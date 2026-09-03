/**
 * 逃げ道バーが**内容を覆っている**かの判定 (#816)。
 *
 * `.kiosk-escape-bar` は `position: sticky; bottom: 0` かつ不透明（`--color-bg`）なので、
 * ページがスクロールする局面では viewport 下端に貼り付いて内容の上に乗る。#124 は
 * 「バーがスクロール内容に隠れないこと」を定めたが、**その裏返し（内容がバーに隠れる）**は
 * 塞がれていなかった。初期着地では最下段が切れて見え、**スクロールできると分からない**。
 *
 * ## なぜ余白では解けないか
 *
 * バーは `.screen` / シェル外枠（flex column）の**最後の in-flow 子**である。内容の下に余白を
 * 足すと**バーがその分下がるだけ**で相対関係は変わらない（#787 の 3 周目が実測で確認し、
 * 追加した `padding-bottom` は名指しした遮蔽を 1px も直していなかった）。塞ぐのではなく、
 * **隠れているときだけ「まだ続きがある」と提示する**。
 *
 * ## なぜ固定値ではなく実測するか
 *
 * `KioskFlow` が同型の教訓を残している ——「バーの高さではなく **viewport 下端からバー上端まで
 * の距離**を測る。バーは sticky なので、内容がスクロールしない画面ではバーは下端に付かない」。
 * 高さを使うと 4K で食い込み、別の要素の当たり判定を奪う。ここも同じで、**バーの現在位置**と
 * **内容の下端**の 2 つを実測して引き算する。
 *
 * ## なぜ「in-flow の兄弟」を内容と見なすのか
 *
 * バーは最後の in-flow 子なので、その直前までの in-flow 兄弟の下端は**バーの自然位置**
 * （sticky で持ち上がる前の位置）を指す。持ち上がった分＝バーが覆っている内容の高さである。
 * 🔴 **`position: fixed` / `absolute` の兄弟を数えてはいけない。** `.kiosk-avatar-companion`
 * は fixed で **viewport の左下**に置かれるため、内容が 1px も隠れていない待機画面でも
 * 「バーの下端付近に何かある」と誤判定させる。
 */

/** 判定に使う兄弟要素の幾何。DOM から読むのは呼び出し側で、ここは純粋に数だけを見る。 */
export type SiblingBox = {
  /** `getComputedStyle(el).position`。 */
  position: string;
  /** `getBoundingClientRect().bottom`（viewport 座標）。 */
  bottom: number;
  /** `getBoundingClientRect().height`。 */
  height: number;
  /** `getBoundingClientRect().width`。 */
  width: number;
};

/**
 * 丸め誤差を拾わないための最小値。**実害のある内容を切り捨てる大きさにしない**
 * （1px でも隠れていれば「まだ続きがある」は真である）。
 */
export const MIN_OCCLUSION_PX = 1;

/** 流れの外に居る＝バーの自然位置を示さない配置。 */
const OUT_OF_FLOW_POSITIONS = new Set(['fixed', 'absolute']);

/** `display: none` 等で描画されていない要素（幅も高さも 0）。 */
function isUnrendered(box: SiblingBox): boolean {
  return box.height === 0 && box.width === 0;
}

/**
 * バーより前にある「流し込まれた内容」の下端。
 *
 * 数えられる兄弟が 1 つも無ければ `null` を返す。**0 に倒さない** ——
 * 「内容がここで終わっている」と「測れなかった」は別物で、0 にすると
 * 「バーより上で終わっている＝覆っていない」という**判断**になってしまう。
 */
export function contentBottomOf(siblings: readonly SiblingBox[]): number | null {
  const inFlow = siblings.filter(
    (box) => !OUT_OF_FLOW_POSITIONS.has(box.position) && !isUnrendered(box),
  );
  if (inFlow.length === 0) return null;
  return Math.max(...inFlow.map((box) => box.bottom));
}

/** バーが覆っている内容の高さ（覆っていなければ 0）。 */
export function occludedPx({
  barTop,
  contentBottom,
}: {
  barTop: number;
  contentBottom: number;
}): number {
  return Math.max(0, contentBottom - barTop);
}

/**
 * 提示（「まだ続きがあります」）を出すか。
 *
 * 上界: 隠れた内容があるときだけ出す。
 * 下界: 収まっている画面・スクロールしない画面・測れない場合は出さない。
 */
export function isContentOccluded(barTop: number, siblings: readonly SiblingBox[]): boolean {
  const contentBottom = contentBottomOf(siblings);
  if (contentBottom === null) return false;
  return occludedPx({ barTop, contentBottom }) >= MIN_OCCLUSION_PX;
}
