import { test, expect, revealStaff } from './kiosk-fixtures';

/**
 * 実 orchestrator のローカル起動 (#372 配線)。
 *
 * `VoiceSessionOrchestrator`（ターン検出・barge-in・TTS duck/stop・VRM 同期）は実装も
 * unit テストも揃っていたが**本番呼び出し元がゼロ**で、一度も起動していなかった。
 * `?voiceOrchestrator=1` で mock provider 駆動の実 orchestrator を通す。
 */

/** **既定はオフ。** これが崩れると、全端末の音声挙動が黙って変わる。 */
test('フラグ無しでは音声レイヤが出ない（既存挙動を変えない）', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-idle')).toBeVisible();
  await expect(page.getByTestId('voice-listening-indicator')).toHaveCount(0);
});

test('?voiceOrchestrator=1 で実 orchestrator が起動し、受付が壊れない', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/kiosk?voiceOrchestrator=1');
  await expect(page.getByTestId('kiosk-idle')).toBeVisible();
  await expect(page.getByTestId('voice-layer')).toBeVisible();

  await expect(page.getByTestId('voice-layer')).toHaveAttribute('data-voice-mode', 'idle');
  await expect(page.getByTestId('voice-listening-indicator')).toHaveCount(0);

  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  expect(errors, `page errors: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 音声で相手が選べること (#788)。
 *
 * `EntityDirectory` が空配列だった間、配線（音声確定 → `voiceCandidateToTarget`
 * → `SELECT_TARGET`）は正しいのに候補ゼロで必ず聞き直しになり、音声では誰も選べなかった。
 * 合成発話の起点は相手選択への到達。確定は復唱確認を挟む。
 */
test('?voiceOrchestrator=1 で、担当者を押さずに音声だけで相手が決まる', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // 復唱が出ている間もタッチで別の相手を選べること。
  await revealStaff(page, 'staff-staff-sato');
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();

  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await expect(page.getByTestId('voice-caption')).toContainText('佐藤 太郎');

  const yes = await page.getByTestId('voice-confirm-yes').boundingBox();
  const escapeBar = await page.getByTestId('kiosk-escape-bar').boundingBox();
  expect(yes, '復唱の「はい」が描画されていない').not.toBeNull();
  expect(escapeBar, '逃げ道バーが描画されていない').not.toBeNull();
  expect(
    yes!.y + yes!.height <= escapeBar!.y,
    `復唱ボタンが逃げ道バーに重なっている: yes=${JSON.stringify(yes)} bar=${JSON.stringify(escapeBar)}`,
  ).toBe(true);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const topmost = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="voice-confirm-yes"]');
    if (!button) return 'missing';
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === button || button.contains(hit)
      ? 'button'
      : (hit?.getAttribute('data-testid') ?? hit?.className ?? 'other');
  });
  expect(topmost, '復唱の「はい」が別の要素に覆われている').toBe('button');

  await page.getByTestId('voice-confirm-yes').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();

  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-target')).toHaveText(/佐藤 太郎/);
});

/** 復唱を挟む意味として「違う」と言えることを固定する。 */
test('?voiceOrchestrator=1 で、復唱に「いいえ」と答えたら相手は決まらない', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await page.getByTestId('voice-confirm-no').click();

  await revealStaff(page, 'staff-staff-sato');
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.getByTestId('visitor-name')).toHaveCount(0);
});

/**
 * 大画面（4K サイネージ）で復唱ボタンが逃げ道バーに食い込まないこと (#788)。
 */
test('4K サイネージでも復唱ボタンが逃げ道バーに食い込まない', async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('voice-readback')).toBeVisible();

  const hits = await page.evaluate(() => {
    const yes = document.querySelector('[data-testid="voice-confirm-yes"]');
    if (!yes) return ['missing'];
    const box = yes.getBoundingClientRect();
    return [0.1, 0.5, 0.85, 0.95].map((frac) => {
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height * frac);
      return el === yes || yes.contains(el) ? 'button' : (el?.getAttribute('data-testid') ?? 'other');
    });
  });
  expect(hits, '復唱ボタンの一部が別の要素に覆われている（押すと別の操作が起きる）').toEqual([
    'button',
    'button',
    'button',
    'button',
  ]);
});

/**
 * 縦置き iPad で**相手選択の内容量が変わっても**復唱ボタンが逃げ道バーに食い込まないこと (#788 / #1057)。
 *
 * 旧テストは文字検索で一覧を 1 件へ絞って高さを変えていた。No Typing 後は同じ幾何変化を
 * 「部署群 → 小さい担当者群を開く」で作る。検索欄を復活させず、ResizeObserver / sticky /
 * fixed の回帰検出という本来の目的を維持する。
 */
test('担当者群を開閉しても・スクロールしても復唱ボタンが逃げ道バーに食い込まない', async ({
  page,
}) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('voice-readback')).toBeVisible();

  const bottomEdgeHits = () =>
    page.evaluate(() => {
      const yes = document.querySelector('[data-testid="voice-confirm-yes"]');
      if (!yes) return ['missing'];
      const box = yes.getBoundingClientRect();
      return [0.2, 0.5, 0.8].map((x) => {
        const el = document.elementFromPoint(box.left + box.width * x, box.bottom - 2);
        return el === yes || yes.contains(el) ? 'button' : (el?.getAttribute('data-testid') ?? 'other');
      });
    });

  expect(await bottomEdgeHits(), '部署群の表示時点で食い込んでいる').toEqual([
    'button',
    'button',
    'button',
  ]);

  // 小さい担当者群を開き、コンテンツ高さを変える。
  await revealStaff(page, 'staff-staff-sato');
  await page.waitForTimeout(300);
  expect(await bottomEdgeHits(), '担当者群を開いた後に食い込んでいる').toEqual([
    'button',
    'button',
    'button',
  ]);

  // 部署群へ戻してからスクロールし、viewport 基準に留まることを見る。
  await page.getByTestId('staff-group-back').click();
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  expect(await bottomEdgeHits(), 'スクロール後に食い込んでいる').toEqual([
    'button',
    'button',
    'button',
  ]);

  const drift = await page.evaluate(() => {
    const yes = document.querySelector('[data-testid="voice-confirm-yes"]');
    const bar = document.querySelector('[data-testid="kiosk-escape-bar"]');
    if (!yes || !bar) return null;
    return Math.round(bar.getBoundingClientRect().top - yes.getBoundingClientRect().bottom);
  });
  expect(drift, `逃げ道バーとの間隔が想定外: ${drift}`).toBeLessThanOrEqual(64);
  expect(drift).toBeGreaterThanOrEqual(0);
});
