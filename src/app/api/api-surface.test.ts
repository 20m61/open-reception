import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diffApiSurface,
  formatApiSurface,
  parseApiSurface,
  type ApiSurfaceEntry,
} from '@/domain/governance/api-surface';

/**
 * 公開 API 表面のスナップショット検査 (#424「config / API schema の diff チェック」)。
 *
 * `src/app/api/**\/route.ts` が公開しているメソッド × パスを走査し、`docs/api-surface.txt` と
 * 突き合わせる。**削除・改名でこのテストが落ちる**ので、スナップショットの更新が
 * diff に現れ、レビューで「何が消えたか」が必ず目に入る。
 *
 * **壊れる相手はリポジトリの外に居る。** 同一リポジトリ内の呼び出し元は typecheck が捕まえるが、
 * 配布済みの受付端末は `/api/kiosk/*` を叩き続けるので捕まえられない。
 *
 * 更新方法:
 *   UPDATE_API_SURFACE=1 npx vitest run src/app/api/api-surface.test.ts
 *
 * 走査の作りは `src/app/api/admin/authz-coverage.test.ts` と同じ流儀（別実装の走査を
 * 増やさない。あちらは「ガードを通っているか」、こちらは「表面が変わっていないか」を見る）。
 */
const API_ROOT = join('src', 'app', 'api');
const SNAPSHOT = join('docs', 'api-surface.txt');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const SNAPSHOT_HEADER = [
  '# 公開 API 表面のスナップショット (#424)。**手で書き換えない。**',
  '#',
  '# 生成: UPDATE_API_SURFACE=1 npx vitest run src/app/api/api-surface.test.ts',
  '# 検査: src/app/api/api-surface.test.ts（削除・改名でテストが落ちる）',
  '#',
  '# 行が消える差分は破壊的変更。配布済みの受付端末が叩いている経路が含まれるため、',
  '# 削除・改名は移行期間と端末側の追従を伴わないと現場が壊れる。',
  '',
].join('\n');

function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      routeFiles(path, found);
      continue;
    }
    if (entry.name === 'route.ts') found.push(path);
  }
  return found;
}

/**
 * ルートファイルのパスを URL パスへ。動的セグメント（`[tenantId]`）はそのまま残す
 * ——名前を変えても URL 形状は同じなので、リネームで差分にしない（実体は同じ経路）。
 * ただし**セグメントの増減**は形状が変わるので差分になる。
 */
function urlPathOf(file: string): string {
  return `/${file.replace(/\\/g, '/').replace(/^src\/app\//, '').replace(/\/route\.ts$/, '')}`.replace(
    /\[[^\]]+\]/g,
    '[]',
  );
}

/**
 * そのルートが公開している HTTP メソッド（`export async function GET` / `export const GET`）。
 *
 * **正規表現はリテラル 1 本**にして、メソッド名で組み立てない。メソッドごとに
 * `new RegExp(...)` を作ると semgrep の `detect-non-literal-regexp`（ReDoS）に当たる。
 * ここは固定配列由来で実害は無いが、**1 パスで全 export を拾って突き合わせる方が
 * 素直で速い**ので、抑制コメントではなく書き方で解く。
 */
const EXPORTED_UPPER_IDENT = /export\s+(?:async\s+function|function|const)\s+([A-Z]+)\b/g;

function exportedMethods(source: string): string[] {
  const exported = new Set<string>();
  for (const match of source.matchAll(EXPORTED_UPPER_IDENT)) {
    if (match[1] !== undefined) exported.add(match[1]);
  }
  return HTTP_METHODS.filter((method) => exported.has(method));
}

function collectSurface(): ApiSurfaceEntry[] {
  const entries: ApiSurfaceEntry[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const method of exportedMethods(source)) {
      entries.push(`${method} ${urlPathOf(file)}`);
    }
  }
  return entries;
}

describe('公開 API 表面 (#424)', () => {
  const current = collectSurface();

  it('走査自体が壊れていない（1 本も拾えないなら検査は無意味）', () => {
    // 走査が空を返すと「差分なし」で常に通るテストになる。**検出器のトリップワイヤ**。
    expect(current.length).toBeGreaterThan(50);
    expect(current).toContain('GET /api/kiosk/flow');
  });

  it('スナップショットと一致する（削除・改名は破壊的）', () => {
    if (process.env.UPDATE_API_SURFACE === '1') {
      writeFileSync(SNAPSHOT, SNAPSHOT_HEADER + formatApiSurface(current), 'utf8');
      return;
    }
    const diff = diffApiSurface(parseApiSurface(readFileSync(SNAPSHOT, 'utf8')), current);
    // 破壊的な方を先に出す（両方あるときに削除が流れて見えなくならないように）。
    expect(
      diff.removed,
      '消えた API 経路（破壊的）。配布済み端末が叩いている可能性がある。'
        + '意図した削除なら UPDATE_API_SURFACE=1 で更新し、PR に移行手順を書く',
    ).toEqual([]);
    expect(
      diff.added,
      '新しい API 経路。UPDATE_API_SURFACE=1 でスナップショットを更新する',
    ).toEqual([]);
  });
});
