import { describe, expect, it } from 'vitest';

import {
  MIN_OCCLUSION_PX,
  contentBottomOf,
  isContentOccluded,
  occludedPx,
  type SiblingBox,
} from './escape-bar-occlusion';

/** 通常の in-flow 要素（既定は「見えていて高さがある」）。 */
function flow(bottom: number, over: Partial<SiblingBox> = {}): SiblingBox {
  return { position: 'static', bottom, height: 100, width: 400, ...over };
}

describe('逃げ道バーが内容を覆っているかの判定 (#816)', () => {
  describe('contentBottomOf: バーより前にある「流し込まれた内容」の下端', () => {
    it('in-flow の兄弟のうち最も下の下端を返す', () => {
      expect(contentBottomOf([flow(200), flow(640), flow(310)])).toBe(640);
    });

    it('内容が 1 つも無ければ null（測れなかった、を 0 に倒さない）', () => {
      expect(contentBottomOf([])).toBeNull();
    });

    /**
     * 🔴 これが本判定の要。`.kiosk-avatar-companion` は `position: fixed` で
     * **viewport の左下**に置かれる（globals.css）。除外しないと、内容が 1px も
     * 隠れていない画面でも「バーの下端付近に何かある」＝覆われている、と誤判定する。
     */
    it('position: fixed の兄弟は内容として数えない（アバターコンパニオンは viewport 下端に居る）', () => {
      expect(contentBottomOf([flow(300), flow(760, { position: 'fixed' })])).toBe(300);
    });

    it('position: absolute の兄弟も数えない（流れの外なのでバーの自然位置を示さない）', () => {
      expect(contentBottomOf([flow(300), flow(760, { position: 'absolute' })])).toBe(300);
    });

    it('display:none 相当（幅も高さも 0）の兄弟は数えない', () => {
      expect(contentBottomOf([flow(300), flow(0, { height: 0, width: 0 })])).toBe(300);
    });

    /**
     * 高さ 0 でも幅を持つ要素は「流れの終端マーカ」として意味がある
     * （`.kiosk-chat-slot` は中身が fixed なので高さ 0 のまま在ることがある）。
     * バーの自然位置をもっとも正確に示すのはこれなので、落としてはいけない。
     */
    it('高さ 0 でも幅を持つ in-flow 要素は数える', () => {
      expect(contentBottomOf([flow(300), flow(655, { height: 0, width: 400 })])).toBe(655);
    });

    it('数えられる兄弟が 1 つも無ければ null', () => {
      expect(contentBottomOf([flow(760, { position: 'fixed' })])).toBeNull();
    });
  });

  describe('occludedPx: 覆われている高さ', () => {
    /**
     * #816 本文の実測（1024x768・iPad 9.7"/mini 横向き相当）。
     * 最下段の群カードが bottom 713 に対し、バー top 658 で **55px 潜っていた**。
     */
    it('実測の 1024x768 では 55px 覆われている', () => {
      expect(occludedPx({ barTop: 658, contentBottom: 713 })).toBe(55);
    });

    it('内容がバー上端で終わっていれば 0', () => {
      expect(occludedPx({ barTop: 658, contentBottom: 658 })).toBe(0);
    });

    it('内容がバーより上で終わっていても負にはしない', () => {
      expect(occludedPx({ barTop: 658, contentBottom: 500 })).toBe(0);
    });
  });

  describe('isContentOccluded: 提示を出すか', () => {
    /** 上界: 隠れた内容があるときは出す。 */
    it('実測の 55px は出す', () => {
      expect(isContentOccluded(658, [flow(713)])).toBe(true);
    });

    /**
     * 🔴 **境界のすぐ内側**を踏む（`MIN_OCCLUSION_PX` を大きくする変異を素通りさせない）。
     * 1px でも隠れていれば「まだ続きがある」は真である。
     */
    it('しきい値ちょうど（1px）でも出す', () => {
      expect(isContentOccluded(658, [flow(658 + MIN_OCCLUSION_PX)])).toBe(true);
    });

    /** 下界 1: ぴったり収まっている画面では出さない（「常に出す」で空虚に通らせない）。 */
    it('内容がバー上端で終わっていれば出さない', () => {
      expect(isContentOccluded(658, [flow(658)])).toBe(false);
    });

    /** 下界 2: そもそもスクロールしない画面（内容がバーよりずっと上）では出さない。 */
    it('内容がバーよりはるか上で終わっていれば出さない', () => {
      expect(isContentOccluded(658, [flow(300)])).toBe(false);
    });

    /**
     * 下界 3: **fixed の兄弟だけでは出さない。** これが無いと、待機画面のように
     * スクロールしない画面でもアバターコンパニオン（viewport 左下・fixed）を拾って
     * 出しっぱなしになる。
     */
    it('fixed の兄弟がバーより下に居ても出さない', () => {
      expect(isContentOccluded(658, [flow(300), flow(760, { position: 'fixed' })])).toBe(false);
    });

    /** 下界 4: 測れないときは出さない（「測れなかった」を「隠れている」に倒さない）。 */
    it('数えられる兄弟が 1 つも無ければ出さない', () => {
      expect(isContentOccluded(658, [])).toBe(false);
    });

    /** しきい値は 1px 未満の丸め誤差を拾わないためのもので、実害のある値であってはならない。 */
    it('しきい値は 1px 以上 4px 以下（実内容を切り捨てない）', () => {
      expect(MIN_OCCLUSION_PX).toBeGreaterThanOrEqual(1);
      expect(MIN_OCCLUSION_PX).toBeLessThanOrEqual(4);
    });
  });
});
