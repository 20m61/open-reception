/**
 * secret 値型・secret ストアの client 混入を防ぐ静的ガード (issue #405 Inc1 AC3)。
 *
 * `@/domain/provider-config/secret`（SecretValue / TenantSecretStore）と
 * `@/lib/platform/tenant-secret-store` は secret 値を扱う server-only module。'use client'
 * ファイルがこれらを import すると secret 値がクライアントバンドルに載りうるため禁止する。
 * `src/lib/security/client-secret-guard.test.ts` と同じ静的解析方式（本リポジトリは server-only
 * npm パッケージを使わない）。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(process.cwd(), 'src');

/** client から import してはならない server-only module 指定子（部分一致）。 */
const FORBIDDEN_IMPORTS = [
  '@/domain/provider-config/secret',
  '@/domain/provider-config/secrets-manager-store',
  '@/lib/platform/tenant-secret-store',
  '@/lib/platform/provider-resolution',
  'domain/provider-config/secret',
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isClientFile(content: string): boolean {
  return /^\s*(['"])use client\1/m.test(content.slice(0, 200));
}

describe('provider-config secret の client 混入ガード (#405 Inc1 AC3)', () => {
  const files = listSourceFiles(SRC_DIR);

  it("'use client' ファイルは secret 値型・secret ストアを import しない", () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (!isClientFile(content)) continue;
      for (const spec of FORBIDDEN_IMPORTS) {
        if (content.includes(spec)) violations.push(`${file}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
