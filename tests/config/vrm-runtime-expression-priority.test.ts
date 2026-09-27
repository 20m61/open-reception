import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * VRMA は body/head だけでなく expression track を持ち得る。
 * VrmAvatarViewer が runtime の感情・口形素・blink を mixer より前に書くと、
 * `mixer.update()` が同じ expression を後勝ちで上書きし、受付状態や TTS に同期した
 * 表情制御がアセット依存で消える。
 *
 * three を node unit へ持ち込まず、viewer の実配線順を直接固定する。
 * 最終順序は `mixer.update` → runtime facial controls → `vrm.update`。
 */
describe('VRM runtime facial control priority', () => {
  it('VRMA 更新後に runtime 表情/口パクを適用し、その後 vrm.update する', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/kiosk/VrmAvatarViewer.tsx'),
      'utf8',
    );

    const mixerUpdate = src.indexOf('mixer.update(dt);');
    const emotionApply = src.indexOf(
      'for (const { name, value } of emotionExpressionValues(expressionRef.current))',
    );
    const mouthApply = src.indexOf("expressionManager.setValue('aa', frameWeights.mouthAa);");
    const blinkApply = src.indexOf("expressionManager.setValue('blink', frameWeights.blink);");
    const vrmUpdate = src.indexOf('vrm?.update(dt);');

    for (const index of [mixerUpdate, emotionApply, mouthApply, blinkApply, vrmUpdate]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(mixerUpdate).toBeLessThan(emotionApply);
    expect(emotionApply).toBeLessThan(mouthApply);
    expect(mouthApply).toBeLessThan(blinkApply);
    expect(blinkApply).toBeLessThan(vrmUpdate);
  });
});
