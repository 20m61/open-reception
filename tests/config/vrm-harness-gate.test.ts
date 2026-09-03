/**
 * 検査用ハーネスが**既定で到達不能**であることを縛る (#930)。
 *
 * ## なぜ機械で縛るか
 *
 * `src/app/kiosk/vrm-harness/` は `VrmAvatarViewer` の入力を実行時に差し替えられる面で、
 * 検査のためだけに在る。ガードを外す（`notFound()` を消す・既定を有効にする）変更は
 * **本番ビルドへ検査専用の経路を露出させる**が、ハーネス自体は検査でしか使われないので
 * **誰も落ちないまま通る**。散文の注記では守れないので実測で縛る。
 *
 * 有効化は `KIOSK_VRM_HARNESS=1` のときだけ（`scripts/vrm-check.sh` が専用サーバへ渡す）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAGE = 'src/app/kiosk/vrm-harness/page.tsx';

/** コメントを落としたソース（コメント中の言及に一致させない）。 */
function pageCode(): string {
  return readFileSync(PAGE, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('VRM ハーネスのガード (#930)', () => {
  it('🔴 env が有効でなければ notFound() へ落とす', () => {
    const code = pageCode();
    expect(code).toContain('notFound()');
    expect(code).toMatch(/process\.env\[[^\]]*\]\s*!==\s*'1'/);
  });

  /** **下界**: 既定で有効になっていない（`!== '1'` を `=== '1'` へ反転する変異を落とす）。 */
  it('🔴 既定は無効（条件を反転していない）', () => {
    expect(pageCode()).not.toMatch(/process\.env\[[^\]]*\]\s*===\s*'1'\s*\)\s*notFound/);
  });

  it('有効化の env 名が検査スクリプトと一致している', () => {
    expect(pageCode()).toContain("'KIOSK_VRM_HARNESS'");
    expect(readFileSync('scripts/vrm-check.sh', 'utf8')).toContain('KIOSK_VRM_HARNESS');
  });
});
