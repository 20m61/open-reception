// VRM 実描画・状態別表示・.vrma 再生の実ブラウザ検証 (#31 / #65 の headless 可能分)。
// 実行: node .vrm-visual-check.mjs <baseURL> <outDir>
import { chromium, request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3100';
const outDir = process.argv[3] ?? './vrm-shots';
mkdirSync(outDir, { recursive: true });

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function enrollKiosk(page) {
  const admin = await request.newContext({ baseURL });
  try {
    const login = await admin.post('/api/admin/login', { data: { password: 'open-reception' } });
    if (!login.ok()) throw new Error('admin login failed');
    const created = await admin.post('/api/admin/devices', {
      data: {
        tenantId: 'internal',
        siteId: 'default-site',
        name: `vrm-check-${Math.random().toString(36).slice(2, 9)}`,
        kind: 'kiosk',
      },
    });
    const deviceId = (await created.json()).id;
    const issued = await admin.post(`/api/admin/devices/${deviceId}/reissue-token`, {
      data: { tenantId: 'internal' },
    });
    const { enrollmentUrl } = await issued.json();
    const token = new URL(enrollmentUrl).searchParams.get('token') ?? '';
    const enroll = await page.request.post(baseURL + '/api/kiosk/enroll', { data: { token } });
    if (!enroll.ok()) throw new Error('enroll failed: ' + enroll.status());
  } finally {
    await admin.dispose();
  }
}


/**
 * canvas 内でモデルが占める領域を求める (#578 レビュー M2/M7 の自動検証)。
 *
 * 画角の妥当性（顔が切れていないか・遠すぎないか・中央にいるか）は「実機で見るしかない」と
 * していたが、**画素を見れば機械的に判定できる**。背景色に依存しないよう、四隅の画素を
 * 背景の基準としてサンプルし、そこから十分離れた画素をモデルとみなす。
 * （canvas は `alpha: true` で背景を描かないが、要素スクショでは背後のページ背景が
 *   合成されるため、透明度ではなく「四隅との差」で見る。）
 */
async function measureModelBounds(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // 四隅＝背景の基準（モデルは中央に立つ前提）。
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const isBackground = (px) =>
    corners.some((c) => Math.abs(px[0] - c[0]) + Math.abs(px[1] - c[1]) + Math.abs(px[2] - c[2]) < 30);

  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isBackground(at(x, y))) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { found: false, width, height };
  return {
    found: true,
    width,
    height,
    minX, minY, maxX, maxY,
    coverage: count / (width * height),
    centerX: (minX + maxX) / 2 / width,
  };
}

const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  args: ['--enable-unsafe-swiftshader'],
});
/**
 * **実機条件（DPR 2）で回す** (#578 レビュー B1)。
 *
 * ここが `deviceScaleFactor: 1` だったため、DPR>1 でしか起きない欠陥に**構造的に盲目**
 * だった。実際、`gl.setSize` が書いた backing store を ResizeObserver が拾って canvas が
 * 指数的に肥大する退行を、この検査は 1 度も検出できなかった（DPR=1 では
 * `pixelRatio=1` になり、書き戻しても寸法が変わらないため発火しない）。
 * 受付端末の iPad は DPR=2。**検査は実機の条件に寄せる。**
 */
const ctx = await browser.newContext({
  viewport: { width: 810, height: 1080 },
  deviceScaleFactor: Number(process.env.VRM_CHECK_DPR ?? 2),
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await enrollKiosk(page);
await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });

// --- 1. VRM canvas がプレースホルダの代わりに現れるか
const canvas = page.getByTestId('vrm-canvas');
let canvasShown = true;
try {
  await canvas.waitFor({ state: 'visible', timeout: 60000 });
} catch {
  canvasShown = false;
}
note('vrm: canvas visible (VRM enabled, not placeholder)', canvasShown);

if (canvasShown) {
  /**
   * **canvas の実寸が安定しているか** (#578 レビュー B1 の回帰固定)。
   *
   * `gl.setSize` の書き戻しを自分で観測して発散すると、数百 ms で上限まで肥大して
   * GPU が落ちる。「描画されているか」だけを見る検査ではこの形の破綻を捕まえられない。
   *
   * **観測は「落ち着いてから」始める。** canvas は CSS 適用前の intrinsic 300x150 から
   * `applyFraming` 後の実寸へ**正常に一度だけ**成長する。その途中で 1 枚目を撮ると
   * 正常な初期化を暴走と誤検知する（負荷がかかると再現する過渡状態の 1 点サンプリング）。
   * 連続 2 回同じ値になるまで待ってから基準を取り、以後**変わらない**ことを見る。
   */
  const readSize = () => canvas.evaluate((el) => ({ w: el.width, h: el.height }));
  let settled = await readSize();
  let settleOk = false;
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(500);
    const next = await readSize();
    if (next.w === settled.w && next.h === settled.h) { settleOk = true; break; }
    settled = next;
  }
  note(
    `vrm: canvas backing store settles (${settled.w}x${settled.h})`,
    settleOk && settled.w > 0 && settled.h > 0,
    settleOk ? '' : 'never stopped changing (runaway resize?)',
  );

  // モデル読込 + 初回描画待ち(SwiftShader は遅い)
  await page.waitForTimeout(12000);

  const sizeAfter = await readSize();
  // 落ち着いた後に動いたら暴走。等値で見る（正常なら再適用しても同じ値になる）。
  note(
    `vrm: canvas backing store stays stable (${settled.w}x${settled.h} -> ${sizeAfter.w}x${sizeAfter.h})`,
    sizeAfter.w === settled.w && sizeAfter.h === settled.h,
  );

  // 観測属性（#578 増分 1・2）。実機で「モーションが変」を切り分ける入口。
  const readObserved = () =>
    canvas.evaluate((el) => ({
      version: el.getAttribute('data-vrm-version'),
      motion: el.getAttribute('data-motion-state'),
      framing: el.getAttribute('data-camera-framing'),
    }));
  const observed = await readObserved();
  console.log(
    `  [vrm] data-vrm-version=${observed.version} data-motion-state=${observed.motion}` +
      ` data-camera-framing=${observed.framing}`,
  );
  /**
   * 🔴 **「null でも none でもない」では弱すぎる** (#731)。
   *
   * 属性がハードコードされた定数へ化けても素通りするので、切り分けの前提（実機で読んだ値が
   * 事実である）が成立しない。同梱の Rose は VRM 0.x なので、**実際の版を名指しで期待する**。
   * モデルを差し替えたらここが落ちる——それは気づくべき変更なので、落ちてよい。
   */
  note(
    `vrm: spec version reflects the bundled model (0.x)`,
    observed.version === '0',
    `data-vrm-version=${observed.version}`,
  );

  /**
   * 頭の高さは humanoid から**実測**していること (#731)。
   *
   * 実測を落として既定値へ倒す退行（`headHeight = undefined`）は、描画としては「それらしく」
   * 見えるので画素の検査では捕まらない。出どころそのものを見る。
   */
  const framingSrc = /(?:^|;)src=([^;]*)/.exec(observed.framing ?? '')?.[1];
  note(
    'vrm: head height is measured from humanoid (not fallback)',
    framingSrc === 'measured',
    `src=${framingSrc ?? '(none)'}`,
  );

  // --- 2. 実際に描画されているか(黒/空でない): canvas 要素のスクショの画素分散
  const shot1 = await canvas.screenshot();
  const stats1 = await sharp(shot1).stats();
  const maxStd = Math.max(...stats1.channels.map((c) => c.stdev));
  note('vrm: canvas has non-blank pixels (model rendered)', maxStd > 8, `max stdev=${maxStd.toFixed(1)}`);
  await sharp(shot1).toFile(`${outDir}/vrm-01-idle.png`);

  // --- 2b. 画角の妥当性を機械的に判定する (#578 レビュー M2/M7)
  const bounds = await measureModelBounds(shot1);
  if (!bounds.found) {
    note('vrm: model occupies pixels (framing measurable)', false, 'no non-background pixels');
  } else {
    const { minY, maxY, minX, maxX, coverage, centerX, width: cw, height: ch } = bounds;
    console.log(
      `  [vrm] bounds x=[${minX},${maxX}] y=[${minY},${maxY}] coverage=${(coverage * 100).toFixed(1)}% centerX=${centerX.toFixed(2)}`,
    );
    // 顔が切れていないか: 上端に張り付いていたら頭が画面外へ出ている疑い。
    note('vrm: head not clipped at top', minY > 1, `minY=${minY}`);
    // 遠すぎ/近すぎ: 画面に対して極端な占有率でない。
    note(
      'vrm: model coverage within sane band (2%..80%)',
      coverage > 0.02 && coverage < 0.8,
      `coverage=${(coverage * 100).toFixed(1)}%`,
    );
    // 縦方向に潰れていない（far 平面外や near クリップの兆候）。
    note('vrm: model spans a meaningful height', maxY - minY > ch * 0.15, `h=${maxY - minY}/${ch}`);
    // 左右中央から大きく外れていない。
    note('vrm: model roughly centered horizontally', Math.abs(centerX - 0.5) < 0.2, `centerX=${centerX.toFixed(2)}`);
    // 左右が両端に張り付いていない（横方向にはみ出していない）。
    note('vrm: model not clipped horizontally', minX > 0 && maxX < cw - 1, `x=[${minX},${maxX}]`);
  }

  // --- 2c. 描画領域の縦横比が変わっても歪まないか (#731)
  /**
   * 🔴 **`camera.updateProjectionMatrix()` の削除は、属性では絶対に捕まらない。**
   *
   * 画角は `resolveCameraFraming` が決め、`data-camera-framing` はその**純関数の出力**を
   * そのまま載せる。行列へ反映したかは属性に出ないので、呼び出しを消しても属性は 1 文字も
   * 変わらない。three.js は明示的に呼ぶまで射影行列を作り直さないため、`aspect` を代入した
   * だけでは描画は古い比率のまま——**モデルが伸びる**（#578 増分 3 が直した欠陥そのもの）。
   *
   * 端末の回転では捕まらない: アバター領域は 3:4 を保つので、viewport を回しても canvas の
   * **縦横比は変わらない**（実測: 300x400 → 480x640）。比が変わらなければ射影も変わらず、
   * 壊れていても差が出ない。よって**親要素の縦横比そのもの**を変えて確かめる。canvas は
   * 親の 100%、`ResizeObserver` は親を観測しているので、これは実経路をそのまま通る。
   */
  if (bounds.found) {
    const portraitRatio = (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY);
    const framingBefore = (await readObserved()).framing;
    const readBox = () =>
      canvas.evaluate((el) => ({ cw: el.clientWidth, ch: el.clientHeight, bw: el.width, bh: el.height }));
    const boxBefore = await readBox();

    // 親を横長へ。**canvas ではなく親**を触る（canvas を直接触ると `gl.setSize` の
    // 書き戻しと混ざり、この検査自身が #578 の発散経路を作る）。
    await canvas.evaluate((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      parent.dataset.vrmCheckPrevStyle = parent.getAttribute('style') ?? '';
      parent.style.height = `${Math.round(parent.clientWidth * 0.5)}px`;
    });
    await page.waitForTimeout(4000);

    const boxAfter = await readBox();
    const framingAfter = (await readObserved()).framing;
    console.log(
      `  [vrm] canvas ${boxBefore.bw}x${boxBefore.bh} -> ${boxAfter.bw}x${boxAfter.bh}` +
        ` framing ${framingBefore} -> ${framingAfter}`,
    );

    const aspectChanged =
      boxAfter.bh > 0 && boxBefore.bh > 0 && Math.abs(boxAfter.bw / boxAfter.bh - boxBefore.bw / boxBefore.bh) > 0.1;
    // この検査自体が成立しているか。比が変わらなければ以下は何も確かめていない。
    note('vrm: canvas aspect actually changed (check is meaningful)', aspectChanged,
      `${(boxBefore.bw / Math.max(boxBefore.bh, 1)).toFixed(2)} -> ${(boxAfter.bw / Math.max(boxAfter.bh, 1)).toFixed(2)}`);

    // 比が変われば画角も決め直される（`ResizeObserver` → `applyFraming` の配線）。
    note(
      'vrm: framing recomputed when the drawing area reshapes',
      Boolean(framingAfter) && framingAfter !== framingBefore,
      `${framingBefore} -> ${framingAfter}`,
    );

    const reshapedShot = await canvas.screenshot();
    await sharp(reshapedShot).toFile(`${outDir}/vrm-01b-reshaped.png`);
    const reshaped = await measureModelBounds(reshapedShot);
    if (!reshaped.found) {
      note('vrm: model proportions survive reshape', false, 'no non-background pixels after reshape');
    } else {
      const reshapedRatio = (reshaped.maxX - reshaped.minX) / (reshaped.maxY - reshaped.minY);
      const drift = reshapedRatio / portraitRatio;
      console.log(
        `  [vrm] w/h before=${portraitRatio.toFixed(3)} after=${reshapedRatio.toFixed(3)} drift=${drift.toFixed(2)}x`,
      );
      // 射影を更新しないと、縦横比の変化分だけ倍率で狂う。描画の揺らぎは飲み込む幅にする。
      note(
        'vrm: model proportions survive reshape (projection matrix updated)',
        drift > 0.8 && drift < 1.25,
        `drift=${drift.toFixed(2)}x (before=${portraitRatio.toFixed(3)} after=${reshapedRatio.toFixed(3)})`,
      );
    }

    // 以降の検査は元のレイアウト前提なので必ず戻す。
    await canvas.evaluate((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      parent.setAttribute('style', parent.dataset.vrmCheckPrevStyle ?? '');
      delete parent.dataset.vrmCheckPrevStyle;
    });
    await page.waitForTimeout(3000);
  }

  // --- 3. 手続き的アイドル(呼吸)で動いているか: 2.5 秒空けて差分
  await page.waitForTimeout(2500);
  const shot2 = await canvas.screenshot();
  await sharp(shot2).toFile(`${outDir}/vrm-02-idle-2.5s.png`);
  note('vrm: idle animation moves the model (frames differ)', !shot1.equals(shot2));

  await page.screenshot({ path: `${outDir}/vrm-03-idle-full.png` });

  // --- 4. 受付を開始し状態遷移後もアバターが生きているか(表情/ポーズは目視)
  const start = page.getByTestId('signage-start').or(page.locator('main'));
  await page.touchscreen.tap(405, 540);
  await page.waitForTimeout(4000);
  const canvasAfter = await page.getByTestId('vrm-canvas').count();
  note('vrm: canvas survives state transition to reception', canvasAfter > 0, `count=${canvasAfter}`);
  await page.screenshot({ path: `${outDir}/vrm-04-purpose-full.png` });

  // --- 5. motionUrl 属性(状態別モーション接続口)の確認
  if (canvasAfter > 0) {
    const motionUrl = await page.getByTestId('vrm-canvas').first().getAttribute('data-motion-url');
    console.log('info: data-motion-url =', JSON.stringify(motionUrl));
  }

  // --- 6. 自作 idle.vrma を default motion に割り当て、実再生を検証 (#31)
  const admin = await request.newContext({ baseURL });
  try {
    await admin.post('/api/admin/login', { data: { password: 'open-reception' } });
    const created = await admin.post('/api/admin/assets', {
      data: { kind: 'motion', name: 'idle(自作 vrma)', url: '/avatar/idle.vrma' },
    });
    const body = await created.json();
    const assetId = body.id ?? body.value?.id;
    note('vrma: motion asset registered', created.ok() && !!assetId, `id=${assetId}`);
    const put = await admin.put('/api/admin/motions', { data: { default: assetId } });
    note('vrma: assigned as default motion', put.ok());

    await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });
    const canvas2 = page.getByTestId('vrm-canvas');
    await canvas2.waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForTimeout(12000);
    const mu = await canvas2.getAttribute('data-motion-url');
    note('vrma: kiosk resolves motion url', mu === '/avatar/idle.vrma', `data-motion-url=${mu}`);
    const m1 = await canvas2.screenshot();
    await sharp(m1).toFile(`${outDir}/vrm-05-vrma-playing.png`);
    const mstats = await sharp(m1).stats();
    const mstd = Math.max(...mstats.channels.map((c) => c.stdev));
    note('vrma: canvas rendered during playback', mstd > 8, `max stdev=${mstd.toFixed(1)}`);
    await page.waitForTimeout(2500);
    const m2 = await canvas2.screenshot();
    await sharp(m2).toFile(`${outDir}/vrm-06-vrma-playing-2.5s.png`);
    note('vrma: motion animates the model (frames differ)', !m1.equals(m2));
    // 後始末(割り当て解除)
    await admin.put('/api/admin/motions', { data: { default: null } });
  } finally {
    await admin.dispose();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
