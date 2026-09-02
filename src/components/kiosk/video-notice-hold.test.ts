import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ビデオ経路の予告は CallingView + 保持ゲート (#832)。
 *
 * jsdom が無いので振る舞いではなく構造を固定する。e2e が遷移列を縛る。
 */
const SCREEN = readFileSync('src/components/kiosk/reception-screens.tsx', 'utf8');
const FLOW = readFileSync('src/components/kiosk/KioskFlow.tsx', 'utf8');

describe('ビデオ経路の予告保持 (#832)', () => {
  it('onTimeout は CALL_TIMEOUT を直 dispatch しない', () => {
    expect(SCREEN).not.toMatch(/onTimeout=\{\(\) => dispatch\(\{ type: 'CALL_TIMEOUT'/);
    expect(SCREEN).toMatch(/onTimeout=\{onCallTimeout\}/);
  });

  it('vonageCallId があっても CallingView を描く', () => {
    const calling = SCREEN.slice(SCREEN.indexOf("case 'calling':"), SCREEN.indexOf("case 'connected':"));
    expect(calling).toContain('<KioskCallView');
    expect(calling).toContain('<CallingView');
    expect(calling).not.toMatch(/vonageCallId \? \([\s\S]*<KioskCallView[\s\S]*\) : \([\s\S]*<CallingView/);
  });

  it('KioskFlow はビデオ timeout を pendingTimeout へ送る', () => {
    expect(FLOW).toMatch(/onCallTimeout:/);
    expect(FLOW).toMatch(/setPendingTimeout\(\{ sessionId: vonageCallId \}\)/);
  });
});
