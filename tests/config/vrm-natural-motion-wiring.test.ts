/**
 * natural micro-motion の hot path / deterministic harness 配線を固定する (#1085)。
 *
 * VRM 実描画は node の unit test では動かないため、純関数が green でも viewer が毎フレーム
 * buffer を作る実装へ戻れば検出できない。実行時に見られない境界だけを静的に確認する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const VIEWER = 'src/components/kiosk/VrmAvatarViewer.tsx';
const HARNESS = 'src/app/kiosk/vrm-harness/harness-client.tsx';
const AVATAR_GUIDE = 'src/components/kiosk/avatar/AvatarGuide.tsx';

function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      return !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*');
    })
    .join('\n');
}

describe('VRM natural motion の配線 (#1085)', () => {
  it('🔴 pose buffer は render loop の外で一度だけ作り、毎フレーム同じ options を渡す', () => {
    const viewer = code(VIEWER);
    const createAt = viewer.indexOf('const statePoseBuffer = createStatePoseBuffer()');
    const renderAt = viewer.indexOf('const render = () =>');

    expect(createAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(createAt);
    expect(viewer).toMatch(
      /resolveStatePose\(avatarStateRef\.current,\s*clock\.elapsedTime,\s*statePoseOptions\)/,
    );
  });

  it('🔴 gaze 合成も buffer 内の head / neck を置換しない', () => {
    const viewer = code(VIEWER);
    expect(viewer).toContain('neck.x =');
    expect(viewer).toContain('head.x =');
    expect(viewer).not.toMatch(/pose\.(?:neck|head)\s*=\s*\{/);
  });

  it('harness だけが固定 seed を渡し、通常受付は読込単位の seed に任せる', () => {
    const harness = code(HARNESS);
    expect(harness).toContain('naturalMotionSeed={DEFAULT_NATURAL_MOTION_SEED}');
    expect(code(AVATAR_GUIDE)).not.toContain('naturalMotionSeed=');
  });
});
