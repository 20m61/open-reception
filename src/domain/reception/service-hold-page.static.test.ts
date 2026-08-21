/**
 * 全断（オリジン到達不能）でも同じ停止画面を出す (#629 / Gate A)。
 *
 * `renderServiceHoldPage()` は middleware から返る。**サーバ Lambda が落ちていると
 * middleware は走らない**ので、その経路には入らない。CloudFront 既定の応答は英語の
 * 技術文（"The request could not be satisfied" / "ERROR: ... CloudFront"）で、
 * それが来訪者が最初に見る画面になる。
 *
 * そこで同じ HTML を **S3 の静的ファイル**としても置き、CloudFront の custom error
 * response（502 / 504）から差す（配線は `infra/lib/stacks/web-stack.ts`）。
 * ここで縛るのは 2 つ ──
 *
 * 1. **実在すること。** 無いと CloudFront は元のコードではなく **404** を来訪者へ返す
 *    （AWS: "CloudFront returns an HTTP 404 status code to the viewer"）。
 * 2. **中身が middleware 版と一致していること。** ずれても全断時にしか出ないので
 *    誰も気付けない。
 *
 * 更新: `UPDATE_SERVICE_HOLD_PAGE=1 npx vitest run src/domain/reception/service-hold-page.static.test.ts`
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICE_HOLD_PAGE_PATH, renderServiceHoldPage } from './service-hold-page';

/** `public/` 直下は S3 のルートへ配られる（`/assets/default-bg.jpg` と同じ規則）。 */
const FILE = path.join(process.cwd(), 'public', SERVICE_HOLD_PAGE_PATH.replace(/^\//, ''));

const expected = renderServiceHoldPage();
if (process.env.UPDATE_SERVICE_HOLD_PAGE === '1') writeFileSync(FILE, expected);

describe('全断時の静的な停止画面 (#629)', () => {
  it('🔴 実在する（無いと来訪者には 404 が出る）', () => {
    expect(existsSync(FILE), `${FILE} が無い`).toBe(true);
  });

  it('🔴 middleware が返すものと同じ文面', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(expected);
  });

  /**
   * 🔴 **S3 origin の behavior に一致するパスであること。** サーバ Lambda 側のパスに
   * すると、Lambda が落ちているまさにそのときに取りに行けない。
   * behavior 側の実体は `infra/test/web-stack.test.ts` が突き合わせる。
   */
  it('🔴 静的配信されるパスに置く', () => {
    expect(SERVICE_HOLD_PAGE_PATH).toMatch(/^\/assets\//);
  });
});
