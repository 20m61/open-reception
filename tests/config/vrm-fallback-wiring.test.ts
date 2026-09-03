/**
 * VRM の fallback 判定が、純関数の側だけで緑にならないようにする (#932)。
 *
 * ## なぜ機械で縛るか
 *
 * `shouldShowVrmFallback` の unit は**判定そのもの**しか見ない。`VrmAvatarViewer` が
 * その関数を使うのをやめて元の `failed: boolean` 判定へ戻しても、**unit は全部緑のまま
 * 通る**（本 PR の変異検証で実測: 純関数の変異 3 件は kill されたが、配線を戻す変異は
 * **生存した**）。
 *
 * これは #923 の独立レビューが B1 として名指しした族と同型である ——
 * `prepareLoadedVrm` の呼び出しと `setAnimationLoop(render)` を両方落としても
 * unit 6663 本が全部緑だった。VRM は e2e / VRT / soak で無効なので、jsdom も実描画も
 * この配線を見ていない（`vitest.config.ts` は `environment: 'node'`、実描画検査は
 * サーバ env から URL を受け取るので**セッション内での差し替えができない**）。
 *
 * 実行時に見られないなら、**静的に見る**しかない。`tests/config/gate-stamp-consumers.test.ts`
 * と同じ方針（散文ではなく実測を正本にする）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const VIEWER = 'src/components/kiosk/VrmAvatarViewer.tsx';

function viewerSource(): string {
  return readFileSync(VIEWER, 'utf8');
}

/** `showFallback` を決めている行（代入の右辺）。 */
function showFallbackAssignment(source: string): string {
  const line = source.split('\n').find((l) => /const\s+showFallback\s*=/.test(l));
  expect(line, `${VIEWER} に showFallback の代入が見つかりません`).toBeDefined();
  return line!;
}

describe('VRM fallback 判定の配線 (#932)', () => {
  it('🔴 fallback 判定は shouldShowVrmFallback に委ねる（viewer が独自に組み立てない）', () => {
    expect(showFallbackAssignment(viewerSource())).toContain('shouldShowVrmFallback');
  });

  it('純関数を実際に import している（名前だけ書いて使わない、を防ぐ）', () => {
    expect(viewerSource()).toMatch(/import\s*\{[^}]*shouldShowVrmFallback[^}]*\}\s*from\s*'\.\/avatar\/fallback-state'/);
  });

  /**
   * **下界**: 「失敗したら以後ずっと fallback」へ戻す変異を名指しで落とす。
   * `failedUrl` は URL を持つので、真偽値として扱う書き方（`|| failedUrl` /
   * `failedUrl !== undefined`）が判定に現れたら退行である。
   */
  it('🔴 失敗を真偽値として持ち回る判定に戻っていない', () => {
    const assignment = showFallbackAssignment(viewerSource());
    expect(assignment).not.toMatch(/\|\|\s*failed/);
    expect(assignment).not.toMatch(/failedUrl\s*!==\s*undefined/);
  });
});
