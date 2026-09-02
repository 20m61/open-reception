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

  // 音声レイヤがマウントされている（＝ factory が渡り、start() が通っている）。
  await expect(page.getByTestId('voice-layer')).toBeVisible();

  // 🔴 **待機画面で聞き取りへ進んでいないこと** (#788)。以前はここで
  // `voice-listening-indicator` が出るのを「起動した証拠」にしていたが、それは
  // **合成発話が idle で走っていた**という不具合そのものを正解として書いていた。
  // 来訪者が一言も発していないのに相手が確定しうる（候補 1 件・高信頼なら復唱も挟まない）。
  await expect(page.getByTestId('voice-layer')).toHaveAttribute('data-voice-mode', 'idle');
  await expect(page.getByTestId('voice-listening-indicator')).toHaveCount(0);

  // 起動によって受付導線が壊れないこと。ここが本質 —— 音声を足したせいで
  // タッチで受付できなくなるなら、フラグ以前の問題になる。
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  expect(errors, `page errors: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 音声で相手が選べること (#788)。
 *
 * これが本題。`EntityDirectory` が空配列だった間、配線（音声確定 → `voiceCandidateToTarget`
 * → `SELECT_TARGET`）は正しいのに**候補ゼロで必ず聞き直し**になり、音声では誰も選べなかった。
 * ソースを読むとタッチと等価に見えるので、**振る舞いで縛らないと同じ形へ戻る**。
 *
 * 合成発話の起点は相手選択への到達（`notifyReceptionState('selectingTarget')`）。確定は
 * **復唱確認を挟む** ── 自動採用にすると相手選択画面が 1 フレームで消え、別の相手に
 * 会いに来た来訪者がタッチで選ぶ間も、取り消す口も無くなる（理由は `local-mode.ts` の
 * `LOCAL_SYNTHETIC_STT_CONFIDENCE`）。
 */
test('?voiceOrchestrator=1 で、担当者を押さずに音声だけで相手が決まる', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // 🔴 **相手選択画面は消えない。** 復唱が出ている間もタッチで別の相手を選べること。
  await revealStaff(page, 'staff-staff-sato');
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();

  // 見える応答（復唱）が出る。無言で相手が決まらない。名前は字幕側に出る
  // （`voice-readback` は「はい／いいえ」のボタン行）。
  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await expect(page.getByTestId('voice-caption')).toContainText('佐藤 太郎');

  /*
   * 🔴 **逃げ道バーと物理的に重ならないこと** (#124 がチャットドロワーに課したのと同じ規則)。
   * `bottom: 0` だった間、担当者リストが長い端末では sticky の「戻る」が復唱の上へ乗り、
   * どちらかが必ず押せなかった（実測: Playwright の click が pointer events を奪われた）。
   * click 自体は重なったときしか落ちない ── リストの長さに依存しない形で縛る。
   */
  const yes = await page.getByTestId('voice-confirm-yes').boundingBox();
  const escapeBar = await page.getByTestId('kiosk-escape-bar').boundingBox();
  expect(yes, '復唱の「はい」が描画されていない').not.toBeNull();
  expect(escapeBar, '逃げ道バーが描画されていない').not.toBeNull();
  // 🔴 **スラックを足さない。** `+1` を許すと 1px 食い込む値（実測 93px）が素通りする。
  expect(
    yes!.y + yes!.height <= escapeBar!.y,
    `復唱ボタンが逃げ道バーに重なっている: yes=${JSON.stringify(yes)} bar=${JSON.stringify(escapeBar)}`,
  ).toBe(true);

  /*
   * 🔴 **操作カードに覆われないこと** (#788)。この層は DOM 上で受付画面より**前**にあるので、
   * z-index が無いと担当者カードが「はい／いいえ」を覆う。**担当者リストを末尾まで送ってから**
   * 見る ── リストが短いと物理的に重ならず、重なりを作らない限りこの回帰は観測できない
   * （実測: z-index を外す変異は、リストが短い単独実行では素通りした）。
   */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const topmost = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="voice-confirm-yes"]');
    if (!button) return 'missing';
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === button || button.contains(hit) ? 'button' : (hit?.getAttribute('data-testid') ?? hit?.className ?? 'other');
  });
  expect(topmost, '復唱の「はい」が別の要素に覆われている').toBe('button');

  // 「はい」で初めて相手が確定する。ここまで担当者カードは一度も押していない。
  await page.getByTestId('voice-confirm-yes').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();

  // 🔴 **画面が進んだことだけでは足りない。** 相手が実際に入っていることを確認画面で見る
  // （`SELECT_TARGET` の target が空でも遷移だけはしうるし、部署が入っていても空ではない）。
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-target')).toHaveText(/佐藤 太郎/);
});

/**
 * 「いいえ」で取り消せること (#788 レビュー 2 周目)。
 *
 * 復唱を挟む意味は、来訪者が**違うと言える**ことにある。取り消し口が死ぬと、
 * 自動採用へ戻したのと実質同じになる。
 */
test('?voiceOrchestrator=1 で、復唱に「いいえ」と答えたら相手は決まらない', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await page.getByTestId('voice-confirm-no').click();

  // 相手選択に留まり、タッチで自分の相手を選べる。
  await revealStaff(page, 'staff-staff-sato');
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.getByTestId('visitor-name')).toHaveCount(0);
});

/**
 * 大画面（4K サイネージ）で復唱ボタンが逃げ道バーに食い込まないこと (#788)。
 *
 * 🔴 **iPad の viewport だけでは捕まえられない。** 持ち上げ量を固定値（96px）にしていた間、
 * ipad-portrait では余裕が 2px だけ残って通り、**large-display では 38px 食い込んで
 * 「はい」の下半分を押すと「戻る」が発火していた**（実測）。原因は、内容がスクロールしない
 * 画面では sticky の逃げ道バーが viewport 下端に付かず、`.screen` の下 padding 分だけ
 * 浮くこと。バーの「高さ」ではなく「viewport 下端からの距離」を測らないと合わない。
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
    // 🔴 **中心だけ見ない。** 食い込みは下端から始まるので、下寄りの点を含めて見る。
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
 * 縦置き iPad で**担当者を検索で絞っても**復唱ボタンが逃げ道バーに食い込まないこと (#788)。
 *
 * 🔴 **4K のテストとは逆向きの盲点を塞ぐ。** 4K は「内容がスクロールしない画面」で崩れたが、
 * こちらは「**スクロールしていた画面が、絞り込みでスクロールしなくなる**」瞬間に崩れる。
 * 一覧が縮むとページが overflow しなくなり、sticky のバーが `.screen` の下 padding ぶん
 * 浮く。バー自身は変わらないので ResizeObserver は鳴らず、scrollY も 0 のままなので
 * scroll も鳴らない ── **再測定の契機が無いまま持ち上げ量が古い値で残る**（実測 −8px）。
 *
 * あわせて**スクロール後の矩形**も見る。`position: fixed` を `absolute` に戻す変異と、
 * scroll リスナを外す変異は、スクロールしない検査では原理的に落とせない。
 */
test('担当者を絞り込んでも・スクロールしても復唱ボタンが逃げ道バーに食い込まない', async ({
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
      // 食い込みは下端から始まるので、下端寄りを横方向に振って見る。**角丸を避ける** ──
      // 両端ちょうどは border-radius の外側で親レイヤが出るため、重なりと区別できない。
      return [0.2, 0.5, 0.8].map((x) => {
        const el = document.elementFromPoint(box.left + box.width * x, box.bottom - 2);
        return el === yes || yes.contains(el) ? 'button' : (el?.getAttribute('data-testid') ?? 'other');
      });
    });

  expect(await bottomEdgeHits(), '絞り込み前から食い込んでいる').toEqual([
    'button',
    'button',
    'button',
  ]);

  // 一覧を 1 件まで絞る = ページが overflow しなくなり、sticky のバーが浮く。
  await page.getByTestId('staff-search').fill('佐');
  await page.waitForTimeout(300);
  expect(await bottomEdgeHits(), '絞り込みで一覧が縮んだ後に食い込んでいる').toEqual([
    'button',
    'button',
    'button',
  ]);

  // スクロールしても viewport 基準に留まること（absolute へ戻す変異・scroll リスナ削除を落とす）。
  await page.getByTestId('staff-search').fill('');
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
  // 🔴 **上限も縛る。** 「重なっていない」だけなら、画面上端へ飛んでいても満たせる
  // （`absolute` で初期包含ブロック基準のまま流れていく形がまさにそれ）。
  expect(drift, `逃げ道バーとの間隔が想定外: ${drift}`).toBeLessThanOrEqual(64);
  expect(drift).toBeGreaterThanOrEqual(0);
});
