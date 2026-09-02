import { describe, expect, it, vi } from 'vitest';

/**
 * `playwright.config.ts` の**退行しては困る設定**を静的に固定する。
 *
 * ここに書くのは「壊れても他のテストが赤くならない」種類の設定だけ。どちらも
 * 実際に一度壊れた（あるいは壊れる寸前だった）ものを対象にしている。
 *
 * ## タイムアウトを伸ばしてある
 *
 * `playwright.config.ts` の import は依存が重く、**vitest 既定の 5 秒に収まらないことがある**。
 * 単独実行でも 3 回に 1 回落ちる実在のフレークだった（負荷時はさらに落ちやすい）。
 * ゲートが「実装と無関係に赤くなる」と、赤の意味が薄れて無視されるようになるので固定する。
 */
const IMPORT_TIMEOUT_MS = 30_000;
describe('playwright.config.ts', () => {
  it('欠落した VRT ベースラインを黙って生成しない (updateSnapshots: none)', async () => {
    const config = (await import('../../playwright.config')).default;

    // Playwright の既定は 'missing'（欠落分を自動生成）。既定のままだと、
    // **retries: 1 と組み合わさって「1 回目が baseline を書いて落ち、retry が通る」**ため、
    // レビューされていない描画が新 baseline として焼き付いたまま suite は green になる。
    // 実際 linux の baseline は 4 枚欠けている（darwin のみで生成された結果系 4 状態）ので、
    // Linux 実行環境（Claude Code on the web 等）へ移ると即座にこの罠を踏む。
    // 意図的な取り直しは CLI の `--update-snapshots` が config を上書きするのでそちらで行う。
    expect(config.updateSnapshots).toBe('none');
  }, IMPORT_TIMEOUT_MS);

  it('chromium 系 project にフェイクカメラを渡す (#361)', async () => {
    const config = (await import('../../playwright.config')).default;
    const chromiumProjects = (config.projects ?? []).filter(
      (p) => p.use && 'browserName' in p.use && p.use.browserName === 'chromium',
    );

    expect(chromiumProjects.length).toBeGreaterThan(0);
    for (const project of chromiumProjects) {
      const args = project.use?.launchOptions?.args ?? [];
      // これが落ちると QR 受付の `scanning` が約 2 秒の過渡状態へ戻り、
      // `kiosk-checkin*.spec.ts` が負荷次第で落ちるフレークに逆戻りする。
      expect(args).toContain('--use-fake-device-for-media-stream');
      expect(args).toContain('--use-fake-ui-for-media-stream');
    }
  }, IMPORT_TIMEOUT_MS);

  it('PW_EXECUTABLE_PATH 指定時もフェイクカメラ引数を失わない（置換ではなくマージ）', async () => {
    vi.resetModules();
    const previous = process.env.PW_EXECUTABLE_PATH;
    process.env.PW_EXECUTABLE_PATH = '/tmp/fake-chromium';
    try {
      const config = (await import('../../playwright.config')).default;
      const project = (config.projects ?? []).find((p) => p.name === 'chromium-ipad');
      // executablePath を返す分岐で launchOptions ごと置き換えると、プリインストール
      // Chromium を使う実行環境でだけフェイクカメラが消えて #361 が再発する。
      expect(project?.use?.launchOptions?.executablePath).toBe('/tmp/fake-chromium');
      expect(project?.use?.launchOptions?.args).toContain('--use-fake-device-for-media-stream');
    } finally {
      if (previous === undefined) delete process.env.PW_EXECUTABLE_PATH;
      else process.env.PW_EXECUTABLE_PATH = previous;
      vi.resetModules();
    }
  });
});
