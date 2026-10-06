import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'src');
const CANONICAL = resolve(SRC, 'domain/governance/aws-runtime.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * Detect only the class we are forbidding: an env-derived region immediately
 * falling back to a concrete literal outside the canonical resolver.
 *
 * This intentionally does NOT ban region literals in general. AWS invariants
 * such as CloudFront/us-east-1 and synthetic test fixtures are different concerns.
 */
const AD_HOC_REGION_DEFAULT =
  /(?:AWS_REGION|AWS_DEFAULT_REGION)\s*(?:\?\?|\|\|)\s*['"`][a-z]{2}-[a-z0-9-]+-\d+['"`]/g;

function adHocRegionDefaultOffsets(source: string): number[] {
  return [...source.matchAll(AD_HOC_REGION_DEFAULT)].map((match) => match.index);
}

function hasAdHocRegionDefault(source: string): boolean {
  return adHocRegionDefaultOffsets(source).length > 0;
}

describe('AWS region configuration provenance (#1234)', () => {
  it('detector itself rejects an ad-hoc env fallback and accepts the canonical call', () => {
    expect(hasAdHocRegionDefault("env.AWS_REGION ?? 'ap-northeast-1'")).toBe(true);
    expect(hasAdHocRegionDefault("env.AWS_REGION\n  ?? 'ap-northeast-1'")).toBe(true);
    expect(hasAdHocRegionDefault('resolveAwsRegion(env)')).toBe(false);
  });

  it('production src keeps region defaults in aws-runtime.ts only', () => {
    const offenders: string[] = [];

    for (const path of walk(SRC)) {
      if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path.endsWith('.d.ts')) continue;
      if (resolve(path) === CANONICAL) continue;

      const source = readFileSync(path, 'utf8');
      for (const offset of adHocRegionDefaultOffsets(source)) {
        const line = source.slice(0, offset).split(/\r?\n/).length;
        offenders.push(`${relative(process.cwd(), path)}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
