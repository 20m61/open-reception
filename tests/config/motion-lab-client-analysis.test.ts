import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/admin/MotionLabManager.tsx', 'utf8');

describe('Motion Lab client analysis wiring', () => {
  it('keeps BVH analysis local to the browser and wires the deterministic pipeline', () => {
    expect(source).toContain("accept=\".bvh,text/plain\"");
    expect(source).toContain('file.text()');
    expect(source).toContain('parseBvh(source)');
    expect(source).toContain('deriveBvhQaMetrics(parsed)');
    expect(source).toContain('evaluateMotionQa(metrics, motionQaProfileFor(motionKey))');
    expect(source).not.toContain("fetch('/api");
  });

  it('exposes result and error hooks for e2e coverage', () => {
    expect(source).toContain('data-testid=\"motion-lab-bvh-input\"');
    expect(source).toContain('data-testid=\"motion-lab-decision\"');
    expect(source).toContain('data-testid=\"motion-lab-error\"');
  });
});
